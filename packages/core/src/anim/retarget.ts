import {
  AnimationClip,
  AnimationMixer,
  Matrix4,
  Object3D,
  Quaternion,
  QuaternionKeyframeTrack,
  Vector3,
  VectorKeyframeTrack,
  type KeyframeTrack,
} from 'three';
import { HUMANOID_WITH_FINGERS, canonicalParent, tposeDirection } from '../skeleton';
import type { BoneMap } from './bonemap';
import { measureArmClearance, type ArmClearance } from './armClearance';

/**
 * Skeleton-independent humanoid animation.
 *
 * Rotations are local rotations in the canonical *normalized* skeleton: a T-pose
 * facing +Z where every bone frame is world-aligned (like VRM's normalized humanoid).
 * Hips translation is measured in units of the rest hips height: y is the height
 * above the ground (about 1 when standing), x/z are relative to the first frame.
 */
export interface NormalizedClip {
  name: string;
  fps: number;
  frames: number;
  bones: string[];
  /** frames * bones.length * 4 (x, y, z, w). */
  rotations: Float32Array;
  /** frames * 3. */
  hips: Float32Array;
  loop: boolean;
  meta?: Record<string, unknown>;
}

export interface SkeletonBinding {
  root: Object3D;
  map: BoneMap;
  /** World-space T-pose rotation of each mapped bone (bind rotation * straightening). */
  tpose: Map<string, Quaternion>;
  restHipsWorld: Vector3;
  hipsHeight: number;
  /** Local transforms of every node at bind time; sampling always starts from these. */
  restPose: Array<[Object3D, Vector3, Quaternion, Vector3]>;
  /**
   * A relaxed, gently curled hand (normalized local rotations per finger bone), used
   * for fingers a clip doesn't animate, so hands don't hang stiff and splayed.
   */
  relaxedFingers: Map<string, Quaternion>;
  /** Clearance measured from the mesh (radians from straight down, per side). */
  autoArmClearance: ArmClearance;
  /** Hanging arms are swung out to at least this angle so they stay outside the body. */
  armClearance: ArmClearance;
  /** Extra swing (radians) for hanging arms: positive moves them away from the body, negative closer. */
  armOffset: number;
}

/** Moves hanging arms `degrees` further from the body (negative: closer), on top of the measured clearance. */
export function setArmSpacing(binding: SkeletonBinding, degrees: number): void {
  binding.armClearance = { ...binding.autoArmClearance };
  binding.armOffset = (degrees * Math.PI) / 180;
}

// Curl per segment (proximal, intermediate, distal), in degrees: more toward the little finger.
const RELAXED_CURL: Record<string, [number, number, number]> = {
  Index: [12, 18, 12],
  Middle: [16, 22, 14],
  Ring: [20, 26, 16],
  Little: [24, 30, 18],
};

const ORDER = HUMANOID_WITH_FINGERS.map((d) => d.name);

/**
 * Captures the skeleton's rest state. Call while the skeleton is in its bind/rest
 * pose. Arms and legs are straightened into a T-pose so that A-pose rigs and
 * T-pose animations line up.
 */
export function bindSkeleton(root: Object3D, map: BoneMap): SkeletonBinding {
  root.updateMatrixWorld(true);
  const restPose: SkeletonBinding['restPose'] = [];
  root.traverse((o) => restPose.push([o, o.position.clone(), o.quaternion.clone(), o.scale.clone()]));
  const node = (canon: string) => (map[canon] ? root.getObjectByName(map[canon]) : undefined);
  const tpose = new Map<string, Quaternion>();
  const correction = new Map<string, Quaternion>();
  const wp = (o: Object3D) => o.getWorldPosition(new Vector3());

  for (const canon of ORDER) {
    const bone = node(canon);
    if (!bone) continue;
    let parentCorr = new Quaternion();
    for (let p = canonicalParent(canon); p; p = canonicalParent(p)) {
      if (correction.has(p)) { parentCorr = correction.get(p)!.clone(); break; }
    }
    let corr = parentCorr.clone();
    const target = tposeDirection(canon);
    const def = HUMANOID_WITH_FINGERS.find((d) => d.name === canon)!;
    const child = def.primaryChild ? node(def.primaryChild) : undefined;
    if (target && child) {
      const dir = wp(child).sub(wp(bone)).applyQuaternion(parentCorr);
      if (dir.lengthSq() > 1e-12) {
        const align = new Quaternion().setFromUnitVectors(dir.normalize(), new Vector3(...target));
        corr = align.multiply(parentCorr);
      }
    }
    correction.set(canon, corr);
    const bind = bone.getWorldQuaternion(new Quaternion());
    tpose.set(canon, corr.clone().multiply(bind));
  }

  // Relaxed fingers curl toward the palm. The palm side follows from the knuckle line
  // (index -> little) and handedness, so it works whichever way the palms face.
  // A misread knuckle line would curl the fingers sideways, so a palm far from the
  // usual "facing down" in the T-pose borrows the other hand's (mirrored), or that.
  const palms: Partial<Record<'left' | 'right', Vector3>> = {};
  for (const side of ['left', 'right'] as const) {
    const hand = node(`${side}Hand`), index = node(`${side}IndexProximal`), little = node(`${side}LittleProximal`);
    const handCorr = correction.get(`${side}Hand`);
    if (!hand || !index || !little || !handCorr) continue;
    const a = new Vector3(side === 'left' ? 1 : -1, 0, 0);
    const knuckles = wp(little).sub(wp(index)).applyQuaternion(handCorr);
    knuckles.addScaledVector(a, -knuckles.dot(a));
    if (knuckles.lengthSq() < 1e-12) continue;
    knuckles.normalize();
    // Left hand: palm = -(finger x knuckle line); right hand: +(finger x knuckle line).
    palms[side] = new Vector3().crossVectors(a, knuckles).multiplyScalar(side === 'left' ? -1 : 1);
  }
  const down = new Vector3(0, -1, 0);
  const plausible = (p: Vector3 | undefined) => !!p && p.dot(down) > 0.5;
  const relaxedFingers = new Map<string, Quaternion>();
  for (const side of ['left', 'right'] as const) {
    if (!palms[side]) continue;
    const other = palms[side === 'left' ? 'right' : 'left'];
    const palm = plausible(palms[side]) ? palms[side]! : plausible(other) ? new Vector3(-other!.x, other!.y, other!.z) : down;
    const a = new Vector3(side === 'left' ? 1 : -1, 0, 0);
    const axis = new Vector3().crossVectors(a, palm).normalize();
    for (const [finger, angles] of Object.entries(RELAXED_CURL)) {
      ['Proximal', 'Intermediate', 'Distal'].forEach((segment, k) => {
        const canon = `${side}${finger}${segment}`;
        if (node(canon)) relaxedFingers.set(canon, new Quaternion().setFromAxisAngle(axis, (angles[k] * Math.PI) / 180));
      });
    }
  }

  const hipsNode = node('hips');
  if (!hipsNode) throw new Error('Skeleton has no hips bone mapped.');
  const restHipsWorld = wp(hipsNode);
  let ground = Infinity;
  for (const canon of ['leftFoot', 'rightFoot', 'leftToes', 'rightToes']) {
    const n = node(canon);
    if (n) ground = Math.min(ground, wp(n).y);
  }
  if (!Number.isFinite(ground)) ground = 0;
  const hipsHeight = Math.max(1e-6, restHipsWorld.y - ground);
  const autoArmClearance = measureArmClearance(root, map);
  return { root, map, tpose, restHipsWorld, hipsHeight, restPose, relaxedFingers, autoArmClearance, armClearance: { ...autoArmClearance }, armOffset: 0 };
}

/** Samples any three.js animation on a mapped skeleton into a NormalizedClip. */
export function extractNormalizedClip(
  binding: SkeletonBinding,
  clip: AnimationClip,
  options: { fps?: number; start?: number; end?: number; name?: string } = {},
): NormalizedClip {
  const fps = options.fps ?? 30;
  const start = options.start ?? 0;
  const end = Math.min(options.end ?? clip.duration, clip.duration);
  const frames = Math.max(1, Math.floor((end - start) * fps) + 1);
  const bones = ORDER.filter((c) => binding.map[c] && binding.tpose.has(c));
  const nodes = bones.map((c) => binding.root.getObjectByName(binding.map[c])!);
  const rotations = new Float32Array(frames * bones.length * 4);
  const hips = new Float32Array(frames * 3);
  const hipsNode = binding.root.getObjectByName(binding.map.hips)!;
  const feet = ['leftFoot', 'rightFoot', 'leftToes', 'rightToes']
    .map((c) => (binding.map[c] ? binding.root.getObjectByName(binding.map[c]) : undefined))
    .filter((o): o is Object3D => !!o);
  const footMin = new Float32Array(frames);

  // Sample from the rest pose (bones the clip doesn't animate stay at rest),
  // then put back whatever pose the skeleton was showing.
  const saved: Array<[Object3D, Vector3, Quaternion, Vector3]> = [];
  binding.root.traverse((o) => saved.push([o, o.position.clone(), o.quaternion.clone(), o.scale.clone()]));
  for (const [o, p, r, sc] of binding.restPose) {
    o.position.copy(p);
    o.quaternion.copy(r);
    o.scale.copy(sc);
  }
  const mixer = new AnimationMixer(binding.root);
  const action = mixer.clipAction(clip);
  action.play();
  const worldN = new Map<string, Quaternion>();
  const inv = new Quaternion();
  const tmp = new Quaternion();
  const pos = new Vector3();
  const tmpV = new Vector3();
  for (let f = 0; f < frames; f++) {
    mixer.setTime(start + f / fps);
    binding.root.updateMatrixWorld(true);
    worldN.clear();
    bones.forEach((canon, i) => {
      // Normalized world rotation: source world rotation relative to its T-pose.
      const w = nodes[i].getWorldQuaternion(new Quaternion()).multiply(inv.copy(binding.tpose.get(canon)!).invert());
      worldN.set(canon, w);
      let parentW: Quaternion | undefined;
      for (let p = canonicalParent(canon); p; p = canonicalParent(p)) {
        if (worldN.has(p)) { parentW = worldN.get(p); break; }
      }
      const local = parentW ? tmp.copy(parentW).invert().multiply(w) : tmp.copy(w);
      local.toArray(rotations, (f * bones.length + i) * 4);
    });
    hipsNode.getWorldPosition(pos);
    pos.toArray(hips, f * 3);
    let m = Infinity;
    for (const foot of feet) m = Math.min(m, foot.getWorldPosition(tmpV).y);
    footMin[f] = m;
  }
  // Ground: a low percentile of the feet height over the clip (robust to jumps and noise).
  const sorted = Array.from(footMin).filter(Number.isFinite).sort((a, b) => a - b);
  const ground = sorted.length ? sorted[Math.floor(sorted.length * 0.02)] : binding.restHipsWorld.y - binding.hipsHeight;
  const x0 = hips[0], z0 = hips[2];
  for (let f = 0; f < frames; f++) {
    hips[f * 3] = (hips[f * 3] - x0) / binding.hipsHeight;
    hips[f * 3 + 1] = (hips[f * 3 + 1] - ground) / binding.hipsHeight;
    hips[f * 3 + 2] = (hips[f * 3 + 2] - z0) / binding.hipsHeight;
  }
  action.stop();
  mixer.uncacheRoot(binding.root);
  for (const [o, p, r, sc] of saved) {
    o.position.copy(p);
    o.quaternion.copy(r);
    o.scale.copy(sc);
  }
  binding.root.updateMatrixWorld(true);
  return { name: options.name ?? clip.name, fps, frames, bones, rotations, hips, loop: false };
}

export interface BakeOptions {
  /** Remove horizontal root travel (default true for loops). */
  inPlace?: boolean;
  /** Playback speed multiplier baked into the clip timing. */
  speed?: number;
  name?: string;
  /** Keep hanging arms outside the body (binding.armClearance). Default true. */
  clearBody?: boolean;
}

const _up = new Vector3();
const _lat = new Vector3();
const _dir = new Vector3();
const _axis = new Vector3();
const _swing = new Quaternion();

/**
 * Swings a hanging upper arm (normalized world rotation `w`, updated in place) out
 * sideways until it keeps the binding's clearance from the body, then by the user's
 * offset. Arms that are raised are left alone; the effect fades in as the arm points down.
 */
function clearBody(binding: SkeletonBinding, worldN: Map<string, Quaternion>, side: 'left' | 'right', w: Quaternion): void {
  const need = binding.armClearance[side];
  if (!(need > 0) && !binding.armOffset) return;
  const s = side === 'left' ? 1 : -1;
  const chest = worldN.get(canonicalParent(`${side}Shoulder`)!)!;
  _up.set(0, 1, 0).applyQuaternion(chest);
  _lat.set(s, 0, 0).applyQuaternion(chest);
  _dir.set(s, 0, 0).applyQuaternion(w);
  const down = -_dir.dot(_up);
  if (down <= 0) return;
  const delta = Math.max(0, need - Math.atan2(_dir.dot(_lat), down)) + binding.armOffset;
  if (!delta) return;
  const t = Math.min(1, down / 0.5);
  _axis.crossVectors(_lat, _up).normalize();
  w.premultiply(_swing.setFromAxisAngle(_axis, delta * t * t * (3 - 2 * t)));
}

/**
 * Bakes a NormalizedClip onto a mapped skeleton, producing a regular
 * AnimationClip with quaternion tracks for every mapped bone and a hips position track.
 */
export function bakeClip(binding: SkeletonBinding, clip: NormalizedClip, options: BakeOptions = {}): AnimationClip {
  const speed = options.speed ?? 1;
  const inPlace = options.inPlace ?? clip.loop;
  const clear = options.clearBody ?? true;
  const { root, map } = binding;
  const index = new Map(clip.bones.map((b, i) => [b, i]));
  const targets = ORDER.filter((c) => map[c] && binding.tpose.has(c));
  const nodeOf = new Map(targets.map((c) => [c, root.getObjectByName(map[c])!]));
  const canonOfNode = new Map<Object3D, string>();
  for (const [c, n] of nodeOf) canonOfNode.set(n, c);

  // Rest local rotations for every node in the hierarchy (used for unmapped in-between bones).
  const restLocal = new Map<Object3D, Quaternion>();
  root.traverse((o) => restLocal.set(o, o.quaternion.clone()));
  const rootParentWorld = root.parent ? root.parent.getWorldQuaternion(new Quaternion()) : new Quaternion();
  const rootWorld = rootParentWorld.clone().multiply(root.quaternion);

  const times = new Float32Array(clip.frames);
  for (let f = 0; f < clip.frames; f++) times[f] = f / clip.fps / speed;
  const values = new Map<string, Float32Array>(targets.map((c) => [c, new Float32Array(clip.frames * 4)]));
  const hipsValues = new Float32Array(clip.frames * 3);

  const hipsNode = nodeOf.get('hips')!;
  const hipsParentInv = new Matrix4();
  hipsNode.parent?.updateWorldMatrix(true, false);
  if (hipsNode.parent) hipsParentInv.copy(hipsNode.parent.matrixWorld).invert();

  // Pre-order list of nodes from root.
  const nodes: Object3D[] = [];
  root.traverse((o) => nodes.push(o));

  const worldN = new Map<string, Quaternion>();
  const worldT = new Map<Object3D, Quaternion>();
  const q = new Quaternion();
  const hp = new Vector3();
  const drift = new Vector3();
  const first = new Vector3(clip.hips[0], 0, clip.hips[2]);
  const last = new Vector3(clip.hips[(clip.frames - 1) * 3], 0, clip.hips[(clip.frames - 1) * 3 + 2]);

  for (let f = 0; f < clip.frames; f++) {
    // Normalized world rotations along the canonical hierarchy.
    worldN.clear();
    for (const canon of ORDER) {
      const i = index.get(canon);
      // Fingers the clip doesn't animate take the relaxed hand pose.
      const local = i !== undefined ? q.fromArray(clip.rotations, (f * clip.bones.length + i) * 4).clone() : binding.relaxedFingers.get(canon)?.clone() ?? new Quaternion();
      const parent = canonicalParent(canon);
      const pw = parent ? worldN.get(parent)! : new Quaternion();
      const w = pw.clone().multiply(local);
      worldN.set(canon, w);
      if (clear && (canon === 'leftUpperArm' || canon === 'rightUpperArm')) clearBody(binding, worldN, canon === 'leftUpperArm' ? 'left' : 'right', w);
    }
    // Walk the target hierarchy computing world rotations and local results.
    worldT.clear();
    for (const node of nodes) {
      const parentWorld = node === root ? rootParentWorld : worldT.get(node.parent!) ?? rootWorld;
      const canon = canonOfNode.get(node);
      if (canon) {
        const w = worldN.get(canon)!.clone().multiply(binding.tpose.get(canon)!);
        worldT.set(node, w);
        const local = parentWorld.clone().invert().multiply(w);
        local.toArray(values.get(canon)!, f * 4);
      } else {
        worldT.set(node, parentWorld.clone().multiply(restLocal.get(node)!));
      }
    }
    // Hips position.
    hp.fromArray(clip.hips, f * 3);
    if (inPlace) {
      const t = clip.frames > 1 ? f / (clip.frames - 1) : 0;
      drift.copy(first).lerp(last, t);
      hp.x -= drift.x;
      hp.z -= drift.z;
    }
    hp.multiplyScalar(binding.hipsHeight);
    hp.x += binding.restHipsWorld.x;
    hp.y += binding.restHipsWorld.y - binding.hipsHeight;
    hp.z += binding.restHipsWorld.z;
    hp.applyMatrix4(hipsParentInv);
    hp.toArray(hipsValues, f * 3);
  }

  const tracks: KeyframeTrack[] = [];
  for (const canon of targets) {
    const v = values.get(canon)!;
    // Keep quaternion continuity (avoid sign flips that make interpolation spin).
    for (let f = 1; f < clip.frames; f++) {
      const a = (f - 1) * 4, b = f * 4;
      if (v[a] * v[b] + v[a + 1] * v[b + 1] + v[a + 2] * v[b + 2] + v[a + 3] * v[b + 3] < 0) {
        v[b] = -v[b]; v[b + 1] = -v[b + 1]; v[b + 2] = -v[b + 2]; v[b + 3] = -v[b + 3];
      }
    }
    tracks.push(new QuaternionKeyframeTrack(`${nodeOf.get(canon)!.name}.quaternion`, times, v));
  }
  tracks.push(new VectorKeyframeTrack(`${hipsNode.name}.position`, times, hipsValues));
  const out = new AnimationClip(options.name ?? clip.name, -1, tracks);
  out.userData = { rigforge: { loop: clip.loop, inPlace, speed } };
  return out;
}

/** Retargets any clip from one mapped skeleton to another in one step. */
export function retargetClip(source: SkeletonBinding, target: SkeletonBinding, clip: AnimationClip, options: BakeOptions & { fps?: number } = {}): AnimationClip {
  const n = extractNormalizedClip(source, clip, { fps: options.fps });
  return bakeClip(target, n, options);
}
