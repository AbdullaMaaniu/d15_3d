import { Euler, Quaternion } from 'three';
import type { JointMap } from '../skeleton';
import { TAIL_BONES } from '../rig/quadruped';
import type { PropKeys } from '../rig/prop';

export type GaitId = 'idle' | 'walk' | 'trot' | 'gallop' | 'sit' | 'tailWag';

export interface GaitClip {
  id: GaitId;
  name: string;
  loop: boolean;
  keys: PropKeys;
  /** Approximate ground speed (m/s) the cycle represents, for blend thresholds. */
  speed: number;
  description: string;
}

interface GaitSpec {
  cycle: number; // seconds
  swing: number; // upper-leg swing amplitude (rad)
  flex: number; // lower joint flex during swing (rad)
  bob: number; // hips bob, fraction of hip height
  phases: Record<'LF' | 'RF' | 'LB' | 'RB', number>;
  stance: number; // fraction of the cycle a foot is on the ground
  spineFlex: number;
  tail: number;
}

const SPECS: Record<'walk' | 'trot' | 'gallop', GaitSpec> = {
  // Lateral-sequence walk: each foot a quarter cycle apart.
  walk: { cycle: 1.1, swing: 0.32, flex: 0.7, bob: 0.012, phases: { LB: 0, LF: 0.25, RB: 0.5, RF: 0.75 }, stance: 0.62, spineFlex: 0.03, tail: 0.25 },
  // Trot: diagonal pairs move together.
  trot: { cycle: 0.62, swing: 0.42, flex: 0.95, bob: 0.025, phases: { LF: 0, RB: 0, RF: 0.5, LB: 0.5 }, stance: 0.5, spineFlex: 0.04, tail: 0.18 },
  // Rotary gallop: hind pair then fore pair, with spine flexion.
  gallop: { cycle: 0.42, swing: 0.7, flex: 1.2, bob: 0.05, phases: { LB: 0, RB: 0.08, LF: 0.45, RF: 0.53 }, stance: 0.38, spineFlex: 0.16, tail: 0.1 },
};

const STEPS = 24;

const q = (x: number, y = 0, z = 0) => new Quaternion().setFromEuler(new Euler(x, y, z, 'XYZ')).toArray();

function channel(keys: PropKeys, bone: string) {
  return (keys.bones[bone] ??= { times: [], rot: [], pos: [] });
}

function legLength(j: JointMap, side: 'left' | 'right', end: 'Front' | 'Back') {
  const a = j.joints[`${side}${end}UpperLeg`], b = j.joints[`${side}${end}Toes`];
  return a && b ? a[1] - b[1] : 0.5;
}

/** Stride cycle for one foot: angle of the upper leg and flex of the lower joints at phase p. */
function legPose(p: number, spec: GaitSpec) {
  const s = spec.stance;
  let swing: number, flex = 0;
  if (p < s) {
    swing = -spec.swing + (2 * spec.swing * p) / s; // foot sweeps backward while planted
  } else {
    const f = (p - s) / (1 - s);
    const e = f * f * (3 - 2 * f);
    swing = spec.swing - 2 * spec.swing * e; // and returns forward in the air
    flex = Math.sin(f * Math.PI) * spec.flex;
  }
  return { swing, flex };
}

function locomotion(id: 'walk' | 'trot' | 'gallop', joints: JointMap): GaitClip {
  const spec = SPECS[id];
  const keys: PropKeys = { duration: spec.cycle, bones: {} };
  const hipsH = joints.joints.hips?.[1] ?? 0.5;
  for (let i = 0; i <= STEPS; i++) {
    const f = i / STEPS;
    const t = f * spec.cycle;
    for (const [leg, phase] of Object.entries(spec.phases) as Array<['LF' | 'RF' | 'LB' | 'RB', number]>) {
      const side = leg[0] === 'L' ? 'left' : 'right';
      const end = leg[1] === 'F' ? 'Front' : 'Back';
      const { swing, flex } = legPose((f + phase) % 1, spec);
      const bone = (s: string) => `${side}${end}${s}`;
      // Positive X rotation moves a hanging limb backward; forward swing is negative.
      const push = (name: string, rot: number[]) => {
        const c = channel(keys, name);
        c.times.push(t);
        c.rot!.push(...rot);
        c.pos!.push(0, 0, 0);
      };
      if (end === 'Front') {
        push(bone('UpperLeg'), q(-swing));
        push(bone('LowerLeg'), q(-0.2 * flex));
        push(bone('Foot'), q(flex)); // carpus folds back in the air
        push(bone('Toes'), q(-0.3 * flex));
      } else {
        push(bone('UpperLeg'), q(-swing - 0.25 * flex));
        push(bone('LowerLeg'), q(0.8 * flex)); // stifle flexes
        push(bone('Foot'), q(-0.9 * flex)); // hock flexes
        push(bone('Toes'), q(0.3 * flex));
      }
    }
    // Body: hips bob twice per cycle, spine flexes (gallop), head counter-bobs, tail sways.
    const bob = Math.cos(f * Math.PI * 4) * spec.bob * hipsH;
    const hips = channel(keys, 'hips');
    hips.times.push(t);
    hips.rot!.push(...q(0, 0, Math.sin(f * Math.PI * 2) * 0.03));
    hips.pos!.push(0, bob, 0);
    const flexA = Math.sin(f * Math.PI * 2) * spec.spineFlex;
    for (const [name, rot] of [
      ['spine', q(flexA)],
      ['chest', q(-flexA * 0.5)],
      ['neck', q(-Math.cos(f * Math.PI * 4) * 0.04)],
      ['head', q(Math.cos(f * Math.PI * 4) * 0.05)],
    ] as const) {
      const c = channel(keys, name);
      c.times.push(t);
      c.rot!.push(...rot);
      c.pos!.push(0, 0, 0);
    }
    TAIL_BONES.forEach((name, k) => {
      const c = channel(keys, name);
      c.times.push(t);
      c.rot!.push(...q(0, Math.sin(f * Math.PI * 2 - k * 0.6) * spec.tail));
      c.pos!.push(0, 0, 0);
    });
  }
  // Speed ≈ stride length / cycle; stride ≈ 2 * leg * sin(swing) / stance-fraction.
  const leg = (legLength(joints, 'left', 'Front') + legLength(joints, 'left', 'Back')) / 2;
  const speed = (2 * leg * Math.sin(spec.swing)) / (spec.stance * spec.cycle);
  const names = { walk: 'Walk', trot: 'Trot', gallop: 'Gallop' };
  const desc = { walk: 'Four-beat walk', trot: 'Diagonal-pair trot', gallop: 'Rotary gallop' };
  return { id, name: names[id], loop: true, keys, speed, description: desc[id] };
}

function idle(): GaitClip {
  const duration = 4;
  const keys: PropKeys = { duration, bones: {}, interpolation: 'smooth' };
  const set = (bone: string, times: number[], rots: number[][]) => {
    keys.bones[bone] = { times, rot: rots.flat(), pos: times.flatMap(() => [0, 0, 0]) };
  };
  const t = [0, 1, 2, 3, 4];
  // Look around, breathe, lazy tail.
  set('neck', t, [q(0), q(0.05, 0.15), q(-0.05, 0.1), q(0.02, -0.2), q(0)]);
  set('head', t, [q(0), q(0, 0.25, 0.08), q(0.1, 0.1), q(0, -0.3, -0.06), q(0)]);
  set('chest', t, [q(0), q(0.02), q(0), q(0.02), q(0)]);
  TAIL_BONES.forEach((b, k) => set(b, t, [q(0, 0.12 - k * 0.05), q(0.05, -0.15 + k * 0.05), q(0, 0.12 - k * 0.05), q(0.05, -0.15 + k * 0.05), q(0, 0.12 - k * 0.05)]));
  return { id: 'idle', name: 'Idle', loop: true, keys, speed: 0, description: 'Standing, looking around' };
}

function tailWag(): GaitClip {
  const duration = 0.5;
  const keys: PropKeys = { duration, bones: {}, interpolation: 'smooth' };
  const t = [0, 0.25, 0.5];
  TAIL_BONES.forEach((b, k) => {
    const a = 0.35 + k * 0.08;
    keys.bones[b] = { times: t, rot: [q(0.15, a), q(0.15, -a), q(0.15, a)].flat(), pos: [0, 0, 0, 0, 0, 0, 0, 0, 0] };
  });
  return { id: 'tailWag', name: 'Tail Wag', loop: true, keys, speed: 0, description: 'Happy tail (use as a layer)' };
}

function sit(joints: JointMap): GaitClip {
  const duration = 1.2;
  const keys: PropKeys = { duration, bones: {}, interpolation: 'smooth' };
  const hipsH = joints.joints.hips?.[1] ?? 0.5;
  const tilt = -0.55; // nose up
  const t = [0, duration];
  const set = (bone: string, rot: number[], pos: number[] = [0, 0, 0]) => {
    keys.bones[bone] = { times: t, rot: [...q(0), ...rot], pos: [0, 0, 0, ...pos] };
  };
  set('hips', q(tilt), [0, -0.38 * hipsH, 0.05 * hipsH]);
  // Hind legs fold forward under the body; forelegs stay vertical despite the tilt.
  for (const side of ['left', 'right']) {
    set(`${side}BackUpperLeg`, q(-tilt - 1.1));
    set(`${side}BackLowerLeg`, q(1.9));
    set(`${side}BackFoot`, q(-1.2));
    set(`${side}BackToes`, q(0.4));
    set(`${side}FrontUpperLeg`, q(-tilt + 0.05));
  }
  set('neck', q(0.25));
  set('head', q(0.2));
  return { id: 'sit', name: 'Sit', loop: false, keys, speed: 0, description: 'Sit down and stay' };
}

/** Procedural animations for the quadruped skeleton, scaled to its proportions. */
export function quadrupedGaits(joints: JointMap): GaitClip[] {
  return [idle(), locomotion('walk', joints), locomotion('trot', joints), locomotion('gallop', joints), sit(joints), tailWag()];
}
