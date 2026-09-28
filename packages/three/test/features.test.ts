import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { Bone, Group, Mesh, MeshBasicMaterial, PlaneGeometry, Vector3, type AnimationClip } from 'three';
import {
  autoMapBones, bakeClip, bindSkeleton, buildSkinnedCharacter, computeSkinWeights, createMannequin,
  createWasmKernels, decodeClip, detectHumanoid, humanoidDefs, type PresetPack,
} from '../../core/src/index';
import { Character, solveTwoBoneIK } from '../src/index';

const pack = JSON.parse(readFileSync(fileURLToPath(new URL('../../presets/clips.json', import.meta.url)), 'utf8')) as PresetPack;
let make: () => Character;

beforeAll(async () => {
  const kernels = await createWasmKernels(readFileSync(fileURLToPath(new URL('../../core/wasm/rigforge_kernels.wasm', import.meta.url))));
  const { geometry } = createMannequin({ pose: 'A', detail: 8 });
  const positions = geometry.attributes.position.array as Float32Array;
  const index = new Uint32Array(geometry.index!.array);
  const joints = detectHumanoid(positions, index, { kernels });
  const defs = humanoidDefs(true);
  const w = computeSkinWeights(positions, index, defs, joints, { kernels, resolution: 64 });
  make = () => {
    const c = buildSkinnedCharacter(geometry, new MeshBasicMaterial(), defs, joints, w.skinIndex, w.skinWeight);
    const binding = bindSkeleton(c.root, autoMapBones(c.root).map);
    const clip = (id: string, inPlace = true): AnimationClip => {
      const n = decodeClip(pack.clips.find((x) => x.id === id)!);
      return bakeClip(binding, n, { inPlace, name: n.name });
    };
    const clips = [clip('idle'), clip('walk'), clip('run'), clip('jump'), clip('punch'), clip('walk', false)];
    clips[5].name = 'WalkRoot';
    const scene = new Group();
    scene.add(c.root);
    return new Character(c.root, clips);
  };
});

const step = (c: Character, seconds: number, dt = 1 / 30) => {
  for (let t = 0; t < seconds; t += dt) c.update(dt);
};

describe('state machine', () => {
  it('blends by speed, fires triggers and returns after one-shots', () => {
    const c = make();
    const sm = c.stateMachine({
      initial: 'move',
      parameters: { speed: 0 },
      states: {
        move: { blend: { param: 'speed', clips: [[0, 'Idle'], [1.4, 'Walk'], [4, 'Run']] } },
        jump: { clip: 'Jump', loop: false },
      },
      transitions: [
        { from: 'move', to: 'jump', when: [{ trigger: 'jump' }] },
        { from: 'jump', to: 'move', exitTime: 0.95 },
      ],
    });
    const entered: string[] = [];
    sm.onEnter((to) => entered.push(to));
    step(c, 0.5);
    expect(sm.state).toBe('move');
    const walk = c.actions.get('Walk')!, run = c.actions.get('Run')!;
    sm.set('speed', 2.7);
    step(c, 0.1);
    expect(walk.getEffectiveWeight()).toBeGreaterThan(0.4);
    expect(run.getEffectiveWeight()).toBeGreaterThan(0.4);
    // Blended cycles stay in phase.
    const phase = (a: typeof walk) => (a.time % a.getClip().duration) / a.getClip().duration;
    expect(Math.abs(phase(walk) - phase(run))).toBeLessThan(0.05);
    sm.trigger('jump');
    step(c, 0.1);
    expect(sm.state).toBe('jump');
    step(c, 2.5);
    expect(sm.state).toBe('move');
    expect(entered).toEqual(['jump', 'move']);
  });
});

describe('layers', () => {
  it('overrides only the masked bones', () => {
    const base = make();
    const layered = make();
    base.play('Walk', { fade: 0 });
    layered.play('Walk', { fade: 0 });
    layered.playLayer('attack', 'Punch', { mask: 'upperBody', fade: 0 });
    step(base, 0.6);
    step(layered, 0.6);
    const q = (c: Character, b: string) => c.bone(b)!.quaternion;
    expect(q(layered, 'leftUpperLeg').angleTo(q(base, 'leftUpperLeg'))).toBeLessThan(1e-3);
    expect(q(layered, 'rightUpperArm').angleTo(q(base, 'rightUpperArm'))).toBeGreaterThan(0.05);
    layered.stopLayer('attack', 0.2);
    step(layered, 0.4);
    step(base, 0.4);
    expect(q(layered, 'rightUpperArm').angleTo(q(base, 'rightUpperArm'))).toBeLessThan(1e-3);
  });
});

describe('root motion', () => {
  it('moves the object and keeps the hips over it', () => {
    const c = make();
    c.rootMotion = true;
    c.play('WalkRoot', { fade: 0 });
    const hipsRest = c.bone('hips')!.position.clone();
    step(c, 3);
    expect(c.object.position.z).toBeGreaterThan(1.5);
    expect(Math.abs(c.object.position.x)).toBeLessThan(0.5);
    expect(c.bone('hips')!.position.x).toBeCloseTo(hipsRest.x, 5);
    expect(c.bone('hips')!.position.z).toBeCloseTo(hipsRest.z, 5);
  });
});

describe('IK', () => {
  it('two-bone solver reaches reachable targets', () => {
    const a = new Bone(), b = new Bone(), e = new Bone();
    a.add(b); b.add(e);
    b.position.set(0, -0.45, 0);
    e.position.set(0, -0.42, 0);
    a.position.set(0, 1, 0);
    const target = new Vector3(0.1, 0.35, 0.2);
    expect(solveTwoBoneIK(a, b, e, target, new Vector3(0, 0.6, 1))).toBe(true);
    expect(e.getWorldPosition(new Vector3()).distanceTo(target)).toBeLessThan(1e-3);
    // The knee bends toward the pole (+Z).
    expect(b.getWorldPosition(new Vector3()).z).toBeGreaterThan(0.2);
  });

  it('foot IK plants a foot on a raised step', () => {
    const c = make();
    c.play('Idle', { fade: 0 });
    step(c, 0.2);
    const leftBefore = c.bone('leftFoot')!.getWorldPosition(new Vector3());
    const step20 = new Mesh(new PlaneGeometry(0.4, 0.6).rotateX(-Math.PI / 2), new MeshBasicMaterial());
    step20.position.set(leftBefore.x, 0.2, leftBefore.z);
    step20.updateMatrixWorld(true);
    c.enableFootIK({ ground: [step20] });
    step(c, 0.1);
    const left = c.bone('leftFoot')!.getWorldPosition(new Vector3());
    const right = c.bone('rightFoot')!.getWorldPosition(new Vector3());
    expect(left.y - leftBefore.y).toBeGreaterThan(0.15);
    expect(Math.abs(right.y - leftBefore.y)).toBeLessThan(0.08);
  });
});
