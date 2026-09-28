import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MeshBasicMaterial, Quaternion, Vector3 } from 'three';
import { createQuadrupedMannequin } from '../src/mesh/mannequin';
import { QUADRUPED_DEFS, detectQuadruped, guessQuadrupedOrientation } from '../src/rig/quadruped';
import { computeSkinWeights } from '../src/rig/weights';
import { buildSkinnedCharacter } from '../src/rig/build';
import { createWasmKernels } from '../src/kernels';

const kernelsP = createWasmKernels(readFileSync(fileURLToPath(new URL('../wasm/rigforge_kernels.wasm', import.meta.url))));

describe('quadruped', () => {
  it('detects the joints of a procedural dog', async () => {
    const kernels = await kernelsP;
    const { geometry, truth } = createQuadrupedMannequin();
    const positions = geometry.attributes.position.array as Float32Array;
    const result = detectQuadruped(positions, new Uint32Array(geometry.index!.array), { kernels });
    const err = (n: string) => new Vector3(...truth.joints[n]).distanceTo(new Vector3(...result.joints[n]));
    const errors = Object.fromEntries(Object.keys(truth.joints).map((n) => [n, +err(n).toFixed(3)]));
    if (process.env.RF_DEBUG) console.log(result.notes, errors);
    expect(result.notes).toEqual([]);
    expect(result.measurements.hasTail).toBe(true);
    for (const n of ['leftFrontUpperLeg', 'rightFrontFoot', 'leftBackLowerLeg', 'rightBackFoot', 'hips', 'chest', 'spine']) expect(err(n), n).toBeLessThan(0.08);
    // Head is ahead of the neck, which is ahead of the chest; tail runs backward.
    expect(result.joints.head[2]).toBeGreaterThan(result.joints.neck[2]);
    expect(result.joints.neck[2]).toBeGreaterThan(result.joints.chest[2]);
    expect(result.joints.tail3[2]).toBeLessThan(result.joints.tail0[2]);
    expect(result.tails.head[2]).toBeGreaterThan(0.7);
  });

  it('orients a dog that faces -X', () => {
    const { geometry } = createQuadrupedMannequin();
    const turned = geometry.clone().applyQuaternion(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), -Math.PI / 2));
    const { rotation } = guessQuadrupedOrientation(turned);
    const nose = new Vector3(0, 0.8, 0.81).applyAxisAngle(new Vector3(0, 1, 0), -Math.PI / 2).applyQuaternion(rotation);
    expect(nose.z).toBeGreaterThan(0.7);
  });

  it('skins legs to leg bones', async () => {
    const kernels = await kernelsP;
    const { geometry, truth } = createQuadrupedMannequin();
    const positions = geometry.attributes.position.array as Float32Array;
    const index = new Uint32Array(geometry.index!.array);
    const w = computeSkinWeights(positions, index, QUADRUPED_DEFS, truth, { kernels, resolution: 128 });
    const names = QUADRUPED_DEFS.map((d) => d.name);
    const dominantAt = (p: [number, number, number]) => {
      let best = 0, bd = Infinity;
      for (let i = 0; i < positions.length / 3; i++) {
        const d = Math.hypot(positions[i * 3] - p[0], positions[i * 3 + 1] - p[1], positions[i * 3 + 2] - p[2]);
        if (d < bd) { bd = d; best = i; }
      }
      let k = 0;
      for (let j = 1; j < 4; j++) if (w.skinWeight[best * 4 + j] > w.skinWeight[best * 4 + k]) k = j;
      return names[w.skinIndex[best * 4 + k]];
    };
    expect(dominantAt([0.1, 0.2, 0.31])).toBe('leftFrontLowerLeg');
    expect(dominantAt([-0.1, 0.4, -0.26])).toBe('rightBackUpperLeg');
    expect(dominantAt([0, 0.76, -0.76])).toMatch(/^tail[23]$/);
    expect(dominantAt([0, 0.82, 0.75])).toBe('head');
    const c = buildSkinnedCharacter(geometry, new MeshBasicMaterial(), QUADRUPED_DEFS, truth, w.skinIndex, w.skinWeight, 'Dog');
    expect(c.skeleton.bones.length).toBe(QUADRUPED_DEFS.length);
  });
});

describe('quadruped gaits', () => {
  it('walks: feet alternate and stay near the ground', async () => {
    const { AnimationMixer } = await import('three');
    const { bakePropClip } = await import('../src/rig/prop');
    const { quadrupedGaits } = await import('../src/anim/gaits');
    const { geometry, truth } = createQuadrupedMannequin();
    const n = geometry.attributes.position.count;
    const c = buildSkinnedCharacter(geometry, new MeshBasicMaterial(), QUADRUPED_DEFS, truth, new Uint16Array(n * 4), new Float32Array(n * 4).map((_, i) => (i % 4 ? 0 : 1)), 'Dog');
    const gaits = quadrupedGaits(truth);
    expect(gaits.map((g) => g.id)).toEqual(['idle', 'walk', 'trot', 'gallop', 'sit', 'tailWag']);
    const walk = gaits.find((g) => g.id === 'walk')!;
    expect(walk.speed).toBeGreaterThan(0.3);
    expect(walk.speed).toBeLessThan(2);
    const mixer = new AnimationMixer(c.root);
    mixer.clipAction(bakePropClip(c, walk.keys, 'Walk')).play();
    const toeZ: number[][] = [];
    const lowest: number[] = [];
    for (let i = 0; i < 12; i++) {
      mixer.setTime((i / 12) * walk.keys.duration);
      c.root.updateMatrixWorld(true);
      const p = (b: string) => c.bones[b].getWorldPosition(new Vector3());
      toeZ.push(['leftFrontToes', 'rightFrontToes'].map((b) => p(b).z));
      lowest.push(Math.min(...['leftFrontToes', 'rightFrontToes', 'leftBackToes', 'rightBackToes'].map((b) => p(b).y)));
    }
    // Left and right forefeet are out of phase: when one is ahead the other is behind.
    const diffs = toeZ.map(([l, r]) => l - r);
    expect(Math.max(...diffs)).toBeGreaterThan(0.05);
    expect(Math.min(...diffs)).toBeLessThan(-0.05);
    // Some foot is always close to the ground.
    for (const y of lowest) expect(y).toBeLessThan(0.08);
  });
});
