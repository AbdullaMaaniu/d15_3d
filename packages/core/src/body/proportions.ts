import { boneDef, type JointMap } from '../skeleton';
import type { BodyShape } from './generate';

type V3 = [number, number, number];

/**
 * Which length control scales the stretch from a bone's joint to its child's
 * joint (or to its tail): the bone's own length.
 */
function lengthControl(bone: string): keyof BodyShape | null {
  if (/UpperLeg|LowerLeg/.test(bone)) return 'legLength';
  if (/Foot|Toes/.test(bone)) return 'footLength';
  if (/UpperArm|LowerArm/.test(bone)) return 'armLength';
  if (/Hand|Thumb|Index|Middle|Ring|Little/.test(bone)) return 'handLength';
  if (/^(hips|spine|chest|upperChest)$/.test(bone)) return 'torsoLength';
  if (bone === 'neck') return 'neckLength';
  if (bone === 'head') return 'head';
  return null;
}

/** Controls that change the skeleton, not only the surface around it. */
export const PROPORTION_CONTROLS = ['height', 'legLength', 'armLength', 'handLength', 'footLength', 'torsoLength', 'neckLength', 'shoulderWidth', 'hipWidth'] as const;

/** True when the shape changes the skeleton's proportions. */
export function changesProportions(shape: BodyShape): boolean {
  return PROPORTION_CONTROLS.some((k) => Math.abs((shape[k] ?? 1) - 1) > 1e-6);
}

/**
 * The rig's joints with the shape's proportions applied: bone lengths (legs,
 * arms, hands, feet, torso, neck, head), shoulder and hip width, and overall
 * height. The feet stay on the ground and the body stays centred over them.
 */
export function proportionJoints(map: JointMap, shape: BodyShape): JointMap {
  if (!changesProportions(shape) && Math.abs((shape.head ?? 1) - 1) < 1e-6) return map;
  const J = map.joints, T = map.tails;
  const f = (k: keyof BodyShape | null) => (k ? shape[k] ?? 1 : 1);
  const joints: Record<string, V3> = {}, tails: Record<string, V3> = {};
  // Parents come before children in the canonical order; resolve on demand to be safe.
  const place = (b: string): V3 => {
    if (joints[b]) return joints[b];
    const p = boneDef(b)?.parent;
    if (!p || !J[p]) return (joints[b] = [...J[b]] as V3);
    const base = place(p);
    const o: V3 = [J[b][0] - J[p][0], J[b][1] - J[p][1], J[b][2] - J[p][2]];
    let s = f(lengthControl(p));
    if (/^(left|right)Shoulder$/.test(b)) {
      // Collarbones start at the top of the torso; their spread is the shoulder width.
      o[0] *= f('shoulderWidth');
      o[1] *= f('torsoLength');
      s = 1;
    } else if (/^(left|right)UpperArm$/.test(b)) {
      o[0] *= f('shoulderWidth');
      s = 1;
    } else if (/^(left|right)UpperLeg$/.test(b)) {
      o[0] *= f('hipWidth');
      s = 1;
    }
    return (joints[b] = [base[0] + o[0] * s, base[1] + o[1] * s, base[2] + o[2] * s]);
  };
  for (const b of Object.keys(J)) place(b);
  for (const b of Object.keys(T)) {
    if (!J[b]) continue;
    const s = f(lengthControl(b));
    tails[b] = [joints[b][0] + (T[b][0] - J[b][0]) * s, joints[b][1] + (T[b][1] - J[b][1]) * s, joints[b][2] + (T[b][2] - J[b][2]) * s];
  }
  // Keep the feet where they stood: lift or lower everything by the change in ankle height.
  const feet = ['leftFoot', 'rightFoot'].filter((b) => J[b]);
  const lift = feet.length ? feet.reduce((s, b) => s + J[b][1] - joints[b][1], 0) / feet.length : 0;
  const hips = J.hips ?? [0, 0, 0];
  const ground = Math.min(...Object.values(J).map((p) => p[1]), ...Object.values(T).map((p) => p[1]));
  const h = f('height');
  const fix = (p: V3): V3 => [hips[0] + (p[0] - hips[0]) * h, ground + (p[1] + lift - ground) * h, hips[2] + (p[2] - hips[2]) * h];
  for (const b of Object.keys(joints)) joints[b] = fix(joints[b]);
  for (const b of Object.keys(tails)) tails[b] = fix(tails[b]);
  return { joints, tails } as JointMap;
}

/**
 * An average adult's skeleton in the rig's pose: every bone keeps the rig's
 * direction (so the rig's animation copies straight across, bone for bone) but
 * takes the reference human's length, scaled to the rig's standing height. A
 * stylised rig (long legs, wide shoulders, big head) still gets a body of
 * normal human proportions. Bones the reference doesn't have (fingers) keep the
 * rig's own. The feet stand on the rig's ground.
 */
export function humanJoints(human: JointMap, map: JointMap): JointMap {
  const H = human.joints, J = map.joints;
  const stand = (m: JointMap) => {
    const feet = ['leftFoot', 'rightFoot'].map((f) => m.joints[f]).filter(Boolean);
    return m.joints.head && feet.length ? m.joints.head[1] - feet.reduce((s, f) => s + f[1], 0) / feet.length : NaN;
  };
  const size = stand(map) / stand(human) || 1;
  const joints: Record<string, V3> = {}, tails: Record<string, V3> = {};
  const offset = (from: V3, to: V3, refFrom?: V3, refTo?: V3): V3 => {
    const d: V3 = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
    if (!refFrom || !refTo) return d;
    const l = Math.hypot(...d), rl = Math.hypot(refTo[0] - refFrom[0], refTo[1] - refFrom[1], refTo[2] - refFrom[2]) * size;
    return l > 1e-9 ? [(d[0] / l) * rl, (d[1] / l) * rl, (d[2] / l) * rl] : d;
  };
  const place = (b: string): V3 => {
    if (joints[b]) return joints[b];
    const p = boneDef(b)?.parent;
    if (!p || !J[p]) return (joints[b] = [...J[b]] as V3);
    const base = place(p);
    const o = offset(J[p], J[b], H[p], H[b]);
    return (joints[b] = [base[0] + o[0], base[1] + o[1], base[2] + o[2]]);
  };
  for (const b of Object.keys(J)) place(b);
  for (const b of Object.keys(map.tails)) {
    if (!J[b]) continue;
    const o = offset(J[b], map.tails[b], H[b], human.tails[b]);
    tails[b] = [joints[b][0] + o[0], joints[b][1] + o[1], joints[b][2] + o[2]];
  }
  const low = (m: { joints: Record<string, V3>; tails: Record<string, V3> }) => Math.min(...Object.values(m.joints).map((p) => p[1]), ...Object.values(m.tails).map((p) => p[1]));
  const lift = low(map as any) - low({ joints, tails });
  for (const p of [...Object.values(joints), ...Object.values(tails)]) p[1] += lift;
  return { joints, tails } as JointMap;
}
