import {
  Bone,
  Group,
  type BufferGeometry,
  type Material,
  Skeleton,
  SkinnedMesh,
  Uint16BufferAttribute,
  Float32BufferAttribute,
} from 'three';
import type { BoneDef, JointMap } from '../skeleton';

export interface RiggedCharacter {
  root: Group;
  mesh: SkinnedMesh;
  skeleton: Skeleton;
  bones: Record<string, Bone>;
  defs: readonly BoneDef[];
}

/**
 * Builds canonical bones (identity rest rotations, world-aligned frames) at the
 * fitted joint positions and binds the geometry with the computed weights.
 */
export function buildSkinnedCharacter(
  geometry: BufferGeometry,
  materials: Material | Material[],
  defs: readonly BoneDef[],
  map: JointMap,
  skinIndex: Uint16Array,
  skinWeight: Float32Array,
  name = 'Character',
): RiggedCharacter {
  const bones: Record<string, Bone> = {};
  const list: Bone[] = [];
  for (const def of defs) {
    const bone = new Bone();
    bone.name = def.name;
    const p = map.joints[def.name];
    if (!p) throw new Error(`Missing joint position for ${def.name}`);
    const parentPos = def.parent ? map.joints[def.parent] : [0, 0, 0];
    bone.position.set(p[0] - parentPos[0], p[1] - parentPos[1], p[2] - parentPos[2]);
    bones[def.name] = bone;
    list.push(bone);
    if (def.parent) bones[def.parent].add(bone);
  }
  const geo = geometry.clone();
  geo.setAttribute('skinIndex', new Uint16BufferAttribute(skinIndex, 4));
  geo.setAttribute('skinWeight', new Float32BufferAttribute(skinWeight, 4));
  const mesh = new SkinnedMesh(geo, materials);
  mesh.name = `${name}Mesh`;
  mesh.frustumCulled = false;
  const root = new Group();
  root.name = name;
  root.add(mesh);
  root.add(list[0]);
  root.updateMatrixWorld(true);
  const skeleton = new Skeleton(list);
  mesh.bind(skeleton);
  // Remember the leaf tails for tools that need bone lengths (e.g. the skeleton overlay).
  root.userData.rigforge = { version: 1, tails: map.tails };
  return { root, mesh, skeleton, bones, defs };
}

/** Resets every bone to its bind pose. */
export function resetPose(character: RiggedCharacter): void {
  character.skeleton.pose();
}
