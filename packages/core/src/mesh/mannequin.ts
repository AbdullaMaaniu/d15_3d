import { BoxGeometry, BufferGeometry, CapsuleGeometry, Matrix4, Quaternion, SphereGeometry, Vector3 } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { JointMap } from '../skeleton';

type V3 = [number, number, number];

export interface MannequinOptions {
  pose?: 'T' | 'A';
  /** Model separate fingers (default true); false produces mitten hands. */
  fingers?: boolean;
  /** Segments per capsule; lower = fewer triangles. */
  detail?: number;
}

/**
 * Procedural test humanoid (1.8 m, Y up, facing +Z) built from overlapping
 * primitives, a deliberately non-manifold "triangle soup" like AI-generated meshes.
 * Returns the geometry and ground-truth joint positions.
 */
export function createMannequin(options: MannequinOptions = {}): { geometry: BufferGeometry; truth: JointMap } {
  const pose = options.pose ?? 'T';
  const fingers = options.fingers ?? true;
  const detail = options.detail ?? 12;
  const parts: BufferGeometry[] = [];
  const joints: Record<string, V3> = {};
  const tails: Record<string, V3> = {};

  const limb = (a: V3, b: V3, r: number, squashZ = 1) => {
    const va = new Vector3(...a), vb = new Vector3(...b);
    const len = va.distanceTo(vb);
    const g = new CapsuleGeometry(r, Math.max(0.001, len), 4, detail);
    if (squashZ !== 1) g.scale(1, 1, squashZ);
    const q = new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), vb.clone().sub(va).normalize());
    g.applyMatrix4(new Matrix4().compose(va.clone().add(vb).multiplyScalar(0.5), q, new Vector3(1, 1, 1)));
    parts.push(g);
  };
  const ball = (c: V3, r: number, sy = 1) => {
    const g = new SphereGeometry(r, detail + 4, detail);
    g.scale(1, sy, 1);
    g.translate(...c);
    parts.push(g);
  };
  const box = (c: V3, s: V3, rot?: Quaternion) => {
    const g = new BoxGeometry(...s, 2, 2, 2);
    if (rot) g.applyQuaternion(rot);
    g.translate(...c);
    parts.push(g);
  };

  // Torso, neck, head.
  joints.hips = [0, 0.96, 0];
  joints.spine = [0, 1.05, 0];
  joints.chest = [0, 1.18, 0];
  joints.upperChest = [0, 1.3, 0];
  joints.neck = [0, 1.46, 0];
  joints.head = [0, 1.54, 0];
  tails.head = [0, 1.8, 0];
  limb([0, 0.99, 0], [0, 1.36, 0], 0.15, 0.62);
  limb([0, 1.4, 0], [0, 1.55, 0], 0.05);
  ball([0, 1.665, 0.01], 0.12, 1.12);

  // Legs.
  for (const side of [1, -1] as const) {
    const n = side === 1 ? 'left' : 'right';
    joints[`${n}UpperLeg`] = [0.09 * side, 0.92, 0];
    joints[`${n}LowerLeg`] = [0.09 * side, 0.5, 0.01];
    joints[`${n}Foot`] = [0.09 * side, 0.08, 0];
    joints[`${n}Toes`] = [0.09 * side, 0.025, 0.13];
    tails[`${n}Toes`] = [0.09 * side, 0.025, 0.19];
    limb(joints[`${n}UpperLeg`], joints[`${n}LowerLeg`], 0.072);
    limb(joints[`${n}LowerLeg`], joints[`${n}Foot`], 0.052);
    box([0.09 * side, 0.04, 0.06], [0.09, 0.07, 0.26]);
  }

  // Arms.
  for (const side of [1, -1] as const) {
    const n = side === 1 ? 'left' : 'right';
    const shoulder: V3 = [0.19 * side, 1.4, 0];
    const angle = pose === 'A' ? (-45 * Math.PI) / 180 : 0;
    const rot = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), angle * side);
    const place = (x: number, y = 0, z = 0): V3 => {
      const v = new Vector3(x * side, y, z).applyQuaternion(rot);
      return [shoulder[0] + v.x, shoulder[1] + v.y, shoulder[2] + v.z];
    };
    joints[`${n}Shoulder`] = [0.05 * side, 1.4, 0];
    joints[`${n}UpperArm`] = place(0);
    joints[`${n}LowerArm`] = place(0.28);
    joints[`${n}Hand`] = place(0.54);
    limb(place(0), place(0.28), 0.048);
    limb(place(0.28), place(0.54), 0.04);
    // Palm.
    box(place(0.6), [0.12, 0.03, 0.09], rot);
    if (fingers) {
      const spreads: Array<[string, number, number]> = [
        ['Index', 0.032, 0.085],
        ['Middle', 0.011, 0.095],
        ['Ring', -0.011, 0.088],
        ['Little', -0.032, 0.07],
      ];
      for (const [f, z, l] of spreads) {
        const k = place(0.66, 0, z);
        const t = place(0.66 + l, 0, z);
        joints[`${n}${f}Proximal`] = k;
        joints[`${n}${f}Intermediate`] = place(0.66 + 0.45 * l, 0, z);
        joints[`${n}${f}Distal`] = place(0.66 + 0.75 * l, 0, z);
        tails[`${n}${f}Distal`] = t;
        limb(k, t, 0.0085);
      }
      const tm = place(0.56, -0.005, 0.035);
      const tp = place(0.6, -0.01, 0.07);
      const tt = place(0.66, -0.015, 0.11);
      joints[`${n}ThumbMetacarpal`] = tm;
      joints[`${n}ThumbProximal`] = tp;
      joints[`${n}ThumbDistal`] = place(0.63, -0.012, 0.09);
      tails[`${n}ThumbDistal`] = tt;
      limb(tp, tt, 0.01);
    } else {
      box(place(0.72), [0.14, 0.028, 0.085], rot);
    }
    tails[`${n}Hand`] = place(0.8);
  }

  const nonIndexed = parts.map((p) => {
    const g = p.index ? p.toNonIndexed() : p;
    for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'uv') g.deleteAttribute(k);
    return g;
  });
  const merged = mergeGeometries(nonIndexed, false)!;
  // Re-index (keeps it a soup: vertices are only merged within identical positions+attributes).
  const geometry = toIndexed(merged);
  return { geometry, truth: { joints, tails } };
}

function toIndexed(g: BufferGeometry): BufferGeometry {
  const n = g.attributes.position.count;
  const idx = new Uint32Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  g.setIndex(Array.from(idx));
  return g;
}
