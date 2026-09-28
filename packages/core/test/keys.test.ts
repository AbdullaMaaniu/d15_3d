import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AnimationMixer, MeshBasicMaterial, Quaternion, Vector3 } from 'three';
import {
  applyKeyLayer, autoMapBones, bakeClip, bindPoseClip, bindSkeleton, buildSkinnedCharacter, computeSkinWeights,
  createMannequin, createWasmKernels, decodeClip, deleteKeys, detectHumanoid, emptyKeyLayer, humanoidDefs,
  keyTimes, rigHipsToNormalized, rigLocalToNormalized, sampleNormalized, sampleNormalizedHips, setBoneKey, setHipsKey,
  type PresetPack,
} from '../src/index';

const pack = JSON.parse(readFileSync(fileURLToPath(new URL('../../presets/clips.json', import.meta.url)), 'utf8')) as PresetPack;

async function rig() {
  const kernels = await createWasmKernels(readFileSync(fileURLToPath(new URL('../wasm/rigforge_kernels.wasm', import.meta.url))));
  const { geometry } = createMannequin({ pose: 'A', detail: 8 });
  const positions = geometry.attributes.position.array as Float32Array;
  const index = new Uint32Array(geometry.index!.array);
  const joints = detectHumanoid(positions, index, { kernels });
  const defs = humanoidDefs(true);
  const w = computeSkinWeights(positions, index, defs, joints, { kernels, resolution: 64 });
  const c = buildSkinnedCharacter(geometry, new MeshBasicMaterial(), defs, joints, w.skinIndex, w.skinWeight);
  return { c, binding: bindSkeleton(c.root, autoMapBones(c.root).map) };
}

function poseAt(c: Awaited<ReturnType<typeof rig>>['c'], clip: import('three').AnimationClip, t: number) {
  const mixer = new AnimationMixer(c.root);
  mixer.clipAction(clip).play();
  mixer.setTime(t);
  c.root.updateMatrixWorld(true);
  const out = { arm: c.bones.leftLowerArm.quaternion.clone(), hips: c.bones.hips.position.clone() };
  mixer.stopAllAction();
  c.skeleton.pose();
  return out;
}

describe('keyframes', () => {
  it('a bind-pose clip bakes back to the bind pose', async () => {
    const { c, binding } = await rig();
    // Leave the skeleton posed (as the editor's pose test does): the blank clip must still be the bind pose.
    c.bones.leftUpperLeg.rotation.x = 0.8;
    c.bones.rightUpperArm.rotation.z = 0.5;
    const clip = bakeClip(binding, bindPoseClip(binding, 1));
    const mixer = new AnimationMixer(c.root);
    mixer.clipAction(clip).play();
    mixer.setTime(0.5);
    const bad = c.skeleton.bones.filter((b) => b.quaternion.angleTo(new Quaternion()) > 1e-3).map((b) => b.name);
    expect(bad).toEqual([]);
  });

  it('keys reproduce a posed bone on top of a moving clip', async () => {
    const { c, binding } = await rig();
    const walk = decodeClip(pack.clips.find((x) => x.id === 'walk')!);
    const t = 0.5;
    // Pose: bend the elbow 60° relative to the walk at time t, and raise the hips 5 cm.
    const base = poseAt(c, bakeClip(binding, walk, { inPlace: false }), t);
    const posed = base.arm.clone().multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI / 3));
    const qn = rigLocalToNormalized(binding, 'leftLowerArm', posed);
    const offset = sampleNormalized(walk, 'leftLowerArm', t).invert().multiply(qn);
    let layer = setBoneKey(emptyKeyLayer(), 'leftLowerArm', t, offset);
    const raised = base.hips.clone().add(new Vector3(0, 0.05, 0));
    layer = setHipsKey(layer, t, rigHipsToNormalized(binding, raised).sub(sampleNormalizedHips(walk, t)));
    expect(keyTimes(layer)).toEqual([0.5]);

    const edited = poseAt(c, bakeClip(binding, applyKeyLayer(walk, layer), { inPlace: false }), t);
    expect(edited.arm.angleTo(posed)).toBeLessThan(2e-3);
    expect(edited.hips.distanceTo(raised)).toBeLessThan(2e-3);

    const cleared = deleteKeys(layer, t);
    expect(keyTimes(cleared)).toEqual([]);
  });
});
