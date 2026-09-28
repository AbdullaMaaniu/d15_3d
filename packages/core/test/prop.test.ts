import { describe, expect, it } from 'vitest';
import { AnimationMixer, BoxGeometry, MeshBasicMaterial, Vector3 } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { bakePropClip, buildPropCharacter, deletePropKeys, propKeyTimes, propMotionKeys, setPropKey, splitParts } from '../src/rig/prop';

/** A chest: a body box and a lid box sitting on top (separate parts). */
function chest() {
  const body = new BoxGeometry(1, 0.5, 0.6).translate(0, 0.25, 0);
  const lid = new BoxGeometry(1, 0.1, 0.6).translate(0, 0.56, 0);
  return mergeGeometries([body.toNonIndexed(), lid.toNonIndexed()])!;
}

describe('prop rigs', () => {
  it('splits parts and hinges the lid', () => {
    const g = chest();
    const split = splitParts(g);
    expect(split.parts.length).toBe(2);
    const lidPart = split.parts.find((p) => p.center[1] > 0.5)!.id;
    const c = buildPropCharacter(g, new MeshBasicMaterial(), split, {
      bones: [
        { name: 'root', parent: null, pivot: [0, 0, 0] },
        { name: 'lid', parent: 'root', pivot: [0, 0.51, -0.3] },
      ],
      partBone: { [lidPart]: 'lid' },
    });
    expect(c.skeleton.bones.map((b) => b.name)).toEqual(['root', 'lid']);

    const open = bakePropClip(c, propMotionKeys({ type: 'swing', bone: 'lid', axis: [1, 0, 0], degrees: -100, duration: 2, pingPong: false }), 'Open');
    const mixer = new AnimationMixer(c.root);
    mixer.clipAction(open).play();
    mixer.setTime(1.999);
    c.root.updateMatrixWorld(true);
    // The front edge of the lid (z = +0.3) swings up around the back hinge.
    const front = new Vector3(0, 0.56, 0.3).applyMatrix4(c.bones.lid.matrixWorld.clone().multiply(c.mesh.skeleton.boneInverses[1]));
    expect(front.y).toBeGreaterThan(1.0);
    // The body doesn't move.
    const corner = new Vector3(0.5, 0, 0.3).applyMatrix4(c.bones.root.matrixWorld.clone().multiply(c.mesh.skeleton.boneInverses[0]));
    expect(corner.distanceTo(new Vector3(0.5, 0, 0.3))).toBeLessThan(1e-5);
  });

  it('keys bone transforms relative to rest', () => {
    const g = chest();
    const split = splitParts(g);
    const c = buildPropCharacter(g, new MeshBasicMaterial(), split, { bones: [{ name: 'root', parent: null, pivot: [0, 0, 0] }], partBone: {} });
    const bone = c.bones.root;
    bone.position.y += 0.5;
    let keys = setPropKey({ duration: 1, bones: {} }, bone, 1);
    bone.position.y -= 0.5;
    keys = setPropKey(keys, bone, 0);
    expect(propKeyTimes(keys)).toEqual([0, 1]);
    const clip = bakePropClip(c, keys, 'Jump');
    const mixer = new AnimationMixer(c.root);
    mixer.clipAction(clip).play();
    mixer.setTime(0.5);
    expect(bone.position.y).toBeCloseTo(0.25, 3);
    expect(propKeyTimes(deletePropKeys(keys, 1))).toEqual([0]);
  });
});
