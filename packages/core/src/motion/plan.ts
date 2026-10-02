import { POSE_CONTROL_NAMES, type Pose, type PoseControl, type PoseKey } from './pose';

/**
 * A motion plan: what a text-to-motion provider returns. It is a short script of
 * steps played in sequence and blended together. Each step plays a library clip
 * (a motion-captured preset or a built-in gesture) or, when nothing in the
 * library fits, a custom pose-key gesture. A step can also overlay a second
 * motion on part of the body, e.g. waving while walking.
 */
export interface MotionPlan {
  name: string;
  /** Loop the whole result (idles, walk cycles). */
  loop: boolean;
  steps: MotionStep[];
}

export type BodyPart = 'arms' | 'leftArm' | 'rightArm' | 'upperBody' | 'head';
export const BODY_PARTS: BodyPart[] = ['arms', 'leftArm', 'rightArm', 'upperBody', 'head'];

export interface MotionSource {
  /** A library clip id (preset or gesture). */
  clip?: string;
  /** Custom pose keys, used when `clip` is not given. */
  keys?: PoseKey[];
  /** Which hand or leg does the main action; the clip is mirrored to match. */
  side?: 'left' | 'right';
  /** Play a one-shot this many times (default 1). */
  repeat?: number;
  /** Playback speed multiplier (default 1). */
  speed?: number;
}

export interface MotionStep extends MotionSource {
  /** Looping clips: how long to keep going. One-shots: hold the final pose until this length. */
  seconds?: number;
  /** Play a second motion on part of the body during this step. */
  overlay?: MotionSource & { part: BodyPart };
}

const num = (v: unknown, lo: number, hi: number): number | undefined => {
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : undefined;
};

const CONTROL_SET = new Set<string>(POSE_CONTROL_NAMES);

function sanitizePose(v: unknown): Pose {
  const pose: Pose = {};
  // Accepts { control: degrees } or [{ control, degrees }] (the wire form models write).
  const entries: Array<[unknown, unknown]> = Array.isArray(v)
    ? v.map((e) => [(e as { control?: unknown })?.control, (e as { degrees?: unknown })?.degrees])
    : v && typeof v === 'object' ? Object.entries(v) : [];
  for (const [k, d] of entries) {
    const n = num(d, -360, 360);
    if (typeof k === 'string' && CONTROL_SET.has(k) && n !== undefined) pose[k as PoseControl] = n;
  }
  return pose;
}

function sanitizeKeys(v: unknown): PoseKey[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const keys = v
    .map((k) => ({ t: num((k as { t?: unknown })?.t, 0, 60), pose: sanitizePose((k as { pose?: unknown })?.pose) }))
    .filter((k): k is PoseKey => k.t !== undefined)
    .slice(0, 200);
  return keys.length ? keys : undefined;
}

function sanitizeSource(v: Record<string, unknown>, clipIds: Set<string>): MotionSource | null {
  const clip = typeof v.clip === 'string' && clipIds.has(v.clip) ? v.clip : undefined;
  const keys = clip ? undefined : sanitizeKeys(v.keys);
  if (!clip && !keys) return null;
  const out: MotionSource = clip ? { clip } : { keys };
  if (v.side === 'left' || v.side === 'right') out.side = v.side;
  const repeat = num(v.repeat, 1, 10);
  if (repeat !== undefined) out.repeat = Math.round(repeat);
  const speed = num(v.speed, 0.25, 3);
  if (speed !== undefined) out.speed = speed;
  return out;
}

/**
 * Validates an untrusted plan (from a model or a file): drops unknown clips,
 * controls and fields, clamps numbers. Throws if no playable step is left.
 */
export function sanitizeMotionPlan(raw: unknown, clipIds: Iterable<string>): MotionPlan {
  const ids = new Set(clipIds);
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const steps: MotionStep[] = [];
  for (const s of Array.isArray(r.steps) ? r.steps.slice(0, 20) : []) {
    if (!s || typeof s !== 'object') continue;
    const src = sanitizeSource(s as Record<string, unknown>, ids);
    if (!src) continue;
    const step: MotionStep = src;
    const seconds = num((s as Record<string, unknown>).seconds, 0.2, 60);
    if (seconds !== undefined) step.seconds = seconds;
    const o = (s as Record<string, unknown>).overlay as Record<string, unknown> | undefined;
    if (o && typeof o === 'object' && BODY_PARTS.includes(o.part as BodyPart)) {
      const os = sanitizeSource(o, ids);
      if (os) step.overlay = { ...os, part: o.part as BodyPart };
    }
    steps.push(step);
  }
  if (!steps.length) throw new Error('The motion plan has no playable steps.');
  const name = typeof r.name === 'string' && r.name.trim() ? r.name.trim().slice(0, 40) : 'Generated';
  return { name, loop: r.loop === true, steps };
}

/**
 * JSON Schema for a plan in the wire form models write (pose keys as
 * [{ control, degrees }] lists), for structured outputs.
 */
export function motionPlanSchema(clipIds: string[]): Record<string, unknown> {
  const key = {
    type: 'object',
    additionalProperties: false,
    required: ['t', 'pose'],
    properties: {
      t: { type: 'number', description: 'Seconds from the start of this motion.' },
      pose: {
        type: 'array',
        description: 'Joint angles set at this key; joints not listed hold their previous value.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['control', 'degrees'],
          properties: { control: { type: 'string', enum: POSE_CONTROL_NAMES }, degrees: { type: 'number' } },
        },
      },
    },
  };
  const source = {
    clip: { type: 'string', enum: clipIds, description: 'A library clip id. Omit to use keys instead.' },
    keys: { type: 'array', items: key, description: 'Custom pose keys, only when no library clip fits.' },
    side: { type: 'string', enum: ['left', 'right'], description: 'Which hand or leg does the action.' },
    repeat: { type: 'integer', description: 'Play a one-shot this many times.' },
    speed: { type: 'number', description: 'Playback speed, 1 = normal.' },
  };
  return {
    type: 'object',
    additionalProperties: false,
    required: ['name', 'loop', 'steps'],
    properties: {
      name: { type: 'string', description: 'A short clip name, 1 to 3 words.' },
      loop: { type: 'boolean', description: 'True for cycles meant to repeat forever (idle, walk).' },
      steps: {
        type: 'array',
        description: 'Motions played one after another, blended together.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ...source,
            seconds: { type: 'number', description: 'Looping clips: duration. One-shots: hold the end pose until this length.' },
            overlay: {
              type: 'object',
              additionalProperties: false,
              required: ['part'],
              description: 'A second motion played on part of the body during this step.',
              properties: { ...source, part: { type: 'string', enum: BODY_PARTS } },
            },
          },
        },
      },
    },
  };
}
