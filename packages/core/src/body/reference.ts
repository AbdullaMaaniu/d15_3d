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

/** Thickness multipliers per reference bone (around the bone), e.g. from `insideScale`. */
export type BoneScale = Partial<Record<string, number>>;

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
function shapeReference(ref: ReferenceBody, shape: BodyShape, boneScale: BoneScale = {}): Float32Array {
  const out = Float32Array.from(ref.positions);
  const overall = shape.overall ?? 1;
  const active = (Object.keys(CONTROL_AREAS) as BodyControl[]).filter((k) => Math.abs((shape[k] ?? 1) - 1) > 1e-6);
  const head = shape.head ?? 1;
  const scaled = ref.bones.map((b) => boneScale[b] ?? 1);
  if (!active.length && Math.abs(overall - 1) < 1e-6 && Math.abs(head - 1) < 1e-6 && scaled.every((m) => m === 1)) return out;
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
      let m = overall * scaled[b];
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

/**
 * Maps the torso by height along its joint chain: a point at some height of the
 * reference torso goes to the same fraction of the rig's matching segment, with
 * its offset from the chain turned with the torso and scaled to the build.
 */
function torsoMap(R: JointMap, map: JointMap, thick: number): ((p: V3) => V3) | null {
  const chain = ['hips', 'spine', 'chest', 'upperChest', 'neck'].filter((b) => R.joints[b] && map.joints[b]);
  if (chain.length < 2 || chain[0] !== 'hips') return null;
  const rp = chain.map((b) => R.joints[b] as V3), tp = chain.map((b) => map.joints[b] as V3);
  const ru = norm(sub(rp[rp.length - 1], rp[0]));
  const rot = rotationBetween(ru, norm(sub(tp[tp.length - 1], tp[0])));
  const h = rp.map((p) => dot(sub(p, rp[0]), ru));
  return (p) => {
    const hp = dot(sub(p, rp[0]), ru);
    // Segment containing this height (the end segments extend past the ends).
    let i = 0;
    while (i < h.length - 2 && hp > h[i + 1]) i++;
    const f = (hp - h[i]) / (h[i + 1] - h[i] || 1);
    const rc = add(rp[i], scale(sub(rp[i + 1], rp[i]), f));
    const tc = add(tp[i], scale(sub(tp[i + 1], tp[i]), f));
    return add(tc, scale(mul3(rot, sub(p, rc)), thick));
  };
}

/**
 * Fits the reference body to a humanoid rig. Bones the rig doesn't have hand
 * their vertices to the nearest parent it does have.
 */
export function fitReferenceBody(ref: ReferenceBody, map: JointMap, shape: BodyShape = {}, boneScale: BoneScale = {}): BodyMesh {
  const R = ref.joints, J = map.joints;
  const span = (m: JointMap, a: string, b: string) => (m.joints[a] && m.joints[b] ? len(sub(m.joints[a], m.joints[b])) : NaN);
  // Thickness follows the character's build: shoulder span and torso length against the reference's.
  const ratios = [span(map, 'leftUpperArm', 'rightUpperArm') / span(R, 'leftUpperArm', 'rightUpperArm'), span(map, 'hips', 'neck') / span(R, 'hips', 'neck')].filter(Number.isFinite);
  const thick = ratios.length ? ratios.reduce((s, r) => s + r, 0) / ratios.length : 1;

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
  const TORSO = ['hips', 'spine', 'chest', 'upperChest'];
  const torso = torsoMap(R, map, thick);
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
      // Heads, hands and feet keep their own proportions; limbs take the build.
      const along = len(td) / (len(rd) || 1);
      m = boneMatrix(ra, ta, rotationBetween(ru, norm(td)), ru, along, /head|Hand|Foot|Toes/.test(b) ? along : thick);
    }
    xf.set(b, (p) => apply34(m, p));
  }

  const src = shapeReference(ref, shape, boneScale);
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
  const skinIndex = new Uint16Array(V * 4), skinWeight = new Float32Array(V * 4);
  for (let v = 0; v < V; v++) {
    const acc = new Map<number, number>();
    for (let k = 0; k < 4; k++) {
      const w = ref.skinWeight[v * 4 + k];
      if (w > 0) {
        const b = boneOf[ref.skinIndex[v * 4 + k]];
        acc.set(b, (acc.get(b) ?? 0) + w);
      }
    }
    [...acc].forEach(([b, w], i) => {
      skinIndex[v * 4 + i] = b;
      skinWeight[v * 4 + i] = w;
    });
  }
  return { positions, normals: vertexNormals(positions, ref.index), index: ref.index, skinIndex, skinWeight, bones };
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

/**
 * How much to slim each part of the fitted body so it sits inside the
 * character's own surface (its clothes): for each bone, the share of its
 * surface that pokes out is pulled in toward the bone until most of it is
 * inside. Only ever slims; roomy clothes don't fatten the body.
 *
 * `solid` is the character voxelized in rig space (see `Kernels.voxelize`).
 */
export function insideScale(ref: ReferenceBody, map: JointMap, solid: VoxelGrid, options: { inside?: number; min?: number } = {}): BoneScale {
  // Neighbouring bones share their blend zones, so later passes catch what the first left out.
  let scaleBy: BoneScale = {};
  for (let pass = 0; pass < 4; pass++) {
    const more = insidePass(ref, map, solid, scaleBy, options);
    const next: BoneScale = { ...scaleBy };
    for (const [b, m] of Object.entries(more)) next[b] = Math.max(options.min ?? 0.45, (next[b] ?? 1) * m!);
    scaleBy = next;
  }
  return scaleBy;
}

function insidePass(ref: ReferenceBody, map: JointMap, solid: VoxelGrid, current: BoneScale, options: { inside?: number; min?: number }): BoneScale {
  const inside = options.inside ?? 0.95, min = options.min ?? 0.45;
  const body = fitReferenceBody(ref, map, {}, current);
  const isIn = (p: V3) => {
    const x = Math.floor((p[0] - solid.origin[0]) / solid.dx), y = Math.floor((p[1] - solid.origin[1]) / solid.dx), z = Math.floor((p[2] - solid.origin[2]) / solid.dx);
    return x >= 0 && y >= 0 && z >= 0 && x < solid.nx && y < solid.ny && z < solid.nz && solid.data[x + solid.nx * (y + solid.ny * z)] !== 0;
  };
  // Each vertex belongs to its strongest bone; measure against that bone's axis in the rig.
  const ratios = new Map<number, number[]>();
  const V = body.positions.length / 3;
  for (let v = 0; v < V; v++) {
    let best = -1, bw = 0;
    for (let k = 0; k < FIT_SLOTS; k++) {
      const w = ref.fitWeight[v * FIT_SLOTS + k];
      if (w > bw) {
        bw = w;
        best = ref.fitIndex[v * FIT_SLOTS + k];
      }
    }
    const name = ref.bones[best];
    // Hands, feet and the head are too small to measure against a voxel grid (and gloves, shoes and hair are roomy anyway).
    if (/head|Hand|Foot|Toes/.test(name)) continue;
    const a = map.joints[name] as V3 | undefined, e = boneEnd(map, name);
    if (!a || !e) continue;
    const p: V3 = [body.positions[v * 3], body.positions[v * 3 + 1], body.positions[v * 3 + 2]];
    const u = norm(sub(e, a));
    const t = Math.min(Math.max(dot(sub(p, a), u), 0), len(sub(e, a)));
    const c = add(a, scale(u, t));
    const radial = sub(p, c);
    let r = 1;
    if (!isIn(p)) {
      r = 0;
      for (let s = 0.95; s >= min; s -= 0.05) {
        if (isIn(add(c, scale(radial, s)))) {
          r = s;
          break;
        }
      }
      // Out of reach of slimming (the fit is off there, not the thickness): ignore it.
      if (!r) continue;
    }
    if (!ratios.has(best)) ratios.set(best, []);
    ratios.get(best)!.push(r);
  }
  const out: BoneScale = {};
  for (const [b, rs] of ratios) {
    rs.sort((x, y) => x - y);
    const q = rs[Math.floor((1 - inside) * (rs.length - 1))];
    if (q < 1) out[ref.bones[b]] = Math.max(min, q);
  }
  return out;
}
