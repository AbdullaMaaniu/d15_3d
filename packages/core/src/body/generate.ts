import type { JointMap } from '../skeleton';

/**
 * A body generated from the rig: every body part is a smooth tapered shape
 * around its bone, with separate side / front / back widths at a few rings
 * (shoulder, biceps, elbow, ...). The parts are blended into one surface with a
 * smooth union, so shoulders and hips join naturally. Proportions come from the
 * character's own shoulder and hip spacing, so stylised characters get a
 * matching body; the shape controls scale individual rings.
 *
 * The surface is extracted from the blended distance field with surface nets,
 * then snapped onto the field. Each vertex is weighted to the bones of the
 * parts it lies on, so the body moves with the rig.
 */

export type BodyControl =
  | 'overall'
  | 'head'
  | 'neck'
  | 'shoulders'
  | 'chest'
  | 'back'
  | 'waist'
  | 'belly'
  | 'hips'
  | 'glutes'
  | 'deltoids'
  | 'biceps'
  | 'triceps'
  | 'elbows'
  | 'forearms'
  | 'wrists'
  | 'thighs'
  | 'knees'
  | 'calves'
  | 'ankles';

/** Multipliers per control; 1 is the default build for the skeleton. */
export type BodyShape = Partial<Record<BodyControl, number>>;

export interface BodyControlDef {
  id: BodyControl;
  label: string;
  group: 'Overall' | 'Head & neck' | 'Torso' | 'Arms' | 'Legs';
}

export const BODY_CONTROLS: BodyControlDef[] = [
  { id: 'overall', label: 'Overall thickness', group: 'Overall' },
  { id: 'head', label: 'Head', group: 'Head & neck' },
  { id: 'neck', label: 'Neck', group: 'Head & neck' },
  { id: 'shoulders', label: 'Shoulders', group: 'Torso' },
  { id: 'chest', label: 'Chest', group: 'Torso' },
  { id: 'back', label: 'Back', group: 'Torso' },
  { id: 'waist', label: 'Waist', group: 'Torso' },
  { id: 'belly', label: 'Belly', group: 'Torso' },
  { id: 'hips', label: 'Hips', group: 'Torso' },
  { id: 'glutes', label: 'Glutes', group: 'Torso' },
  { id: 'deltoids', label: 'Deltoids', group: 'Arms' },
  { id: 'biceps', label: 'Biceps', group: 'Arms' },
  { id: 'triceps', label: 'Triceps', group: 'Arms' },
  { id: 'elbows', label: 'Elbows', group: 'Arms' },
  { id: 'forearms', label: 'Forearms', group: 'Arms' },
  { id: 'wrists', label: 'Wrists', group: 'Arms' },
  { id: 'thighs', label: 'Thighs', group: 'Legs' },
  { id: 'knees', label: 'Knees', group: 'Legs' },
  { id: 'calves', label: 'Calves', group: 'Legs' },
  { id: 'ankles', label: 'Ankles', group: 'Legs' },
];

type V3 = [number, number, number];

/** A cross-section: half-widths to the side, to the front and to the back (meters). */
interface Ring {
  c: V3;
  side: number;
  front: number;
  back: number;
  /** Bone this part of the body follows. */
  bone: string;
}

/** A tapered part between two rings, in a local frame (along, side, front). */
interface Segment {
  a: Ring;
  b: Ring;
  bone: string;
  /** Unit axis a -> b, its length, and the front direction perpendicular to it. */
  u: V3;
  len: number;
  f: V3;
  s: V3;
}

export interface BodyMesh {
  positions: Float32Array;
  normals: Float32Array;
  index: Uint32Array;
  /** 4 bone names' indices into `bones` and weights per vertex. */
  skinIndex: Uint16Array;
  skinWeight: Float32Array;
  bones: string[];
}

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const norm = (a: V3): V3 => {
  const l = len(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const lerp = (a: V3, b: V3, t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

function segment(a: Ring, b: Ring, front: V3 = [0, 0, 1]): Segment {
  const d = sub(b.c, a.c);
  const l = len(d);
  const u: V3 = l > 1e-9 ? scale(d, 1 / l) : [0, 1, 0];
  // Front: the requested direction made perpendicular to the part.
  let f = sub(front, scale(u, dot(front, u)));
  if (len(f) < 1e-6) f = Math.abs(u[1]) < 0.9 ? sub([0, 1, 0], scale(u, u[1])) : sub([1, 0, 0], scale(u, u[0]));
  f = norm(f);
  return { a, b, bone: a.bone, u, len: l, f, s: cross(u, f) };
}

/**
 * Rings and parts of a humanoid body for these joints. Base widths are fractions
 * of the shoulder span (S, between the upper-arm joints) and hip span.
 */
export function bodyParts(map: JointMap, shape: BodyShape = {}): Segment[] {
  const J = map.joints, T = map.tails;
  const m = (k: BodyControl) => (shape[k] ?? 1) * (k === 'overall' ? 1 : shape.overall ?? 1);
  const S = len(sub(J.leftUpperArm, J.rightUpperArm));
  const P = J.leftUpperLeg && J.rightUpperLeg ? len(sub(J.leftUpperLeg, J.rightUpperLeg)) : S * 0.5;
  const ring = (c: V3, side: number, front: number, back: number, bone: string): Ring => ({ c, side, front, back, bone });
  const round = (c: V3, r: number, bone: string) => ring(c, r, r, r, bone);
  const segs: Segment[] = [];

  // Torso, from below the hips to the head.
  const up = norm(sub(J.neck, J.hips));
  const torsoLen = len(sub(J.neck, J.hips));
  const hipW = Math.max(0.47 * S, 0.9 * P) * m('hips');
  const crotch = ring(add(J.hips, scale(up, -0.12 * torsoLen)), hipW * 0.9, 0.3 * S * m('hips'), 0.32 * S * m('glutes'), 'hips');
  const hips = ring(J.hips, hipW, 0.3 * S * m('hips') * Math.sqrt(m('belly')), 0.33 * S * m('glutes'), 'hips');
  const waistC = J.spine ?? lerp(J.hips, J.neck, 0.3);
  const waist = ring(waistC, 0.39 * S * m('waist'), 0.27 * S * m('waist') * m('belly'), 0.25 * S * m('waist'), 'spine');
  const chestC = J.chest ?? lerp(J.hips, J.neck, 0.55);
  const chest = ring(chestC, 0.44 * S * m('chest'), 0.3 * S * m('chest'), 0.28 * S * m('back'), 'chest');
  const upperC = J.upperChest ?? lerp(J.hips, J.neck, 0.8);
  const upper = ring(upperC, 0.47 * S * m('shoulders'), 0.26 * S * m('chest'), 0.27 * S * m('back'), J.upperChest ? 'upperChest' : 'chest');
  const neckR = 0.17 * S * m('neck');
  const neck = round(J.neck, neckR, 'neck');
  const neckTop = round(J.head, neckR * 0.95, 'neck');
  const torso = [crotch, hips, waist, chest, upper, neck, neckTop];
  for (let i = 0; i + 1 < torso.length; i++) segs.push(segment(torso[i], torso[i + 1]));

  // Head: an egg between the head joint and the top of the head.
  const top = T.head ?? add(J.head, scale(up, 0.6 * S));
  const hh = len(sub(top, J.head)) / 2;
  const hc = lerp(J.head, top, 0.5);
  const hw = hh * 0.85 * m('head');
  const hd = hh * 0.95 * m('head');
  // The rounded ends add the smaller radius (the width), so the axis is shortened by it.
  const reachUp = Math.max(0.05 * hh, hh - hw * 0.95);
  segs.push(segment(ring(add(hc, scale(up, -reachUp)), hw, hd, hd, 'head'), ring(add(hc, scale(up, reachUp)), hw * 0.95, hd * 0.95, hd * 0.95, 'head')));

  for (const side of ['left', 'right'] as const) {
    const j = (n: string) => J[`${side}${n}`] as V3 | undefined;
    const t = (n: string) => T[`${side}${n}`] as V3 | undefined;
    // Arm: collarbone, shoulder, biceps, elbow, forearm, wrist, hand.
    const collar = j('Shoulder'), sh = j('UpperArm'), el = j('LowerArm'), wr = j('Hand');
    if (sh && el && wr) {
      const del = 0.15 * S * m('deltoids');
      if (collar) segs.push(segment(round(collar, 0.12 * S * m('shoulders'), `${side}Shoulder`), round(sh, del, `${side}Shoulder`)));
      const shoulder = round(sh, del, `${side}UpperArm`);
      const bi = ring(lerp(sh, el, 0.45), 0.125 * S * Math.sqrt(m('biceps') * m('triceps')), 0.125 * S * m('biceps'), 0.13 * S * m('triceps'), `${side}UpperArm`);
      const elbow = round(el, 0.1 * S * m('elbows'), `${side}UpperArm`);
      const elbowL = round(el, 0.1 * S * m('elbows'), `${side}LowerArm`);
      const fore = round(lerp(el, wr, 0.3), 0.115 * S * m('forearms'), `${side}LowerArm`);
      const wrist = round(wr, 0.075 * S * m('wrists'), `${side}LowerArm`);
      segs.push(segment(shoulder, bi), segment(bi, elbow), segment(elbowL, fore), segment(fore, wrist));
      // Hand: flat (thin across the palm), towards the middle finger tip.
      const tip = t('MiddleDistal') ?? t('Hand') ?? add(wr, scale(norm(sub(wr, el)), 0.5 * S));
      const handLen = len(sub(tip, wr));
      const palm = ring(add(wr, scale(norm(sub(tip, wr)), handLen * 0.12)), 0.045 * S * m('wrists'), 0.11 * S, 0.11 * S, `${side}Hand`);
      const fingers = ring(add(wr, scale(norm(sub(tip, wr)), handLen * 0.85)), 0.035 * S, 0.1 * S, 0.1 * S, `${side}Hand`);
      // Front = up for the hand, so "side" is the palm's thickness.
      segs.push(segment(palm, fingers, [0, 1, 0]));
    }
    // Leg: hip, thigh, knee, calf, ankle, foot.
    const hp = j('UpperLeg'), kn = j('LowerLeg'), an = j('Foot');
    if (hp && kn && an) {
      const thighTop = round(hp, 0.26 * S * m('thighs'), `${side}UpperLeg`);
      const thigh = round(lerp(hp, kn, 0.3), 0.24 * S * m('thighs'), `${side}UpperLeg`);
      const knee = round(kn, 0.15 * S * m('knees'), `${side}UpperLeg`);
      const kneeL = round(kn, 0.15 * S * m('knees'), `${side}LowerLeg`);
      const calf = ring(lerp(kn, an, 0.3), 0.155 * S * m('calves'), 0.14 * S * m('calves'), 0.18 * S * m('calves'), `${side}LowerLeg`);
      const ankle = round(an, 0.095 * S * m('ankles'), `${side}LowerLeg`);
      segs.push(segment(thighTop, thigh), segment(thigh, knee), segment(kneeL, calf), segment(calf, ankle));
      // Foot: from the ankle down and forward to the toes; front = up, so "side" is its width.
      const toes = j('Toes');
      const toeTip = t('Toes') ?? (toes ? add(toes, [0, 0, 0.3 * S]) : add(an, [0, -0.2 * S, 0.6 * S]));
      const heel = ring(add(an, [0, -0.12 * S, -0.05 * S]), 0.1 * S * m('ankles'), 0.08 * S, 0.08 * S, `${side}Foot`);
      const ball = ring(toes ?? lerp(an, toeTip, 0.7), 0.13 * S, 0.06 * S, 0.06 * S, toes ? `${side}Toes` : `${side}Foot`);
      segs.push(segment(round(an, 0.095 * S * m('ankles'), `${side}Foot`), heel, [0, 0, 1]));
      segs.push(segment(heel, ball, [0, 1, 0]));
      segs.push(segment(ball, ring(toeTip, 0.1 * S, 0.045 * S, 0.045 * S, ball.bone), [0, 1, 0]));
    }
  }
  return segs;
}

/** Approximate signed distance to one part (negative inside). */
function partDistance(g: Segment, px: number, py: number, pz: number): number {
  const dx = px - g.a.c[0], dy = py - g.a.c[1], dz = pz - g.a.c[2];
  const along = dx * g.u[0] + dy * g.u[1] + dz * g.u[2];
  const t = g.len > 0 ? Math.min(1, Math.max(0, along / g.len)) : 0;
  const side = g.a.side + (g.b.side - g.a.side) * t;
  const fr = dx * g.f[0] + dy * g.f[1] + dz * g.f[2];
  const front = fr >= 0 ? g.a.front + (g.b.front - g.a.front) * t : g.a.back + (g.b.back - g.a.back) * t;
  const sd = dx * g.s[0] + dy * g.s[1] + dz * g.s[2];
  // Past the ends the part closes with a rounded cap as long as its smaller radius.
  const capR = Math.min(side, front);
  const beyond = along < 0 ? along : along > g.len ? along - g.len : 0;
  const e = Math.sqrt((sd / side) ** 2 + (fr / front) ** 2 + (beyond / capR) ** 2);
  return (e - 1) * Math.min(side, front);
}

/** Polynomial smooth minimum. */
function smin(a: number, b: number, k: number): number {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

export interface GenerateOptions {
  /** Grid cell size in meters (default: 1/110 of the body's height). */
  cell?: number;
}

/** Builds the body mesh for a humanoid rig. */
export function generateBody(map: JointMap, shape: BodyShape = {}, options: GenerateOptions = {}): BodyMesh {
  const segs = bodyParts(map, shape);
  const S = len(sub(map.joints.leftUpperArm, map.joints.rightUpperArm));
  const k = 0.07 * S;
  // Each part only matters near itself: its bounds, padded by the blend width.
  const box = segs.map((g) => {
    const pad = Math.max(g.a.side, g.a.front, g.a.back, g.b.side, g.b.front, g.b.back) + k;
    return [0, 1, 2].flatMap((i) => [Math.min(g.a.c[i], g.b.c[i]) - pad, Math.max(g.a.c[i], g.b.c[i]) + pad]);
  });
  const field = (x: number, y: number, z: number) => {
    let d = 1e9;
    for (let s = 0; s < segs.length; s++) {
      const b = box[s];
      if (x < b[0] || x > b[1] || y < b[2] || y > b[3] || z < b[4] || z > b[5]) continue;
      d = smin(d, partDistance(segs[s], x, y, z), k);
    }
    return d;
  };

  // Bounds of all parts.
  const lo: V3 = [Infinity, Infinity, Infinity], hi: V3 = [-Infinity, -Infinity, -Infinity];
  for (const b of box) {
    for (let i = 0; i < 3; i++) {
      lo[i] = Math.min(lo[i], b[i * 2]);
      hi[i] = Math.max(hi[i], b[i * 2 + 1]);
    }
  }
  const height = hi[1] - lo[1];
  const h = options.cell ?? height / 110;
  const nx = Math.ceil((hi[0] - lo[0]) / h) + 2, ny = Math.ceil((hi[1] - lo[1]) / h) + 2, nz = Math.ceil((hi[2] - lo[2]) / h) + 2;
  const ox = lo[0] - h, oy = lo[1] - h, oz = lo[2] - h;
  const at = (i: number, j: number, l: number) => i + nx * (j + ny * l);
  // Accumulate each part over its own box only (same smooth union, far less work).
  const val = new Float32Array(nx * ny * nz).fill(1e9);
  for (let s = 0; s < segs.length; s++) {
    const b = box[s], g = segs[s];
    const i0 = Math.max(0, Math.floor((b[0] - ox) / h)), i1 = Math.min(nx - 1, Math.ceil((b[1] - ox) / h));
    const j0 = Math.max(0, Math.floor((b[2] - oy) / h)), j1 = Math.min(ny - 1, Math.ceil((b[3] - oy) / h));
    const l0 = Math.max(0, Math.floor((b[4] - oz) / h)), l1 = Math.min(nz - 1, Math.ceil((b[5] - oz) / h));
    for (let l = l0; l <= l1; l++) for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const id = at(i, j, l);
      val[id] = smin(val[id], partDistance(g, ox + i * h, oy + j * h, oz + l * h), k);
    }
  }

  // Surface nets: one vertex per cell the surface passes through.
  const cellVert = new Int32Array((nx - 1) * (ny - 1) * (nz - 1)).fill(-1);
  const cv = (i: number, j: number, l: number) => i + (nx - 1) * (j + (ny - 1) * l);
  const pos: number[] = [];
  const corners = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]];
  const edges = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
  const v = new Float32Array(8);
  for (let l = 0; l < nz - 1; l++) for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
    for (let c = 0; c < 8; c++) v[c] = val[at(i + corners[c][0], j + corners[c][1], l + corners[c][2])];
    let neg = 0;
    for (let c = 0; c < 8; c++) if (v[c] < 0) neg++;
    if (neg === 0 || neg === 8) continue;
    let sx = 0, sy = 0, sz = 0, n = 0;
    for (const [p, q] of edges) {
      if ((v[p] < 0) === (v[q] < 0)) continue;
      const t = v[p] / (v[p] - v[q]);
      sx += corners[p][0] + (corners[q][0] - corners[p][0]) * t;
      sy += corners[p][1] + (corners[q][1] - corners[p][1]) * t;
      sz += corners[p][2] + (corners[q][2] - corners[p][2]) * t;
      n++;
    }
    cellVert[cv(i, j, l)] = pos.length / 3;
    pos.push(ox + (i + sx / n) * h, oy + (j + sy / n) * h, oz + (l + sz / n) * h);
  }
  const tris: number[] = [];
  const quad = (a: number, b: number, c: number, d: number, flip: boolean) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    if (flip) tris.push(a, c, b, a, d, c);
    else tris.push(a, b, c, a, c, d);
  };
  for (let l = 1; l < nz - 1; l++) for (let j = 1; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) {
    const inside = val[at(i, j, l)] < 0;
    // Edges along x, y, z from this grid point.
    if (i < nx - 1 && inside !== val[at(i + 1, j, l)] < 0) quad(cellVert[cv(i, j - 1, l - 1)], cellVert[cv(i, j, l - 1)], cellVert[cv(i, j, l)], cellVert[cv(i, j - 1, l)], !inside);
    if (j < ny - 1 && inside !== val[at(i, j + 1, l)] < 0) quad(cellVert[cv(i - 1, j, l - 1)], cellVert[cv(i - 1, j, l)], cellVert[cv(i, j, l)], cellVert[cv(i, j, l - 1)], !inside);
    if (l < nz - 1 && inside !== val[at(i, j, l + 1)] < 0) quad(cellVert[cv(i - 1, j - 1, l)], cellVert[cv(i, j - 1, l)], cellVert[cv(i, j, l)], cellVert[cv(i - 1, j, l)], !inside);
  }

  // Snap vertices onto the field and take normals from its gradient.
  const positions = Float32Array.from(pos);
  const normals = new Float32Array(positions.length);
  const e = h * 0.25;
  for (let v = 0; v < positions.length / 3; v++) {
    let x = positions[v * 3], y = positions[v * 3 + 1], z = positions[v * 3 + 2];
    let gx = 0, gy = 0, gz = 0;
    for (let it = 0; it < 3; it++) {
      const d = field(x, y, z);
      gx = (field(x + e, y, z) - field(x - e, y, z)) / (2 * e);
      gy = (field(x, y + e, z) - field(x, y - e, z)) / (2 * e);
      gz = (field(x, y, z + e) - field(x, y, z - e)) / (2 * e);
      const g2 = gx * gx + gy * gy + gz * gz || 1;
      if (it < 2) {
        x -= (d * gx) / g2;
        y -= (d * gy) / g2;
        z -= (d * gz) / g2;
      }
    }
    positions.set([x, y, z], v * 3);
    const gl = Math.hypot(gx, gy, gz) || 1;
    normals.set([gx / gl, gy / gl, gz / gl], v * 3);
  }

  // Face every triangle outwards (along the field's gradient).
  const index = Uint32Array.from(tris);
  for (let t = 0; t < index.length; t += 3) {
    const a = index[t], b = index[t + 1], c = index[t + 2];
    const ab = sub([positions[b * 3], positions[b * 3 + 1], positions[b * 3 + 2]], [positions[a * 3], positions[a * 3 + 1], positions[a * 3 + 2]]);
    const ac = sub([positions[c * 3], positions[c * 3 + 1], positions[c * 3 + 2]], [positions[a * 3], positions[a * 3 + 1], positions[a * 3 + 2]]);
    const fn = cross(ab, ac);
    let o = 0;
    for (const v of [a, b, c]) o += fn[0] * normals[v * 3] + fn[1] * normals[v * 3 + 1] + fn[2] * normals[v * 3 + 2];
    if (o < 0) {
      index[t + 1] = c;
      index[t + 2] = b;
    }
  }

  // Weights: each vertex follows the parts it lies on, blending where they meet.
  const bones = [...new Set(segs.map((g) => g.bone))];
  const boneOf = segs.map((g) => bones.indexOf(g.bone));
  const V = positions.length / 3;
  const skinIndex = new Uint16Array(V * 4), skinWeight = new Float32Array(V * 4);
  const acc = new Float64Array(bones.length);
  const blend = 0.12 * S;
  const ds = new Float64Array(segs.length);
  for (let v = 0; v < V; v++) {
    const x = positions[v * 3], y = positions[v * 3 + 1], z = positions[v * 3 + 2];
    let dmin = Infinity;
    for (let s = 0; s < segs.length; s++) {
      const b = box[s];
      if (x < b[0] || x > b[1] || y < b[2] || y > b[3] || z < b[4] || z > b[5]) { ds[s] = Infinity; continue; }
      ds[s] = partDistance(segs[s], x, y, z);
      if (ds[s] < dmin) dmin = ds[s];
    }
    acc.fill(0);
    for (let s = 0; s < segs.length; s++) {
      const w = 1 - (ds[s] - dmin) / blend;
      if (w > 0) acc[boneOf[s]] += w * w;
    }
    const top = [...acc.keys()].filter((b) => acc[b] > 0).sort((a, b) => acc[b] - acc[a]).slice(0, 4);
    const sum = top.reduce((s, b) => s + acc[b], 0) || 1;
    top.forEach((b, i) => {
      skinIndex[v * 4 + i] = b;
      skinWeight[v * 4 + i] = acc[b] / sum;
    });
  }
  return { positions, normals, index, skinIndex, skinWeight, bones };
}
