import { Quaternion, Vector3 } from 'three';
import { BODY_BONES } from '../skeleton';
import type { NormalizedClip } from '../anim/retarget';
import { decodeClip, type EncodedClip } from '../anim/codec';
import { mirrorClip, resampleClip } from '../anim/clipTools';
import { GESTURES } from './gestures';
import { controlBones, poseKeysClip, touchedControls, type Pose, type PoseControl, type PoseKey } from './pose';
import type { BodyPart, MotionPlan, MotionSource } from './plan';

export interface LibraryClip {
  id: string;
  name: string;
  description: string;
  /** 'loop' clips cycle (idle, walk); 'once' clips play through. */
  kind: 'loop' | 'once';
  category: string;
  seconds: number;
  /** Which side does the main action (one-handed waves, kicks). */
  side: 'left' | 'right' | 'both';
  /** Motion-captured preset, or pose keys for built-in gestures. */
  clip?: NormalizedClip;
  keys?: PoseKey[];
}

export interface MotionLibrary {
  clips: Map<string, LibraryClip>;
}

const OUT_BONES = [...BODY_BONES];
/**
 * Which side does the action in a one-shot: the side whose hand or foot rises
 * highest (a wave, a kick), or 'both' when neither stands out.
 */
export function activeSide(clip: NormalizedClip): 'left' | 'right' | 'both' {
  const B = clip.bones.length;
  const idx = new Map(clip.bones.map((b, i) => [b, i]));
  const q = new Quaternion(), w = new Quaternion(), v = new Vector3();
  const rise = (chain: string[], dir: [number, number, number]) => {
    let best = -Infinity;
    for (let f = 0; f < clip.frames; f++) {
      w.identity();
      for (const b of chain) if (idx.has(b)) w.multiply(q.fromArray(clip.rotations, (f * B + idx.get(b)!) * 4));
      best = Math.max(best, v.set(...dir).applyQuaternion(w).y);
    }
    return best;
  };
  const arm = (s: string) => rise([`${s}Shoulder`, `${s}UpperArm`], [s === 'left' ? 1 : -1, 0, 0]);
  const leg = (s: string) => rise([`${s}UpperLeg`], [0, -1, 0]);
  const da = arm('left') - arm('right'), dl = leg('left') - leg('right');
  const d = Math.abs(da) > Math.abs(dl) ? da : dl;
  return d > 0.3 ? 'left' : d < -0.3 ? 'right' : 'both';
}

/** What some presets actually look like, where their pack description undersells it (models pick clips by these). */
const DESCRIPTIONS: Record<string, string> = {
  bow: 'Deep theatrical bow: leans far forward and lifts one leg behind',
  wave: 'Wave hello with both hands overhead',
};

/** The clip library a provider picks from: presets plus the built-in gestures. */
export function createMotionLibrary(presets: EncodedClip[]): MotionLibrary {
  const clips = new Map<string, LibraryClip>();
  for (const p of presets) {
    const clip = decodeClip(p);
    clips.set(p.id, {
      id: p.id,
      name: p.name,
      description: DESCRIPTIONS[p.id] ?? p.description ?? p.name,
      kind: p.loop ? 'loop' : 'once',
      category: p.category,
      seconds: +((p.frames - (p.loop ? 0 : 1)) / p.fps).toFixed(2),
      side: p.loop ? 'both' : activeSide(clip),
      clip,
    });
  }
  for (const g of GESTURES) {
    if (clips.has(g.id)) continue;
    clips.set(g.id, {
      id: g.id, name: g.name, description: g.description, kind: 'once', category: 'gesture',
      seconds: Math.max(...g.keys.map((k) => k.t)), side: g.side, keys: g.keys,
    });
  }
  return { clips };
}

// ---------------------------------------------------------------------------
// Clip helpers over the output bone set.

/** Re-expresses a clip over OUT_BONES (missing bones are identity). */
function toBodyBones(clip: NormalizedClip): NormalizedClip {
  const idx = new Map(clip.bones.map((b, i) => [b, i]));
  const B = OUT_BONES.length, S = clip.bones.length;
  const rotations = new Float32Array(clip.frames * B * 4);
  for (let f = 0; f < clip.frames; f++) {
    for (let i = 0; i < B; i++) {
      const s = idx.get(OUT_BONES[i]);
      if (s === undefined) rotations[(f * B + i) * 4 + 3] = 1;
      else rotations.set(clip.rotations.subarray((f * S + s) * 4, (f * S + s) * 4 + 4), (f * B + i) * 4);
    }
  }
  return { ...clip, bones: OUT_BONES, rotations, hips: clip.hips.slice() };
}

function retime(clip: NormalizedClip, speed: number): NormalizedClip {
  if (Math.abs(speed - 1) < 1e-3) return clip;
  return resampleClip({ ...clip, fps: clip.fps * speed }, clip.fps);
}

/** Concatenates loop cycles, carrying the root travel forward. */
function cycles(clip: NormalizedClip, count: number): NormalizedClip {
  const N = clip.frames, B = clip.bones.length;
  // Open loops: frame N would equal frame 0, so one cycle travels (last - first) * N / (N - 1).
  const k = N > 1 ? N / (N - 1) : 1;
  const dx = (clip.hips[(N - 1) * 3] - clip.hips[0]) * k, dz = (clip.hips[(N - 1) * 3 + 2] - clip.hips[2]) * k;
  const frames = N * count;
  const rotations = new Float32Array(frames * B * 4);
  const hips = new Float32Array(frames * 3);
  for (let c = 0; c < count; c++) {
    rotations.set(clip.rotations, c * N * B * 4);
    for (let f = 0; f < N; f++) {
      const o = (c * N + f) * 3;
      hips[o] = clip.hips[f * 3] + dx * c;
      hips[o + 1] = clip.hips[f * 3 + 1];
      hips[o + 2] = clip.hips[f * 3 + 2] + dz * c;
    }
  }
  return { ...clip, frames, rotations, hips };
}

/** Holds the last frame until the clip lasts `frames` frames. */
function holdTo(clip: NormalizedClip, frames: number): NormalizedClip {
  if (frames <= clip.frames) return clip;
  const B = clip.bones.length, N = clip.frames;
  const rotations = new Float32Array(frames * B * 4);
  const hips = new Float32Array(frames * 3);
  rotations.set(clip.rotations);
  hips.set(clip.hips);
  for (let f = N; f < frames; f++) {
    rotations.copyWithin(f * B * 4, (N - 1) * B * 4, N * B * 4);
    hips.copyWithin(f * 3, (N - 1) * 3, N * 3);
  }
  return { ...clip, frames, rotations, hips };
}

/** Plays a looping clip for `frames` frames. */
function loopTo(clip: NormalizedClip, frames: number): NormalizedClip {
  const c = cycles(clip, Math.max(1, Math.ceil(frames / clip.frames)));
  return { ...c, frames, rotations: c.rotations.slice(0, frames * c.bones.length * 4), hips: c.hips.slice(0, frames * 3) };
}

const MIRROR_SIGN: Partial<Record<PoseControl, number>> = { turn: -1, spineSide: -1, spineTwist: -1, headTurn: -1, headTilt: -1 };

function mirrorKeys(keys: PoseKey[]): PoseKey[] {
  return keys.map((k) => {
    const pose: Pose = {};
    for (const [c, v] of Object.entries(k.pose) as Array<[PoseControl, number]>) {
      const m = (c.startsWith('left') ? 'right' + c.slice(4) : c.startsWith('right') ? 'left' + c.slice(5) : c) as PoseControl;
      pose[m] = v * (MIRROR_SIGN[c] ?? 1);
    }
    return { t: k.t, pose };
  });
}

/** Bones a pose-key gesture actually moves. */
function keyBones(keys: PoseKey[]): Set<string> {
  const set = new Set<string>();
  for (const c of touchedControls(keys)) for (const b of controlBones(c)) set.add(b);
  return set;
}

/** Copies `bones` from `top` over `base` (same length), weighted per frame. */
function layer(base: NormalizedClip, top: NormalizedClip, bones: Set<string>, weight: (f: number) => number, hipsHeight = false): NormalizedClip {
  const B = OUT_BONES.length;
  const out = { ...base, rotations: base.rotations.slice(), hips: base.hips.slice() };
  const a = new Quaternion(), b = new Quaternion();
  for (let f = 0; f < base.frames; f++) {
    const w = weight(f);
    if (w <= 0) continue;
    const tf = Math.min(f, top.frames - 1);
    for (let i = 0; i < B; i++) {
      if (!bones.has(OUT_BONES[i])) continue;
      a.fromArray(out.rotations, (f * B + i) * 4);
      b.fromArray(top.rotations, (tf * B + i) * 4);
      a.slerp(b, w).toArray(out.rotations, (f * B + i) * 4);
    }
    if (hipsHeight) out.hips[f * 3 + 1] += (top.hips[tf * 3 + 1] - out.hips[f * 3 + 1]) * w;
  }
  return out;
}

const PART_BONES: Record<BodyPart, string[]> = {
  leftArm: ['leftShoulder', 'leftUpperArm', 'leftLowerArm', 'leftHand'],
  rightArm: ['rightShoulder', 'rightUpperArm', 'rightLowerArm', 'rightHand'],
  arms: [],
  head: ['neck', 'head'],
  upperBody: [],
};
PART_BONES.arms = [...PART_BONES.leftArm, ...PART_BONES.rightArm];
PART_BONES.upperBody = ['spine', 'chest', 'upperChest', ...PART_BONES.head, ...PART_BONES.arms];

const smooth = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

// ---------------------------------------------------------------------------

export interface CompileOptions {
  fps?: number;
  /** Crossfade between steps, seconds. */
  blend?: number;
}

interface Built {
  clip: NormalizedClip;
  /** True when the source is a looping clip (cycles rather than a one-shot). */
  loops: boolean;
}

/** One playthrough of a source (repeats included), over OUT_BONES. */
function buildSource(lib: MotionLibrary, src: MotionSource, fps: number, base: NormalizedClip | null): Built {
  const entry = src.clip ? lib.clips.get(src.clip) : undefined;
  const flip = !!src.side && !!entry && entry.side !== 'both' && entry.side !== src.side;
  let clip: NormalizedClip;
  let loops = false;
  if (entry?.clip) {
    clip = toBodyBones(resampleClip(flip ? mirrorClip(entry.clip) : entry.clip, fps));
    loops = entry.kind === 'loop';
  } else {
    let keys = entry?.keys ?? src.keys ?? [];
    // Custom keys are written for whichever side the step names; built-in gestures use the right hand.
    if (flip) keys = mirrorKeys(keys);
    const pose = poseKeysClip(keys, { fps, name: entry?.name ?? 'Gesture' });
    // Untouched bones follow the idle base so the body keeps breathing and shifting weight.
    if (base) {
      const moved = keyBones(keys);
      const legs = [...moved].some((b) => /Leg|Foot/.test(b));
      clip = layer(loopTo(base, pose.frames), pose, moved, () => 1, legs);
    } else clip = pose;
  }
  clip = retime(clip, src.speed ?? 1);
  if (!loops && (src.repeat ?? 1) > 1) {
    const parts = Array.from({ length: src.repeat! }, () => clip);
    clip = concat(parts, Math.round(0.15 * fps));
  }
  return { clip, loops };
}

/**
 * Joins clips one after another. Each new clip blends in from the previous
 * clip's final pose over `blendFrames`, and its root travel continues from
 * where the previous one stopped.
 */
function concat(parts: NormalizedClip[], blendFrames: number): NormalizedClip {
  const B = OUT_BONES.length;
  const total = parts.reduce((n, p) => n + p.frames, 0);
  const rotations = new Float32Array(total * B * 4);
  const hips = new Float32Array(total * 3);
  const a = new Quaternion(), b = new Quaternion();
  let at = 0;
  for (const [pi, p] of parts.entries()) {
    const prev = at - 1;
    const ox = pi ? hips[prev * 3] - p.hips[0] : -p.hips[0];
    const oz = pi ? hips[prev * 3 + 2] - p.hips[2] : -p.hips[2];
    for (let f = 0; f < p.frames; f++) {
      const o = at + f;
      const w = pi && blendFrames > 0 ? smooth((f + 1) / (blendFrames + 1)) : 1;
      for (let i = 0; i < B; i++) {
        b.fromArray(p.rotations, (f * B + i) * 4);
        if (w < 1) a.fromArray(rotations, (prev * B + i) * 4).slerp(b, w).toArray(rotations, (o * B + i) * 4);
        else b.toArray(rotations, (o * B + i) * 4);
      }
      hips[o * 3] = p.hips[f * 3] + ox;
      hips[o * 3 + 2] = p.hips[f * 3 + 2] + oz;
      hips[o * 3 + 1] = w < 1 ? hips[prev * 3 + 1] + (p.hips[f * 3 + 1] - hips[prev * 3 + 1]) * w : p.hips[f * 3 + 1];
    }
    at += p.frames;
  }
  return { ...parts[0], frames: total, rotations, hips, bones: OUT_BONES };
}

/** Turns a plan into one NormalizedClip over the body bones. */
export function compileMotionPlan(plan: MotionPlan, lib: MotionLibrary, options: CompileOptions = {}): NormalizedClip {
  const fps = options.fps ?? 30;
  const blendFrames = Math.round((options.blend ?? 0.3) * fps);
  const idle = lib.clips.get('idle')?.clip;
  const base = idle ? toBodyBones(resampleClip(idle, fps)) : null;
  const segments: NormalizedClip[] = [];
  for (const step of plan.steps) {
    let { clip, loops } = buildSource(lib, step, fps, base);
    if (loops) {
      const seconds = step.seconds ?? (step.overlay ? 4 : 3);
      const n = Math.max(1, Math.round((seconds * fps) / clip.frames));
      clip = cycles(clip, n);
    } else if (step.seconds) clip = holdTo(clip, Math.round(step.seconds * fps) + 1);

    if (step.overlay) {
      const part = step.overlay.part;
      const side = step.overlay.side ?? (part === 'leftArm' ? 'left' : part === 'rightArm' ? 'right' : undefined);
      const over = buildSource(lib, { ...step.overlay, side }, fps, null);
      const top = over.loops ? loopTo(over.clip, clip.frames) : over.clip;
      const fade = Math.round(0.25 * fps);
      const endF = over.loops ? clip.frames : top.frames;
      // Fade the overlay in, and back out to the base motion when it ends.
      const weight = (f: number) => Math.min(smooth(f / fade), over.loops ? 1 : smooth((endF - 1 - f) / fade));
      clip = layer(clip, top, new Set(PART_BONES[part]), weight);
    }
    segments.push(clip);
  }
  let out = concat(segments, blendFrames);
  if (plan.loop && plan.steps.length > 1) out = closeLoop(out, blendFrames);
  return { ...out, name: plan.name, fps, loop: plan.loop, meta: { plan } };
}

/** Blends the tail of a clip into its first frame so it loops without a pop. */
function closeLoop(clip: NormalizedClip, blendFrames: number): NormalizedClip {
  const B = OUT_BONES.length, N = clip.frames;
  const out = { ...clip, rotations: clip.rotations.slice(), hips: clip.hips.slice() };
  const a = new Quaternion(), b = new Quaternion();
  const n = Math.min(blendFrames, N - 1);
  for (let k = 0; k < n; k++) {
    const f = N - n + k;
    const w = smooth((k + 1) / (n + 1));
    for (let i = 0; i < B; i++) {
      a.fromArray(out.rotations, (f * B + i) * 4);
      b.fromArray(clip.rotations, i * 4);
      a.slerp(b, w).toArray(out.rotations, (f * B + i) * 4);
    }
    out.hips[f * 3 + 1] += (clip.hips[1] - out.hips[f * 3 + 1]) * w;
  }
  return out;
}
