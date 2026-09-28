import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AnimationMixer, CapsuleGeometry, MeshBasicMaterial, Vector3 } from 'three';
import { autoTails, boneChain, creatureDefs, mirrorSubtree } from '../src/rig/creature';
import { computeSkinWeights } from '../src/rig/weights';
import { buildSkinnedCharacter } from '../src/rig/build';
import { bakePropClip, propMotionKeys } from '../src/rig/prop';
import { createWasmKernels } from '../src/kernels';

describe('creature rigs', () => {
  it('builds, skins and waves a tentacle', async () => {
    const kernels = await createWasmKernels(readFileSync(fileURLToPath(new URL('../wasm/rigforge_kernels.wasm', import.meta.url))));
    // A 1 m tentacle lying along +Z.
    const geo = new CapsuleGeometry(0.06, 1, 6, 16, 12).rotateX(Math.PI / 2).translate(0, 0.1, 0.5);
    const bones = [
      { name: 'base', parent: null },
      { name: 'seg1', parent: 'base' },
      { name: 'seg2', parent: 'seg1' },
      { name: 'tip', parent: 'seg2' },
    ];
    const joints: Record<string, [number, number, number]> = { base: [0, 0.1, 0], seg1: [0, 0.1, 0.3], seg2: [0, 0.1, 0.6], tip: [0, 0.1, 0.85] };
    const defs = creatureDefs(bones);
    expect(defs.map((d) => d.primaryChild)).toEqual(['seg1', 'seg2', 'tip', null]);
    const tails = autoTails(defs, joints);
    expect(tails.tip[2]).toBeCloseTo(0.975, 3);
    const positions = geo.attributes.position.array as Float32Array;
    const w = computeSkinWeights(positions, new Uint32Array(geo.index!.array), defs, { joints, tails }, { kernels, resolution: 96 });
    const c = buildSkinnedCharacter(geo, new MeshBasicMaterial(), defs, { joints, tails }, w.skinIndex, w.skinWeight, 'Tentacle');

    const chain = boneChain(defs, 'base');
    expect(chain).toEqual(['base', 'seg1', 'seg2', 'tip']);
    const clip = bakePropClip(c, propMotionKeys({ type: 'wave', bone: 'base', chain, axis: [0, 1, 0], degrees: 30, duration: 1 }), 'Wave');
    const mixer = new AnimationMixer(c.root);
    mixer.clipAction(clip).play();
    const xs: number[] = [];
    for (let i = 0; i < 8; i++) {
      mixer.setTime(i / 8);
      c.root.updateMatrixWorld(true);
      xs.push(c.bones.tip.getWorldPosition(new Vector3()).x);
    }
    // The tip swings side to side.
    expect(Math.max(...xs)).toBeGreaterThan(0.1);
    expect(Math.min(...xs)).toBeLessThan(-0.1);
  });

  it('mirrors a leg chain to the other side', () => {
    const bones = [
      { name: 'body', parent: null },
      { name: 'leftLeg1', parent: 'body' },
      { name: 'leftLeg2', parent: 'leftLeg1' },
    ];
    const joints: Record<string, [number, number, number]> = { body: [0, 0.5, 0], leftLeg1: [0.2, 0.4, 0], leftLeg2: [0.4, 0.1, 0] };
    const m = mirrorSubtree(bones, joints, 'leftLeg1');
    expect(m.bones).toEqual([{ name: 'rightLeg1', parent: 'body' }, { name: 'rightLeg2', parent: 'rightLeg1' }]);
    expect(m.joints.rightLeg2).toEqual([-0.4, 0.1, 0]);
  });
});
