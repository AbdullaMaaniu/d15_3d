import { Object3D, Quaternion, Raycaster, Vector3 } from 'three';

const _a = new Vector3();
const _b = new Vector3();
const _c = new Vector3();
const _t = new Vector3();
const _v1 = new Vector3();
const _v2 = new Vector3();
const _q = new Quaternion();
const _pq = new Quaternion();

/** Applies a world-space rotation delta to a bone (keeps its children attached). */
export function rotateBoneWorld(bone: Object3D, delta: Quaternion): void {
  const parentWorld = bone.parent ? bone.parent.getWorldQuaternion(_pq) : _pq.identity();
  const world = parentWorld.clone().multiply(bone.quaternion);
  world.premultiply(delta);
  bone.quaternion.copy(parentWorld.invert().multiply(world));
  bone.updateMatrixWorld(true);
}

/**
 * Analytic two-bone IK (thigh -> shin -> foot, or upper arm -> forearm -> hand).
 * Bends the chain so `end` reaches `target`, keeping the current bend plane
 * (the middle joint's side) unless a `pole` point is given.
 * Returns false when the target is unreachable (the chain is then stretched toward it).
 */
export function solveTwoBoneIK(root: Object3D, mid: Object3D, end: Object3D, target: Vector3, pole?: Vector3): boolean {
  root.updateWorldMatrix(true, true);
  const a = root.getWorldPosition(_a);
  const b = mid.getWorldPosition(_b);
  const c = end.getWorldPosition(_c);
  const lab = a.distanceTo(b);
  const lcb = b.distanceTo(c);
  const lat = Math.min(Math.max(a.distanceTo(target), 1e-6), lab + lcb - 1e-5);
  const reachable = a.distanceTo(target) <= lab + lcb;

  // 1. Set the middle joint angle with the law of cosines.
  const cosB = clamp((lab * lab + lcb * lcb - lat * lat) / (2 * lab * lcb), -1, 1);
  const desiredB = Math.acos(cosB); // interior angle at the middle joint
  const ba = _v1.copy(a).sub(b).normalize();
  const bc = _v2.copy(c).sub(b).normalize();
  const currentB = Math.acos(clamp(ba.dot(bc), -1, 1));
  let bendAxis = new Vector3().crossVectors(bc, ba);
  if (bendAxis.lengthSq() < 1e-8) {
    // Straight chain: bend so the middle joint ends up toward the pole
    // (the end segment swings away from it, then the chain is re-aimed).
    const away = pole ? new Vector3().subVectors(b, pole) : new Vector3(0, 0, -1);
    away.addScaledVector(bc, -away.dot(bc));
    if (away.lengthSq() < 1e-10) away.set(1, 0, 0).addScaledVector(bc, -bc.x);
    bendAxis = new Vector3().crossVectors(bc, away.normalize());
  }
  bendAxis.normalize();
  _q.setFromAxisAngle(bendAxis, currentB - desiredB);
  rotateBoneWorld(mid, _q);

  // 2. Swing the whole chain so the end lands on the target.
  const c2 = end.getWorldPosition(new Vector3());
  const toEnd = c2.sub(a).normalize();
  const toTarget = _t.copy(target).sub(a).normalize();
  _q.setFromUnitVectors(toEnd, toTarget);
  rotateBoneWorld(root, _q);
  return reachable;
}

function clamp(x: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, x));
}

/** Ground query: returns the ground height (and optionally normal) below a point, or null. */
export type GroundQuery = (x: number, z: number, fromY: number) => number | null;

/** Builds a GroundQuery that raycasts straight down against the given objects. */
export function raycastGround(objects: Object3D[], maxDistance = 5): GroundQuery {
  const ray = new Raycaster();
  const origin = new Vector3();
  const down = new Vector3(0, -1, 0);
  return (x, z, fromY) => {
    origin.set(x, fromY, z);
    ray.set(origin, down);
    ray.far = maxDistance;
    const hit = ray.intersectObjects(objects, true)[0];
    return hit ? hit.point.y : null;
  };
}

export interface FootIKOptions {
  /** Where the ground is. A flat plane at the character's y when omitted. */
  ground?: GroundQuery | Object3D[];
  /** How far above a foot to start probing for ground, in meters (default 0.5). */
  probeHeight?: number;
  /** Max downward hips adjustment in meters (default 0.35). */
  maxHipsDrop?: number;
  /** 0..1 blend (default 1). */
  weight?: number;
}

export interface Leg {
  upper: Object3D;
  lower: Object3D;
  foot: Object3D;
}

/**
 * Keeps feet planted on uneven ground: each foot keeps its animated height above
 * the character's floor, measured from the actual ground under it; the hips drop
 * so the lower foot can still reach.
 */
export class FootIK {
  options: Required<Omit<FootIKOptions, 'ground'>> & { ground: GroundQuery | null };
  constructor(
    private root: Object3D,
    private hips: Object3D,
    private legs: Leg[],
    options: FootIKOptions = {},
  ) {
    this.options = {
      ground: Array.isArray(options.ground) ? raycastGround(options.ground) : options.ground ?? null,
      probeHeight: options.probeHeight ?? 0.5,
      maxHipsDrop: options.maxHipsDrop ?? 0.35,
      weight: options.weight ?? 1,
    };
  }

  setGround(ground: GroundQuery | Object3D[] | null) {
    this.options.ground = Array.isArray(ground) ? raycastGround(ground) : ground;
  }

  apply(): void {
    const { ground, probeHeight, maxHipsDrop, weight } = this.options;
    if (!ground || weight <= 0) return;
    this.root.updateMatrixWorld(true);
    const floorY = this.root.getWorldPosition(new Vector3()).y;
    const targets: Array<Vector3 | null> = [];
    let drop = 0;
    for (const leg of this.legs) {
      const p = leg.foot.getWorldPosition(new Vector3());
      const g = ground(p.x, p.z, p.y + probeHeight);
      if (g === null) {
        targets.push(null);
        continue;
      }
      const lift = p.y - floorY; // animated height of the foot above the floor
      const target = new Vector3(p.x, g + lift, p.z);
      targets.push(target);
      drop = Math.min(drop, target.y - p.y);
    }
    drop = Math.max(drop, -maxHipsDrop) * weight;
    if (drop < 0) {
      // Lower the hips in world space.
      const worldDelta = new Vector3(0, drop, 0);
      const parent = this.hips.parent!;
      const inv = parent.matrixWorld.clone().invert();
      const hw = this.hips.getWorldPosition(new Vector3()).add(worldDelta).applyMatrix4(inv);
      this.hips.position.copy(hw);
      this.hips.updateMatrixWorld(true);
    }
    this.legs.forEach((leg, i) => {
      const t = targets[i];
      if (!t) return;
      if (weight < 1) {
        const p = leg.foot.getWorldPosition(new Vector3());
        t.lerpVectors(p, t, weight);
      }
      // Knees bend toward the character's front.
      const knee = leg.lower.getWorldPosition(new Vector3());
      const forward = new Vector3(0, 0, 1).applyQuaternion(this.root.getWorldQuaternion(new Quaternion()));
      solveTwoBoneIK(leg.upper, leg.lower, leg.foot, t, knee.addScaledVector(forward, 0.5));
    });
  }
}
