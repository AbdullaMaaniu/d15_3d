import { Quaternion, Vector3 } from 'three';
import { mirrorBoneName } from '../skeleton';
import type { NormalizedClip } from './retarget';

/** Returns a copy of frames [start, end) of the clip. */
export function sliceClip(clip: NormalizedClip, start: number, end: number): NormalizedClip {
  start = Math.max(0, Math.floor(start));
  end = Math.min(clip.frames, Math.floor(end));
  const B = clip.bones.length;
  return {
    ...clip,
    frames: end - start,
    rotations: clip.rotations.slice(start * B * 4, end * B * 4),
    hips: clip.hips.slice(start * 3, end * 3),
  };
}

const hipsIndex = (clip: NormalizedClip) => clip.bones.indexOf('hips');

/**
 * Rotates the whole motion about Y so the character faces +Z (and, for
 * locomotion, travels toward +Z), and moves the start to the origin in X/Z.
 */
export function alignHeading(clip: NormalizedClip, mode: 'facing' | 'travel' | 'start' = 'facing'): NormalizedClip {
  const out: NormalizedClip = { ...clip, rotations: clip.rotations.slice(), hips: clip.hips.slice() };
  const hi = hipsIndex(clip);
  if (hi < 0) return out;
  const B = clip.bones.length;
  let yaw = 0;
  if (mode === 'travel') {
    const dx = clip.hips[(clip.frames - 1) * 3] - clip.hips[0];
    const dz = clip.hips[(clip.frames - 1) * 3 + 2] - clip.hips[2];
    if (Math.hypot(dx, dz) > 0.2) yaw = Math.atan2(dx, dz);
    else mode = 'facing';
  }
  if (mode === 'facing' || mode === 'start') {
    // Average facing over the clip (or its first few frames).
    let sx = 0, sz = 0;
    const q = new Quaternion();
    const f = new Vector3();
    const count = mode === 'start' ? Math.min(clip.frames, 8) : clip.frames;
    for (let i = 0; i < count; i++) {
      q.fromArray(clip.rotations, (i * B + hi) * 4);
      f.set(0, 0, 1).applyQuaternion(q);
      sx += f.x;
      sz += f.z;
    }
    yaw = Math.atan2(sx, sz);
  }
  const r = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), -yaw);
  const q = new Quaternion();
  const p = new Vector3();
  const x0 = clip.hips[0], z0 = clip.hips[2];
  for (let i = 0; i < clip.frames; i++) {
    q.fromArray(out.rotations, (i * B + hi) * 4).premultiply(r).toArray(out.rotations, (i * B + hi) * 4);
    p.set(clip.hips[i * 3] - x0, clip.hips[i * 3 + 1], clip.hips[i * 3 + 2] - z0).applyQuaternion(r);
    p.toArray(out.hips, i * 3);
  }
  return out;
}

/** Pose distance between two frames (rotation angles + hips height). */
export function poseDistance(clip: NormalizedClip, a: number, b: number): number {
  const B = clip.bones.length;
  let d = 0;
  for (let i = 0; i < B; i++) {
    const ia = (a * B + i) * 4, ib = (b * B + i) * 4;
    const dot = Math.abs(
      clip.rotations[ia] * clip.rotations[ib] + clip.rotations[ia + 1] * clip.rotations[ib + 1] +
      clip.rotations[ia + 2] * clip.rotations[ib + 2] + clip.rotations[ia + 3] * clip.rotations[ib + 3],
    );
    d += 1 - Math.min(1, dot);
  }
  d += 4 * Math.abs(clip.hips[a * 3 + 1] - clip.hips[b * 3 + 1]);
  return d;
}

/**
 * Finds the best loop inside the clip: frames [start, end) whose end pose and
 * velocity best match the start. Period is searched in [minFrames, maxFrames].
 */
export function findLoop(clip: NormalizedClip, minFrames: number, maxFrames: number, searchStart = 0, searchEnd = clip.frames): { start: number; end: number; error: number } {
  let best = { start: 0, end: Math.min(clip.frames, maxFrames), error: Infinity };
  for (let s = searchStart; s < searchEnd - minFrames - 2; s++) {
    for (let len = minFrames; len <= maxFrames && s + len + 1 < clip.frames; len++) {
      const e = s + len;
      const err = poseDistance(clip, s, e) + 0.5 * poseDistance(clip, s + 1, e + 1);
      if (err < best.error) best = { start: s, end: e, error: err };
    }
  }
  return best;
}

/**
 * Makes a cycle loop seamlessly. Expects the cycle plus one extra frame (the
 * frame that should equal frame 0). The mismatch between that extra frame and
 * frame 0 is spread linearly over the cycle, then the extra frame is dropped.
 */
export function makeSeamlessLoop(clip: NormalizedClip): NormalizedClip {
  const B = clip.bones.length;
  const N = clip.frames - 1;
  const out: NormalizedClip = {
    ...clip,
    frames: N,
    rotations: clip.rotations.slice(0, N * B * 4),
    hips: clip.hips.slice(0, N * 3),
    loop: true,
  };
  const q0 = new Quaternion(), qN = new Quaternion(), delta = new Quaternion(), step = new Quaternion(), q = new Quaternion();
  const identity = new Quaternion();
  for (let i = 0; i < B; i++) {
    q0.fromArray(clip.rotations, i * 4);
    qN.fromArray(clip.rotations, (N * B + i) * 4);
    if (q0.dot(qN) < 0) qN.set(-qN.x, -qN.y, -qN.z, -qN.w);
    delta.copy(q0).multiply(qN.invert());
    for (let f = 0; f < N; f++) {
      step.copy(identity).slerp(delta, f / N);
      q.fromArray(out.rotations, (f * B + i) * 4).premultiply(step).toArray(out.rotations, (f * B + i) * 4);
    }
  }
  const dy = clip.hips[1] - clip.hips[N * 3 + 1];
  for (let f = 0; f < N; f++) out.hips[f * 3 + 1] += (dy * f) / N;
  return out;
}

/** Resamples to a new frame rate with slerp. */
export function resampleClip(clip: NormalizedClip, fps: number): NormalizedClip {
  if (fps === clip.fps) return clip;
  const duration = (clip.frames - 1) / clip.fps;
  const frames = Math.max(1, Math.round(duration * fps) + 1);
  const B = clip.bones.length;
  const rotations = new Float32Array(frames * B * 4);
  const hips = new Float32Array(frames * 3);
  const qa = new Quaternion(), qb = new Quaternion();
  for (let f = 0; f < frames; f++) {
    const t = (f / fps) * clip.fps;
    const a = Math.min(clip.frames - 1, Math.floor(t));
    const b = Math.min(clip.frames - 1, a + 1);
    const w = t - a;
    for (let i = 0; i < B; i++) {
      qa.fromArray(clip.rotations, (a * B + i) * 4);
      qb.fromArray(clip.rotations, (b * B + i) * 4);
      qa.slerp(qb, w).toArray(rotations, (f * B + i) * 4);
    }
    for (let k = 0; k < 3; k++) hips[f * 3 + k] = clip.hips[a * 3 + k] * (1 - w) + clip.hips[b * 3 + k] * w;
  }
  return { ...clip, fps, frames, rotations, hips };
}

/** Mirrors the motion left <-> right (in the normalized, world-aligned frame: negate X). */
export function mirrorClip(clip: NormalizedClip): NormalizedClip {
  const B = clip.bones.length;
  const idx = new Map(clip.bones.map((b, i) => [b, i]));
  const rotations = new Float32Array(clip.rotations.length);
  const hips = clip.hips.slice();
  for (let f = 0; f < clip.frames; f++) {
    for (let i = 0; i < B; i++) {
      const src = idx.get(mirrorBoneName(clip.bones[i])) ?? i;
      const o = (f * B + src) * 4;
      // Reflection across the YZ plane: (x, y, z, w) -> (x, -y, -z, w).
      rotations[(f * B + i) * 4] = clip.rotations[o];
      rotations[(f * B + i) * 4 + 1] = -clip.rotations[o + 1];
      rotations[(f * B + i) * 4 + 2] = -clip.rotations[o + 2];
      rotations[(f * B + i) * 4 + 3] = clip.rotations[o + 3];
    }
    hips[f * 3] = -clip.hips[f * 3];
  }
  return { ...clip, rotations, hips };
}

const ARM = /^(left|right)(Shoulder|UpperArm|LowerArm|Hand|Thumb|Index|Middle|Ring|Little)/;

/**
 * Rebuilds one arm of a looping symmetric gait (a walk cycle) as the other arm,
 * mirrored and half a cycle later. Motion capture sometimes has one lazy arm (the
 * actor held something, or tired); in a symmetric gait the arms mirror each other
 * half a step apart, so the good arm fully defines the other.
 */
export function symmetrizeArms(clip: NormalizedClip, from: 'left' | 'right'): NormalizedClip {
  const B = clip.bones.length;
  const idx = new Map(clip.bones.map((b, i) => [b, i]));
  const rotations = clip.rotations.slice();
  const N = clip.frames;
  const half = Math.round(N / 2);
  for (let i = 0; i < B; i++) {
    const m = ARM.exec(clip.bones[i]);
    if (!m || m[1] === from) continue;
    const src = idx.get(mirrorBoneName(clip.bones[i]));
    if (src === undefined) continue;
    for (let f = 0; f < N; f++) {
      const o = (((f + half) % N) * B + src) * 4;
      // Reflection across the YZ plane, as in mirrorClip.
      rotations[(f * B + i) * 4] = clip.rotations[o];
      rotations[(f * B + i) * 4 + 1] = -clip.rotations[o + 1];
      rotations[(f * B + i) * 4 + 2] = -clip.rotations[o + 2];
      rotations[(f * B + i) * 4 + 3] = clip.rotations[o + 3];
    }
  }
  return { ...clip, rotations };
}

export function clipDuration(clip: NormalizedClip): number {
  return clip.frames > 1 ? (clip.frames - 1) / clip.fps : 0;
}
