import { Matrix4, Quaternion, Vector3 } from 'three';
import { BODY_BONES } from '../skeleton';
import type { NormalizedClip } from '../anim/retarget';

/**
 * Body poses described with plain joint angles (degrees), so a person or a
 * language model can write them without knowing quaternions or bone frames.
 * Angles are measured from a relaxed standing pose with the arms hanging.
 */
export const POSE_CONTROLS = {
  turn: 'Whole body yaw. + turns to the character\'s left.',
  spineBend: 'Bend the spine. + forward (a bow), - arch back.',
  spineSide: 'Lean sideways. + toward the character\'s left.',
  spineTwist: 'Twist the shoulders. + toward the character\'s left.',
  headNod: 'Tilt the head. + chin down, - look up.',
  headTurn: 'Turn the head. + look to the character\'s left.',
  headTilt: 'Tilt the head sideways. + ear toward the left shoulder.',
  leftShrug: 'Lift the left shoulder (0 to 30).',
  rightShrug: 'Lift the right shoulder (0 to 30).',
  leftArmLift: 'Raise the left arm from hanging: 0 hanging, 90 horizontal, 180 straight up.',
  rightArmLift: 'Raise the right arm from hanging: 0 hanging, 90 horizontal, 180 straight up.',
  leftArmForward: 'Direction the left arm is raised toward: 0 out to the side, 90 to the front, 150 across the chest, -45 behind.',
  rightArmForward: 'Direction the right arm is raised toward: 0 out to the side, 90 to the front, 150 across the chest, -45 behind.',
  leftForearmRoll: 'Roll the left elbow\'s bend direction around the upper arm. At 0 the forearm bends forward (or up when the arm points forward). With the arm out to the side, 90 points the bent forearm up (a wave). Negative values bend the forearm in across the body (clapping, crossed arms, hand to chin).',
  rightForearmRoll: 'Roll the right elbow\'s bend direction around the upper arm. At 0 the forearm bends forward (or up when the arm points forward). With the arm out to the side, 90 points the bent forearm up (a wave). Negative values bend the forearm in across the body (clapping, crossed arms, hand to chin).',
  leftElbow: 'Bend the left elbow: 0 straight, 90 right angle, 150 fully bent.',
  rightElbow: 'Bend the right elbow: 0 straight, 90 right angle, 150 fully bent.',
  leftWrist: 'Bend the left wrist. + palm side.',
  rightWrist: 'Bend the right wrist. + palm side.',
  leftHip: 'Swing the left thigh: + forward and up (90 = thigh horizontal), - backward.',
  rightHip: 'Swing the right thigh: + forward and up (90 = thigh horizontal), - backward.',
  leftHipOut: 'Spread the left leg out to the side.',
  rightHipOut: 'Spread the right leg out to the side.',
  leftKnee: 'Bend the left knee: 0 straight, 90 right angle, 150 fully bent.',
  rightKnee: 'Bend the right knee: 0 straight, 90 right angle, 150 fully bent.',
  leftAnkle: 'Point the left foot. + toes up, - toes down. Feet stay flat on the floor at 0.',
  rightAnkle: 'Point the right foot. + toes up, - toes down. Feet stay flat on the floor at 0.',
} as const;

export type PoseControl = keyof typeof POSE_CONTROLS;
export const POSE_CONTROL_NAMES = Object.keys(POSE_CONTROLS) as PoseControl[];
export type Pose = Partial<Record<PoseControl, number>>;

/** A relaxed standing pose: arms hang with a soft elbow. */
export const NEUTRAL_POSE: Required<Pose> = Object.fromEntries(POSE_CONTROL_NAMES.map((c) => [c, 0])) as Required<Pose>;
NEUTRAL_POSE.leftElbow = 10;
NEUTRAL_POSE.rightElbow = 10;
NEUTRAL_POSE.leftArmLift = 4;
NEUTRAL_POSE.rightArmLift = 4;

const LIMITS: Partial<Record<PoseControl, [number, number]>> = {
  spineBend: [-40, 100], spineSide: [-45, 45], spineTwist: [-70, 70],
  headNod: [-60, 70], headTurn: [-85, 85], headTilt: [-40, 40],
  leftShrug: [-10, 35], rightShrug: [-10, 35],
  leftArmLift: [0, 180], rightArmLift: [0, 180],
  leftArmForward: [-80, 170], rightArmForward: [-80, 170],
  leftForearmRoll: [-120, 120], rightForearmRoll: [-120, 120],
  leftElbow: [0, 150], rightElbow: [0, 150],
  leftWrist: [-70, 70], rightWrist: [-70, 70],
  leftHip: [-40, 130], rightHip: [-40, 130],
  leftHipOut: [-15, 60], rightHipOut: [-15, 60],
  leftKnee: [0, 155], rightKnee: [0, 155],
  leftAnkle: [-50, 40], rightAnkle: [-50, 40],
};

export function clampControl(c: PoseControl, v: number): number {
  const l = LIMITS[c];
  if (!Number.isFinite(v)) return 0;
  return l ? Math.max(l[0], Math.min(l[1], v)) : v;
}

/** Which bones each control moves (used to decide what a gesture overrides). */
export function controlBones(c: PoseControl): string[] {
  if (c === 'turn') return ['hips'];
  if (c.startsWith('spine')) return ['spine', 'chest', 'upperChest'];
  if (c.startsWith('head')) return ['neck', 'head'];
  const side = c.startsWith('left') ? 'left' : 'right';
  if (/Shrug|Arm|Forearm|Elbow|Wrist/.test(c)) return [`${side}Shoulder`, `${side}UpperArm`, `${side}LowerArm`, `${side}Hand`];
  return [`${side}UpperLeg`, `${side}LowerLeg`, `${side}Foot`, `${side}Toes`, 'hips'];
}

const D = Math.PI / 180;
const X = new Vector3(1, 0, 0), Y = new Vector3(0, 1, 0), Z = new Vector3(0, 0, 1);
const qa = (axis: Vector3, deg: number) => new Quaternion().setFromAxisAngle(axis, deg * D);

// Leg proportions in units of the rest hips height (thigh, shin, ankle height).
const THIGH = 0.47, SHIN = 0.45, ANKLE = 0.08, KNEE_R = 0.04;

/** Rotation taking frame (a1, a2) onto frame (b1, b2); both pairs orthonormal. */
function frameRotation(a1: Vector3, a2: Vector3, b1: Vector3, b2: Vector3): Quaternion {
  const ma = new Matrix4().makeBasis(a1, a2, a1.clone().cross(a2));
  const mb = new Matrix4().makeBasis(b1, b2, b1.clone().cross(b2));
  return new Quaternion().setFromRotationMatrix(mb.multiply(ma.transpose()));
}

function armRotations(side: 'left' | 'right', p: Required<Pose>, out: Map<string, Quaternion>) {
  const s = side === 'left' ? 1 : -1;
  const lift = p[`${side}ArmLift`], fwd = p[`${side}ArmForward`], roll = p[`${side}ForearmRoll`];
  const elbow = p[`${side}Elbow`], shrug = p[`${side}Shrug`], wrist = p[`${side}Wrist`];
  // Shoulder: lift the collarbone (rotate the bone's outward direction up).
  const shoulder = qa(Z, s * shrug * 0.6);
  // The arm hangs down with its elbow bending forward, then swings up by `lift`
  // toward the horizontal direction `fwd` (0 = out to the side, 90 = to the front).
  const aim = new Vector3(s * Math.cos(fwd * D), 0, Math.sin(fwd * D));
  const down = new Vector3(0, -1, 0);
  const axis = down.clone().cross(aim).normalize();
  const swing = new Quaternion().setFromAxisAngle(axis, lift * D);
  const dir = down.clone().applyQuaternion(swing);
  let bend = Z.clone().applyQuaternion(swing);
  // Roll the bend direction around the arm (+ = toward up for an arm out to the side).
  bend.applyAxisAngle(dir, -s * roll * D);
  bend = bend.sub(dir.clone().multiplyScalar(bend.dot(dir))).normalize();
  // Upper arm relative to the chest, then expressed under the shoulder.
  const upper = frameRotation(new Vector3(s, 0, 0), Z.clone(), dir, bend);
  out.set(`${side}Shoulder`, shoulder);
  out.set(`${side}UpperArm`, shoulder.clone().invert().multiply(upper));
  // Elbow: rotate the forearm (T-pose direction +-X) toward the bend direction (+Z in bone space).
  const hinge = new Vector3(s, 0, 0).cross(Z).normalize();
  out.set(`${side}LowerArm`, new Quaternion().setFromAxisAngle(hinge, elbow * D));
  out.set(`${side}Hand`, new Quaternion().setFromAxisAngle(hinge, wrist * D * 0.8));
}

function legRotations(side: 'left' | 'right', p: Required<Pose>, out: Map<string, Quaternion>): number {
  const s = side === 'left' ? 1 : -1;
  const hip = p[`${side}Hip`], spread = p[`${side}HipOut`], knee = p[`${side}Knee`], ankle = p[`${side}Ankle`];
  const upper = qa(Z, s * spread).multiply(qa(X, -hip));
  const lower = qa(X, knee);
  out.set(`${side}UpperLeg`, upper);
  out.set(`${side}LowerLeg`, lower);
  // Keep the foot level with the floor, then point it.
  out.set(`${side}Foot`, qa(X, hip - knee - ankle).multiply(qa(Z, -s * spread)));
  out.set(`${side}Toes`, new Quaternion());
  // Lowest point of this leg below the hips (knee or sole).
  const kneeP = new Vector3(0, -THIGH, 0).applyQuaternion(upper);
  const ankleP = new Vector3(0, -SHIN, 0).applyQuaternion(upper.clone().multiply(lower)).add(kneeP);
  return Math.min(kneeP.y - KNEE_R, ankleP.y - ANKLE);
}

/**
 * Normalized local rotations for every body bone, plus the hips height (in rest
 * hips heights) that keeps the lowest foot or knee on the floor.
 */
export function poseRotations(pose: Pose): { rotations: Map<string, Quaternion>; hipsHeight: number } {
  const p = { ...NEUTRAL_POSE };
  for (const c of POSE_CONTROL_NAMES) if (pose[c] !== undefined) p[c] = clampControl(c, pose[c]!);
  const out = new Map<string, Quaternion>();
  out.set('hips', qa(Y, p.turn));
  const spine = (f: number) => qa(Y, p.spineTwist * f).multiply(qa(X, p.spineBend * f)).multiply(qa(Z, -p.spineSide * f));
  out.set('spine', spine(0.3));
  out.set('chest', spine(0.35));
  out.set('upperChest', spine(0.35));
  const head = (f: number) => qa(Y, p.headTurn * f).multiply(qa(X, p.headNod * f)).multiply(qa(Z, -p.headTilt * f));
  out.set('neck', head(0.4));
  out.set('head', head(0.6));
  armRotations('left', p, out);
  armRotations('right', p, out);
  const low = Math.min(legRotations('left', p, out), legRotations('right', p, out));
  return { rotations: out, hipsHeight: -low };
}

export interface PoseKey {
  /** Seconds from the start of the gesture. */
  t: number;
  /** Controls set at this key; any not given hold their previous value. */
  pose: Pose;
}

const ease = (x: number) => x * x * (3 - 2 * x);

/** Fills every control at every key: unset controls hold the previous key's value (neutral at the start). */
export function resolveKeys(keys: PoseKey[]): Array<{ t: number; pose: Required<Pose> }> {
  const sorted = [...keys].sort((a, b) => a.t - b.t);
  let cur = { ...NEUTRAL_POSE };
  return sorted.map((k) => {
    cur = { ...cur };
    for (const c of POSE_CONTROL_NAMES) if (k.pose[c] !== undefined) cur[c] = clampControl(c, k.pose[c]!);
    return { t: Math.max(0, k.t), pose: cur };
  });
}

/** Controls that any key changes away from neutral. */
export function touchedControls(keys: PoseKey[]): Set<PoseControl> {
  const set = new Set<PoseControl>();
  for (const k of keys) for (const c of POSE_CONTROL_NAMES) if (k.pose[c] !== undefined && k.pose[c] !== NEUTRAL_POSE[c]) set.add(c);
  return set;
}

/** Interpolated pose at time t (eased between keys). */
export function samplePoseKeys(resolved: Array<{ t: number; pose: Required<Pose> }>, t: number): Required<Pose> {
  if (!resolved.length) return { ...NEUTRAL_POSE };
  if (t <= resolved[0].t) return resolved[0].pose;
  for (let i = 1; i < resolved.length; i++) {
    const a = resolved[i - 1], b = resolved[i];
    if (t <= b.t) {
      const x = b.t > a.t ? ease((t - a.t) / (b.t - a.t)) : 1;
      const p = { ...a.pose };
      for (const c of POSE_CONTROL_NAMES) p[c] = a.pose[c] + (b.pose[c] - a.pose[c]) * x;
      return p;
    }
  }
  return resolved[resolved.length - 1].pose;
}

/** Bakes pose keys into a NormalizedClip over the body bones. */
export function poseKeysClip(keys: PoseKey[], options: { fps?: number; name?: string; duration?: number } = {}): NormalizedClip {
  const fps = options.fps ?? 30;
  const resolved = resolveKeys(keys);
  const duration = Math.max(options.duration ?? 0, resolved.length ? resolved[resolved.length - 1].t : 0, 1 / fps);
  const frames = Math.round(duration * fps) + 1;
  const bones = [...BODY_BONES];
  const B = bones.length;
  const rotations = new Float32Array(frames * B * 4);
  const hips = new Float32Array(frames * 3);
  for (let f = 0; f < frames; f++) {
    const { rotations: r, hipsHeight } = poseRotations(samplePoseKeys(resolved, f / fps));
    for (let i = 0; i < B; i++) (r.get(bones[i]) ?? new Quaternion()).toArray(rotations, (f * B + i) * 4);
    hips[f * 3 + 1] = hipsHeight;
  }
  return { name: options.name ?? 'Pose', fps, frames, bones, rotations, hips, loop: false };
}
