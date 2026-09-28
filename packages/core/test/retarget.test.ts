import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AnimationMixer, MeshStandardMaterial, Quaternion, Vector3 } from 'three';
import { createMannequin } from '../src/mesh/mannequin';
import { detectHumanoid } from '../src/rig/landmarks';
import { computeSkinWeights } from '../src/rig/weights';
import { buildSkinnedCharacter } from '../src/rig/build';
import { humanoidDefs } from '../src/skeleton';
import { autoMapBones } from '../src/anim/bonemap';
import { bakeClip, bindSkeleton, extractNormalizedClip } from '../src/anim/retarget';
import { decodeClip, type PresetPack } from '../src/anim/codec';
import { createWasmKernels } from '../src/kernels';

const pack = JSON.parse(readFileSync(fileURLToPath(new URL('../../presets/clips.json', import.meta.url)), 'utf8')) as PresetPack;

async function rig(pose: 'T' | 'A') {
  const kernels = await createWasmKernels(readFileSync(fileURLToPath(new URL('../wasm/rigforge_kernels.wasm', import.meta.url))));
  const { geometry } = createMannequin({ pose });
  const positions = geometry.attributes.position.array as Float32Array;
  const index = new Uint32Array(geometry.index!.array);
  const detected = detectHumanoid(positions, index, { kernels });
  const defs = humanoidDefs(true);
  const w = computeSkinWeights(positions, index, defs, detected, { kernels, resolution: 96 });
  return buildSkinnedCharacter(geometry, new MeshStandardMaterial(), defs, detected, w.skinIndex, w.skinWeight);
}

describe('retargeting', () => {
  it('maps the canonical skeleton onto itself', async () => {
    const c = await rig('A');
    const { map, missing, family } = autoMapBones(c.root);
    expect(family).toBe('rigforge');
    expect(missing).toEqual([]);
    expect(map.leftIndexProximal).toBe('leftIndexProximal');
  });

  it('round-trips a preset through an A-pose rig', async () => {
    const c = await rig('A');
    const binding = bindSkeleton(c.root, autoMapBones(c.root).map);
    // A-pose arms get straightened into the T-pose frame.
    const upperArmT = binding.tpose.get('leftUpperArm')!;
    expect(upperArmT.angleTo(new Quaternion())).toBeGreaterThan(0.5);

    const walk = decodeClip(pack.clips.find((x) => x.id === 'walk')!);
    const baked = bakeClip(binding, walk, { inPlace: false });
    const back = extractNormalizedClip(binding, baked, { fps: walk.fps });
    const B = walk.bones.length;
    let maxErr = 0;
    let hipsErr = 0;
    for (let f = 0; f < Math.min(walk.frames, back.frames) - 1; f++) {
      for (const bone of ['hips', 'leftUpperArm', 'rightLowerLeg', 'spine', 'head']) {
        const i = walk.bones.indexOf(bone), j = back.bones.indexOf(bone);
        const a = new Quaternion().fromArray(walk.rotations, (f * B + i) * 4);
        const b = new Quaternion().fromArray(back.rotations, (f * back.bones.length + j) * 4);
        maxErr = Math.max(maxErr, a.angleTo(b));
      }
      hipsErr = Math.max(hipsErr, Math.abs(back.hips[f * 3 + 1] - walk.hips[f * 3 + 1]));
    }
    expect(maxErr).toBeLessThan(0.02);
    // Ground is re-estimated from the feet, so allow a small vertical offset.
    expect(hipsErr).toBeLessThan(0.08);
  });

  it('relaxes fingers the clip does not animate, curling toward the palm', async () => {
    const c = await rig('T');
    const binding = bindSkeleton(c.root, autoMapBones(c.root).map);
    expect(binding.relaxedFingers.size).toBe(24);
    // A one-frame T-pose clip without fingers, and the same with straight fingers.
    const bones = ['hips'];
    const tpose = { name: 'T', fps: 30, frames: 1, bones, rotations: new Float32Array([0, 0, 0, 1]), hips: new Float32Array([0, 1, 0]), loop: false };
    const fingerBones = [...binding.relaxedFingers.keys()];
    const straight = { ...tpose, bones: [...bones, ...fingerBones], rotations: new Float32Array((1 + fingerBones.length) * 4).map((_, i) => (i % 4 === 3 ? 1 : 0)) };
    const tipAfter = (clip: typeof tpose) => {
      const mixer = new AnimationMixer(c.root);
      mixer.clipAction(bakeClip(binding, clip, { inPlace: true })).play();
      mixer.update(0);
      c.root.updateMatrixWorld(true);
      const out: Record<string, Vector3> = {};
      for (const side of ['left', 'right']) out[side] = c.bones[`${side}MiddleDistal`].getWorldPosition(new Vector3());
      mixer.stopAllAction();
      return out;
    };
    const relaxed = tipAfter(tpose);
    const flat = tipAfter(straight);
    for (const side of ['left', 'right']) {
      // Palms face down in the mannequin's T-pose: curled tips drop and pull in toward the wrist.
      expect(relaxed[side].y).toBeLessThan(flat[side].y - 0.005);
      expect(Math.abs(relaxed[side].x)).toBeLessThan(Math.abs(flat[side].x));
    }
    // Mirror images of each other (within the detected joints' own asymmetry).
    expect(Math.abs(relaxed.left.x + relaxed.right.x)).toBeLessThan(0.02);
    expect(Math.abs(relaxed.left.y - relaxed.right.y)).toBeLessThan(0.02);
  });

  it('animates the skinned character', async () => {
    const c = await rig('T');
    const binding = bindSkeleton(c.root, autoMapBones(c.root).map);
    const clip = bakeClip(binding, decodeClip(pack.clips.find((x) => x.id === 'wave')!));
    const mixer = new AnimationMixer(c.root);
    mixer.clipAction(clip).play();
    const hand = new Vector3();
    const positions: number[] = [];
    for (let t = 0; t < clip.duration; t += 0.25) {
      mixer.setTime(t);
      c.root.updateMatrixWorld(true);
      c.bones.rightHand.getWorldPosition(hand);
      positions.push(hand.y);
      // Feet stay on the ground.
      const foot = c.bones.leftFoot.getWorldPosition(new Vector3());
      expect(foot.y).toBeGreaterThan(-0.05);
      expect(foot.y).toBeLessThan(0.25);
    }
    // Some hand goes above the shoulders during a wave.
    const lh: number[] = [];
    for (let t = 0; t < clip.duration; t += 0.25) {
      mixer.setTime(t);
      c.root.updateMatrixWorld(true);
      lh.push(Math.max(c.bones.leftHand.getWorldPosition(new Vector3()).y, c.bones.rightHand.getWorldPosition(new Vector3()).y));
    }
    expect(Math.max(...lh)).toBeGreaterThan(1.45);
  });
});
