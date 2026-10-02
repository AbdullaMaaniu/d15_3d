import { BufferGeometry, Float32BufferAttribute, Matrix4, MeshStandardMaterial, SkinnedMesh, Uint16BufferAttribute, Uint32BufferAttribute } from 'three';
import { generateBody, type BodyShape, type JointMap } from '@rigforge/core';
import type { RiggedCharacter } from '@rigforge/core';

/**
 * The generated body as a skinned mesh driven by the character's own skeleton,
 * so it moves with every clip. Shown in the Body step (not exported yet).
 */
export function buildBodyMesh(built: RiggedCharacter, joints: JointMap, shape: BodyShape, skinColor: string): SkinnedMesh {
  const body = generateBody(joints, shape);
  const names = built.skeleton.bones.map((b) => b.name);
  const remap = body.bones.map((n) => Math.max(0, names.indexOf(n)));
  const skinIndex = new Uint16Array(body.skinIndex.length);
  for (let i = 0; i < skinIndex.length; i++) skinIndex[i] = remap[body.skinIndex[i]];
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(body.positions, 3));
  g.setAttribute('normal', new Float32BufferAttribute(body.normals, 3));
  g.setAttribute('skinIndex', new Uint16BufferAttribute(skinIndex, 4));
  g.setAttribute('skinWeight', new Float32BufferAttribute(body.skinWeight, 4));
  g.setIndex(new Uint32BufferAttribute(body.index, 1));
  const mesh = new SkinnedMesh(g, new MeshStandardMaterial({ color: skinColor, roughness: 0.75, metalness: 0 }));
  mesh.name = 'Body';
  mesh.frustumCulled = false;
  mesh.userData.rfBody = true;
  // Geometry is in rig space, like the character's own mesh.
  mesh.bind(built.skeleton, new Matrix4());
  return mesh;
}
