import { Quaternion, SkinnedMesh, Vector3, type Object3D } from 'three';
import type { BoneMap } from './bonemap';

/** Minimum angle (radians) each arm must keep away from straight down to stay outside the body. */
export interface ArmClearance {
  left: number;
  right: number;
}

const TORSO = new Set(['hips', 'spine', 'chest', 'upperChest', 'leftShoulder', 'rightShoulder', 'leftUpperLeg', 'rightUpperLeg']);
const MAX = (50 * Math.PI) / 180;

/**
 * How far out a hanging arm has to swing to clear the torso, measured on the skinned
 * mesh at bind time. Animations are made for slim bodies; on a bulky one (a padded
 * jacket, a big belly) the same "arms down" pose sinks the arms into the hips.
 *
 * The body is upright in the rig's space (Y up, facing +Z, left is +X). For each side
 * it swings the model's own arm (sleeve included, which can be much wider than the
 * arm) down around the shoulder joint and finds the smallest angle from vertical, in
 * the frontal plane, at which it stays outside the torso.
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
  const ls = vec('leftUpperArm'), rs = vec('rightUpperArm');
  if (!ls || !rs) return result;
  const cx = (ls.x + rs.x) / 2;
  const d = new Vector3();
  const q = new Quaternion();
  const p = new Vector3();
  for (const side of ['left', 'right'] as const) {
    const s = side === 'left' ? 1 : -1;
    const shoulder = vec(`${side}UpperArm`), elbow = vec(`${side}LowerArm`), wrist = vec(`${side}Hand`);
    if (!shoulder || !elbow || !wrist) continue;
    const upper = shoulder.distanceTo(elbow), reach = upper + elbow.distanceTo(wrist);
    const rest = elbow.clone().sub(shoulder).normalize();
    const armBone = new RegExp(`^${side}(UpperArm|LowerArm|Hand|Thumb|Index|Middle|Ring|Little)`);
    // The torso's outer surface on this side per height row (with its front-to-back
    // extent), rows between vertex rings filled in from their neighbours.
    const cell = 0.1 * upper;
    let y0 = Infinity, y1 = -Infinity;
    for (let v = 0; v < count; v++) {
      if (!TORSO.has(owner[v])) continue;
      y0 = Math.min(y0, positions[v * 3 + 1]);
      y1 = Math.max(y1, positions[v * 3 + 1]);
    }
    if (!(y1 > y0)) continue;
    const rows = Math.floor((y1 - y0) / cell) + 1;
    const wall = new Float64Array(rows).fill(-Infinity);
    const zLo = new Float64Array(rows).fill(Infinity), zHi = new Float64Array(rows).fill(-Infinity);
    for (let v = 0; v < count; v++) {
      if (!TORSO.has(owner[v])) continue;
      const r = Math.floor((positions[v * 3 + 1] - y0) / cell);
      wall[r] = Math.max(wall[r], s * (positions[v * 3] - cx));
      zLo[r] = Math.min(zLo[r], positions[v * 3 + 2]);
      zHi[r] = Math.max(zHi[r], positions[v * 3 + 2]);
    }
    for (let r = 0, prev = -1; r < rows; r++) {
      if (wall[r] === -Infinity) continue;
      for (let g = prev + 1; prev >= 0 && g < r; g++) {
        const t = (g - prev) / (r - prev);
        wall[g] = wall[prev] + t * (wall[r] - wall[prev]);
        zLo[g] = Math.min(zLo[prev], zLo[r]);
        zHi[g] = Math.max(zHi[prev], zHi[r]);
      }
      prev = r;
    }
    // The arm's own surface (a sleeve can be much wider than the arm), past the armpit.
    const arm: Vector3[] = [];
    for (let v = 0; v < count; v++) {
      if (!armBone.test(owner[v])) continue;
      const rel = vertex(v).clone().sub(shoulder);
      const along = rel.dot(rest);
      if (along > 0.15 * upper && along < reach) arm.push(rel);
    }
    if (arm.length < 20) continue;
    // Swing the straight arm down in the frontal plane until almost none of it is inside the torso.
    const tol = 0.03 * upper;
    let need = MAX;
    for (let deg = 0; deg <= 50; deg++) {
      const th = (deg * Math.PI) / 180;
      q.setFromUnitVectors(rest, d.set(s * Math.sin(th), -Math.cos(th), 0));
      let inside = 0;
      for (const rel of arm) {
        p.copy(rel).applyQuaternion(q).add(shoulder);
        const r = Math.floor((p.y - y0) / cell);
        if (r < 0 || r >= rows || p.z < zLo[r] || p.z > zHi[r]) continue;
        if (s * (p.x - cx) < wall[r] - tol) inside++;
      }
      if (inside <= 0.01 * arm.length) {
        need = th;
        break;
      }
    }
    result[side] = need;
  }
  // A symmetric body gets the same spacing on both sides (the wider one), so one
  // noisier measurement doesn't leave the character lopsided.
  const le = vec('leftLowerArm'), re = vec('rightLowerArm');
  const upper = le ? ls.distanceTo(le) : 0;
  if (le && re && upper > 0 && Math.hypot(ls.x - cx + (rs.x - cx), ls.y - rs.y, ls.z - rs.z) < 0.15 * upper && Math.hypot(le.x - cx + (re.x - cx), le.y - re.y, le.z - re.z) < 0.15 * upper) {
    result.left = result.right = Math.max(result.left, result.right);
  }
  return result;
}
