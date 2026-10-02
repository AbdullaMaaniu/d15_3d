import type { JointMap } from '../skeleton';
import { boneDef } from '../skeleton';
import type { BodyControl, BodyMesh, BodyShape } from './generate';
import type { VoxelGrid } from '../voxel/grid';

/**
 * A realistic human body (sculpted reference mesh, rigged once offline) fitted
 * to a character's skeleton. Every bone of the reference is mapped onto the
 * matching bone of the character (moved, turned and stretched to its length),
 * and the vertices follow their bones by their skin weights, so the reference
 * takes the character's pose and proportions while keeping its anatomy.
 * The shape controls push the surface in or out around the bones first.
 */

type V3 = [number, number, number];

/** The rigged reference body, as stored in `assets/reference-body.bin`. */
export interface ReferenceBody {
  positions: Float32Array;
  index: Uint32Array;
  /** 4 indices into `bones` and weights per vertex. */
  skinIndex: Uint16Array;
  skinWeight: Float32Array;
  /**
   * Softer weights (no hard seams) that only drive the fitting, so stretching
   * one bone more than its neighbour bends the surface smoothly. FIT_SLOTS per vertex.
   */
  fitIndex: Uint16Array;
  fitWeight: Float32Array;
  bones: string[];
  /** The reference's own skeleton (rig space: Y up, facing +Z, feet at 0, 1.80 m tall). */
  joints: JointMap;
}

const MAGIC = 0x32424652; // 'RFB2'
/** Bones per vertex in the fitting weights (the torso blends more than 4 at once). */
export const FIT_SLOTS = 8;

/** Packs a reference body: header, JSON (bones, joints), then the arrays. */
export function encodeReferenceBody(ref: ReferenceBody): Uint8Array {
  const vc = ref.positions.length / 3;
  const json = new TextEncoder().encode(JSON.stringify({ vertexCount: vc, indexCount: ref.index.length, bones: ref.bones, joints: ref.joints }));
  const jsonLen = Math.ceil(json.length / 4) * 4;
  const wide = vc > 65535;
  const size = 8 + jsonLen + vc * 12 + ref.index.length * (wide ? 4 : 2) + vc * 8 + vc * FIT_SLOTS * 2;
  const out = new Uint8Array(Math.ceil(size / 4) * 4);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, MAGIC, true);
  dv.setUint32(4, jsonLen, true);
  out.fill(0x20, 8, 8 + jsonLen);
  out.set(json, 8);
  let o = 8 + jsonLen;
  out.set(new Uint8Array(ref.positions.buffer, ref.positions.byteOffset, ref.positions.byteLength), o);
  o += vc * 12;
  const idx = wide ? Uint32Array.from(ref.index) : Uint16Array.from(ref.index);
  out.set(new Uint8Array(idx.buffer), o);
  o += idx.byteLength;
  for (let i = 0; i < vc * 4; i++) out[o + i] = ref.skinIndex[i];
  o += vc * 4;
  for (let i = 0; i < vc * 4; i++) out[o + i] = Math.round(ref.skinWeight[i] * 255);
  o += vc * 4;
  for (let i = 0; i < vc * FIT_SLOTS; i++) out[o + i] = ref.fitIndex[i];
  o += vc * FIT_SLOTS;
  for (let i = 0; i < vc * FIT_SLOTS; i++) out[o + i] = Math.round(ref.fitWeight[i] * 255);
  return out;
}

export function decodeReferenceBody(data: ArrayBuffer | Uint8Array): ReferenceBody {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0, true) !== MAGIC) throw new Error('Not a RigForge reference body');
  const jsonLen = dv.getUint32(4, true);
  const head = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + jsonLen)));
  const vc: number = head.vertexCount, ic: number = head.indexCount;
  let o = 8 + jsonLen;
  // A copy, aligned for the typed arrays (Node's Buffer.slice would share its pool).
  const copy = (n: number) => new Uint8Array(bytes.subarray(o, (o += n))).buffer;
  const positions = new Float32Array(copy(vc * 12));
  const index = vc > 65535 ? new Uint32Array(copy(ic * 4)) : Uint32Array.from(new Uint16Array(copy(ic * 2)));
  const weights = (n: number) => {
    const raw = bytes.subarray(o, (o += vc * n));
    const w = new Float32Array(vc * n);
    for (let v = 0; v < vc; v++) {
      let s = 0;
      for (let k = 0; k < n; k++) s += raw[v * n + k];
      for (let k = 0; k < n; k++) w[v * n + k] = raw[v * n + k] / (s || 1);
    }
    return w;
  };
  const skinIndex = Uint16Array.from(bytes.subarray(o, (o += vc * 4)));
  const skinWeight = weights(4);
  const fitIndex = Uint16Array.from(bytes.subarray(o, (o += vc * FIT_SLOTS)));
  const fitWeight = weights(FIT_SLOTS);
  return { positions, index, skinIndex, skinWeight, fitIndex, fitWeight, bones: head.bones, joints: head.joints };
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
const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/** Where a bone ends: its main child's joint, or its tail. */
function boneEnd(map: JointMap, name: string): V3 | undefined {
  const J = map.joints, T = map.tails;
  if (name.endsWith('Hand')) {
    const side = name.slice(0, -4);
    return T[`${side}MiddleDistal`] ?? T[name];
  }
  const child = boneDef(name)?.primaryChild;
  return (child && J[child]) || T[name];
}

/** Axis frame of a bone: along it, and a front direction (+Z made perpendicular) and side. */
function frame(a: V3, b: V3): { u: V3; f: V3; s: V3; l: number } {
  const d = sub(b, a);
  const l = len(d);
  const u: V3 = l > 1e-9 ? scale(d, 1 / l) : [0, 1, 0];
  // Feet and hands point forward or down; use up as their "front" when +Z is along them.
  let f = sub([0, 0, 1], scale(u, u[2]));
  if (len(f) < 0.3) f = sub([0, 1, 0], scale(u, u[1]));
  f = norm(f);
  return { u, f, s: cross(u, f), l };
}

/** Rotation taking unit vector a to unit vector b (shortest arc), as a 3x3 row-major matrix. */
function rotationBetween(a: V3, b: V3): number[] {
  const v = cross(a, b), c = dot(a, b);
  if (c < -0.999999) {
    // Opposite: half turn about any perpendicular axis.
    const p = norm(Math.abs(a[0]) < 0.9 ? cross(a, [1, 0, 0]) : cross(a, [0, 1, 0]));
    return [2 * p[0] * p[0] - 1, 2 * p[0] * p[1], 2 * p[0] * p[2], 2 * p[1] * p[0], 2 * p[1] * p[1] - 1, 2 * p[1] * p[2], 2 * p[2] * p[0], 2 * p[2] * p[1], 2 * p[2] * p[2] - 1];
  }
  const k = 1 / (1 + c);
  return [
    v[0] * v[0] * k + c, v[0] * v[1] * k - v[2], v[0] * v[2] * k + v[1],
    v[1] * v[0] * k + v[2], v[1] * v[1] * k + c, v[1] * v[2] * k - v[0],
    v[2] * v[0] * k - v[1], v[2] * v[1] * k + v[0], v[2] * v[2] * k + c,
  ];
}
const mul3 = (m: number[], p: V3): V3 => [m[0] * p[0] + m[1] * p[1] + m[2] * p[2], m[3] * p[0] + m[4] * p[1] + m[5] * p[2], m[6] * p[0] + m[7] * p[1] + m[8] * p[2]];

/**
 * Affine map (3x4, row-major) of one bone: stretch by `along` on axis `u` and by
 * `across` around it, turn by `rot`, and move joint `ra` onto `ta`.
 */
function boneMatrix(ra: V3, ta: V3, rot: number[], u: V3, along: number, across: number): number[] {
  // S = across * I + (along - across) * u u^T, then M = rot * S.
  const S = [0, 1, 2].map((i) => [0, 1, 2].map((j) => (i === j ? across : 0) + (along - across) * u[i] * u[j]));
  const M = [0, 1, 2].map((i) => [0, 1, 2].map((j) => rot[i * 3] * S[0][j] + rot[i * 3 + 1] * S[1][j] + rot[i * 3 + 2] * S[2][j]));
  const t = sub(ta, [M[0][0] * ra[0] + M[0][1] * ra[1] + M[0][2] * ra[2], M[1][0] * ra[0] + M[1][1] * ra[1] + M[1][2] * ra[2], M[2][0] * ra[0] + M[2][1] * ra[1] + M[2][2] * ra[2]]);
  return [...M[0], t[0], ...M[1], t[1], ...M[2], t[2]];
}
const apply34 = (m: number[], p: V3): V3 => [
  m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3],
  m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7],
  m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11],
];

/** Where each shape control acts: bones, a span along the bone (0 = joint, 1 = end) and a side of it. */
interface ControlArea {
  bones: string[];
  t?: [number, number];
  dir?: 'front' | 'back' | 'side';
}
const LIMB = (n: string) => [`left${n}`, `right${n}`];
const CONTROL_AREAS: Partial<Record<BodyControl, ControlArea[]>> = {
  neck: [{ bones: ['neck'] }],
  shoulders: [{ bones: ['upperChest'], t: [0.3, 1.2], dir: 'side' }, { bones: LIMB('Shoulder') }],
  chest: [{ bones: ['chest'], t: [0.3, 1.2], dir: 'front' }, { bones: ['upperChest'], t: [-0.2, 0.7], dir: 'front' }],
  back: [{ bones: ['chest'], t: [0, 1.2], dir: 'back' }, { bones: ['upperChest'], t: [-0.2, 0.8], dir: 'back' }],
  waist: [{ bones: ['spine'], t: [-0.1, 1] }, { bones: ['chest'], t: [-0.3, 0.2] }],
  belly: [{ bones: ['spine'], t: [-0.4, 1], dir: 'front' }, { bones: ['hips'], t: [0.3, 1.2], dir: 'front' }],
  hips: [{ bones: ['hips'], t: [-0.5, 0.7], dir: 'side' }, { bones: LIMB('UpperLeg'), t: [-0.2, 0.25], dir: 'side' }],
  glutes: [{ bones: ['hips'], t: [-0.5, 0.7], dir: 'back' }, { bones: LIMB('UpperLeg'), t: [-0.2, 0.3], dir: 'back' }],
  deltoids: [{ bones: LIMB('UpperArm'), t: [-0.2, 0.3] }],
  biceps: [{ bones: LIMB('UpperArm'), t: [0.15, 0.85], dir: 'front' }],
  triceps: [{ bones: LIMB('UpperArm'), t: [0.15, 0.85], dir: 'back' }],
  elbows: [{ bones: LIMB('UpperArm'), t: [0.8, 1.2] }, { bones: LIMB('LowerArm'), t: [-0.2, 0.2] }],
  forearms: [{ bones: LIMB('LowerArm'), t: [0.05, 0.7] }],
  wrists: [{ bones: LIMB('LowerArm'), t: [0.7, 1.2] }, { bones: LIMB('Hand'), t: [-0.2, 0.15] }],
  thighs: [{ bones: LIMB('UpperLeg'), t: [0, 0.8] }],
  knees: [{ bones: LIMB('UpperLeg'), t: [0.8, 1.2] }, { bones: LIMB('LowerLeg'), t: [-0.2, 0.2] }],
  calves: [{ bones: LIMB('LowerLeg'), t: [0.05, 0.55], dir: 'back' }],
  ankles: [{ bones: LIMB('LowerLeg'), t: [0.75, 1.2] }, { bones: LIMB('Foot'), t: [-0.3, 0.3] }],
};

/** How strongly a control acts at a point: 1 inside its span and side, fading out at the edges. */
function areaWeight(a: ControlArea, t: number, cf: number, cs: number): number {
  let w = 1;
  if (a.t) {
    const pad = 0.12;
    w *= smooth(a.t[0] - pad, a.t[0] + pad, t) * (1 - smooth(a.t[1] - pad, a.t[1] + pad, t));
  }
  if (a.dir === 'front') w *= smooth(-0.3, 0.4, cf);
  else if (a.dir === 'back') w *= smooth(-0.3, 0.4, -cf);
  else if (a.dir === 'side') w *= smooth(0.25, 0.75, Math.abs(cs));
  return w;
}

/** Pushes the reference surface in or out around its bones for the shape controls (reference space). */
function shapeReference(ref: ReferenceBody, shape: BodyShape, girth: Girth = {}): Float32Array {
  const out = Float32Array.from(ref.positions);
  const overall = shape.overall ?? 1;
  const active = (Object.keys(CONTROL_AREAS) as BodyControl[]).filter((k) => Math.abs((shape[k] ?? 1) - 1) > 1e-6);
  const head = shape.head ?? 1;
  const thinned = ref.bones.map((b) => girth[b] ?? 1);
  if (!active.length && Math.abs(overall - 1) < 1e-6 && Math.abs(head - 1) < 1e-6 && thinned.every((g) => g === 1)) return out;
  const frames = ref.bones.map((b) => {
    const a = ref.joints.joints[b] as V3 | undefined, e = boneEnd(ref.joints, b);
    return a && e ? { a, ...frame(a, e) } : null;
  });
  const perBone = ref.bones.map((b) => active.flatMap((k) => (CONTROL_AREAS[k] ?? []).filter((a) => a.bones.includes(b)).map((a) => ({ a, m: shape[k]! }))));
  const headBone = ref.bones.indexOf('head');
  const V = ref.positions.length / 3;
  for (let v = 0; v < V; v++) {
    const p: V3 = [ref.positions[v * 3], ref.positions[v * 3 + 1], ref.positions[v * 3 + 2]];
    let d: V3 = [0, 0, 0];
    for (let k = 0; k < FIT_SLOTS; k++) {
      const w = ref.fitWeight[v * FIT_SLOTS + k];
      const b = ref.fitIndex[v * FIT_SLOTS + k];
      const fr = frames[b];
      if (w <= 0 || !fr) continue;
      const rel = sub(p, fr.a);
      const along = dot(rel, fr.u);
      const radial = sub(rel, scale(fr.u, along));
      const r = len(radial) || 1;
      const t = along / (fr.l || 1);
      const cf = dot(radial, fr.f) / r, cs = dot(radial, fr.s) / r;
      let m = overall * thinned[b];
      for (const { a, m: val } of perBone[b]) m *= 1 + (val - 1) * areaWeight(a, t, cf, cs);
      // The head grows as a whole, around its middle.
      if (b === headBone && Math.abs(head - 1) > 1e-6) {
        const mid = add(fr.a, scale(fr.u, fr.l * 0.5));
        d = add(d, scale(sub(p, mid), w * (head - 1)));
      }
      d = add(d, scale(radial, w * (m - 1)));
    }
    out[v * 3] += d[0];
    out[v * 3 + 1] += d[1];
    out[v * 3 + 2] += d[2];
  }
  return out;
}

/** A smooth bump: 1 at `c`, fading to 0 at `c - below` and `c + above`. */
const bump = (x: number, c: number, below: number, above = below) => {
  const w = x < c ? below : above;
  return Math.abs(x - c) >= w ? 0 : 0.5 + 0.5 * Math.cos((Math.PI * (x - c)) / w);
};

/**
 * The reference scan is athletic: a narrow waist under a deep chest. This
 * brings its torso to the average adult man (US Army ANSUR II, 4,082 men,
 * measured relative to stature) as smooth side, front and back scales by
 * height along the torso (0 at the hip joint, 1 at the neck): a fuller waist
 * and belly (easing down into the pelvis, so it doesn't overhang), a slightly
 * flatter chest.
 */
function averageBuild(t: number): [side: number, front: number, back: number] {
  const waist = bump(t, AVERAGE_BUILD.waistAt, AVERAGE_BUILD.waistBelow, AVERAGE_BUILD.waistAbove);
  const chest = bump(t, AVERAGE_BUILD.chestAt, AVERAGE_BUILD.chestSpan);
  // The back fills out at the waist only, not down over the buttocks.
  const back = bump(t, AVERAGE_BUILD.waistAt, AVERAGE_BUILD.waistAbove);
  return [1 + AVERAGE_BUILD.waistSide * waist, 1 + AVERAGE_BUILD.belly * waist - AVERAGE_BUILD.chestFront * chest, 1 + AVERAGE_BUILD.waistBack * back];
}
const AVERAGE_BUILD = { waistAt: 0.38, waistBelow: 0.5, waistAbove: 0.3, waistSide: 0.16, belly: 0.3, waistBack: 0.1, chestAt: 0.75, chestSpan: 0.18, chestFront: 0.08 };

/**
 * Maps the torso by height along its joint chain: a point at some height of the
 * reference torso goes to the same fraction of the rig's matching segment, with
 * its offset from the chain turned with the torso and scaled to the build:
 * `size` front to back, and side to side by the rig's hip and shoulder
 * spacing, within a human range of its size.
 */
function torsoMap(R: JointMap, map: JointMap, size: number): ((p: V3) => V3) | null {
  const chain = ['hips', 'spine', 'chest', 'upperChest', 'neck'].filter((b) => R.joints[b] && map.joints[b]);
  if (chain.length < 2 || chain[0] !== 'hips') return null;
  const rp = chain.map((b) => R.joints[b] as V3), tp = chain.map((b) => map.joints[b] as V3);
  const ru = norm(sub(rp[rp.length - 1], rp[0]));
  const rot = rotationBetween(ru, norm(sub(tp[tp.length - 1], tp[0])));
  const h = rp.map((p) => dot(sub(p, rp[0]), ru));
  const width = (a: string, b: string) =>
    R.joints[a] && R.joints[b] && map.joints[a] && map.joints[b] ? len(sub(map.joints[a], map.joints[b])) / len(sub(R.joints[a], R.joints[b])) : size;
  // One width for the whole torso: varying it with height would pinch the sides under the arms.
  // Nor narrower than where the arms attach, which would stretch the armpits into webs.
  const shoulders = size * Math.min(1.3, Math.max(0.85, width('leftUpperArm', 'rightUpperArm') / size));
  const lat = Math.max(size * Math.min(1.15, Math.max(0.9, (width('leftUpperLeg', 'rightUpperLeg') + width('leftUpperArm', 'rightUpperArm')) / 2 / size)), 0.95 * shoulders);
  // Nor flattens it much more front to back than side to side, which reads as a box with flaps.
  const depth = Math.max(size, 0.9 * lat);
  const top = h[h.length - 1] || 1;
  const base = (p: V3): V3 => {
    const hp = dot(sub(p, rp[0]), ru);
    // Segment containing this height (the end segments extend past the ends).
    let i = 0;
    while (i < h.length - 2 && hp > h[i + 1]) i++;
    const f = (hp - h[i]) / (h[i + 1] - h[i] || 1);
    const rc = add(rp[i], scale(sub(rp[i + 1], rp[i]), f));
    const tc = add(tp[i], scale(sub(tp[i + 1], tp[i]), f));
    const o = sub(p, rc);
    const [side, front, back] = averageBuild(hp / top);
    const d = back + (front - back) * smooth(-0.03, 0.03, o[2]);
    return add(tc, mul3(rot, [o[0] * lat * side, o[1] * size, o[2] * depth * d]));
  };
  // Then a smooth local correction so the limbs' roots land on the rig's
  // shoulder and hip joints, where the limbs are attached: otherwise the
  // armpits and groin are torn between torso and limb and fold into webs.
  const roots = ['leftUpperArm', 'rightUpperArm', 'leftUpperLeg', 'rightUpperLeg', ...chain].filter((b) => R.joints[b] && map.joints[b]);
  const c = roots.map((b) => R.joints[b] as V3);
  const sigma = 0.12 * size;
  const k = (a: V3, b: V3) => Math.exp(-(len(sub(a, b)) ** 2) / (2 * sigma * sigma));
  const resid = roots.map((b, i) => sub(map.joints[b] as V3, base(c[i])));
  const n = c.length;
  const K = c.map((a) => c.map((b) => k(a, b)));
  const w = [0, 1, 2].map((axis) => solveDense(K, resid.map((r) => r[axis])));
  return (p) => {
    const q = base(p);
    for (let i = 0; i < n; i++) {
      const f = k(p, c[i]);
      if (f < 1e-6) continue;
      q[0] += w[0][i] * f;
      q[1] += w[1][i] * f;
      q[2] += w[2][i] * f;
    }
    return q;
  };
}

/** Solves A x = b (small, dense) by Gaussian elimination with partial pivoting. */
function solveDense(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const d = M[c][c] || 1e-12;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / d;
      for (let j = c; j <= n; j++) M[r][j] -= f * M[c][j];
    }
  }
  return M.map((row, i) => row[n] / (row[i] || 1e-12));
}

/**
 * Fits the reference body to a humanoid rig. Bones the rig doesn't have hand
 * their vertices to the nearest parent it does have.
 */
export function fitReferenceBody(ref: ReferenceBody, map: JointMap, shape: BodyShape = {}, options: { rest?: JointMap; girth?: Girth } = {}): BodyMesh {
  const R = ref.joints, J = map.joints;
  // Overall size: the rig's standing height (head joint over the feet) against
  // the reference's. With proportions applied (`map` from proportionJoints), the
  // size comes from the rig as it was (`rest`) and the height control, so longer
  // legs don't also mean a bigger head and a thicker build.
  const stand = (m: JointMap) => {
    const feet = ['leftFoot', 'rightFoot'].map((f) => m.joints[f]).filter(Boolean);
    return m.joints.head && feet.length ? m.joints.head[1] - feet.reduce((s, f) => s + f[1], 0) / feet.length : NaN;
  };
  const size = (options.rest ? (stand(options.rest) / stand(R)) * (shape.height ?? 1) : stand(map) / stand(R)) || 1;

  // Bones present in both, else their nearest present ancestor.
  const has = (b: string) => !!J[b] && !!R.joints[b];
  const owner = ref.bones.map((b) => {
    let n: string | null = b;
    while (n && !has(n)) n = boneDef(n)?.parent ?? null;
    return n ?? 'hips';
  });
  // The torso is mapped as one piece along its joints (hips to neck), so it
  // stays continuous however the spacing and small zigzags of its joints
  // differ between the reference and the rig.
  // The collarbones go with it, so the arms attach where the torso is widened to.
  const TORSO = ['hips', 'spine', 'chest', 'upperChest', 'leftShoulder', 'rightShoulder'];
  const torso = torsoMap(R, map, size);
  const xf = new Map<string, (p: V3) => V3>();
  for (const b of new Set(owner)) {
    if (torso && TORSO.includes(b)) {
      xf.set(b, torso);
      continue;
    }
    const ra = R.joints[b] as V3, ta = J[b] as V3;
    const re = boneEnd(R, b), te = boneEnd(map, b);
    let m: number[];
    if (!re || !te) {
      // Nothing to aim at: just move it along.
      m = boneMatrix(ra, ta, [1, 0, 0, 0, 1, 0, 0, 0, 1], [0, 1, 0], 1, 1);
    } else {
      const rd = sub(re, ra), td = sub(te, ta), ru = norm(rd);
      // Limbs stretch to the rig's bone lengths at the body's size; the head and
      // hands keep human proportions (a stylised big head doesn't make a big skull).
      const along = b === 'head' ? size : /Hand/.test(b) ? size * (shape.handLength ?? 1) : len(td) / (len(rd) || 1);
      const across = size;
      const tu = norm(td);
      m = boneMatrix(ra, ta, rotationBetween(ru, tu), ru, along, across);
      if (torso && /^(neck|leftUpperArm|rightUpperArm|leftUpperLeg|rightUpperLeg)$/.test(b)) {
        // Limbs and neck grow out of the torso: up to their joint they move as
        // the torso does, and take their own fit a little way along. Otherwise
        // the armpits, groin and collar, which blend torso and limb, are torn
        // between the two and fold into flaps.
        const l = len(rd) || 1, limb = m;
        // Arms leave the torso sideways, whatever angle they hang at.
        const hips = R.joints.hips as V3;
        const out: V3 | null = /Arm/.test(b) ? norm([ra[0] - hips[0], 0, 0]) : null;
        xf.set(b, (p) => {
          const f = smooth(-0.1, 0.5, dot(sub(p, ra), out ?? ru) / l);
          const q = apply34(limb, p);
          if (f >= 1) return q;
          const t = torso(p);
          return add(t, scale(sub(q, t), f));
        });
        continue;
      }
    }
    xf.set(b, (p) => apply34(m, p));
  }

  const src = shapeReference(ref, shape, options.girth);
  const V = src.length / 3;
  const positions = new Float32Array(V * 3);
  for (let v = 0; v < V; v++) {
    const p: V3 = [src[v * 3], src[v * 3 + 1], src[v * 3 + 2]];
    let q: V3 = [0, 0, 0];
    for (let k = 0; k < FIT_SLOTS; k++) {
      const w = ref.fitWeight[v * FIT_SLOTS + k];
      if (w > 0) q = add(q, scale(xf.get(owner[ref.fitIndex[v * FIT_SLOTS + k]])!(p), w));
    }
    positions.set(q, v * 3);
  }

  // Weights move to the bones that own them, merged per vertex.
  const bones = [...new Set(owner)];
  const boneOf = owner.map((b) => bones.indexOf(b));
  // The side of the chest under the armpit stays with the torso: weighted to
  // the upper arm, it is dragged into the ribs (a caved-in armpit) whenever
  // the arm comes down from the rest pose. The arm's weight there fades out
  // from just outside the shoulder joint inward.
  const armpit = (['left', 'right'] as const).map((side) => {
    const arm = ref.bones.indexOf(`${side}UpperArm`), joint = R.joints[`${side}UpperArm`] as V3 | undefined;
    const torsoBone = bones.indexOf(owner[ref.bones.indexOf(`${side}Shoulder`)] ?? 'upperChest');
    return arm >= 0 && joint && torsoBone >= 0 ? { arm, joint, torsoBone, out: side === 'left' ? 1 : -1 } : null;
  });
  const skinIndex = new Uint16Array(V * 4), skinWeight = new Float32Array(V * 4);
  for (let v = 0; v < V; v++) {
    const acc = new Map<number, number>();
    for (let k = 0; k < 4; k++) {
      const w = ref.skinWeight[v * 4 + k];
      if (w <= 0) continue;
      const src = ref.skinIndex[v * 4 + k];
      const a = armpit.find((x) => x?.arm === src);
      let keep = w;
      if (a) {
        const lateral = (ref.positions[v * 3] - a.joint[0]) * a.out, below = a.joint[1] - ref.positions[v * 3 + 1];
        keep = w * Math.max(smooth(-0.02, 0.05, lateral), 1 - smooth(0, 0.04, below));
        if (keep < w) acc.set(a.torsoBone, (acc.get(a.torsoBone) ?? 0) + w - keep);
      }
      const b = boneOf[src];
      acc.set(b, (acc.get(b) ?? 0) + keep);
    }
    // At most four influences: drop the weakest and renormalise.
    const top = [...acc].filter(([, w]) => w > 1e-6).sort((x, y) => y[1] - x[1]).slice(0, 4);
    const sum = top.reduce((t, [, w]) => t + w, 0) || 1;
    top.forEach(([b, w], i) => {
      skinIndex[v * 4 + i] = b;
      skinWeight[v * 4 + i] = w / sum;
    });
  }
  return { positions, normals: vertexNormals(positions, ref.index), index: ref.index, skinIndex, skinWeight, bones };
}

/** Thickness per bone, around the bone (1 = as built). */
export type Girth = Partial<Record<string, number>>;

/**
 * The slimmest each part may get to fit inside clothes: a slim adult man (5th
 * percentile of ANSUR II girths over the mean): chest 0.87, waist 0.82,
 * buttocks 0.88, upper arm 0.85, forearm 0.89, thigh 0.85, calf 0.88.
 */
const SLIMMEST: Array<[RegExp, number]> = [
  [/^hips$/, 0.88],
  [/^spine$/, 0.82],
  [/^(chest|upperChest)$/, 0.87],
  [/UpperArm/, 0.85],
  [/LowerArm/, 0.89],
  [/UpperLeg/, 0.85],
  [/LowerLeg/, 0.88],
];

/**
 * How much to thin each part of the fitted body so it sits inside the
 * character's own surface (its clothes): per bone, the thickness at which
 * `inside` of its vertices are within `solid`, never below a slim adult's
 * (SLIMMEST). Parts the clothes don't cover where the body is (a sleeve on a
 * longer arm) are left alone: thinning can't fix a part that's elsewhere.
 * Hands, feet, head and neck are skipped (gloves, shoes and hair are roomy).
 */
export function clothesGirth(ref: ReferenceBody, map: JointMap, solid: VoxelGrid, shape: BodyShape = {}, options: { rest?: JointMap; inside?: number } = {}): Girth {
  const inside = options.inside ?? 0.99;
  const body = fitReferenceBody(ref, map, shape, options);
  const isIn = (p: V3) => {
    const x = Math.floor((p[0] - solid.origin[0]) / solid.dx), y = Math.floor((p[1] - solid.origin[1]) / solid.dx), z = Math.floor((p[2] - solid.origin[2]) / solid.dx);
    return x >= 0 && y >= 0 && z >= 0 && x < solid.nx && y < solid.ny && z < solid.nz && solid.data[x + solid.nx * (y + solid.ny * z)] !== 0;
  };
  const floor = (b: string) => SLIMMEST.find(([re]) => re.test(b))?.[1];
  const ratios = new Map<string, number[]>();
  const V = body.positions.length / 3;
  for (let v = 0; v < V; v++) {
    // Each vertex belongs to its strongest bone; measured against that bone's axis in the fit.
    let best = -1, bw = 0;
    for (let k = 0; k < FIT_SLOTS; k++) {
      const w = ref.fitWeight[v * FIT_SLOTS + k];
      if (w > bw) {
        bw = w;
        best = ref.fitIndex[v * FIT_SLOTS + k];
      }
    }
    const name = ref.bones[best];
    if (!name || floor(name) === undefined) continue;
    const a = map.joints[name] as V3 | undefined, e = boneEnd(map, name);
    if (!a || !e) continue;
    const p: V3 = [body.positions[v * 3], body.positions[v * 3 + 1], body.positions[v * 3 + 2]];
    const u = norm(sub(e, a));
    const c = add(a, scale(u, Math.min(Math.max(dot(sub(p, a), u), 0), len(sub(e, a)))));
    const radial = sub(p, c);
    let r = 1;
    if (!isIn(p)) {
      r = 0;
      for (let s = 0.97; s >= 0.45; s -= 0.01) {
        if (isIn(add(c, scale(radial, s)))) {
          r = s;
          break;
        }
      }
      if (!r) continue;
    }
    if (!ratios.has(name)) ratios.set(name, []);
    ratios.get(name)!.push(r);
  }
  const out: Girth = {};
  for (const [b, rs] of ratios) {
    rs.sort((x, y) => x - y);
    const q = rs[Math.floor((1 - inside) * (rs.length - 1))];
    if (q < 1) out[b] = Math.max(floor(b)!, q);
  }
  return out;
}

function vertexNormals(p: Float32Array, index: Uint32Array): Float32Array {
  const n = new Float32Array(p.length);
  for (let t = 0; t < index.length; t += 3) {
    const a = index[t] * 3, b = index[t + 1] * 3, c = index[t + 2] * 3;
    const e1: V3 = [p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]];
    const e2: V3 = [p[c] - p[a], p[c + 1] - p[a + 1], p[c + 2] - p[a + 2]];
    const f = cross(e1, e2);
    for (const i of [a, b, c]) {
      n[i] += f[0];
      n[i + 1] += f[1];
      n[i + 2] += f[2];
    }
  }
  for (let i = 0; i < n.length; i += 3) {
    const l = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1;
    n[i] /= l;
    n[i + 1] /= l;
    n[i + 2] /= l;
  }
  return n;
}
