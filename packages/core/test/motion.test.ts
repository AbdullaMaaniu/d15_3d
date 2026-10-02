import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import type { PresetPack } from '../src/anim/codec';
import type { NormalizedClip } from '../src/anim/retarget';
import { canonicalParent } from '../src/skeleton';
import { poseRotations, poseKeysClip, type Pose } from '../src/motion/pose';
import { motionPlanSchema, sanitizeMotionPlan } from '../src/motion/plan';
import { compileMotionPlan, createMotionLibrary } from '../src/motion/compile';
import {
  claudeMotionProvider, createMockMotionProvider, describeLibrary, generateMotion, MotionProviderError, planFromText, builtinMotionProvider,
} from '../src/motion/providers';
import { GESTURES } from '../src/motion/gestures';

const pack = JSON.parse(readFileSync(fileURLToPath(new URL('../../presets/clips.json', import.meta.url)), 'utf8')) as PresetPack;
const lib = createMotionLibrary(pack.clips);
const catalog = describeLibrary(lib);

// A canonical skeleton (rest hips height 1) for forward kinematics in normalized space.
const OFFSETS: Record<string, [number, number, number]> = {
  spine: [0, 0.1, 0], chest: [0, 0.12, 0], upperChest: [0, 0.12, 0], neck: [0, 0.14, 0], head: [0, 0.1, 0],
  leftShoulder: [0.03, 0.1, 0], leftUpperArm: [0.15, 0, 0], leftLowerArm: [0.28, 0, 0], leftHand: [0.25, 0, 0],
  leftUpperLeg: [0.1, -0.03, 0], leftLowerLeg: [0, -0.47, 0], leftFoot: [0, -0.42, 0], leftToes: [0, -0.06, 0.13],
};
for (const [k, v] of Object.entries({ ...OFFSETS })) if (k.startsWith('left')) OFFSETS['right' + k.slice(4)] = [-v[0], v[1], v[2]];
const HAND_TIP: [number, number, number] = [0.08, 0, 0];

/** World positions of joints for one frame of a clip (or a rotation map). */
function fk(local: (bone: string) => Quaternion, hips: Vector3): Map<string, { p: Vector3; q: Quaternion }> {
  const out = new Map<string, { p: Vector3; q: Quaternion }>();
  out.set('hips', { p: hips.clone(), q: local('hips') });
  const order = ['spine', 'chest', 'upperChest', 'neck', 'head', 'leftShoulder', 'leftUpperArm', 'leftLowerArm', 'leftHand', 'rightShoulder', 'rightUpperArm', 'rightLowerArm', 'rightHand', 'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'leftToes', 'rightUpperLeg', 'rightLowerLeg', 'rightFoot', 'rightToes'];
  for (const b of order) {
    const parent = out.get(canonicalParent(b)!)!;
    const p = new Vector3(...OFFSETS[b]).applyQuaternion(parent.q).add(parent.p);
    out.set(b, { p, q: parent.q.clone().multiply(local(b)) });
  }
  for (const s of ['left', 'right']) {
    const h = out.get(`${s}Hand`)!;
    out.set(`${s}Tip`, { p: new Vector3(s === 'left' ? HAND_TIP[0] : -HAND_TIP[0], 0, 0).applyQuaternion(h.q).add(h.p), q: h.q });
  }
  return out;
}

const posed = (pose: Pose) => {
  const { rotations, hipsHeight } = poseRotations(pose);
  return fk((b) => rotations.get(b) ?? new Quaternion(), new Vector3(0, hipsHeight, 0));
};

function frame(clip: NormalizedClip, f: number) {
  const B = clip.bones.length;
  const idx = new Map(clip.bones.map((b, i) => [b, i]));
  return fk((b) => (idx.has(b) ? new Quaternion().fromArray(clip.rotations, (f * B + idx.get(b)!) * 4) : new Quaternion()), new Vector3().fromArray(clip.hips, f * 3));
}

describe('pose controls', () => {
  it('raise the arms the way the names say', () => {
    const side = posed({ leftArmLift: 90, leftElbow: 0 });
    const sh = side.get('leftUpperArm')!.p, hand = side.get('leftHand')!.p;
    expect(hand.x - sh.x).toBeGreaterThan(0.5); // out to the character's left (+X)
    expect(Math.abs(hand.y - sh.y)).toBeLessThan(0.02);

    const front = posed({ rightArmLift: 90, rightArmForward: 90, rightElbow: 0 });
    const rs = front.get('rightUpperArm')!.p, rh = front.get('rightHand')!.p;
    expect(rh.z - rs.z).toBeGreaterThan(0.5); // forward (+Z)
    expect(Math.abs(rh.x - rs.x)).toBeLessThan(0.02);

    const up = posed({ leftArmLift: 180, leftElbow: 0 });
    expect(up.get('leftHand')!.p.y - up.get('leftUpperArm')!.p.y).toBeGreaterThan(0.5);

    const across = posed({ leftArmLift: 60, leftArmForward: 150, leftElbow: 0 });
    expect(across.get('leftHand')!.p.x).toBeLessThan(across.get('leftUpperArm')!.p.x);
  });

  it('bend elbows forward from a hanging arm and up for a wave', () => {
    const hang = posed({ leftArmLift: 0, leftElbow: 90 });
    const el = hang.get('leftLowerArm')!.p, wr = hang.get('leftHand')!.p;
    expect(wr.z - el.z).toBeGreaterThan(0.2);
    for (const s of ['left', 'right'] as const) {
      const wave = posed({ [`${s}ArmLift`]: 90, [`${s}Elbow`]: 90, [`${s}ForearmRoll`]: 90 } as Pose);
      expect(wave.get(`${s}Hand`)!.p.y - wave.get(`${s}LowerArm`)!.p.y).toBeGreaterThan(0.2);
    }
  });

  it('turn, bend and look in the stated directions', () => {
    const p = posed({ spineBend: 60 });
    expect(p.get('head')!.p.z).toBeGreaterThan(0.2);
    const lean = posed({ spineSide: 30 });
    expect(lean.get('head')!.p.x).toBeGreaterThan(0.1);
    const look = posed({ headTurn: 80 });
    expect(new Vector3(0, 0, 1).applyQuaternion(look.get('head')!.q).x).toBeGreaterThan(0.9);
    const nod = posed({ headNod: 40 });
    expect(new Vector3(0, 0, 1).applyQuaternion(nod.get('head')!.q).y).toBeLessThan(-0.5);
  });

  it('keeps the feet on the floor when crouching and kneeling', () => {
    const stand = posed({});
    expect(stand.get('hips')!.p.y).toBeCloseTo(1, 2);
    for (const pose of [{ leftHip: 90, rightHip: 90, leftKnee: 110, rightKnee: 110 }, GESTURES.find((g) => g.id === 'kneel')!.keys.at(-2)!.pose]) {
      const p = posed(pose);
      expect(p.get('hips')!.p.y).toBeLessThan(0.75);
      const lowest = Math.min(...['leftFoot', 'rightFoot', 'leftLowerLeg', 'rightLowerLeg'].map((b) => p.get(b)!.p.y));
      // Joint centers sit a little above the floor (ankle height, knee radius).
      expect(lowest).toBeGreaterThan(-0.02);
      expect(lowest).toBeLessThan(0.12);
    }
  });
});

describe('built-in provider', () => {
  const plan = (s: string) => planFromText(s, catalog);

  it('recognises single motions and loops them', () => {
    expect(plan('walk')).toMatchObject({ loop: true, steps: [{ clip: 'walk' }] });
    expect(plan('A character jogging')).toMatchObject({ steps: [{ clip: 'run' }] });
    expect(plan('walk backwards slowly').steps[0]).toMatchObject({ clip: 'walk_backward', speed: 0.78 });
  });

  it('sequences clauses with modifiers', () => {
    const p = plan('Walk for 4 seconds, then wave with the left hand, then jump twice');
    expect(p.loop).toBe(false);
    expect(p.steps).toEqual([{ clip: 'walk', seconds: 4 }, { clip: 'wave_hand', side: 'left' }, { clip: 'jump', repeat: 2 }]);
  });

  it('overlays a gesture on locomotion', () => {
    const p = plan('wave while walking');
    expect(p.steps).toHaveLength(1);
    expect(p.steps[0]).toMatchObject({ clip: 'walk', overlay: { clip: 'wave_hand', part: 'rightArm' } });
    expect(plan('march and clap').steps[0]).toMatchObject({ clip: 'walk', overlay: { clip: 'clap', part: 'arms' } });
  });

  it('explains what it understands when nothing matches', async () => {
    await expect(generateMotion('photosynthesise', builtinMotionProvider, lib)).rejects.toThrow(/No motion recognised/);
  });
});

describe('plans', () => {
  it('sanitizes untrusted plans', () => {
    const p = sanitizeMotionPlan({
      name: 'x'.repeat(100),
      loop: 'yes',
      steps: [
        { clip: 'nope' },
        { clip: 'walk', seconds: 1e6, speed: 99, side: 'up' },
        { keys: [{ t: 0.5, pose: [{ control: 'leftArmLift', degrees: 90 }, { control: 'evil', degrees: 1 }] }] },
        { clip: 'idle', overlay: { clip: 'wave', part: 'tail' } },
      ],
    }, lib.clips.keys());
    expect(p.name).toHaveLength(40);
    expect(p.loop).toBe(false);
    expect(p.steps).toEqual([
      { clip: 'walk', seconds: 60, speed: 3 },
      { keys: [{ t: 0.5, pose: { leftArmLift: 90 } }] },
      { clip: 'idle' },
    ]);
    expect(() => sanitizeMotionPlan({ steps: [{ clip: 'nope' }] }, lib.clips.keys())).toThrow(/no playable steps/);
  });

  it('describes every clip in the schema', () => {
    const schema = motionPlanSchema(catalog.map((c) => c.id)) as any;
    expect(schema.properties.steps.items.properties.clip.enum).toContain('clap');
    expect(schema.properties.steps.items.properties.clip.enum).toContain('walk');
  });

  it('compiles steps into one continuous clip', () => {
    const walk = lib.clips.get('walk')!;
    const clip = compileMotionPlan({ name: 'T', loop: false, steps: [{ clip: 'walk', seconds: 3 }, { clip: 'bow' }, { clip: 'clap' }] }, lib);
    const bow = lib.clips.get('bow')!, clap = lib.clips.get('clap')!;
    const expected = 3 + bow.seconds + clap.seconds;
    expect(clip.frames / 30).toBeGreaterThan(expected - 1.2);
    expect(clip.frames / 30).toBeLessThan(expected + 1.2);
    // Travel continues through the steps: no hips jump bigger than one frame of walking.
    let maxStep = 0;
    for (let f = 1; f < clip.frames; f++) maxStep = Math.max(maxStep, Math.hypot(clip.hips[f * 3] - clip.hips[f * 3 - 3], clip.hips[f * 3 + 2] - clip.hips[f * 3 - 1]));
    expect(maxStep).toBeLessThan(0.15);
    expect(clip.hips[(clip.frames - 1) * 3 + 2]).toBeGreaterThan(1); // walked forward
    // No pose pops between frames.
    const B = clip.bones.length;
    const a = new Quaternion(), b = new Quaternion();
    let maxTurn = 0;
    for (let f = 1; f < clip.frames; f++) {
      for (let i = 0; i < B; i++) {
        a.fromArray(clip.rotations, ((f - 1) * B + i) * 4);
        b.fromArray(clip.rotations, (f * B + i) * 4);
        maxTurn = Math.max(maxTurn, a.angleTo(b));
      }
    }
    expect(maxTurn).toBeLessThan(0.6);
    expect(walk.kind).toBe('loop');
  });

  it('swings each arm opposite its own leg when walking', () => {
    const clip = compileMotionPlan({ name: 'W', loop: true, steps: [{ clip: 'walk', seconds: 4 }] }, lib);
    for (const s of ['left', 'right'] as const) {
      let cov = 0, va = 0, vl = 0;
      const hand: number[] = [], foot: number[] = [];
      for (let f = 0; f < clip.frames; f++) {
        const j = frame(clip, f);
        const hz = j.get('hips')!.p.z;
        hand.push(j.get(`${s}Hand`)!.p.z - hz);
        foot.push(j.get(`${s}Foot`)!.p.z - hz);
      }
      const mh = hand.reduce((x, y) => x + y) / hand.length, mf = foot.reduce((x, y) => x + y) / foot.length;
      for (let f = 0; f < hand.length; f++) {
        cov += (hand[f] - mh) * (foot[f] - mf);
        va += (hand[f] - mh) ** 2;
        vl += (foot[f] - mf) ** 2;
      }
      expect(cov / Math.sqrt(va * vl), `${s} arm vs ${s} leg`).toBeLessThan(-0.5);
    }
  });

  it('overlays only the requested body part', () => {
    const plain = compileMotionPlan({ name: 'A', loop: false, steps: [{ clip: 'walk', seconds: 4 }] }, lib);
    const waved = compileMotionPlan({ name: 'B', loop: false, steps: [{ clip: 'walk', seconds: 4, overlay: { clip: 'wave_hand', part: 'leftArm' } }] }, lib);
    expect(waved.frames).toBe(plain.frames);
    const B = plain.bones.length, f = 45;
    const diff = (bone: string) => {
      const i = plain.bones.indexOf(bone);
      return new Quaternion().fromArray(plain.rotations, (f * B + i) * 4).angleTo(new Quaternion().fromArray(waved.rotations, (f * B + i) * 4));
    };
    expect(diff('leftUpperArm')).toBeGreaterThan(0.3);
    expect(diff('rightUpperArm')).toBeLessThan(2e-3); // acos rounding
    expect(diff('leftUpperLeg')).toBeLessThan(2e-3);
    // The wave is mirrored onto the left arm: the left hand ends up high.
    expect(frame(waved, f).get('leftHand')!.p.y).toBeGreaterThan(frame(waved, f).get('leftShoulder')!.p.y);
  });

  it('mirrors one-handed clips to the requested side', () => {
    expect(lib.clips.get('wave')!.side).toBe('both'); // the mocap wave uses both hands
    expect(lib.clips.get('throw')!.side).toBe('right');
    for (const [id, side] of [['throw', 'left'], ['wave_hand', 'left'], ['wave_hand', 'right']] as const) {
      const clip = compileMotionPlan({ name: 'W', loop: false, steps: [{ clip: id, side }] }, lib);
      const other = side === 'left' ? 'right' : 'left';
      const peak = (s: string) => Math.max(...Array.from({ length: clip.frames }, (_, f) => frame(clip, f).get(`${s}Hand`)!.p.y));
      expect(peak(side), `${id} ${side}`).toBeGreaterThan(peak(other) + 0.3);
    }
  });

  it('builds custom pose-key gestures on top of the idle', () => {
    const clip = compileMotionPlan({ name: 'K', loop: false, steps: [{ keys: [{ t: 0.6, pose: { rightArmLift: 170, rightElbow: 5 } }, { t: 1.2, pose: {} }] }] }, lib);
    const j = frame(clip, 18);
    expect(j.get('rightHand')!.p.y).toBeGreaterThan(j.get('head')!.p.y);
    // The legs still come from the idle, not a frozen neutral pose.
    const B = clip.bones.length, i = clip.bones.indexOf('leftUpperLeg');
    expect(new Quaternion().fromArray(clip.rotations, i * 4).angleTo(new Quaternion())).toBeGreaterThan(1e-3);
    expect(poseKeysClip([{ t: 1, pose: {} }]).frames).toBe(31);
    expect(B).toBe(22);
  });
});

describe('providers', () => {
  it('runs a mock provider through to a clip', async () => {
    const mock = createMockMotionProvider({ name: 'Hi', loop: false, steps: [{ clip: 'wave' }] });
    const { plan, clip } = await generateMotion('say hi', mock, lib);
    expect(mock.calls).toEqual(['say hi']);
    expect(plan.steps[0].clip).toBe('wave');
    expect(clip.frames).toBeGreaterThan(30);
    expect(clip.meta?.plan).toEqual(plan);
  });

  function fakeFetch(reply: (body: any) => { status: number; json: unknown }) {
    const seen: Array<{ url: string; headers: Headers; body: any }> = [];
    const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      seen.push({ url: String(input), headers: new Headers(init?.headers), body });
      const r = reply(body);
      return new Response(JSON.stringify(r.json), { status: r.status, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    return { f, seen };
  }

  const message = (text: string, stop_reason = 'end_turn') => ({
    id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason, stop_sequence: null,
    content: [{ type: 'text', text }], usage: { input_tokens: 10, output_tokens: 10 },
  });

  it('asks Claude for a structured plan', async () => {
    const plan = { name: 'Salute', loop: false, steps: [{ clip: 'walk', seconds: 3 }, { clip: 'salute' }] };
    const { f, seen } = fakeFetch(() => ({ status: 200, json: message(JSON.stringify(plan)) }));
    const provider = claudeMotionProvider({ apiKey: 'sk-test', fetch: f });
    const out = await generateMotion('march then salute', provider, lib);
    expect(out.plan).toEqual(plan);
    const req = seen[0];
    expect(req.url).toContain('/v1/messages');
    expect(req.headers.get('x-api-key')).toBe('sk-test');
    expect(req.headers.get('anthropic-beta')).toContain('server-side-fallback-2026-07-01');
    expect(req.body.model).toBe('claude-opus-5-5');
    expect(req.body.fallbacks).toBe('default');
    expect(req.body.output_config.format.type).toBe('json_schema');
    expect(req.body.messages).toEqual([{ role: 'user', content: 'march then salute' }]);
    expect(req.body.system).toContain('salute');
  });

  it('reports refusals and bad keys plainly', async () => {
    const refused = fakeFetch(() => ({ status: 200, json: message('', 'refusal') }));
    await expect(generateMotion('x', claudeMotionProvider({ apiKey: 'k', fetch: refused.f }), lib)).rejects.toThrow(/declined/);
    const denied = fakeFetch(() => ({ status: 401, json: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } } }));
    const err = await generateMotion('x', claudeMotionProvider({ apiKey: 'k', fetch: denied.f }), lib).catch((e) => e);
    expect(err).toBeInstanceOf(MotionProviderError);
    expect(err.kind).toBe('auth');
    await expect(generateMotion('x', claudeMotionProvider({ apiKey: '' }), lib)).rejects.toThrow(/API key is required/);
  });
});
