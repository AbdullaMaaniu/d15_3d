import { describe, expect, it } from 'vitest';
import { Bone, Group, Mesh, SphereGeometry, Vector3 } from 'three';
import { Character, SpringBones } from '../src/index';

/** A head with a 4-link ponytail hanging backward. */
function rig() {
  const root = new Group();
  const head = new Bone(); head.name = 'head'; head.position.set(0, 1.6, 0);
  root.add(head);
  let parent: Bone = head;
  const hair: string[] = [];
  for (let i = 0; i < 4; i++) {
    const b = new Bone();
    b.name = `hair${i}`;
    b.position.set(0, i === 0 ? 0.05 : -0.08, i === 0 ? -0.1 : -0.01);
    parent.add(b);
    parent = b;
    hair.push(b.name);
  }
  root.updateMatrixWorld(true);
  return { root, head, hair };
}

const tip = (root: Group) => root.getObjectByName('hair3')!.getWorldPosition(new Vector3());

describe('spring bones', () => {
  it('lag behind when the body moves, then settle back', () => {
    const { root, hair } = rig();
    const springs = new SpringBones(root, { chains: [{ bones: hair, stiffness: 1.5, damping: 0.3, gravity: 0 }] });
    const rest = tip(root);
    // Jerk the character forward.
    root.position.z += 0.3;
    springs.update(1 / 60);
    const moved = tip(root);
    // The hair trails behind the head (less than the full 0.3 m forward).
    expect(moved.z - rest.z).toBeLessThan(0.28);
    for (let i = 0; i < 400; i++) springs.update(1 / 60);
    const settled = tip(root);
    expect(settled.distanceTo(rest.clone().add(new Vector3(0, 0, 0.3)))).toBeLessThan(0.02);
  });

  it('keeps segment lengths and respects colliders', () => {
    const { root, hair } = rig();
    const springs = new SpringBones(root, {
      chains: [{ bones: hair, gravity: 3, stiffness: 0.1 }],
      colliders: [{ bone: 'head', offset: [0, -0.1, -0.12], radius: 0.08 }],
    });
    for (let i = 0; i < 200; i++) springs.update(1 / 60);
    const h1 = root.getObjectByName('hair1')!.getWorldPosition(new Vector3());
    const h2 = root.getObjectByName('hair2')!.getWorldPosition(new Vector3());
    expect(h1.distanceTo(h2)).toBeCloseTo(Math.hypot(0.08, 0.01), 3);
    const center = root.getObjectByName('head')!.localToWorld(new Vector3(0, -0.1, -0.12));
    for (const n of ['hair1', 'hair2', 'hair3']) {
      expect(root.getObjectByName(n)!.getWorldPosition(new Vector3()).distanceTo(center)).toBeGreaterThan(0.08 - 1e-3);
    }
  });

  it('are picked up from exported extras', () => {
    const { root, hair } = rig();
    root.userData.rigforge = { springs: { chains: [{ bones: hair }] } };
    root.add(new Mesh(new SphereGeometry(0.1)));
    const c = new Character(root, []);
    expect(c.springs?.jointCount).toBe(4);
    c.update(1 / 60);
    const clone = c.clone();
    expect(clone.springs?.jointCount).toBe(4);
  });
});
