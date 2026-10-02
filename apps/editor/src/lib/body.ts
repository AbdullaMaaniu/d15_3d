import { BufferGeometry, Float32BufferAttribute, Matrix4, MeshStandardMaterial, SkinnedMesh, Uint16BufferAttribute, Uint32BufferAttribute } from 'three';
import { decodeReferenceBody, fitReferenceBody, generateBody, insideSlim, tsKernels, type BodyMesh, type BodyShape, type JointMap, type ReferenceBody } from '@rigforge/core';
import type { RiggedCharacter } from '@rigforge/core';
import referenceUrl from '@rigforge/core/assets/reference-body.bin?url';

let reference: Promise<ReferenceBody | null> | null = null;

/** The realistic reference body, fetched once; null if it can't be loaded. */
export function loadReferenceBody(): Promise<ReferenceBody | null> {
  reference ??= fetch(referenceUrl)
    .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`HTTP ${r.status}`))))
    .then(decodeReferenceBody)
    .catch((e) => {
      console.warn('[rigforge] reference body unavailable, using the generated one', e);
      return null;
    });
  return reference;
}

const slimming = new WeakMap<RiggedCharacter, { joints: JointMap; slim: number }>();

/** How much the reference body is slimmed to sit inside this character's clothes (measured once per rig). */
function insideCharacter(built: RiggedCharacter, joints: JointMap, ref: ReferenceBody): number {
  const cached = slimming.get(built);
  if (cached?.joints === joints) return cached.slim;
  const g = built.mesh.geometry;
  const positions = g.getAttribute('position').array as Float32Array;
  g.computeBoundingBox();
  const height = g.boundingBox!.max.y - g.boundingBox!.min.y;
  const grid = tsKernels.voxelize({ positions, index: g.index ? Uint32Array.from(g.index.array) : null, dx: height / 200 });
  const slim = insideSlim(ref, joints, grid);
  slimming.set(built, { joints, slim });
  return slim;
}

/** The body fitted inside this character (rig space, bind pose): the reference body, or a generated one without it. */
export function fitBody(built: RiggedCharacter, joints: JointMap, shape: BodyShape, ref: ReferenceBody | null): BodyMesh {
  return ref ? fitReferenceBody(ref, joints, shape, insideCharacter(built, joints, ref)) : generateBody(joints, shape);
}

/**
 * The body as a skinned mesh driven by the character's own skeleton, so it
 * moves with every clip: the reference body fitted to the rig and slimmed to
 * sit inside the clothes, or a generated one when the reference isn't available. Shown in the Body step (not exported yet).
 */
export function buildBodyMesh(built: RiggedCharacter, joints: JointMap, shape: BodyShape, skinColor: string, ref: ReferenceBody | null): SkinnedMesh {
  const body = fitBody(built, joints, shape, ref);
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
