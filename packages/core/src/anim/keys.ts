import { AnimationClip, Quaternion, Vector3 } from 'three';
import { canonicalParent } from '../skeleton';
import { extractNormalizedClip, type NormalizedClip, type SkeletonBinding } from './retarget';

/** Rotation keys for one bone: times in seconds, values as quaternions (x, y, z, w). */
export interface KeyChannel {
  times: number[];
  values: number[];
}

/**
 * Hand-authored keys layered on top of a clip, in normalized skeleton space.
 * Each bone key is a local rotation *offset* (q = base * offset) so edits ride
 * along with the underlying motion; hips keys offset the hips position (hip heights).
 * Between keys offsets are interpolated; before the first / after the last they hold.
 */
export interface KeyLayer {
  bones: Record<string, KeyChannel>;
  hips?: { times: number[]; values: number[] };
  interpolation?: 'linear' | 'smooth';
}

export function emptyKeyLayer(): KeyLayer {
  return { bones: {} };
}

export function keyCount(layer: KeyLayer | undefined): number {
  if (!layer) return 0;
  let n = layer.hips?.times.length ?? 0;
  for (const c of Object.values(layer.bones)) n += c.times.length;
  return n;
}

/** All distinct key times, sorted. */
export function keyTimes(layer: KeyLayer | undefined, bone?: string): number[] {
  if (!layer) return [];
  const set = new Set<number>();
  const add = (ts: number[]) => ts.forEach((t) => set.add(Math.round(t * 1000) / 1000));
  if (bone) {
    if (bone === 'hips' && layer.hips) add(layer.hips.times);
    if (layer.bones[bone]) add(layer.bones[bone].times);
  } else {
    for (const c of Object.values(layer.bones)) add(c.times);
    if (layer.hips) add(layer.hips.times);
  }
  return [...set].sort((a, b) => a - b);
}

const EPS = 1 / 120;

function upsert(times: number[], values: number[], stride: number, t: number, v: ArrayLike<number>) {
  let i = times.findIndex((x) => Math.abs(x - t) < EPS);
  if (i >= 0) {
    for (let k = 0; k < stride; k++) values[i * stride + k] = v[k];
    return;
  }
  i = times.findIndex((x) => x > t);
  if (i < 0) i = times.length;
  times.splice(i, 0, t);
  values.splice(i * stride, 0, ...Array.from(v));
}

function remove(times: number[], values: number[], stride: number, t: number): boolean {
  const i = times.findIndex((x) => Math.abs(x - t) < EPS);
  if (i < 0) return false;
  times.splice(i, 1);
  values.splice(i * stride, stride);
  return true;
}

/** Returns a copy of the layer with a rotation offset key set. */
export function setBoneKey(layer: KeyLayer, bone: string, time: number, offset: Quaternion): KeyLayer {
  const next = cloneLayer(layer);
  const ch = (next.bones[bone] ??= { times: [], values: [] });
  upsert(ch.times, ch.values, 4, time, offset.toArray());
  return next;
}

export function setHipsKey(layer: KeyLayer, time: number, offset: Vector3): KeyLayer {
  const next = cloneLayer(layer);
  next.hips ??= { times: [], values: [] };
  upsert(next.hips.times, next.hips.values, 3, time, offset.toArray());
  return next;
}

/** Removes keys at `time` (for one bone, or all bones when omitted). */
export function deleteKeys(layer: KeyLayer, time: number, bone?: string): KeyLayer {
  const next = cloneLayer(layer);
  for (const [name, ch] of Object.entries(next.bones)) {
    if (bone && bone !== name) continue;
    remove(ch.times, ch.values, 4, time);
    if (!ch.times.length) delete next.bones[name];
  }
  if (next.hips && (!bone || bone === 'hips')) {
    remove(next.hips.times, next.hips.values, 3, time);
    if (!next.hips.times.length) delete next.hips;
  }
  return next;
}

export function cloneLayer(layer: KeyLayer): KeyLayer {
  return {
    interpolation: layer.interpolation,
    bones: Object.fromEntries(Object.entries(layer.bones).map(([k, c]) => [k, { times: [...c.times], values: [...c.values] }])),
    hips: layer.hips ? { times: [...layer.hips.times], values: [...layer.hips.values] } : undefined,
  };
}

function segment(times: number[], t: number, smooth: boolean): [number, number, number] {
  if (t <= times[0]) return [0, 0, 0];
  const last = times.length - 1;
  if (t >= times[last]) return [last, last, 0];
  let i = 0;
  while (times[i + 1] < t) i++;
  let f = (t - times[i]) / (times[i + 1] - times[i]);
  if (smooth) f = f * f * (3 - 2 * f);
  return [i, i + 1, f];
}

/** Samples the layer's rotation offset for a bone at time t (identity when unkeyed). */
export function sampleBoneOffset(layer: KeyLayer, bone: string, t: number, out = new Quaternion()): Quaternion {
  const ch = layer.bones[bone];
  if (!ch || !ch.times.length) return out.identity();
  const [a, b, f] = segment(ch.times, t, layer.interpolation === 'smooth');
  const qa = new Quaternion().fromArray(ch.values, a * 4);
  const qb = new Quaternion().fromArray(ch.values, b * 4);
  return out.copy(qa).slerp(qb, f);
}

export function sampleHipsOffset(layer: KeyLayer, t: number, out = new Vector3()): Vector3 {
  const h = layer.hips;
  if (!h || !h.times.length) return out.set(0, 0, 0);
  const [a, b, f] = segment(h.times, t, layer.interpolation === 'smooth');
  return out.fromArray(h.values, a * 3).lerp(new Vector3().fromArray(h.values, b * 3), f);
}

/** Bakes a key layer into a clip (adding channels for keyed bones the clip lacks). */
export function applyKeyLayer(clip: NormalizedClip, layer: KeyLayer | undefined): NormalizedClip {
  if (!layer || keyCount(layer) === 0) return clip;
  const bones = [...clip.bones];
  for (const b of Object.keys(layer.bones)) if (!bones.includes(b)) bones.push(b);
  const B = bones.length;
  const srcIndex = new Map(clip.bones.map((b, i) => [b, i]));
  const rotations = new Float32Array(clip.frames * B * 4);
  const hips = clip.hips.slice();
  const q = new Quaternion(), off = new Quaternion(), v = new Vector3();
  for (let f = 0; f < clip.frames; f++) {
    const t = f / clip.fps;
    bones.forEach((bone, i) => {
      const src = srcIndex.get(bone);
      if (src !== undefined) q.fromArray(clip.rotations, (f * clip.bones.length + src) * 4);
      else q.identity();
      if (layer.bones[bone]) q.multiply(sampleBoneOffset(layer, bone, t, off));
      q.toArray(rotations, (f * B + i) * 4);
    });
    if (layer.hips) {
      sampleHipsOffset(layer, t, v);
      hips[f * 3] += v.x;
      hips[f * 3 + 1] += v.y;
      hips[f * 3 + 2] += v.z;
    }
  }
  return { ...clip, bones, rotations, hips };
}

/**
 * Converts a bone's local rotation on the bound rig into the normalized clip space.
 * (Inverse of what bakeClip does: L = Tp^-1 * qn * Tb  =>  qn = Tp * L * Tb^-1.)
 */
export function rigLocalToNormalized(binding: SkeletonBinding, bone: string, local: Quaternion): Quaternion {
  const tb = binding.tpose.get(bone);
  if (!tb) return local.clone();
  let tp: Quaternion | undefined;
  for (let p = canonicalParent(bone); p; p = canonicalParent(p)) {
    tp = binding.tpose.get(p);
    if (tp) break;
  }
  const parentWorld = tp ?? binding.root.getWorldQuaternion(new Quaternion());
  return parentWorld.clone().multiply(local).multiply(tb.clone().invert());
}

/** Converts a hips local position on the bound rig to normalized hips coordinates (hip heights). */
export function rigHipsToNormalized(binding: SkeletonBinding, local: Vector3): Vector3 {
  const hips = binding.root.getObjectByName(binding.map.hips)!;
  const world = hips.parent ? local.clone().applyMatrix4(hips.parent.matrixWorld) : local.clone();
  return new Vector3(
    (world.x - binding.restHipsWorld.x) / binding.hipsHeight,
    (world.y - (binding.restHipsWorld.y - binding.hipsHeight)) / binding.hipsHeight,
    (world.z - binding.restHipsWorld.z) / binding.hipsHeight,
  );
}

/** Samples a normalized clip's local rotation for one bone at time t (identity if absent). */
export function sampleNormalized(clip: NormalizedClip, bone: string, t: number, out = new Quaternion()): Quaternion {
  const i = clip.bones.indexOf(bone);
  if (i < 0) return out.identity();
  const x = Math.max(0, Math.min(clip.frames - 1, t * clip.fps));
  const a = Math.floor(x), b = Math.min(clip.frames - 1, a + 1);
  const B = clip.bones.length;
  const qa = new Quaternion().fromArray(clip.rotations, (a * B + i) * 4);
  const qb = new Quaternion().fromArray(clip.rotations, (b * B + i) * 4);
  return out.copy(qa).slerp(qb, x - a);
}

export function sampleNormalizedHips(clip: NormalizedClip, t: number, out = new Vector3()): Vector3 {
  const x = Math.max(0, Math.min(clip.frames - 1, t * clip.fps));
  const a = Math.floor(x), b = Math.min(clip.frames - 1, a + 1);
  return out.fromArray(clip.hips, a * 3).lerp(new Vector3().fromArray(clip.hips, b * 3), x - a);
}

/** A clip that holds the rig's bind pose, as a blank canvas for keyframing. */
export function bindPoseClip(binding: SkeletonBinding, seconds = 2, fps = 30, name = 'New Clip'): NormalizedClip {
  const one = extractNormalizedClip(binding, new AnimationClip('bind', 0, []), { fps, start: 0, end: 0 });
  const frames = Math.max(2, Math.round(seconds * fps) + 1);
  const B = one.bones.length;
  const rotations = new Float32Array(frames * B * 4);
  const hips = new Float32Array(frames * 3);
  // Rest hips: standing at the rest height, no travel.
  for (let f = 0; f < frames; f++) {
    rotations.set(one.rotations.subarray(0, B * 4), f * B * 4);
    hips.set([0, 1, 0], f * 3);
  }
  return { name, fps, frames, bones: one.bones, rotations, hips, loop: false };
}
