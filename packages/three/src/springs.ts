import { Object3D, Quaternion, Vector3 } from 'three';

/** A chain of bones (root → tip) that swings with inertia: hair, tails, ears, capes. */
export interface SpringChainDef {
  name?: string;
  bones: string[];
  /** Pull back toward the animated pose (default 1). */
  stiffness?: number;
  /** 0..1, how quickly motion dies out (default 0.4). */
  damping?: number;
  /** Gravity strength (default 0.3), direction defaults to -Y. */
  gravity?: number;
  gravityDir?: [number, number, number];
  /** Collision radius of each joint (default 0.02 m). */
  radius?: number;
}

export interface SpringColliderDef {
  bone: string;
  offset?: [number, number, number];
  radius: number;
}

export interface SpringConfig {
  chains: SpringChainDef[];
  colliders?: SpringColliderDef[];
}

interface Joint {
  bone: Object3D;
  /** Unit direction to the child in the bone's local frame, and its length. */
  axis: Vector3;
  length: number;
  tail: Vector3;
  prevTail: Vector3;
  /** The animated local rotation seen last frame, and what the spring wrote over it. */
  base: Quaternion;
  applied: Quaternion | null;
  def: Required<Omit<SpringChainDef, 'name' | 'bones' | 'gravityDir'>> & { gravityDir: Vector3 };
}

const _head = new Vector3();
const _v = new Vector3();
const _q = new Quaternion();
const _qw = new Quaternion();
const _pw = new Quaternion();

/**
 * Verlet spring bones in the style of VRM: each joint's tail keeps its momentum,
 * is pulled back toward where the animation wants it, falls with gravity, keeps
 * its length and is pushed out of colliders. Runs after the animation mixer, so
 * it adds secondary motion on top of any clip.
 */
export class SpringBones {
  private joints: Joint[] = [];
  private colliders: Array<{ bone: Object3D; offset: Vector3; radius: number }> = [];
  enabled = true;

  constructor(
    private root: Object3D,
    config: SpringConfig,
    find: (name: string) => Object3D | undefined = (n) => root.getObjectByName(n),
  ) {
    root.updateMatrixWorld(true);
    for (const c of config.colliders ?? []) {
      const bone = find(c.bone);
      if (bone) this.colliders.push({ bone, offset: new Vector3(...(c.offset ?? [0, 0, 0])), radius: c.radius });
    }
    for (const chain of config.chains) {
      const def = {
        stiffness: chain.stiffness ?? 1,
        damping: chain.damping ?? 0.4,
        gravity: chain.gravity ?? 0.3,
        radius: chain.radius ?? 0.02,
        gravityDir: new Vector3(...(chain.gravityDir ?? [0, -1, 0])).normalize(),
      };
      const bones = chain.bones.map(find).filter((b): b is Object3D => !!b);
      bones.forEach((bone, i) => {
        // Direction to the next bone in the chain, or continue the last segment for the tip.
        const next = bones[i + 1];
        let local: Vector3;
        if (next && next.parent === bone) local = next.position.clone();
        else {
          const child = bone.children.find((c) => (c as any).isBone);
          local = child ? child.position.clone() : bone.position.clone().multiplyScalar(0.7);
        }
        if (local.lengthSq() < 1e-10) local.set(0, -0.05, 0);
        const tail = bone.localToWorld(local.clone());
        this.joints.push({ bone, axis: local.clone().normalize(), length: local.length(), tail, prevTail: tail.clone(), def, base: bone.quaternion.clone(), applied: null });
      });
    }
  }

  get jointCount(): number {
    return this.joints.length;
  }

  /** Snaps all tails to the current pose (call after teleporting the character). */
  reset(): void {
    for (const j of this.joints) {
      if (j.applied && j.bone.quaternion.equals(j.applied)) j.bone.quaternion.copy(j.base);
      j.applied = null;
    }
    this.root.updateMatrixWorld(true);
    for (const j of this.joints) {
      const t = j.bone.localToWorld(j.axis.clone().multiplyScalar(j.length));
      j.tail.copy(t);
      j.prevTail.copy(t);
    }
  }

  update(delta: number): void {
    if (!this.enabled || !this.joints.length) return;
    const dt = Math.min(delta, 1 / 20);
    this.root.updateMatrixWorld(true);
    for (const j of this.joints) {
      const bone = j.bone;
      const parent = bone.parent!;
      // The animated pose is the rest the spring pulls back to. Bones no clip animates
      // still hold last frame's spring rotation, so reuse the remembered base for them.
      if (!j.applied || !bone.quaternion.equals(j.applied)) j.base.copy(bone.quaternion);
      const baseLocal = j.base.clone();
      parent.getWorldQuaternion(_pw);
      _qw.copy(_pw).multiply(baseLocal);
      bone.getWorldPosition(_head);

      const inertia = _v.copy(j.tail).sub(j.prevTail).multiplyScalar(1 - j.def.damping);
      const target = j.axis.clone().applyQuaternion(_qw).multiplyScalar(j.length).add(_head);
      const next = j.tail.clone()
        .add(inertia)
        .add(target.sub(j.tail).multiplyScalar(Math.min(1, j.def.stiffness * dt * 10)))
        .addScaledVector(j.def.gravityDir, j.def.gravity * dt);
      // Keep the bone's length.
      next.sub(_head).setLength(j.length).add(_head);
      // Push out of colliders.
      for (const c of this.colliders) {
        const center = c.bone.localToWorld(c.offset.clone());
        const r = c.radius + j.def.radius;
        const d = next.distanceTo(center);
        if (d < r) {
          next.sub(center).setLength(r).add(center);
          next.sub(_head).setLength(j.length).add(_head);
        }
      }
      j.prevTail.copy(j.tail);
      j.tail.copy(next);

      // Rotate the bone so its axis points at the new tail.
      const dirLocal = next.clone().sub(_head).normalize().applyQuaternion(_qw.clone().invert());
      _q.setFromUnitVectors(j.axis, dirLocal);
      bone.quaternion.copy(baseLocal).multiply(_q);
      j.applied = bone.quaternion.clone();
      bone.updateMatrixWorld(true);
    }
  }
}
