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
  it('keeps a follower skeleton (the exported body) in the character\'s pose', () => {
    const root = new Group();
    const hips = new Bone(); hips.name = 'hips'; hips.position.y = 1;
    const hand = new Bone(); hand.name = 'leftHand'; hand.position.x = 0.6;
    root.add(hips); hips.add(hand);
    const body = new Group(); body.userData.rigforge = { follower: { stride: 0.9 } };
    const bHips = new Bone(); bHips.name = 'Body_hips'; bHips.position.y = 0.9; bHips.userData.rigforge = { follows: 'hips' };
    const bHand = new Bone(); bHand.name = 'Body_leftHand'; bHand.position.x = 0.5; bHand.userData.rigforge = { follows: 'leftHand' };
    body.add(bHips); bHips.add(bHand); root.add(body);
    const q = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 0.5);
    const clip = new AnimationClip('Turn', 1, [new QuaternionKeyframeTrack('leftHand.quaternion', [0, 1], [...q.toArray(), ...q.toArray()])]);
    const c = new Character(root, [clip]);
    expect(c.bone('hips')).toBe(hips);
    c.play('Turn');
    hips.position.set(0.2, 1.1, 0);
    c.update(0.1);
    expect(bHand.quaternion.angleTo(q)).toBeLessThan(1e-6);
    // Moves from rest are scaled to the body's size.
    expect(bHips.position.x).toBeCloseTo(0.18);
    expect(bHips.position.y).toBeCloseTo(0.99);
    expect(bHand.position.x).toBeCloseTo(0.5);
  });

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

describe('auto state machine', () => {
  it('guesses roles from clip names and drives them', async () => {
    const { guessController } = await import('../src/stateMachine');
    const setup = guessController(['Idle', 'Walk', 'Run', 'Jump', 'Punch', 'Wave']);
    expect(setup.locomotion).toEqual([[0, 'Idle'], [1.4, 'Walk'], [4, 'Run']]);
    expect(setup.jump).toBe('Jump');
    expect(setup.actions).toEqual({ punch: 'Punch', wave: 'Wave' });
  });

  it('uses the exported setup and fires action triggers', () => {
    const c = makeRig();
    c.object.userData.rigforge = { controller: { locomotion: [[0, 'Idle']], actions: { hello: 'Wave' } } };
    const sm = c.autoStateMachine();
    expect(sm.state).toBe('move');
    sm.trigger('hello');
    c.update(0.05);
    expect(sm.state).toBe('action:hello');
    for (let i = 0; i < 40; i++) c.update(0.05);
    expect(sm.state).toBe('move');
  });
});
