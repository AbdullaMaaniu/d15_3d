import { MeshoptSimplifier } from 'meshoptimizer';
import type { ClothMaterial } from './materials';

/**
 * Cloth simulation for garments on a skinned character (extended position-
 * based dynamics, substepped).
 *
 * The garment's own vertices are the particles. Each frame the skinned
 * character gives every particle a target: where plain skinning would put it.
 * - Where the garment meets non-cloth parts (skin at a collar or cuff) it is
 *   pinned to that target.
 * - Where it lies against the body it grips it: a soft pull to the target,
 *   so heavier fabric sags and lags more. The grip fades where the cloth
 *   stands away from the body (a skirt's hem), which hangs and swings freely.
 * - Edges resist stretching and the hinge across every edge resists folding,
 *   per fabric.
 * - Cloth that lies against the body can't sink into it: it stays on the
 *   outside of its skinned position (a backstop along the body's normal).
 *   Loose cloth is kept out of the limbs and torso by capsules.
 * - A maximum distance from the target, growing with the gap to the body,
 *   keeps it from ever drifting off.
 */

type V3 = [number, number, number];

export interface ClothCapsule {
  /** Bind-pose end points (rig space) and the radius at each (tapered). */
  a: V3;
  b: V3;
  ra: number;
  rb: number;
}

export interface ClothSetup {
  /** Render vertices in rig space (bind pose). */
  positions: ArrayLike<number>;
  index: ArrayLike<number>;
  /** Fabric per triangle: an index into `materials`, or -1 where the triangle isn't cloth. */
  triangleMaterial: ArrayLike<number>;
  materials: readonly ClothMaterial[];
  /** The body inside the clothes (rig space, bind pose), for gaps and collisions. */
  body?: { positions: ArrayLike<number>; normals: ArrayLike<number> };
  capsules?: readonly ClothCapsule[];
  /** Scales how far cloth may move from the skinned surface (default 1). */
  freedom?: number;
  /** Most points the cloth is simulated with (default 1500); finer meshes follow a simplified cage. */
  particleBudget?: number;
}

/** One frame of the animated character, in world space. */
export interface ClothFrame {
  /** Skinned position of every particle (3 per particle): its render vertex's bind position plus `ClothSim.lift`, skinned. */
  targets: Float32Array;
  /** Skinned normals of `bodyVertices` (3 per entry). */
  bodyNormals?: Float32Array;
  /** Skinned positions of `bodyVertices` (3 per entry): the cloth stays outside the body there. */
  bodyPositions?: Float32Array;
  /** Capsules: a, b, ra, rb (8 per capsule, same order as the setup). */
  capsules?: Float32Array;
}

export interface ClothSim {
  /** Particle count. */
  count: number;
  /** Particle of every render vertex, or -1 (not cloth). */
  particleOf: Int32Array;
  /** A render vertex for every particle (to skin its target). */
  vertexOf: Uint32Array;
  /** Pinned particles follow the skin exactly. */
  pinned: Uint8Array;
  /** Points actually simulated (the cage). */
  cageCount: number;
  /**
   * Bind-space offset per particle (3 each) that moves cloth starting inside
   * the body out over it, smoothly. Add it to the bind position before
   * skinning the targets; zero where the cloth already clears the body.
   */
  lift: Float32Array;
  /** Body vertices whose normals the backstops use, in the order `ClothFrame.bodyNormals` lists them. */
  bodyVertices: Uint32Array;
  /** Current particle positions (world). */
  positions: Float32Array;
  /** Current particle normals (world), area-weighted over cloth triangles. */
  normals: Float32Array;
  /** Advances by dt seconds to the given frame. Returns false if it reset (first frame, teleport). */
  step(dt: number, frame: ClothFrame): boolean;
  /** Snaps the cloth to the frame and lets it settle under gravity. */
  reset(frame: ClothFrame, settle?: number): void;
  /** Makes the next step start over from the skinned pose (after a cut). */
  restart(): void;
  /** Debug numbers from the last step. */
  stats: { substeps: number; maxOffset: number; resets: number };
}

const GRAVITY = -9.81;
const AIR_DENSITY = 1.2;
/** Cloth thickness kept between the body and the cloth (m). */
const MARGIN = 0.003;
/** A body this far below the cloth no longer holds it (gap at which grip halves, m). */
const GRIP_FALLOFF = 0.025;
/** Substep length (s). */
const SUBSTEP = 1 / 360;
const MAX_SUBSTEPS = 40;
/** A target jump this large in one frame is a cut or a loop wrap, not motion (m). */
const TELEPORT = 0.35;
/** Cloth closer to the body than this can't sink into it (m). */
const BACKSTOP_RANGE = 0.05;
/** Cloth inside the body is lifted to this far outside it (m). */
const LIFT_CLEARANCE = 0.006;
/** Cloth deeper inside the body than this is left alone: the body is a poor fit there, not a tight garment (m). */
const LIFT_MAX = 0.12;
/** Clearance kept between cloth and the collision capsules (m). */
const CAPSULE_MARGIN = 0.01;

/**
 * Where a garment starts inside the body (the body fitted to a tight or
 * stylised outfit), how far each particle moves out over it: along the
 * nearest body normal to LIFT_CLEARANCE outside, then smoothed across the
 * garment so it inflates evenly instead of tenting. Pinned seams stay put.
 */
function liftOutOfBody(rest: Float32Array, tris: Uint32Array, clothCount: number, pinned: Uint8Array, body: ClothSetup['body']): Float32Array {
  const lift = new Float32Array(rest.length);
  if (!body || !body.positions.length || !clothCount) return lift;
  const BP = body.positions, BN = body.normals;
  const grid = new PointGrid(BP, 0.02);
  // Required push along the body normal, per particle.
  const need = new Float32Array(clothCount);
  const dir = new Float32Array(clothCount * 3);
  let any = false;
  for (let p = 0; p < clothCount; p++) {
    if (pinned[p]) continue;
    const x = rest[p * 3], y = rest[p * 3 + 1], z = rest[p * 3 + 2];
    const b = grid.nearest(x, y, z, 8);
    if (b < 0) continue;
    const nx = BN[b * 3], ny = BN[b * 3 + 1], nz = BN[b * 3 + 2];
    const d = (x - BP[b * 3]) * nx + (y - BP[b * 3 + 1]) * ny + (z - BP[b * 3 + 2]) * nz;
    if (d >= LIFT_CLEARANCE || d < -LIFT_MAX) continue;
    need[p] = LIFT_CLEARANCE - d;
    dir[p * 3] = nx;
    dir[p * 3 + 1] = ny;
    dir[p * 3 + 2] = nz;
    lift[p * 3] = nx * need[p];
    lift[p * 3 + 1] = ny * need[p];
    lift[p * 3 + 2] = nz * need[p];
    any = true;
  }
  if (!any) return lift;
  const nb: number[][] = Array.from({ length: clothCount }, () => []);
  for (let t = 0; t < tris.length; t += 3)
    for (let k = 0; k < 3; k++) {
      const a = tris[t + k], c = tris[t + ((k + 1) % 3)];
      if (a < clothCount && c < clothCount) nb[a].push(c), nb[c].push(a);
    }
  // Smooth, then hold every particle at least as far out as it needs.
  const next = new Float32Array(clothCount * 3);
  for (let pass = 0; pass < 12; pass++) {
    for (let p = 0; p < clothCount; p++) {
      if (pinned[p] || !nb[p].length) {
        for (let k = 0; k < 3; k++) next[p * 3 + k] = lift[p * 3 + k];
        continue;
      }
      for (let k = 0; k < 3; k++) {
        let m = 0;
        for (const q of nb[p]) m += lift[q * 3 + k];
        next[p * 3 + k] = 0.5 * lift[p * 3 + k] + (0.5 * m) / nb[p].length;
      }
      if (need[p] > 0) {
        const o = p * 3;
        const along = next[o] * dir[o] + next[o + 1] * dir[o + 1] + next[o + 2] * dir[o + 2];
        if (along < need[p]) for (let k = 0; k < 3; k++) next[o + k] += dir[o + k] * (need[p] - along);
      }
    }
    lift.set(next);
  }
  return lift;
}

/** Hashes points into cells for nearest-point queries. */
class PointGrid {
  private cells = new Map<number, number[]>();
  constructor(private pts: ArrayLike<number>, private cell: number) {
    for (let i = 0; i < pts.length / 3; i++) {
      const k = this.key(Math.floor(pts[i * 3] / cell), Math.floor(pts[i * 3 + 1] / cell), Math.floor(pts[i * 3 + 2] / cell));
      let c = this.cells.get(k);
      if (!c) this.cells.set(k, (c = []));
      c.push(i);
    }
  }
  private key(x: number, y: number, z: number) {
    return ((x + 512) * 1024 + (y + 512)) * 1024 + (z + 512);
  }
  /** Nearest point within maxRings cells, or -1. */
  nearest(x: number, y: number, z: number, maxRings: number): number {
    const cx = Math.floor(x / this.cell), cy = Math.floor(y / this.cell), cz = Math.floor(z / this.cell);
    let best = -1, bestD = Infinity;
    for (let r = 0; r <= maxRings; r++) {
      for (let i = -r; i <= r; i++)
        for (let j = -r; j <= r; j++)
          for (let k = -r; k <= r; k++) {
            if (Math.max(Math.abs(i), Math.abs(j), Math.abs(k)) !== r) continue;
            const c = this.cells.get(this.key(cx + i, cy + j, cz + k));
            if (!c) continue;
            for (const p of c) {
              const dx = this.pts[p * 3] - x, dy = this.pts[p * 3 + 1] - y, dz = this.pts[p * 3 + 2] - z;
              const d = dx * dx + dy * dy + dz * dz;
              if (d < bestD) (bestD = d), (best = p);
            }
          }
      // Anything in a further ring is at least r cells away.
      if (best >= 0 && Math.sqrt(bestD) <= r * this.cell) break;
    }
    return best;
  }
}

/** Signed distance outside a tapered capsule (negative inside). */
function capsuleDepth(px: number, py: number, pz: number, a: V3, b: V3, ra: number, rb: number): number {
  const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2];
  const l2 = abx * abx + aby * aby + abz * abz || 1;
  const t = Math.min(1, Math.max(0, ((px - a[0]) * abx + (py - a[1]) * aby + (pz - a[2]) * abz) / l2));
  return Math.hypot(px - a[0] - abx * t, py - a[1] - aby * t, pz - a[2] - abz * t) - (ra + (rb - ra) * t);
}

function segmentDistance(px: number, py: number, pz: number, a: V3, b: V3): number {
  const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2];
  const l2 = abx * abx + aby * aby + abz * abz || 1;
  const t = Math.min(1, Math.max(0, ((px - a[0]) * abx + (py - a[1]) * aby + (pz - a[2]) * abz) / l2));
  return Math.hypot(px - a[0] - abx * t, py - a[1] - aby * t, pz - a[2] - abz * t);
}

function triArea(x: ArrayLike<number>, a: number, b: number, c: number): number {
  const ux = x[b * 3] - x[a * 3], uy = x[b * 3 + 1] - x[a * 3 + 1], uz = x[b * 3 + 2] - x[a * 3 + 2];
  const vx = x[c * 3] - x[a * 3], vy = x[c * 3 + 1] - x[a * 3 + 1], vz = x[c * 3 + 2] - x[a * 3 + 2];
  return 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
}

/**
 * Signed dihedral angle of the hinge: wings x1, x2 on either side of the edge x3 -> x4
 * (Bridson et al. 2003, "Simulation of clothing with folds and wrinkles").
 */
function dihedral(x: ArrayLike<number>, i1: number, i2: number, i3: number, i4: number): number {
  const g = hingeGeometry(x, i1, i2, i3, i4);
  return g ? g.theta : 0;
}

const hg = { theta: 0, u: new Float64Array(12) };
/** Angle and its gradient with respect to the four points (u1..u4, 3 each). */
export function hingeGeometry(x: ArrayLike<number>, i1: number, i2: number, i3: number, i4: number): typeof hg | null {
  const o1 = i1 * 3, o2 = i2 * 3, o3 = i3 * 3, o4 = i4 * 3;
  const ex = x[o4] - x[o3], ey = x[o4 + 1] - x[o3 + 1], ez = x[o4 + 2] - x[o3 + 2];
  const el = Math.sqrt(ex * ex + ey * ey + ez * ez);
  if (el < 1e-9) return null;
  // N1 = (x1 - x3) x (x1 - x4), N2 = (x2 - x4) x (x2 - x3)
  const ax = x[o1] - x[o3], ay = x[o1 + 1] - x[o3 + 1], az = x[o1 + 2] - x[o3 + 2];
  const bx = x[o1] - x[o4], by = x[o1 + 1] - x[o4 + 1], bz = x[o1 + 2] - x[o4 + 2];
  const cx = x[o2] - x[o4], cy = x[o2 + 1] - x[o4 + 1], cz = x[o2 + 2] - x[o4 + 2];
  const dx = x[o2] - x[o3], dy = x[o2 + 1] - x[o3 + 1], dz = x[o2 + 2] - x[o3 + 2];
  const n1x = ay * bz - az * by, n1y = az * bx - ax * bz, n1z = ax * by - ay * bx;
  const n2x = cy * dz - cz * dy, n2y = cz * dx - cx * dz, n2z = cx * dy - cy * dx;
  const l1 = n1x * n1x + n1y * n1y + n1z * n1z, l2 = n2x * n2x + n2y * n2y + n2z * n2z;
  if (l1 < 1e-18 || l2 < 1e-18) return null;
  const s1 = Math.sqrt(l1), s2 = Math.sqrt(l2);
  const cos = (n1x * n2x + n1y * n2y + n1z * n2z) / (s1 * s2);
  const crx = n1y * n2z - n1z * n2y, cry = n1z * n2x - n1x * n2z, crz = n1x * n2y - n1y * n2x;
  const sin = (crx * ex + cry * ey + crz * ez) / (s1 * s2 * el);
  hg.theta = -Math.atan2(sin, cos);
  const u = hg.u;
  const k1 = el / l1, k2 = el / l2;
  u[0] = n1x * k1; u[1] = n1y * k1; u[2] = n1z * k1;
  u[3] = n2x * k2; u[4] = n2y * k2; u[5] = n2z * k2;
  const a3 = (bx * ex + by * ey + bz * ez) / el / l1, b3 = (cx * ex + cy * ey + cz * ez) / el / l2;
  const a4 = (ax * ex + ay * ey + az * ez) / el / l1, b4 = (dx * ex + dy * ey + dz * ez) / el / l2;
  u[6] = n1x * a3 + n2x * b3; u[7] = n1y * a3 + n2y * b3; u[8] = n1z * a3 + n2z * b3;
  u[9] = -(n1x * a4 + n2x * b4); u[10] = -(n1y * a4 + n2y * b4); u[11] = -(n1z * a4 + n2z * b4);
  return hg;
}

/** One XPBD pass over the bending hinges. */
function solveBending(x: Float32Array, invMass: Float32Array, idx: Uint32Array, rest: Float32Array, K: Float32Array, h2: number) {
  for (let i = 0, hIdx = 0; i < idx.length; i += 4, hIdx++) {
    const p1 = idx[i], p2 = idx[i + 1], p3 = idx[i + 2], p4 = idx[i + 3];
    const g = hingeGeometry(x, p1, p2, p3, p4);
    if (!g) continue;
    let C = g.theta - rest[hIdx];
    if (C > Math.PI) C -= 2 * Math.PI;
    else if (C < -Math.PI) C += 2 * Math.PI;
    const u = g.u;
    const w1 = invMass[p1], w2 = invMass[p2], w3 = invMass[p3], w4 = invMass[p4];
    const sum =
      w1 * (u[0] * u[0] + u[1] * u[1] + u[2] * u[2]) +
      w2 * (u[3] * u[3] + u[4] * u[4] + u[5] * u[5]) +
      w3 * (u[6] * u[6] + u[7] * u[7] + u[8] * u[8]) +
      w4 * (u[9] * u[9] + u[10] * u[10] + u[11] * u[11]);
    if (sum < 1e-12) continue;
    const dl = -C / (sum + 1 / (K[hIdx] * h2));
    let o = p1 * 3, w = w1 * dl;
    x[o] += u[0] * w; x[o + 1] += u[1] * w; x[o + 2] += u[2] * w;
    o = p2 * 3; w = w2 * dl;
    x[o] += u[3] * w; x[o + 1] += u[4] * w; x[o + 2] += u[5] * w;
    o = p3 * 3; w = w3 * dl;
    x[o] += u[6] * w; x[o + 1] += u[7] * w; x[o + 2] += u[8] * w;
    o = p4 * 3; w = w4 * dl;
    x[o] += u[9] * w; x[o + 1] += u[10] * w; x[o + 2] += u[11] * w;
  }
}

/** Per-particle fabric properties, area-weighted from the triangles around it. */
interface Fabric {
  density: Float32Array;
  damping: Float32Array;
  grip: Float32Array;
  stretch: Float32Array;
  bend: Float32Array;
}

/**
 * Builds the simulation. The garments are simulated on a lighter cage (the
 * cloth simplified to about `particleBudget` points, seams kept), and every
 * vertex of the mesh follows the cage's displacement from the skinned pose.
 */
export async function createClothSim(setup: ClothSetup): Promise<ClothSim> {
  await MeshoptSimplifier.ready;
  const P = setup.positions;
  const I = setup.index;
  const V = P.length / 3;
  const T = I.length / 3;
  const mats = setup.materials;
  const isCloth = (t: number) => setup.triangleMaterial[t] >= 0 && !!mats[setup.triangleMaterial[t]];

  // 1. Weld render vertices that share a position (UV seams), so each garment is one sheet.
  const keyOf = (v: number) => `${Math.round(P[v * 3] * 1e5)},${Math.round(P[v * 3 + 1] * 1e5)},${Math.round(P[v * 3 + 2] * 1e5)}`;
  const byKey = new Map<string, number>();
  const particleOf = new Int32Array(V).fill(-1);
  const vertexList: number[] = [];
  const clothTris: number[] = [];
  for (let t = 0; t < T; t++) {
    if (!isCloth(t)) continue;
    clothTris.push(t);
    for (let k = 0; k < 3; k++) {
      const v = I[t * 3 + k];
      if (particleOf[v] >= 0) continue;
      const key = keyOf(v);
      let p = byKey.get(key);
      if (p === undefined) {
        p = vertexList.length;
        byKey.set(key, p);
        vertexList.push(v);
      }
      particleOf[v] = p;
    }
  }
  const clothCount = vertexList.length;
  // Where cloth meets anything else, it is sewn to it. The ring of non-cloth
  // triangles along that seam joins the sheet, pinned, so the fabric can't
  // fold freely at the seam (a sleeve doesn't hinge at the cuff).
  const pinnedSet = new Set<number>();
  const ringTris: number[] = [];
  for (let t = 0; t < T; t++) {
    if (isCloth(t)) continue;
    let touches = false;
    for (let k = 0; k < 3; k++) {
      const v = I[t * 3 + k];
      const p = particleOf[v] >= 0 ? particleOf[v] : byKey.get(keyOf(v));
      if (p !== undefined && p < clothCount) {
        pinnedSet.add(p);
        touches = true;
      }
    }
    if (touches) ringTris.push(t);
  }
  const ringParticle = (v: number) => {
    if (particleOf[v] >= 0) return particleOf[v];
    const key = keyOf(v);
    let p = byKey.get(key);
    if (p === undefined) {
      p = vertexList.length;
      byKey.set(key, p);
      vertexList.push(v);
      pinnedSet.add(p);
    }
    return p;
  };
  const ringFine = ringTris.flatMap((t) => [ringParticle(I[t * 3]), ringParticle(I[t * 3 + 1]), ringParticle(I[t * 3 + 2])]);
  const count = vertexList.length;
  const pinned = new Uint8Array(count);
  for (const p of pinnedSet) pinned[p] = 1;
  const rest = new Float32Array(count * 3);
  for (let p = 0; p < count; p++) for (let k = 0; k < 3; k++) rest[p * 3 + k] = P[vertexList[p] * 3 + k];
  const fineTris = new Uint32Array(clothTris.length * 3);
  clothTris.forEach((t, i) => {
    for (let k = 0; k < 3; k++) fineTris[i * 3 + k] = particleOf[I[t * 3 + k]];
  });
  const lift = liftOutOfBody(rest, fineTris, clothCount, pinned, setup.body);
  for (let i = 0; i < clothCount * 3; i++) rest[i] += lift[i];

  // Fabric per particle.
  const fineArea = new Float32Array(count);
  const fab: Fabric = { density: new Float32Array(count), damping: new Float32Array(count), grip: new Float32Array(count), stretch: new Float32Array(count), bend: new Float32Array(count) };
  clothTris.forEach((t, i) => {
    const A = triArea(rest, fineTris[i * 3], fineTris[i * 3 + 1], fineTris[i * 3 + 2]) / 3;
    const m = mats[setup.triangleMaterial[t]];
    for (let k = 0; k < 3; k++) {
      const p = fineTris[i * 3 + k];
      fineArea[p] += A;
      fab.density[p] += m.density * A;
      fab.damping[p] += m.damping * A;
      fab.grip[p] += m.grip * A;
      fab.stretch[p] += m.stretch * A;
      fab.bend[p] += m.bend * A;
    }
  });
  let totalArea = 0;
  for (let p = 0; p < count; p++) {
    totalArea += fineArea[p];
    const A = fineArea[p] || 1;
    for (const f of Object.values(fab)) f[p] /= A;
  }

  // 2. The cage: the cloth simplified, seams and open edges kept.
  const budget = setup.particleBudget ?? 1500;
  let cageTris: Uint32Array = fineTris;
  if (clothCount > budget && fineTris.length) {
    const lock = new Uint8Array(clothCount);
    for (let p = 0; p < clothCount; p++) lock[p] = pinned[p];
    const target = Math.max(3, Math.floor((budget * 2 * 3) / 3) * 3);
    [cageTris] = MeshoptSimplifier.simplifyWithAttributes(fineTris, rest.subarray(0, clothCount * 3), 3, new Float32Array(clothCount), 1, [0], lock, target, 1, ['LockBorder', 'Regularize']);
  }
  const cageOf = new Int32Array(count).fill(-1);
  const fineOf: number[] = [];
  const toCage = (p: number) => {
    if (cageOf[p] < 0) {
      cageOf[p] = fineOf.length;
      fineOf.push(p);
    }
    return cageOf[p];
  };
  const tris = Uint32Array.from(cageTris, toCage);
  const ringIdx = Uint32Array.from(ringFine, toCage);
  const n = fineOf.length;
  const solver = createSolver(setup, {
    rest: Float32Array.from({ length: n * 3 }, (_, i) => rest[fineOf[Math.floor(i / 3)] * 3 + (i % 3)]),
    tris,
    ringTris: ringIdx,
    pinned: Uint8Array.from(fineOf, (p) => pinned[p]),
    fabric: {
      density: Float32Array.from(fineOf, (p) => fab.density[p]),
      damping: Float32Array.from(fineOf, (p) => fab.damping[p]),
      grip: Float32Array.from(fineOf, (p) => fab.grip[p]),
      stretch: Float32Array.from(fineOf, (p) => fab.stretch[p]),
      bend: Float32Array.from(fineOf, (p) => fab.bend[p]),
    },
  });

  // 3. Every other cloth particle rides on the nearest cage triangle: its
  // barycentric point plus its offset from it, in the triangle's own frame.
  const embedTri = new Int32Array(count).fill(-1);
  const embedW = new Float32Array(count * 3);
  const embedOffset = new Float32Array(count * 3);
  /** The rest normal in that frame, so shading stays smooth across the cage's edges. */
  const embedNormal = new Float32Array(count * 3);
  {
    const cageRest = solver.rest;
    const restNormals = vertexNormals(cageRest, tris);
    const grid = new PointGrid(cageRest, 0.03);
    const incident: number[][] = Array.from({ length: n }, () => []);
    for (let t = 0; t < tris.length / 3; t++) for (let k = 0; k < 3; k++) incident[tris[t * 3 + k]].push(t);
    const bary = new Float64Array(4);
    const fineNormals = vertexNormals(rest, fineTris);
    for (let p = 0; p < clothCount; p++) {
      if (pinned[p]) continue;
      const x = rest[p * 3], y = rest[p * 3 + 1], z = rest[p * 3 + 2];
      const c = cageOf[p] >= 0 ? cageOf[p] : grid.nearest(x, y, z, 8);
      if (c < 0) continue;
      const candidates = new Set<number>();
      for (const t of incident[c]) for (let k = 0; k < 3; k++) for (const u of incident[tris[t * 3 + k]]) candidates.add(u);
      let best = -1, bestD = Infinity;
      for (const t of candidates) {
        closestOnTriangle(cageRest, tris[t * 3], tris[t * 3 + 1], tris[t * 3 + 2], x, y, z, bary);
        if (bary[3] < bestD) {
          bestD = bary[3];
          best = t;
          embedW[p * 3] = bary[0];
          embedW[p * 3 + 1] = bary[1];
          embedW[p * 3 + 2] = bary[2];
        }
      }
      embedTri[p] = best;
      if (best < 0) continue;
      const f = curvedPoint(cageRest, restNormals, tris, best, embedW, p);
      const ox = x - f[9], oy = y - f[10], oz = z - f[11];
      embedOffset[p * 3] = ox * f[0] + oy * f[1] + oz * f[2];
      const nx = fineNormals[p * 3], ny = fineNormals[p * 3 + 1], nz = fineNormals[p * 3 + 2];
      embedNormal[p * 3] = nx * f[0] + ny * f[1] + nz * f[2];
      embedNormal[p * 3 + 1] = nx * f[3] + ny * f[4] + nz * f[5];
      embedNormal[p * 3 + 2] = nx * f[6] + ny * f[7] + nz * f[8];
      embedOffset[p * 3 + 1] = ox * f[3] + oy * f[4] + oz * f[5];
      embedOffset[p * 3 + 2] = ox * f[6] + oy * f[7] + oz * f[8];
    }
  }

  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  const cageTargets = new Float32Array(n * 3);
  let started = false;
  const lastTargets = new Float32Array(count * 3);

  /** Cage targets from the frame, then the solver, then every particle from the cage. */
  const gather = (frame: ClothFrame) => {
    for (let c = 0; c < n; c++) {
      const p = fineOf[c] * 3;
      cageTargets[c * 3] = frame.targets[p];
      cageTargets[c * 3 + 1] = frame.targets[p + 1];
      cageTargets[c * 3 + 2] = frame.targets[p + 2];
    }
  };
  const scatter = (frame: ClothFrame) => {
    const X = solver.x;
    positions.set(frame.targets);
    for (let p = 0; p < clothCount; p++) {
      const t = embedTri[p];
      if (t < 0) continue;
      const f = curvedPoint(X, solver.normals, tris, t, embedW, p);
      const a = embedOffset[p * 3], b = embedOffset[p * 3 + 1], c = embedOffset[p * 3 + 2];
      positions[p * 3] = f[9] + f[0] * a + f[3] * b + f[6] * c;
      positions[p * 3 + 1] = f[10] + f[1] * a + f[4] * b + f[7] * c;
      positions[p * 3 + 2] = f[11] + f[2] * a + f[5] * b + f[8] * c;
      const u = embedNormal[p * 3], v = embedNormal[p * 3 + 1], w = embedNormal[p * 3 + 2];
      const nx = f[0] * u + f[3] * v + f[6] * w, ny = f[1] * u + f[4] * v + f[7] * w, nz = f[2] * u + f[5] * v + f[8] * w;
      const l = Math.hypot(nx, ny, nz) || 1;
      normals[p * 3] = nx / l;
      normals[p * 3 + 1] = ny / l;
      normals[p * 3 + 2] = nz / l;
    }
  };

  const sim: ClothSim = {
    count,
    particleOf,
    vertexOf: Uint32Array.from(vertexList),
    pinned,
    cageCount: n,
    lift,
    bodyVertices: solver.bodyVertices,
    positions,
    normals,
    stats: { substeps: 0, maxOffset: 0, resets: 0 },
    reset(frame, settle = 0.6) {
      gather(frame);
      solver.reset(cageTargets, frame, settle);
      lastTargets.set(frame.targets);
      scatter(frame);
      started = true;
      sim.stats.resets++;
    },
    restart() {
      started = false;
    },
    step(dt, frame) {
      let jump = 0;
      if (started) {
        const T1 = frame.targets;
        for (let i = 0; i < count * 3; i += 3) {
          const d = Math.abs(T1[i] - lastTargets[i]) + Math.abs(T1[i + 1] - lastTargets[i + 1]) + Math.abs(T1[i + 2] - lastTargets[i + 2]);
          if (d > jump) jump = d;
        }
      }
      if (!started || jump > TELEPORT || !(dt > 0)) {
        sim.reset(frame);
        return false;
      }
      gather(frame);
      sim.stats.substeps = solver.step(dt, cageTargets, frame);
      lastTargets.set(frame.targets);
      scatter(frame);
      let maxOffset = 0;
      for (let p = 0; p < count; p++) {
        const o = p * 3;
        maxOffset = Math.max(maxOffset, Math.hypot(positions[o] - frame.targets[o], positions[o + 1] - frame.targets[o + 1], positions[o + 2] - frame.targets[o + 2]));
      }
      sim.stats.maxOffset = maxOffset;
      return true;
    },
  };
  return sim;
}

const frame12 = new Float64Array(12);
/**
 * A point on the cage, curved between its vertices by their normals (Phong
 * tessellation) so the full-resolution cloth doesn't show the cage's facets,
 * and the frame there: tangent, bitangent, normal (3 each), then the point.
 */
function curvedPoint(x: ArrayLike<number>, nrm: ArrayLike<number>, tris: Uint32Array, t: number, weights: Float32Array, p: number): Float64Array {
  const f = frame12;
  const a = tris[t * 3] * 3, b = tris[t * 3 + 1] * 3, c = tris[t * 3 + 2] * 3;
  const wa = weights[p * 3], wb = weights[p * 3 + 1], wc = weights[p * 3 + 2];
  const fx = x[a] * wa + x[b] * wb + x[c] * wc, fy = x[a + 1] * wa + x[b + 1] * wb + x[c + 1] * wc, fz = x[a + 2] * wa + x[b + 2] * wb + x[c + 2] * wc;
  let px = 0, py = 0, pz = 0, nx = 0, ny = 0, nz = 0;
  for (const [o, w] of [[a, wa], [b, wb], [c, wc]] as const) {
    const ux = nrm[o], uy = nrm[o + 1], uz = nrm[o + 2];
    const d = (fx - x[o]) * ux + (fy - x[o + 1]) * uy + (fz - x[o + 2]) * uz;
    px += (fx - d * ux) * w;
    py += (fy - d * uy) * w;
    pz += (fz - d * uz) * w;
    nx += ux * w;
    ny += uy * w;
    nz += uz * w;
  }
  const ln = Math.hypot(nx, ny, nz) || 1;
  nx /= ln;
  ny /= ln;
  nz /= ln;
  // Tangent: the first edge, made perpendicular to the normal.
  let tx = x[b] - x[a], ty = x[b + 1] - x[a + 1], tz = x[b + 2] - x[a + 2];
  const dn = tx * nx + ty * ny + tz * nz;
  tx -= nx * dn;
  ty -= ny * dn;
  tz -= nz * dn;
  const lt = Math.hypot(tx, ty, tz) || 1;
  tx /= lt;
  ty /= lt;
  tz /= lt;
  f[0] = tx; f[1] = ty; f[2] = tz;
  f[3] = ny * tz - nz * ty; f[4] = nz * tx - nx * tz; f[5] = nx * ty - ny * tx;
  f[6] = nx; f[7] = ny; f[8] = nz;
  const k = 0.75;
  f[9] = fx + (px - fx) * k;
  f[10] = fy + (py - fy) * k;
  f[11] = fz + (pz - fz) * k;
  return f;
}

/** Area-weighted vertex normals. */
function vertexNormals(x: ArrayLike<number>, tris: Uint32Array): Float32Array {
  const out = new Float32Array(x.length);
  for (let i = 0; i < tris.length; i += 3) {
    const a = tris[i] * 3, b = tris[i + 1] * 3, c = tris[i + 2] * 3;
    const ux = x[b] - x[a], uy = x[b + 1] - x[a + 1], uz = x[b + 2] - x[a + 2];
    const vx = x[c] - x[a], vy = x[c + 1] - x[a + 1], vz = x[c + 2] - x[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const o of [a, b, c]) {
      out[o] += nx;
      out[o + 1] += ny;
      out[o + 2] += nz;
    }
  }
  for (let o = 0; o < out.length; o += 3) {
    const l = Math.hypot(out[o], out[o + 1], out[o + 2]) || 1;
    out[o] /= l;
    out[o + 1] /= l;
    out[o + 2] /= l;
  }
  return out;
}

/** Closest point on triangle abc to p: barycentric weights in out[0..2], squared distance in out[3]. */
function closestOnTriangle(x: ArrayLike<number>, a: number, b: number, c: number, px: number, py: number, pz: number, out: Float64Array): void {
  const ax = x[a * 3], ay = x[a * 3 + 1], az = x[a * 3 + 2];
  const abx = x[b * 3] - ax, aby = x[b * 3 + 1] - ay, abz = x[b * 3 + 2] - az;
  const acx = x[c * 3] - ax, acy = x[c * 3 + 1] - ay, acz = x[c * 3 + 2] - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d00 = abx * abx + aby * aby + abz * abz, d01 = abx * acx + aby * acy + abz * acz, d11 = acx * acx + acy * acy + acz * acz;
  const d20 = apx * abx + apy * aby + apz * abz, d21 = apx * acx + apy * acy + apz * acz;
  const den = d00 * d11 - d01 * d01 || 1e-18;
  let v = (d11 * d20 - d01 * d21) / den, w = (d00 * d21 - d01 * d20) / den;
  // Clamp into the triangle (good enough for picking the nearest one).
  v = Math.max(0, v);
  w = Math.max(0, w);
  const s = v + w;
  if (s > 1) {
    v /= s;
    w /= s;
  }
  const u = 1 - v - w;
  const qx = ax + abx * v + acx * w - px, qy = ay + aby * v + acy * w - py, qz = az + abz * v + acz * w - pz;
  out[0] = u;
  out[1] = v;
  out[2] = w;
  out[3] = qx * qx + qy * qy + qz * qz;
}

interface CageInput {
  rest: Float32Array;
  tris: Uint32Array;
  ringTris: Uint32Array;
  pinned: Uint8Array;
  fabric: Fabric;
}

/** The position-based solver on the cage. */
function createSolver(setup: ClothSetup, cage: CageInput) {
  const { rest, tris, ringTris, pinned, fabric } = cage;
  const n = rest.length / 3;

  const area = new Float32Array(n);
  for (let i = 0; i < tris.length; i += 3) {
    const A = triArea(rest, tris[i], tris[i + 1], tris[i + 2]) / 3;
    area[tris[i]] += A;
    area[tris[i + 1]] += A;
    area[tris[i + 2]] += A;
  }
  const mass = new Float32Array(n);
  const invMass = new Float32Array(n);
  for (let p = 0; p < n; p++) {
    if (!area[p]) area[p] = 1e-9;
    mass[p] = Math.max(1e-7, fabric.density[p] * area[p]);
    invMass[p] = pinned[p] ? 0 : 1 / mass[p];
  }
  const dist = (a: number, b: number) => Math.hypot(rest[a * 3] - rest[b * 3], rest[a * 3 + 1] - rest[b * 3 + 1], rest[a * 3 + 2] - rest[b * 3 + 2]);

  // Edges (stretch) and the hinge across each interior edge (bending).
  const edgeMap = new Map<number, number>();
  const edgeA: number[] = [], edgeB: number[] = [], edgeOpp: number[][] = [], edgeCloth: boolean[] = [];
  const addEdges = (tri: Uint32Array, cloth: boolean) => {
    for (let i = 0; i < tri.length; i += 3)
      for (let k = 0; k < 3; k++) {
        const a = tri[i + k], b = tri[i + ((k + 1) % 3)], c = tri[i + ((k + 2) % 3)];
        if (a === b) continue;
        const lo = Math.min(a, b), hi = Math.max(a, b);
        const key = lo * n + hi;
        let e = edgeMap.get(key);
        if (e === undefined) {
          e = edgeA.length;
          edgeMap.set(key, e);
          edgeA.push(lo);
          edgeB.push(hi);
          edgeOpp.push([]);
          edgeCloth.push(false);
        }
        edgeOpp[e].push(c);
        if (cloth) edgeCloth[e] = true;
      }
  };
  addEdges(tris, true);
  addEdges(ringTris, false);
  const avg = (f: Float32Array, ...ps: number[]) => {
    let s = 0, c = 0;
    for (const p of ps) if (!pinned[p] || f === fabric.bend) (s += f[p]), c++;
    return c ? s / c : f[ps[0]];
  };
  const sA: number[] = [], sB: number[] = [], sRest: number[] = [], sK: number[] = [];
  const hinges: number[] = [], hRest: number[] = [], hK: number[] = [];
  for (let e = 0; e < edgeA.length; e++) {
    if (!edgeCloth[e]) continue;
    const a = edgeA[e], b = edgeB[e];
    if (!(pinned[a] && pinned[b])) {
      sA.push(a);
      sB.push(b);
      sRest.push(dist(a, b));
      // Stiffness per particle area, so the fabric behaves the same at any mesh resolution.
      sK.push(avg(fabric.stretch, a, b) * (area[a] + area[b]) * 0.5);
    }
    if (edgeOpp[e].length === 2) {
      const [c, d] = edgeOpp[e];
      if (c === d || (pinned[c] && pinned[d] && pinned[a] && pinned[b])) continue;
      const A1 = triArea(rest, a, b, c), A2 = triArea(rest, a, b, d);
      if (A1 < 1e-12 || A2 < 1e-12) continue;
      hinges.push(c, d, a, b);
      hRest.push(dihedral(rest, c, d, a, b));
      // Discrete-shell bending: stiffness grows with the hinge length over the area it spans.
      const E = dist(a, b);
      const bend = fabric.bend[a] && fabric.bend[b] ? (fabric.bend[a] + fabric.bend[b]) / 2 : Math.max(fabric.bend[a], fabric.bend[b], fabric.bend[c], fabric.bend[d]);
      hK.push((6 * bend * E * E) / (A1 + A2));
    }
  }
  const stretchA = Uint32Array.from(sA), stretchB = Uint32Array.from(sB), stretchRest = Float32Array.from(sRest), stretchK = Float32Array.from(sK);
  const hingeIdx = Uint32Array.from(hinges), hingeRest = Float32Array.from(hRest), hingeK = Float32Array.from(hK);

  // Gap to the body: how tightly each particle fits.
  const gap = new Float32Array(n).fill(0.05);
  const backstop = new Int32Array(n).fill(-1);
  /** How far a particle may sink below its skinned position, along the body normal. */
  const inset = new Float32Array(n);
  /** How close it may come to the body vertex it rests on (its distance at rest, at most MARGIN). */
  const clearance = new Float32Array(n);
  const bodyList: number[] = [];
  if (setup.body && setup.body.positions.length) {
    const BP = setup.body.positions;
    const grid = new PointGrid(BP, 0.02);
    const used = new Map<number, number>();
    for (let p = 0; p < n; p++) {
      const x = rest[p * 3], y = rest[p * 3 + 1], z = rest[p * 3 + 2];
      const b = grid.nearest(x, y, z, 15);
      if (b < 0) continue;
      const d = Math.hypot(x - BP[b * 3], y - BP[b * 3 + 1], z - BP[b * 3 + 2]);
      gap[p] = d;
      // Close to the body, its normal says which way is in.
      if (d < BACKSTOP_RANGE && !pinned[p]) {
        let s = used.get(b);
        if (s === undefined) {
          s = bodyList.length;
          used.set(b, s);
          bodyList.push(b);
        }
        backstop[p] = s;
        inset[p] = Math.min(0.004, 0.3 * d);
        const BN = setup.body.normals;
        clearance[p] = Math.min(MARGIN, (x - BP[b * 3]) * BN[b * 3] + (y - BP[b * 3 + 1]) * BN[b * 3 + 1] + (z - BP[b * 3 + 2]) * BN[b * 3 + 2]);
      }
    }
  }
  const maxDist = new Float32Array(n);
  const gripK = new Float32Array(n);
  for (let p = 0; p < n; p++) {
    maxDist[p] = pinned[p] ? 0 : Math.min(0.35, 0.006 + 1.5 * gap[p]) * (setup.freedom ?? 1);
    // Grip is the body holding the cloth: none without a body.
    gripK[p] = setup.body ? fabric.grip[p] * Math.exp(-Math.max(0, gap[p] - MARGIN) / GRIP_FALLOFF) : 0;
  }

  // Long-range attachments: cloth can't end up further from where it's held
  // (sewn on, or gripping the body) than it is along the fabric, so a hanging
  // skirt doesn't stretch however many links it has.
  const anchorOf = new Int32Array(n).fill(-1);
  const anchorDist = new Float32Array(n).fill(Infinity);
  {
    const adj: number[][] = Array.from({ length: n }, () => []);
    for (let e = 0; e < edgeA.length; e++) {
      adj[edgeA[e]].push(edgeB[e]);
      adj[edgeB[e]].push(edgeA[e]);
    }
    const heap = new MinHeap();
    for (let p = 0; p < n; p++) {
      if (pinned[p] || gripK[p] >= fabric.grip[p] * 0.5) {
        anchorOf[p] = p;
        anchorDist[p] = 0;
        heap.push(0, p);
      }
    }
    while (heap.size) {
      const [d, p] = heap.pop();
      if (d > anchorDist[p]) continue;
      for (const q of adj[p]) {
        const nd = d + dist(p, q);
        if (nd < anchorDist[q]) {
          anchorDist[q] = nd;
          anchorOf[q] = anchorOf[p];
          heap.push(nd, q);
        }
      }
    }
  }

  // Capsules that a particle sits inside at rest shrink for it to where it is,
  // so they never push cloth off its fitted shape.
  const caps = setup.capsules ?? [];
  const capScale = new Float32Array(n * caps.length).fill(1);
  for (let p = 0; p < n; p++)
    caps.forEach((c, i) => {
      const depth = capsuleDepth(rest[p * 3], rest[p * 3 + 1], rest[p * 3 + 2], c.a, c.b, c.ra, c.rb);
      if (depth < CAPSULE_MARGIN) {
        const r = Math.max(c.ra, c.rb);
        capScale[p * caps.length + i] = Math.max(0, (r + depth) / (r + CAPSULE_MARGIN));
      }
    });

  const x = new Float32Array(n * 3);
  const prev = new Float32Array(n * 3);
  const vel = new Float32Array(n * 3);
  const targets = new Float32Array(n * 3);
  const lastTargets = new Float32Array(n * 3);
  const lastCaps = new Float32Array(caps.length * 8);
  const normals = new Float32Array(n * 3);
  const tgt = new Float32Array(n * 3);
  const tgtPrev = new Float32Array(n * 3);
  const bodyN = new Float32Array(bodyList.length * 3);
  const bodyP = new Float32Array(bodyList.length * 3);
  const lastBodyP = new Float32Array(bodyList.length * 3);
  let hasBodyP = false;
  const capNow = new Float32Array(caps.length * 8);

  const computeNormals = () => {
    normals.fill(0);
    for (let i = 0; i < tris.length; i += 3) {
      const a = tris[i] * 3, b = tris[i + 1] * 3, c = tris[i + 2] * 3;
      const ux = x[b] - x[a], uy = x[b + 1] - x[a + 1], uz = x[b + 2] - x[a + 2];
      const vx = x[c] - x[a], vy = x[c + 1] - x[a + 1], vz = x[c + 2] - x[a + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      normals[a] += nx; normals[a + 1] += ny; normals[a + 2] += nz;
      normals[b] += nx; normals[b + 1] += ny; normals[b + 2] += nz;
      normals[c] += nx; normals[c + 1] += ny; normals[c + 2] += nz;
    }
    for (let p = 0; p < n * 3; p += 3) {
      const l = Math.hypot(normals[p], normals[p + 1], normals[p + 2]) || 1;
      normals[p] /= l;
      normals[p + 1] /= l;
      normals[p + 2] /= l;
    }
  };

  const solveDistance = (A: Uint32Array, B: Uint32Array, R: Float32Array, K: Float32Array, h2: number) => {
    for (let e = 0; e < A.length; e++) {
      const a = A[e], b = B[e];
      const wa = invMass[a], wb = invMass[b];
      const w = wa + wb;
      if (w === 0) continue;
      const oa = a * 3, ob = b * 3;
      const dx = x[ob] - x[oa], dy = x[ob + 1] - x[oa + 1], dz = x[ob + 2] - x[oa + 2];
      const l = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (l < 1e-9) continue;
      let C = l - R[e];
      // Cloth buckles rather than compressing: resist shortening less.
      if (C < 0) C *= 0.3;
      const s = C / (w + 1 / (K[e] * h2)) / l;
      x[oa] += dx * s * wa;
      x[oa + 1] += dy * s * wa;
      x[oa + 2] += dz * s * wa;
      x[ob] -= dx * s * wb;
      x[ob + 1] -= dy * s * wb;
      x[ob + 2] -= dz * s * wb;
    }
  };

  /** One substep, from fraction f0 to f1 of the way between the last frame and this one. */
  const substep = (h: number, T1: Float32Array, caps1: Float32Array | undefined, f0: number, f1: number) => {
    for (let i = 0; i < n * 3; i++) {
      tgtPrev[i] = lastTargets[i] + (T1[i] - lastTargets[i]) * f0;
      tgt[i] = lastTargets[i] + (T1[i] - lastTargets[i]) * f1;
    }
    if (caps1) for (let i = 0; i < capNow.length; i++) capNow[i] = lastCaps[i] + (caps1[i] - lastCaps[i]) * f1;
    const h2 = h * h;
    const { density, damping } = fabric;

    // Predict: gravity, air drag (across the cloth, so light fabric floats), damping relative to the body.
    for (let p = 0; p < n; p++) {
      const o = p * 3;
      if (pinned[p]) {
        prev[o] = x[o] = tgt[o];
        prev[o + 1] = x[o + 1] = tgt[o + 1];
        prev[o + 2] = x[o + 2] = tgt[o + 2];
        continue;
      }
      let vx = vel[o], vy = vel[o + 1] + GRAVITY * h, vz = vel[o + 2];
      const nx = normals[o], ny = normals[o + 1], nz = normals[o + 2];
      const vn = vx * nx + vy * ny + vz * nz;
      const drag = Math.min(0.9, (0.5 * AIR_DENSITY * Math.abs(vn) * h) / density[p]);
      vx -= nx * vn * drag;
      vy -= ny * vn * drag;
      vz -= nz * vn * drag;
      const bx = (tgt[o] - tgtPrev[o]) / h, by = (tgt[o + 1] - tgtPrev[o + 1]) / h, bz = (tgt[o + 2] - tgtPrev[o + 2]) / h;
      const keep = Math.exp(-damping[p] * h);
      vx = bx + (vx - bx) * keep;
      vy = by + (vy - by) * keep;
      vz = bz + (vz - bz) * keep;
      prev[o] = x[o];
      prev[o + 1] = x[o + 1];
      prev[o + 2] = x[o + 2];
      x[o] += vx * h;
      x[o + 1] += vy * h;
      x[o + 2] += vz * h;
    }

    // Grip: a soft pull towards the skinned position (compliance 1 / (grip · area)), so weight shows as sag and lag.
    for (let p = 0; p < n; p++) {
      if (pinned[p] || gripK[p] <= 0) continue;
      const o = p * 3;
      const k = gripK[p] * area[p] * h2;
      const f = k / (mass[p] + k);
      x[o] += (tgt[o] - x[o]) * f;
      x[o + 1] += (tgt[o + 1] - x[o + 1]) * f;
      x[o + 2] += (tgt[o + 2] - x[o + 2]) * f;
    }

    solveDistance(stretchA, stretchB, stretchRest, stretchK, h2);
    solveBending(x, invMass, hingeIdx, hingeRest, hingeK, h2);
    solveDistance(stretchA, stretchB, stretchRest, stretchK, h2);

    // Long-range attachments.
    for (let p = 0; p < n; p++) {
      const a = anchorOf[p];
      if (a < 0 || a === p || pinned[p]) continue;
      const o = p * 3, q = a * 3;
      const dx = x[o] - tgt[q], dy = x[o + 1] - tgt[q + 1], dz = x[o + 2] - tgt[q + 2];
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const limit = anchorDist[p] * 1.03;
      if (d > limit) {
        const s = limit / d;
        x[o] = tgt[q] + dx * s;
        x[o + 1] = tgt[q + 1] + dy * s;
        x[o + 2] = tgt[q + 2] + dz * s;
      }
    }

    // Collisions and limits, last so they win.
    const capCount = caps1 ? caps.length : 0;
    for (let p = 0; p < n; p++) {
      if (pinned[p]) continue;
      const o = p * 3;
      // Capsules around the limbs and torso.
      for (let c = 0; c < capCount; c++) {
        const q = c * 8;
        const ax = capNow[q], ay = capNow[q + 1], az = capNow[q + 2];
        const abx = capNow[q + 3] - ax, aby = capNow[q + 4] - ay, abz = capNow[q + 5] - az;
        const l2 = abx * abx + aby * aby + abz * abz || 1;
        const t = Math.min(1, Math.max(0, ((x[o] - ax) * abx + (x[o + 1] - ay) * aby + (x[o + 2] - az) * abz) / l2));
        const dx = x[o] - ax - abx * t, dy = x[o + 1] - ay - aby * t, dz = x[o + 2] - az - abz * t;
        const d2 = dx * dx + dy * dy + dz * dz;
        const full = capNow[q + 6] + (capNow[q + 7] - capNow[q + 6]) * t + CAPSULE_MARGIN;
        if (d2 >= full * full) continue;
        // Cloth that sat inside this capsule at rest (a fitted waistband over the
        // hip joint) may go as deep as it sat, or as deep as skinning puts it.
        let r = full;
        const scale = capScale[p * caps.length + c];
        if (scale < 1) {
          const tt = Math.min(1, Math.max(0, ((tgt[o] - ax) * abx + (tgt[o + 1] - ay) * aby + (tgt[o + 2] - az) * abz) / l2));
          const td = Math.hypot(tgt[o] - ax - abx * tt, tgt[o + 1] - ay - aby * tt, tgt[o + 2] - az - abz * tt);
          r = Math.max(Math.min(td, full), full * scale);
        }
        const d = Math.sqrt(d2);
        if (d < r && d > 1e-6) {
          const s = r / d;
          x[o] = ax + abx * t + dx * s;
          x[o + 1] = ay + aby * t + dy * s;
          x[o + 2] = az + abz * t + dz * s;
        }
      }
      // Backstop: no deeper than `inset` below the skinned position, along the body's normal.
      const b = backstop[p];
      if (b >= 0) {
        const q = b * 3;
        const nx = bodyN[q], ny = bodyN[q + 1], nz = bodyN[q + 2];
        const d = (x[o] - tgt[o]) * nx + (x[o + 1] - tgt[o + 1]) * ny + (x[o + 2] - tgt[o + 2]) * nz;
        if (d < -inset[p]) {
          const push = -inset[p] - d;
          x[o] += nx * push;
          x[o + 1] += ny * push;
          x[o + 2] += nz * push;
        }
      }
      // Never further than its maximum distance from the skinned position.
      const dx = x[o] - tgt[o], dy = x[o + 1] - tgt[o + 1], dz = x[o + 2] - tgt[o + 2];
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d > maxDist[p]) {
        const s = maxDist[p] / d;
        x[o] = tgt[o] + dx * s;
        x[o + 1] = tgt[o + 1] + dy * s;
        x[o + 2] = tgt[o + 2] + dz * s;
      }
      // And never inside the body itself: outside the plane of the body vertex it rests on.
      if (b >= 0 && hasBodyP) {
        const q = b * 3;
        const nx = bodyN[q], ny = bodyN[q + 1], nz = bodyN[q + 2];
        const px = lastBodyP[q] + (bodyP[q] - lastBodyP[q]) * f1;
        const py = lastBodyP[q + 1] + (bodyP[q + 1] - lastBodyP[q + 1]) * f1;
        const pz = lastBodyP[q + 2] + (bodyP[q + 2] - lastBodyP[q + 2]) * f1;
        const e = (x[o] - px) * nx + (x[o + 1] - py) * ny + (x[o + 2] - pz) * nz;
        if (e < clearance[p]) {
          const push = clearance[p] - e;
          x[o] += nx * push;
          x[o + 1] += ny * push;
          x[o + 2] += nz * push;
        }
      }
    }

    for (let i = 0; i < n * 3; i++) vel[i] = (x[i] - prev[i]) / h;
  };

  const setBody = (frame: ClothFrame) => {
    if (frame.bodyNormals && frame.bodyNormals.length === bodyN.length) bodyN.set(frame.bodyNormals);
    else bodyN.fill(0);
    hasBodyP = !!frame.bodyPositions && frame.bodyPositions.length === bodyP.length && !!frame.bodyNormals;
    if (hasBodyP) bodyP.set(frame.bodyPositions!);
  };

  return {
    rest,
    x,
    normals,
    targets,
    bodyVertices: Uint32Array.from(bodyList),
    reset(T: Float32Array, frame: ClothFrame, settle: number) {
      x.set(T);
      targets.set(T);
      lastTargets.set(T);
      vel.fill(0);
      if (frame.capsules) lastCaps.set(frame.capsules);
      setBody(frame);
      lastBodyP.set(bodyP);
      computeNormals();
      // Let gravity and the fabric take over before the first frame shows.
      const steps = Math.round(settle / SUBSTEP);
      for (let s = 0; s < steps; s++) {
        substep(SUBSTEP, T, frame.capsules, 1, 1);
        if (s % 8 === 7) computeNormals();
      }
      vel.fill(0);
      computeNormals();
    },
    /** Advances to the frame; returns the substeps taken. */
    step(dt: number, T: Float32Array, frame: ClothFrame): number {
      setBody(frame);
      targets.set(T);
      const steps = Math.min(MAX_SUBSTEPS, Math.max(1, Math.ceil(dt / SUBSTEP)));
      const h = dt / steps;
      for (let s = 0; s < steps; s++) substep(h, T, frame.capsules, s / steps, (s + 1) / steps);
      lastTargets.set(T);
      if (frame.capsules) lastCaps.set(frame.capsules);
      lastBodyP.set(bodyP);
      computeNormals();
      return steps;
    },
  };
}

class MinHeap {
  private d: number[] = [];
  private p: number[] = [];
  get size() {
    return this.d.length;
  }
  push(d: number, p: number) {
    const D = this.d, Pp = this.p;
    let i = D.length;
    D.push(d);
    Pp.push(p);
    while (i > 0) {
      const j = (i - 1) >> 1;
      if (D[j] <= D[i]) break;
      [D[i], D[j]] = [D[j], D[i]];
      [Pp[i], Pp[j]] = [Pp[j], Pp[i]];
      i = j;
    }
  }
  pop(): [number, number] {
    const D = this.d, Pp = this.p;
    const top: [number, number] = [D[0], Pp[0]];
    const ld = D.pop()!, lp = Pp.pop()!;
    if (D.length) {
      D[0] = ld;
      Pp[0] = lp;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < D.length && D[l] < D[m]) m = l;
        if (r < D.length && D[r] < D[m]) m = r;
        if (m === i) break;
        [D[i], D[m]] = [D[m], D[i]];
        [Pp[i], Pp[m]] = [Pp[m], Pp[i]];
        i = m;
      }
    }
    return top;
  }
}


/**
 * Collision capsules around the limbs and torso, fitted to a body: tapered,
 * reaching most of the way to the surface of each half of the limb.
 */
export function fitClothCapsules(
  body: { positions: ArrayLike<number>; skinIndex: ArrayLike<number>; skinWeight: ArrayLike<number>; bones: readonly string[] },
  joints: Record<string, V3>,
): Array<ClothCapsule & { from: string; to: string }> {
  // Limbs are round enough to fill out to most of their surface; the torso is flat, so its capsule takes its depth.
  const chains: Array<[string, string, string[], number]> = [];
  for (const side of ['left', 'right']) {
    chains.push([`${side}UpperLeg`, `${side}LowerLeg`, [`${side}UpperLeg`], 0.97]);
    chains.push([`${side}LowerLeg`, `${side}Foot`, [`${side}LowerLeg`], 0.97]);
    chains.push([`${side}UpperArm`, `${side}LowerArm`, [`${side}UpperArm`], 0.9]);
    chains.push([`${side}LowerArm`, `${side}Hand`, [`${side}LowerArm`], 0.9]);
  }
  chains.push(['hips', 'chest', ['hips', 'spine'], 0.08]);
  chains.push(['chest', 'neck', ['chest', 'upperChest'], 0.08]);
  const P = body.positions;
  const V = P.length / 3;
  const dominant = new Int32Array(V);
  for (let v = 0; v < V; v++) {
    let best = 0;
    for (let k = 1; k < 4; k++) if (body.skinWeight[v * 4 + k] > body.skinWeight[v * 4 + best]) best = k;
    dominant[v] = body.skinIndex[v * 4 + best];
  }
  const out: Array<ClothCapsule & { from: string; to: string }> = [];
  for (const [from, to, owners, percentile] of chains) {
    const a = joints[from], b = joints[to];
    if (!a || !b) continue;
    const ids = new Set(owners.map((o) => body.bones.indexOf(o)).filter((i) => i >= 0));
    const ab: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const l2 = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2] || 1;
    // Radius near each end, from the flesh between 15% and 85% along the bone.
    const near: number[][] = [[], []];
    for (let v = 0; v < V; v++) {
      if (!ids.has(dominant[v])) continue;
      const t = ((P[v * 3] - a[0]) * ab[0] + (P[v * 3 + 1] - a[1]) * ab[1] + (P[v * 3 + 2] - a[2]) * ab[2]) / l2;
      if (t < 0.15 || t > 0.85) continue;
      near[t < 0.5 ? 0 : 1].push(segmentDistance(P[v * 3], P[v * 3 + 1], P[v * 3 + 2], a, b));
    }
    if (near[0].length < 8 || near[1].length < 8) continue;
    const radius = (d: number[]) => {
      d.sort((x, y) => x - y);
      return d[Math.floor(d.length * percentile)];
    };
    out.push({ from, to, a, b, ra: radius(near[0]), rb: radius(near[1]) });
  }
  return out;
}
