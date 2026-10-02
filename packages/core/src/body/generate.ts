import type { JointMap } from '../skeleton';

/**
 * A normal human body generated along the rig: every body part is a smooth
 * tapered shape around its bone, with separate side / front / back widths at a
 * few rings (deltoid, biceps, elbow, ...). Widths are average adult
 * measurements, scaled per region by the rig's own bone lengths (torso, arms,
 * legs), so the body lines up with the skeleton without copying the
 * character's stylised bulk. Each limb and the torso is one chain; chains are
 * blended with a smooth union so shoulders and hips join naturally. Fingers are
 * tubes along the finger bones. The shape controls scale individual rings.
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
  /** Parts of one limb or the torso form a chain: joined without blending. */
  chain: number;
  /** Length of the rounded end caps, as a fraction of the radius (short inside a chain). */
  capA: number;
  capB: number;
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
  return { a, b, bone: a.bone, u, len: l, f, s: cross(u, f), chain: 0, capA: 1, capB: 1 };
}

/**
 * Scale of each region relative to an average adult (meters per reference meter),
 * from the rig's own bone lengths: the body gets normal human proportions for
 * those bones, whatever the character's styling around them.
 */
export function bodyScales(map: JointMap): { torso: number; arms: number; legs: number } {
  const J = map.joints;
  const torso = len(sub(J.neck, J.hips)) / REF.torsoLength;
  const limb = (side: string, names: string[], ref: number) => {
    const pts = names.map((n) => J[`${side}${n}`] as V3 | undefined);
    if (pts.some((p) => !p)) return null;
    let l = 0;
    for (let i = 1; i < pts.length; i++) l += len(sub(pts[i]!, pts[i - 1]!));
    return l / ref;
  };
  const avg = (a: number | null, b: number | null, fallback: number) => (a && b ? (a + b) / 2 : a ?? b ?? fallback);
  const arms = avg(limb('left', ['UpperArm', 'LowerArm', 'Hand'], REF.armLength), limb('right', ['UpperArm', 'LowerArm', 'Hand'], REF.armLength), torso);
  const legs = avg(limb('left', ['UpperLeg', 'LowerLeg', 'Foot'], REF.legLength), limb('right', ['UpperLeg', 'LowerLeg', 'Foot'], REF.legLength), torso);
  return { torso, arms, legs };
}

/**
 * An average adult (about 1.75 m), in meters: segment lengths, and half-widths
 * (side, front, back) of the body's cross-sections. Girths follow common
 * anthropometric averages (neck 38 cm, biceps 31 cm, thigh 56 cm, calf 37 cm ...).
 */
const REF = {
  torsoLength: 0.5, // hip joints' level to the base of the neck
  armLength: 0.56, // shoulder to wrist
  legLength: 0.86, // hip to ankle
  // Torso rings: fraction along the torso (0 = hips, 1 = base of the neck), half-widths.
  torso: [
    { t: -0.2, side: 0.14, front: 0.085, back: 0.115, zone: 'pelvis' },
    { t: 0.0, side: 0.168, front: 0.1, back: 0.118, zone: 'pelvis' },
    { t: 0.2, side: 0.152, front: 0.098, back: 0.092, zone: 'waist' },
    { t: 0.36, side: 0.138, front: 0.098, back: 0.088, zone: 'waist' },
    { t: 0.55, side: 0.15, front: 0.102, back: 0.094, zone: 'chest' },
    { t: 0.72, side: 0.164, front: 0.112, back: 0.1, zone: 'chest' },
    { t: 0.88, side: 0.17, front: 0.094, back: 0.098, zone: 'shoulders' },
    { t: 1.0, side: 0.1, front: 0.058, back: 0.072, zone: 'neck' },
  ],
  neck: 0.058,
  neckLength: 0.1,
  head: { height: 0.23, side: 0.077, front: 0.1, back: 0.098 },
  arm: {
    deltoid: 0.054,
    upper: [
      { t: 0.18, side: 0.05, front: 0.05, back: 0.053 },
      { t: 0.5, side: 0.044, front: 0.05, back: 0.05 },
      { t: 0.85, side: 0.041, front: 0.04, back: 0.042 },
    ],
    elbow: { side: 0.04, front: 0.038, back: 0.04 },
    fore: [
      { t: 0.25, side: 0.044, front: 0.04, back: 0.041 },
      { t: 0.62, side: 0.034, front: 0.03, back: 0.031 },
    ],
    wrist: { side: 0.02, front: 0.028, back: 0.028 },
    palm: { length: 0.1, side: 0.015, width: 0.042 },
  },
  leg: {
    upper: [
      { t: 0.0, side: 0.085, front: 0.08, back: 0.088 },
      { t: 0.3, side: 0.078, front: 0.082, back: 0.078 },
      { t: 0.72, side: 0.062, front: 0.062, back: 0.058 },
    ],
    knee: { side: 0.052, front: 0.055, back: 0.05 },
    lower: [
      { t: 0.3, side: 0.05, front: 0.044, back: 0.066 },
      { t: 0.66, side: 0.04, front: 0.038, back: 0.04 },
    ],
    ankle: { side: 0.035, front: 0.032, back: 0.03 },
    foot: { length: 0.26, heelWidth: 0.033, ballWidth: 0.05, height: 0.035 },
  },
  fingers: { Thumb: 0.0105, Index: 0.0095, Middle: 0.0097, Ring: 0.009, Little: 0.008 } as Record<string, number>,
};

/** Point at distance fraction t along a polyline (extrapolated past the ends). */
function along(pts: V3[], t: number): V3 {
  const seg: number[] = [];
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    const l = len(sub(pts[i], pts[i - 1]));
    seg.push(l);
    total += l;
  }
  let d = t * total;
  if (d <= 0) return add(pts[0], scale(norm(sub(pts[1], pts[0])), d));
  for (let i = 0; i < seg.length; i++) {
    if (d <= seg[i] || i === seg.length - 1) return lerp(pts[i], pts[i + 1], seg[i] > 0 ? d / seg[i] : 0);
    d -= seg[i];
  }
  return pts[pts.length - 1];
}

/**
 * Rings and parts of a humanoid body for these joints: average adult
 * proportions, scaled per region by the rig's bone lengths.
 */
export function bodyParts(map: JointMap, shape: BodyShape = {}): Segment[] {
  const J = map.joints;
  const m = (k: BodyControl) => (shape[k] ?? 1) * (k === 'overall' ? 1 : shape.overall ?? 1);
  const sc = bodyScales(map);
  const ring = (c: V3, side: number, front: number, back: number, bone: string): Ring => ({ c, side, front, back, bone });
  const segs: Segment[] = [];
  let chainId = 0;
  const chain = (rings: Ring[], front: V3 = [0, 0, 1]) => {
    const id = chainId++;
    for (let i = 0; i + 1 < rings.length; i++) {
      const g = segment(rings[i], rings[i + 1], front);
      g.chain = id;
      // Full rounded caps only at the ends of the chain; inside it, short ones just fill bends.
      g.capA = i === 0 ? 1 : 0.3;
      g.capB = i + 2 === rings.length ? 1 : 0.3;
      segs.push(g);
    }
  };

  // Torso, along the spine from below the hips to the base of the neck.
  const T = sc.torso;
  const spine: V3[] = [J.hips, J.spine, J.chest, J.upperChest, J.neck].filter(Boolean) as V3[];
  const torsoBone = (t: number) => (t < 0.28 ? 'hips' : t < 0.5 && J.spine ? 'spine' : t < 0.8 && J.chest ? 'chest' : J.upperChest ? 'upperChest' : J.chest ? 'chest' : 'spine');
  const zoneMul = (zone: string): [number, number, number] => {
    switch (zone) {
      case 'pelvis': return [m('hips'), m('hips'), m('glutes')];
      case 'waist': return [m('waist'), m('waist') * m('belly'), m('waist')];
      case 'chest': return [m('chest'), m('chest'), m('back')];
      case 'shoulders': return [m('shoulders'), m('chest'), m('back')];
      default: return [m('neck'), m('neck'), m('neck')];
    }
  };
  const torso = REF.torso.map((r) => {
    const [ms, mf, mb] = zoneMul(r.zone);
    return ring(along(spine, r.t), r.side * T * ms, r.front * T * mf, r.back * T * mb, torsoBone(r.t));
  });
  chain(torso);

  // Neck and a human head on it (not the character's head: that stays the model's own).
  const up = norm(sub(J.neck, J.hips));
  const neckR = REF.neck * T * m('neck');
  const neckTop = add(J.neck, scale(up, REF.neckLength * T));
  chain([ring(J.neck, neckR * 1.15, neckR, neckR * 1.1, 'neck'), ring(neckTop, neckR, neckR * 0.95, neckR, 'head')]);
  const H = REF.head;
  const hs = T * m('head');
  const chin = add(neckTop, [0, 0, 0.035 * hs]);
  const skull = add(neckTop, add(scale(up, H.height * 0.62 * hs), [0, 0, 0.005 * hs]));
  const crown = H.side * hs;
  // Jaw: narrower and forward; cranium: an egg ending at the top of the head.
  chain([ring(add(chin, scale(up, 0.02 * hs)), 0.045 * hs, 0.045 * hs, 0.05 * hs, 'head'), ring(add(neckTop, scale(up, H.height * 0.4 * hs)), crown * 0.92, H.front * 0.85 * hs, H.back * 0.8 * hs, 'head')]);
  const capR = Math.min(crown, H.front * hs);
  chain([ring(add(skull, scale(up, -0.04 * hs)), crown, H.front * hs, H.back * hs, 'head'), ring(add(skull, scale(up, H.height * 0.38 * hs - capR)), crown * 0.96, H.front * 0.95 * hs, H.back * 0.95 * hs, 'head')]);

  for (const side of ['left', 'right'] as const) {
    const j = (n: string) => J[`${side}${n}`] as V3 | undefined;
    // Arm.
    const collar = j('Shoulder'), sh = j('UpperArm'), el = j('LowerArm'), wr = j('Hand');
    if (sh && el && wr) {
      const A = sc.arms;
      const out = norm(sub(sh, J.upperChest ?? J.chest ?? J.neck));
      // Deltoid: never wider than the torso's shoulders allow.
      const del = Math.min(REF.arm.deltoid * A, 0.4 * len(sub(sh, collar ?? sh)) + REF.arm.deltoid * A * 0.6) * m('deltoids');
      // Collarbone and trapezius bridge from the chest to the shoulder.
      if (collar) chain([ring(collar, 0.045 * T * m('shoulders'), 0.04 * T, 0.05 * T * m('back'), `${side}Shoulder`), ring(add(sh, scale(out, -0.01 * A)), del * 0.85, del * 0.8, del * 0.85, `${side}Shoulder`)]);
      // Deltoid cap over the shoulder joint.
      const cap = add(sh, add(scale(out, 0.012 * A), scale(up, 0.008 * A)));
      chain([ring(cap, del, del, del * 1.05, `${side}UpperArm`), ring(lerp(sh, el, 0.18), REF.arm.upper[0].side * A * m('deltoids'), REF.arm.upper[0].front * A * m('deltoids'), REF.arm.upper[0].back * A * m('deltoids'), `${side}UpperArm`)]);
      const upper = REF.arm.upper.map((r, i) =>
        ring(lerp(sh, el, r.t), r.side * A * (i === 1 ? Math.sqrt(m('biceps') * m('triceps')) : 1), r.front * A * (i === 1 ? m('biceps') : 1), r.back * A * (i === 1 ? m('triceps') : 1), `${side}UpperArm`),
      );
      const E = REF.arm.elbow;
      chain([...upper, ring(el, E.side * A * m('elbows'), E.front * A * m('elbows'), E.back * A * m('elbows'), `${side}UpperArm`)]);
      const fore = REF.arm.fore.map((r) => ring(lerp(el, wr, r.t), r.side * A * m('forearms'), r.front * A * m('forearms'), r.back * A * m('forearms'), `${side}LowerArm`));
      const W = REF.arm.wrist;
      chain([ring(el, E.side * A * m('elbows'), E.front * A * m('elbows'), E.back * A * m('elbows'), `${side}LowerArm`), ...fore, ring(wr, W.side * A * m('wrists'), W.front * A * m('wrists'), W.back * A * m('wrists'), `${side}LowerArm`)]);
      // Palm: from the wrist to the knuckles; flat across the palm. Fingers are tubes (see fingerTubes).
      const knuckle = j('MiddleProximal') ?? add(wr, scale(norm(sub(wr, el)), REF.arm.palm.length * A));
      const P = REF.arm.palm;
      const across = j('IndexProximal') && j('LittleProximal') ? norm(sub(j('IndexProximal')!, j('LittleProximal')!)) : ([0, 0, 1] as V3);
      chain(
        [
          ring(lerp(wr, knuckle, 0.15), P.side * A, P.width * 0.8 * A, P.width * 0.8 * A, `${side}Hand`),
          ring(lerp(wr, knuckle, 0.85), P.side * 0.85 * A, P.width * A, P.width * A, `${side}Hand`),
        ],
        across,
      );
      if (!j('MiddleProximal')) {
        // No finger bones: a relaxed mitten.
        const tip = add(knuckle, scale(norm(sub(knuckle, wr)), 0.08 * A));
        chain([ring(knuckle, P.side * 0.8 * A, P.width * 0.95 * A, P.width * 0.95 * A, `${side}Hand`), ring(tip, P.side * 0.6 * A, P.width * 0.75 * A, P.width * 0.75 * A, `${side}Hand`)], across);
      }
    }
    // Leg.
    const hp = j('UpperLeg'), kn = j('LowerLeg'), an = j('Foot');
    if (hp && kn && an) {
      const L = sc.legs;
      const upper = REF.leg.upper.map((r) => ring(lerp(hp, kn, r.t), r.side * L * m('thighs'), r.front * L * m('thighs'), r.back * L * m('thighs'), `${side}UpperLeg`));
      const K = REF.leg.knee;
      chain([...upper, ring(kn, K.side * L * m('knees'), K.front * L * m('knees'), K.back * L * m('knees'), `${side}UpperLeg`)]);
      const lower = REF.leg.lower.map((r, i) => ring(lerp(kn, an, r.t), r.side * L * (i === 0 ? m('calves') : 1), r.front * L, r.back * L * (i === 0 ? m('calves') : 1), `${side}LowerLeg`));
      const Ak = REF.leg.ankle;
      const ankle = ring(an, Ak.side * L * m('ankles'), Ak.front * L * m('ankles'), Ak.back * L * m('ankles'), `${side}LowerLeg`);
      chain([ring(kn, K.side * L * m('knees'), K.front * L * m('knees'), K.back * L * m('knees'), `${side}LowerLeg`), ...lower, ankle]);
      // Foot: heel, arch and ball on the ground, toes forward. Front = up, so "side" is the width.
      const F = REF.leg.foot;
      const toes = j('Toes');
      const toeTip = (map.tails[`${side}Toes`] as V3 | undefined) ?? (toes ? add(toes, [0, 0, 0.06 * L]) : add(an, [0, -0.07 * L, 0.18 * L]));
      const sole = Math.min(toeTip[1], toes?.[1] ?? Infinity, an[1] - 0.06 * L) - 0.005 * L;
      const h = F.height * L;
      // Direction from the shoes; size from a human foot.
      const fwd = norm([toeTip[0] - an[0], 0, toeTip[2] - an[2]]);
      const fl = F.length * L;
      const footAt = (d: number, hgt: number): V3 => [an[0] + fwd[0] * d * fl, sole + hgt, an[2] + fwd[2] * d * fl];
      const heel = ring(footAt(-0.12, h * 0.95), F.heelWidth * L, h * 0.95, h * 0.95, `${side}Foot`);
      const arch = ring(footAt(0.18, h * 1.2), (F.heelWidth + F.ballWidth) * 0.5 * L, h * 1.2, h * 0.9, `${side}Foot`);
      const ball = ring(footAt(0.52, h * 0.75), F.ballWidth * L, h * 0.75, h * 0.7, toes ? `${side}Toes` : `${side}Foot`);
      const tip = ring(footAt(0.74, h * 0.5), F.ballWidth * 0.82 * L, h * 0.5, h * 0.45, ball.bone);
      chain([ring(an, Ak.side * L * m('ankles'), Ak.front * L * m('ankles'), Ak.back * L * m('ankles'), `${side}Foot`), arch], [0, 0, 1]);
      chain([heel, arch, ball, tip], [0, 1, 0]);
    }
  }
  return segs;
}

/** Tube meshes for the fingers (thinner than the surface grid can resolve), with their weights. */
function fingerTubes(map: JointMap, armScale: number): { positions: number[]; normals: number[]; index: number[]; bones: string[][]; weights: number[][] } {
  const J = map.joints, Tl = map.tails;
  const out = { positions: [] as number[], normals: [] as number[], index: [] as number[], bones: [] as string[][], weights: [] as number[][] };
  const SIDES = 10;
  for (const side of ['left', 'right']) {
    for (const finger of ['Thumb', 'Index', 'Middle', 'Ring', 'Little']) {
      const names = finger === 'Thumb' ? ['Metacarpal', 'Proximal', 'Distal'] : ['Proximal', 'Intermediate', 'Distal'];
      const pts = names.map((n) => J[`${side}${finger}${n}`] as V3 | undefined);
      const tip = Tl[`${side}${finger}Distal`] as V3 | undefined;
      if (pts.some((p) => !p) || !tip) continue;
      const chainPts = [...(pts as V3[]), tip];
      const bones = names.map((n) => `${side}${finger}${n}`);
      const r0 = REF.fingers[finger] * armScale;
      // Start a little inside the palm so the finger is rooted in it.
      const start = add(chainPts[0], scale(norm(sub(chainPts[0], chainPts[1])), r0 * 1.2));
      // Samples along the chain: (point, radius, bone weights).
      const samples: Array<{ p: V3; r: number; w: Array<[string, number]> }> = [];
      samples.push({ p: start, r: r0 * (finger === 'Thumb' ? 1.25 : 1.05), w: [[bones[0], 1]] });
      for (let s = 0; s < 3; s++) {
        const a = chainPts[s], b = chainPts[s + 1];
        for (let k = 0; k < 4; k++) {
          const t = k / 4;
          // Tapers toward the tip; slightly fuller at each pad.
          const r = r0 * (1 - 0.1 * (s + t)) * (1 + 0.06 * Math.sin(Math.PI * t));
          // Blend into the next bone near the joint ahead.
          const w: Array<[string, number]> = t > 0.75 && s < 2 ? [[bones[s], 1 - (t - 0.75) * 2], [bones[s + 1], (t - 0.75) * 2]] : [[bones[s], 1]];
          samples.push({ p: lerp(a, b, t), r, w });
        }
      }
      const last = chainPts[3], dir = norm(sub(chainPts[3], chainPts[2]));
      const rt = r0 * 0.72;
      // Rounded tip: shrinking rings past the tip point.
      for (let k = 0; k <= 4; k++) {
        const a = (k / 4) * (Math.PI / 2);
        samples.push({ p: add(last, scale(dir, Math.sin(a) * rt - rt * 0.4)), r: Math.max(rt * Math.cos(a), rt * 0.05), w: [[bones[2], 1]] });
      }
      // Rings perpendicular to the chain.
      const base = out.positions.length / 3;
      let prevF: V3 = [0, 1, 0];
      samples.forEach((smp, i) => {
        const nxt = samples[Math.min(i + 1, samples.length - 1)].p, prv = samples[Math.max(i - 1, 0)].p;
        const tdir = norm(sub(nxt, prv));
        let f = sub(prevF, scale(tdir, dot(prevF, tdir)));
        if (len(f) < 1e-6) f = Math.abs(tdir[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
        f = norm(f);
        prevF = f;
        const sdir = cross(tdir, f);
        for (let k = 0; k < SIDES; k++) {
          const ang = (k / SIDES) * Math.PI * 2;
          // Fingers are a little flatter than round.
          const n = add(scale(f, Math.cos(ang)), scale(sdir, Math.sin(ang)));
          const p = add(smp.p, add(scale(f, Math.cos(ang) * smp.r * 0.88), scale(sdir, Math.sin(ang) * smp.r)));
          out.positions.push(...p);
          out.normals.push(...norm(n));
          out.bones.push(smp.w.map((x) => x[0]));
          out.weights.push(smp.w.map((x) => x[1]));
        }
      });
      // Close the base (inside the palm) with a fan.
      const centre = out.positions.length / 3;
      out.positions.push(...samples[0].p);
      out.normals.push(...scale(norm(sub(samples[0].p, samples[1].p)), 1));
      out.bones.push(samples[0].w.map((x) => x[0]));
      out.weights.push(samples[0].w.map((x) => x[1]));
      for (let k = 0; k < SIDES; k++) out.index.push(centre, base + k, base + ((k + 1) % SIDES));
      for (let i = 0; i + 1 < samples.length; i++) {
        for (let k = 0; k < SIDES; k++) {
          const a = base + i * SIDES + k, b = base + i * SIDES + ((k + 1) % SIDES), c = base + (i + 1) * SIDES + k, d = base + (i + 1) * SIDES + ((k + 1) % SIDES);
          out.index.push(a, c, b, b, c, d);
        }
      }
      // Close the fingertip.
      const tipC = out.positions.length / 3, lastRing = base + (samples.length - 1) * SIDES;
      out.positions.push(...add(samples[samples.length - 1].p, scale(dir, rt * 0.05)));
      out.normals.push(...dir);
      out.bones.push([bones[2]]);
      out.weights.push([1]);
      for (let k = 0; k < SIDES; k++) out.index.push(tipC, lastRing + ((k + 1) % SIDES), lastRing + k);
    }
  }
  return out;
}

/** Approximate signed distance to one part (negative inside). */
function partDistance(g: Segment, px: number, py: number, pz: number): number {
  const dx = px - g.a.c[0], dy = py - g.a.c[1], dz = pz - g.a.c[2];
  const along = dx * g.u[0] + dy * g.u[1] + dz * g.u[2];
  const t0 = g.len > 0 ? Math.min(1, Math.max(0, along / g.len)) : 0;
  // Eased taper: widths meet the neighbouring parts without a crease at the rings.
  const t = t0 * t0 * (3 - 2 * t0);
  const side = g.a.side + (g.b.side - g.a.side) * t;
  const fr = dx * g.f[0] + dy * g.f[1] + dz * g.f[2];
  const front = fr >= 0 ? g.a.front + (g.b.front - g.a.front) * t : g.a.back + (g.b.back - g.a.back) * t;
  const sd = dx * g.s[0] + dy * g.s[1] + dz * g.s[2];
  // Past the ends the part closes with a rounded cap as long as its smaller radius.
  const beyond = along < 0 ? along : along > g.len ? along - g.len : 0;
  const capR = Math.min(side, front) * (along < 0 ? g.capA : g.capB) + 1e-6;
  const e = Math.sqrt((sd / side) ** 2 + (fr / front) ** 2 + (beyond / capR) ** 2);
  return (e - 1) * Math.min(side, front);
}

/** Turns every triangle to face the way its vertex normals point (outwards). */
function orient(positions: ArrayLike<number>, normals: ArrayLike<number>, index: Uint32Array): void {
  for (let t = 0; t < index.length; t += 3) {
    const a = index[t], b = index[t + 1], c = index[t + 2];
    const ab: V3 = [positions[b * 3] - positions[a * 3], positions[b * 3 + 1] - positions[a * 3 + 1], positions[b * 3 + 2] - positions[a * 3 + 2]];
    const ac: V3 = [positions[c * 3] - positions[a * 3], positions[c * 3 + 1] - positions[a * 3 + 1], positions[c * 3 + 2] - positions[a * 3 + 2]];
    const fn = cross(ab, ac);
    let o = 0;
    for (const v of [a, b, c]) o += fn[0] * normals[v * 3] + fn[1] * normals[v * 3 + 1] + fn[2] * normals[v * 3 + 2];
    if (o < 0) {
      index[t + 1] = c;
      index[t + 2] = b;
    }
  }
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
  const sc = bodyScales(map);
  // Blend width: joins stay smooth without turning limbs into blobs.
  const k = 0.03 * sc.torso;
  // Each part only matters near itself: its bounds, padded by the blend width.
  const box = segs.map((g) => {
    const pad = Math.max(g.a.side, g.a.front, g.a.back, g.b.side, g.b.front, g.b.back) + k;
    return [0, 1, 2].flatMap((i) => [Math.min(g.a.c[i], g.b.c[i]) - pad, Math.max(g.a.c[i], g.b.c[i]) + pad]);
  });
  const chains = [...new Set(segs.map((g) => g.chain))].map((c) => segs.map((g, i) => (g.chain === c ? i : -1)).filter((i) => i >= 0));
  const field = (x: number, y: number, z: number) => {
    let d = 1e9;
    for (const members of chains) {
      let c = 1e9;
      for (const s of members) {
        const b = box[s];
        if (x < b[0] || x > b[1] || y < b[2] || y > b[3] || z < b[4] || z > b[5]) continue;
        c = Math.min(c, partDistance(segs[s], x, y, z));
      }
      if (c < 1e9) d = smin(d, c, k);
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
  const h = options.cell ?? height / 140;
  const nx = Math.ceil((hi[0] - lo[0]) / h) + 2, ny = Math.ceil((hi[1] - lo[1]) / h) + 2, nz = Math.ceil((hi[2] - lo[2]) / h) + 2;
  const ox = lo[0] - h, oy = lo[1] - h, oz = lo[2] - h;
  const at = (i: number, j: number, l: number) => i + nx * (j + ny * l);
  // Each chain over its own box: its parts joined with a plain minimum, then
  // blended smoothly into the rest of the body.
  const val = new Float32Array(nx * ny * nz).fill(1e9);
  for (const members of chains) {
    const cb = [Infinity, -Infinity, Infinity, -Infinity, Infinity, -Infinity];
    for (const s of members) for (let q = 0; q < 6; q++) cb[q] = q % 2 ? Math.max(cb[q], box[s][q]) : Math.min(cb[q], box[s][q]);
    const i0 = Math.max(0, Math.floor((cb[0] - ox) / h)), i1 = Math.min(nx - 1, Math.ceil((cb[1] - ox) / h));
    const j0 = Math.max(0, Math.floor((cb[2] - oy) / h)), j1 = Math.min(ny - 1, Math.ceil((cb[3] - oy) / h));
    const l0 = Math.max(0, Math.floor((cb[4] - oz) / h)), l1 = Math.min(nz - 1, Math.ceil((cb[5] - oz) / h));
    for (let l = l0; l <= l1; l++) for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const x = ox + i * h, y = oy + j * h, z = oz + l * h;
      let c = 1e9;
      for (const s of members) {
        const b = box[s];
        if (x < b[0] || x > b[1] || y < b[2] || y > b[3] || z < b[4] || z > b[5]) continue;
        c = Math.min(c, partDistance(segs[s], x, y, z));
      }
      if (c >= 1e9) continue;
      const id = at(i, j, l);
      val[id] = smin(val[id], c, k);
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

  const index = Uint32Array.from(tris);
  orient(positions, normals, index);

  // Weights: each vertex follows the parts it lies on, blending where they meet.
  const bones = [...new Set(segs.map((g) => g.bone))];
  const boneOf = segs.map((g) => bones.indexOf(g.bone));
  const V = positions.length / 3;
  const skinIndex = new Uint16Array(V * 4), skinWeight = new Float32Array(V * 4);
  const acc = new Float64Array(bones.length);
  const blend = 0.06 * sc.torso;
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
  // Fingers: tubes along the finger bones, rooted in the palm.
  const tubes = fingerTubes(map, sc.arms);
  if (!tubes.index.length) return { positions, normals, index, skinIndex, skinWeight, bones };
  const extra = tubes.positions.length / 3;
  const allBones = [...bones];
  for (const list of tubes.bones) for (const b of list) if (!allBones.includes(b)) allBones.push(b);
  const P = new Float32Array(positions.length + tubes.positions.length);
  P.set(positions);
  P.set(tubes.positions, positions.length);
  const N = new Float32Array(P.length);
  N.set(normals);
  N.set(tubes.normals, normals.length);
  const I = new Uint32Array(index.length + tubes.index.length);
  I.set(index);
  for (let i = 0; i < tubes.index.length; i++) I[index.length + i] = tubes.index[i] + V;
  orient(P, N, I);
  const SI = new Uint16Array((V + extra) * 4), SW = new Float32Array((V + extra) * 4);
  SI.set(skinIndex);
  SW.set(skinWeight);
  for (let v = 0; v < extra; v++) {
    tubes.bones[v].forEach((b, k) => {
      SI[(V + v) * 4 + k] = allBones.indexOf(b);
      SW[(V + v) * 4 + k] = tubes.weights[v][k];
    });
  }
  return { positions: P, normals: N, index: I, skinIndex: SI, skinWeight: SW, bones: allBones };
}
