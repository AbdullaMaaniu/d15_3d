import { SkinnedMesh, Vector3, type Object3D } from 'three';
import type { BoneMap } from './bonemap';

/** Minimum angle (radians) each arm must keep away from straight down to stay outside the body. */
export interface ArmClearance {
  left: number;
  right: number;
}

const TORSO = new Set(['hips', 'spine', 'chest', 'upperChest', 'leftUpperLeg', 'rightUpperLeg']);
const MAX = (50 * Math.PI) / 180;

function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  values.sort((a, b) => a - b);
  return values[Math.min(values.length - 1, Math.floor(values.length * p))];
}

const _ab = new Vector3();
const _ap = new Vector3();
function segmentDistance(p: Vector3, a: Vector3, b: Vector3): number {
  _ab.subVectors(b, a);
  const t = Math.max(0, Math.min(1, _ap.subVectors(p, a).dot(_ab) / Math.max(1e-12, _ab.lengthSq())));
  return _ap.sub(_ab.multiplyScalar(t)).length();
}

/**
 * How far out a hanging arm has to swing to clear the torso, measured on the skinned
 * mesh at bind time. Animations are made for slim bodies; on a bulky one (a padded
 * jacket, a big belly) the same "arms down" pose sinks the arms into the hips.
 *
 * The body is upright in the rig's space (Y up, facing +Z, left is +X). For each side
 * it finds the smallest angle from vertical, in the frontal plane around the shoulder,
 * at which an arm as thick as the model's own sleeve misses the torso's vertices.
 */
export function measureArmClearance(root: Object3D, map: BoneMap): ArmClearance {
  let mesh: SkinnedMesh | undefined;
  root.traverse((o) => {
    if (!mesh && (o as SkinnedMesh).isSkinnedMesh && (o as SkinnedMesh).geometry.attributes.skinIndex) mesh = o as SkinnedMesh;
  });
  if (!mesh) return { left: 0, right: 0 };
  root.updateMatrixWorld(true);
  const canonOf = new Map(Object.entries(map).map(([canon, name]) => [name, canon]));
  const { position, skinIndex, skinWeight } = mesh.geometry.attributes;
  const positions = new Float32Array(position.count * 3);
  const p = new Vector3();
  for (let v = 0; v < position.count; v++) p.fromBufferAttribute(position, v).applyMatrix4(mesh.matrixWorld).toArray(positions, v * 3);
  const joint = (canon: string) => {
    const b = map[canon] ? root.getObjectByName(map[canon]) : undefined;
    return b ? (b.getWorldPosition(new Vector3()).toArray() as [number, number, number]) : undefined;
  };
  return armClearance(positions, skinIndex.array as ArrayLike<number>, skinWeight.array as ArrayLike<number>, mesh.skeleton.bones.map((b) => canonOf.get(b.name) ?? ''), joint);
}

/**
 * The same measurement on plain arrays: rig-space positions, 4 influences per vertex,
 * the canonical name of each skin bone, and joint positions by canonical name.
 */
export function armClearance(
  positions: ArrayLike<number>,
  skinIndex: ArrayLike<number>,
  skinWeight: ArrayLike<number>,
  bones: readonly string[],
  joint: (canon: string) => readonly number[] | undefined,
): ArmClearance {
  const count = positions.length / 3;
  // Group vertices by their strongest influence.
  const owner = new Array<string>(count);
  for (let v = 0; v < count; v++) {
    let best = 0;
    let bestW = -1;
    for (let k = 0; k < 4; k++) {
      const w = skinWeight[v * 4 + k];
      if (w > bestW) { bestW = w; best = skinIndex[v * 4 + k]; }
    }
    owner[v] = bones[best] ?? '';
  }
  const at = new Vector3();
  const vertex = (v: number) => at.set(positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]);
  const vec = (canon: string) => {
    const j = joint(canon);
    return j ? new Vector3(j[0], j[1], j[2]) : undefined;
  };

  const result = { left: 0, right: 0 };
  for (const side of ['left', 'right'] as const) {
    const s = side === 'left' ? 1 : -1;
    const shoulder = vec(`${side}UpperArm`), elbow = vec(`${side}LowerArm`), wrist = vec(`${side}Hand`);
    if (!shoulder || !elbow || !wrist) continue;
    const upper = shoulder.distanceTo(elbow), reach = upper + elbow.distanceTo(wrist);
    // The sleeve's thickness.
    const radii: number[] = [];
    for (let v = 0; v < count; v++) {
      if (owner[v] === `${side}UpperArm`) radii.push(segmentDistance(vertex(v), shoulder, elbow));
      else if (owner[v] === `${side}LowerArm`) radii.push(segmentDistance(vertex(v), elbow, wrist));
    }
    const r = percentile(radii, 0.75);
    if (!(r > 0)) continue;
    // Angle each torso vertex needs the arm to clear it.
    const needs: number[] = [];
    for (let v = 0; v < count; v++) {
      if (!TORSO.has(owner[v])) continue;
      const p = vertex(v);
      const dz = p.z - shoulder.z;
      if (Math.abs(dz) >= r) continue;
      const out = s * (p.x - shoulder.x), down = shoulder.y - p.y;
      // Skip the armpit, where any arm meets the body.
      if (down < 0.3 * upper) continue;
      const len = Math.hypot(out, down);
      if (len > reach) continue;
      const clear = Math.sqrt(r * r - dz * dz);
      needs.push(Math.atan2(out, down) + Math.asin(Math.min(1, clear / len)));
    }
    result[side] = Math.max(0, Math.min(MAX, percentile(needs, 0.97)));
  }
  return result;
}
