import { Box3, Quaternion, Vector3, type BufferGeometry } from 'three';
import type { BoneDef, JointMap, Side } from '../skeleton';
import type { Kernels } from '../kernels';
import { tsKernels } from '../kernels';
import { EMPTY } from '../voxel/grid';

type V3 = [number, number, number];

export const TAIL_BONES = ['tail0', 'tail1', 'tail2', 'tail3'];
export const LEG_SEGMENTS = {
  front: ['UpperLeg', 'LowerLeg', 'Foot', 'Toes'],
  back: ['UpperLeg', 'LowerLeg', 'Foot', 'Toes'],
} as const;

export function legBone(side: Side, end: 'Front' | 'Back', seg: string): string {
  return `${side}${end}${seg}`;
}

/**
 * Quadruped skeleton (dog, cat, horse...). Rig space: Y up, the animal faces +Z,
 * its left side is +X. Every bone's bind rotation is identity.
 */
function buildDefs(): BoneDef[] {
  const defs: BoneDef[] = [];
  const add = (name: string, parent: string | null, primaryChild: string | null, side: Side | null = null) =>
    defs.push({ name, parent, primaryChild, side, isFinger: false });
  add('hips', null, 'spine');
  add('spine', 'hips', 'chest');
  add('chest', 'spine', 'neck');
  add('neck', 'chest', 'head');
  add('head', 'neck', null);
  TAIL_BONES.forEach((t, i) => add(t, i === 0 ? 'hips' : TAIL_BONES[i - 1], TAIL_BONES[i + 1] ?? null));
  for (const side of ['left', 'right'] as const) {
    for (const end of ['Front', 'Back'] as const) {
      const [a, b, c, d] = LEG_SEGMENTS.front.map((s) => legBone(side, end, s));
      add(a, end === 'Front' ? 'chest' : 'hips', b, side);
      add(b, a, c, side);
      add(c, b, d, side);
      add(d, c, null, side);
    }
  }
  return defs;
}

export const QUADRUPED_DEFS: readonly BoneDef[] = buildDefs();

/**
 * Guesses the yaw that puts a quadruped's body along Z with the head toward +Z:
 * the longest horizontal extent is the body, and the head end rises higher than the tail end.
 */
export function guessQuadrupedOrientation(geometry: BufferGeometry): { rotation: Quaternion; notes: string[] } {
  const pos = geometry.attributes.position.array as ArrayLike<number>;
  const bb = new Box3().setFromBufferAttribute(geometry.attributes.position as any);
  const size = bb.getSize(new Vector3());
  const notes: string[] = [];
  let yaw = 0;
  const alongX = size.x > size.z * 1.1;
  if (alongX) notes.push('Body lay along X; turned it to run along Z.');
  // Highest point near each end of the body.
  let hiA = -Infinity, hiB = -Infinity;
  const axis = alongX ? 0 : 2;
  const lo = alongX ? bb.min.x : bb.min.z, len = alongX ? size.x : size.z;
  for (let i = 0; i < pos.length / 3; i++) {
    const f = (pos[i * 3 + axis] - lo) / (len || 1);
    const y = pos[i * 3 + 1];
    if (f > 0.75) hiB = Math.max(hiB, y);
    else if (f < 0.25) hiA = Math.max(hiA, y);
  }
  // hiB is the +axis end. The head should end up at +Z.
  const headAtPositive = hiB >= hiA;
  if (alongX) yaw = headAtPositive ? -Math.PI / 2 : Math.PI / 2; // +X -> +Z is a -90° turn about Y
  else yaw = headAtPositive ? 0 : Math.PI;
  if (!headAtPositive) notes.push('The head seemed to be at the other end; turned the model around.');
  return { rotation: new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), yaw), notes };
}

export interface QuadrupedDetectResult extends JointMap {
  confidence: number;
  notes: string[];
  measurements: { bellyY: number; backY: number; length: number; height: number; hasTail: boolean };
}

/**
 * Finds quadruped joints from the solid voxel volume: paws are the four blobs
 * touching the ground, legs are traced up to the belly, the spine runs between
 * the shoulders and hips, and slices beyond them give the neck/head and tail.
 */
export function detectQuadruped(positions: Float32Array, index: Uint32Array | null, options: { kernels?: Kernels; resolution?: number } = {}): QuadrupedDetectResult {
  const kernels = options.kernels ?? tsKernels;
  const notes: string[] = [];
  const bb = new Box3();
  for (let i = 0; i < positions.length; i += 3) bb.expandByPoint(new Vector3(positions[i], positions[i + 1], positions[i + 2]));
  const size = bb.getSize(new Vector3());
  const L = Math.max(size.x, size.y, size.z);
  const H = size.y;
  const dx = L / (options.resolution ?? 160);
  const g = kernels.voxelize({ positions, index, dx, pad: 2 });
  const { nx, ny, nz } = g;
  const solid = (x: number, y: number, z: number) => x >= 0 && y >= 0 && z >= 0 && x < nx && y < ny && z < nz && g.data[x + nx * (y + ny * z)] !== EMPTY;
  const wx = (i: number) => g.origin[0] + (i + 0.5) * dx;
  const wy = (i: number) => g.origin[1] + (i + 0.5) * dx;
  const wz = (i: number) => g.origin[2] + (i + 0.5) * dx;
  const yi = (y: number) => Math.floor((y - g.origin[1]) / dx);
  const xiOf = (x: number) => Math.floor((x - g.origin[0]) / dx);
  const ziOf = (z: number) => Math.floor((z - g.origin[2]) / dx);
  const minY = bb.min.y;

  // --- 1. Paws: connected blobs in the XZ footprint of the lowest band. -------------
  const band = yi(minY + 0.1 * H);
  const foot = new Uint8Array(nx * nz);
  for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) for (let y = 0; y <= band; y++) if (solid(x, y, z)) { foot[x + nx * z] = 1; break; }
  const blobs = components2D(foot, nx, nz).sort((a, b) => b.cells.length - a.cells.length);
  let paws: Array<{ x: number; z: number }>;
  const cx = (bb.min.x + bb.max.x) / 2;
  const cz = (bb.min.z + bb.max.z) / 2;
  if (blobs.length >= 4) {
    paws = blobs.slice(0, 4).map((b) => ({ x: wx(b.cx), z: wz(b.cz) }));
  } else {
    notes.push('Could not see four separate feet; legs were placed from body proportions.');
    paws = [
      { x: cx + 0.12 * size.x, z: cz + 0.3 * size.z },
      { x: cx - 0.12 * size.x, z: cz + 0.3 * size.z },
      { x: cx + 0.12 * size.x, z: cz - 0.3 * size.z },
      { x: cx - 0.12 * size.x, z: cz - 0.3 * size.z },
    ];
  }
  paws.sort((a, b) => b.z - a.z);
  const front = paws.slice(0, 2).sort((a, b) => b.x - a.x); // [left(+x), right]
  const back = paws.slice(2, 4).sort((a, b) => b.x - a.x);
  const x0 = (paws[0].x + paws[1].x + paws[2].x + paws[3].x) / 4;
  const zFront = (front[0].z + front[1].z) / 2;
  const zBack = (back[0].z + back[1].z) / 2;
  const zMid = (zFront + zBack) / 2;

  // --- 2. Belly and back height at mid-body. -----------------------------------------
  const column = (x: number, z: number) => {
    const xi = xiOf(x), zi = ziOf(z);
    let lo = -1, hi = -1, sum = 0, c = 0;
    for (let y = yi(minY + 0.12 * H); y < ny; y++) {
      if (solid(xi, y, zi) || solid(xi, y, zi + 1) || solid(xi, y, zi - 1)) {
        if (lo < 0) lo = y;
        hi = y;
        sum += y;
        c++;
      }
    }
    return lo < 0 ? null : { lo: wy(lo), hi: wy(hi), mid: wy(sum / c) };
  };
  const mid = column(x0, zMid) ?? { lo: minY + 0.45 * H, hi: minY + 0.8 * H, mid: minY + 0.62 * H };
  const bellyY = mid.lo;
  const torsoY = (mid.lo + mid.hi) / 2;

  const joints: Record<string, V3> = {};
  const tails: Record<string, V3> = {};

  // --- 3. Legs: follow each leg's cross-section up from the paw to the belly. -------
  const traceLeg = (paw: { x: number; z: number }) => {
    const pts: V3[] = [];
    let px = paw.x, pz = paw.z;
    const win = Math.max(2, Math.round((0.12 * L) / dx));
    for (let y = yi(minY); y <= yi(bellyY); y++) {
      let sx = 0, sz = 0, c = 0;
      const xc = xiOf(px), zc = ziOf(pz);
      for (let z = zc - win; z <= zc + win; z++) for (let x = xc - win; x <= xc + win; x++) {
        if (!solid(x, y, z)) continue;
        // Stay on this leg's side of the body.
        if ((wx(x) - x0) * (paw.x - x0) < 0) continue;
        sx += wx(x); sz += wz(z); c++;
      }
      if (!c) continue;
      px = sx / c; pz = sz / c;
      pts.push([px, wy(y), pz]);
    }
    return pts;
  };
  const place = (side: Side, end: 'Front' | 'Back', paw: { x: number; z: number }) => {
    const pts = traceLeg(paw);
    const top: V3 = pts.length ? [pts[pts.length - 1][0], (bellyY + torsoY) / 2, pts[pts.length - 1][2]] : [paw.x, (bellyY + torsoY) / 2, paw.z];
    const line: V3[] = [top, ...pts.slice().reverse()];
    const len = polyLen(line);
    const [kLower, kFoot] = end === 'Front' ? [0.42, 0.8] : [0.36, 0.72];
    joints[legBone(side, end, 'UpperLeg')] = top;
    joints[legBone(side, end, 'LowerLeg')] = along(line, len * kLower);
    joints[legBone(side, end, 'Foot')] = along(line, len * kFoot);
    // Toes: low on the paw, pointing to its front edge.
    const bottom = pts[0] ?? [paw.x, minY, paw.z];
    let tipZ = bottom[2];
    for (let z = ziOf(bottom[2]); z < nz; z++) {
      let any = false;
      for (let y = yi(minY); y <= yi(minY + 0.06 * H); y++) if (solid(xiOf(bottom[0]), y, z)) any = true;
      if (!any) break;
      tipZ = wz(z);
    }
    const toeY = minY + 0.03 * H;
    joints[legBone(side, end, 'Toes')] = [bottom[0], toeY, bottom[2] + 0.35 * (tipZ - bottom[2])];
    tails[legBone(side, end, 'Toes')] = [bottom[0], toeY, Math.max(tipZ, bottom[2] + 0.02 * L)];
  };
  place('left', 'Front', front[0]);
  place('right', 'Front', front[1]);
  place('left', 'Back', back[0]);
  place('right', 'Back', back[1]);

  // --- 4. Spine between the hips and the shoulders. ---------------------------------
  const spineY = (z: number) => column(x0, z)?.mid ?? torsoY;
  joints.hips = [x0, spineY(zBack), zBack];
  joints.chest = [x0, spineY(zFront), zFront];
  joints.spine = [x0, spineY(zMid), zMid];

  // --- 5. Neck & head: centroids of body slices in front of the shoulders. ----------
  const sliceCentroid = (zi: number, minYv: number) => {
    let sx = 0, sy = 0, c = 0;
    for (let y = yi(minYv); y < ny; y++) for (let x = 0; x < nx; x++) if (solid(x, y, zi)) { sx += wx(x); sy += wy(y); c++; }
    return c ? { x: sx / c, y: sy / c, area: c } : null;
  };
  const headLine: V3[] = [joints.chest];
  for (let z = ziOf(zFront) + 1; z < nz; z++) {
    const c = sliceCentroid(z, bellyY);
    if (!c) break;
    headLine.push([c.x, c.y, wz(z)]);
  }
  const headLen = polyLen(headLine);
  if (headLen < 0.05 * L) notes.push('Could not find a head in front of the shoulders; check the head markers.');
  joints.neck = along(headLine, headLen * 0.3);
  joints.head = along(headLine, headLen * 0.66);
  tails.head = headLine[headLine.length - 1];

  // --- 6. Tail: slices behind the hips whose cross-section is much thinner than the rump.
  const rump = sliceCentroid(ziOf(zBack), bellyY);
  const tailLine: V3[] = [];
  let thin = false;
  for (let z = ziOf(zBack) - 1; z >= 0; z--) {
    const c = sliceCentroid(z, bellyY * 0.9);
    if (!c) break;
    if (rump && c.area < 0.3 * rump.area) thin = true;
    if (thin) tailLine.push([c.x, c.y, wz(z)]);
  }
  const tailLen = polyLen(tailLine);
  const hasTail = tailLine.length > 1 && tailLen > 0.05 * L;
  if (hasTail) {
    TAIL_BONES.forEach((t, i) => (joints[t] = along(tailLine, (tailLen * i) / TAIL_BONES.length)));
    tails[TAIL_BONES[TAIL_BONES.length - 1]] = tailLine[tailLine.length - 1];
  } else {
    // A stub tail at the rump so the skeleton stays uniform.
    const back0: V3 = [x0, joints.hips[1], (rump ? zBack : zBack) - 0.08 * L];
    TAIL_BONES.forEach((t, i) => (joints[t] = [back0[0], back0[1], back0[2] - i * 0.01 * L]));
    tails[TAIL_BONES[TAIL_BONES.length - 1]] = [back0[0], back0[1], back0[2] - 0.05 * L];
  }

  const confidence = Math.max(0.1, 1 - notes.length * 0.25);
  return { joints, tails, confidence, notes, measurements: { bellyY, backY: mid.hi, length: size.z, height: H, hasTail } };
}

function components2D(grid: Uint8Array, nx: number, nz: number) {
  const seen = new Uint8Array(grid.length);
  const out: Array<{ cells: number[]; cx: number; cz: number }> = [];
  for (let i = 0; i < grid.length; i++) {
    if (!grid[i] || seen[i]) continue;
    const cells: number[] = [];
    const stack = [i];
    seen[i] = 1;
    while (stack.length) {
      const k = stack.pop()!;
      cells.push(k);
      const x = k % nx, z = (k / nx) | 0;
      for (const [ddx, ddz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const x2 = x + ddx, z2 = z + ddz;
        if (x2 < 0 || z2 < 0 || x2 >= nx || z2 >= nz) continue;
        const j = x2 + nx * z2;
        if (grid[j] && !seen[j]) { seen[j] = 1; stack.push(j); }
      }
    }
    let sx = 0, sz = 0;
    for (const k of cells) { sx += k % nx; sz += (k / nx) | 0; }
    out.push({ cells, cx: sx / cells.length, cz: sz / cells.length });
  }
  return out;
}

function polyLen(pts: V3[]) {
  let l = 0;
  for (let i = 1; i < pts.length; i++) l += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1], pts[i][2] - pts[i - 1][2]);
  return l;
}

function along(pts: V3[], d: number): V3 {
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const seg = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    if (acc + seg >= d && seg > 0) {
      const t = (d - acc) / seg;
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
    }
    acc += seg;
  }
  return [...pts[pts.length - 1]] as V3;
}
