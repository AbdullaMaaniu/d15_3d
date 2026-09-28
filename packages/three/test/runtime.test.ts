import { describe, expect, it } from 'vitest';
import { AnimationClip, Bone, Group, Quaternion, QuaternionKeyframeTrack, Vector3 } from 'three';
import { Character } from '../src/index';

function makeRig() {
  const root = new Group();
  const hips = new Bone(); hips.name = 'mixamorig:Hips'; hips.position.y = 1;
  const neck = new Bone(); neck.name = 'neck'; neck.position.y = 0.5;
  const head = new Bone(); head.name = 'head'; head.position.y = 0.1;
  const hand = new Bone(); hand.name = 'leftHand'; hand.position.x = 0.6;
  root.add(hips); hips.add(neck); neck.add(head); hips.add(hand);
  const q = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 0.5).toArray();
  const wave = new AnimationClip('Wave', 1, [new QuaternionKeyframeTrack('leftHand.quaternion', [0, 1], [0, 0, 0, 1, ...q])]);
  const idle = new AnimationClip('Idle', 1, [new QuaternionKeyframeTrack('leftHand.quaternion', [0, 1], [0, 0, 0, 1, 0, 0, 0, 1])]);
  return new Character(root, [idle, wave]);
}

describe('Character', () => {
  it('finds bones by canonical name and aliases', () => {
    const c = makeRig();
    expect(c.bone('hips')?.name).toBe('mixamorig:Hips');
    expect(c.bone('leftHand')?.name).toBe('leftHand');
    expect(c.bone('rightHand')).toBeUndefined();
  });

  it('plays, crossfades and reports one-shot completion', () => {
    const c = makeRig();
    c.play('Idle');
    expect(c.current?.getClip().name).toBe('Idle');
    let finished = '';
    c.on('finished', (e) => (finished = e.name));
    c.play('Wave', { fade: 0.1, loop: false });
    for (let i = 0; i < 30; i++) c.update(1 / 20);
    expect(finished).toBe('Wave');
    expect(c.play('Nope')).toBeNull();
  });

  it('turns the head toward a look-at target', () => {
    const c = makeRig();
    c.lookAt(new Vector3(5, 1.6, 0.5), { maxAngle: 1.5 });
    c.update(0.016);
    const head = c.bone('head')!;
    const fwd = new Vector3(0, 0, 1).applyQuaternion(head.getWorldQuaternion(new Quaternion()));
    expect(fwd.x).toBeGreaterThan(0.7);
  });
});
