import { Bone, BufferGeometry, Float32BufferAttribute, Group, Matrix4, MeshStandardMaterial, Skeleton, SkinnedMesh, Uint16BufferAttribute, Uint32BufferAttribute } from 'three';
import { clothesGirth, decodeReferenceBody, fitReferenceBody, generateBody, humanJoints, proportionJoints, tsKernels, PROPORTION_CONTROLS, type BodyShape, type Girth, type JointMap, type ReferenceBody } from '@rigforge/core';
import type { RiggedCharacter } from '@rigforge/core';
import referenceUrl from '@rigforge/core/assets/reference-body.bin?url';
import { partsSummary, useStore } from '../store';

const DEFAULT_SKIN = '#d9a07a';

/** Skin colour from the Parts step, when it has a Skin part. */
export function bodySkinColor(): string {
  const parts = useStore.getState().parts;
  const skinIndex = parts?.defs.findIndex((d) => d.name.toLowerCase() === 'skin') ?? -1;
  return (skinIndex >= 0 && partsSummary()?.baseColors[skinIndex]) || DEFAULT_SKIN;
}

/**
 * The body for export, as it looks in the Body step; null when it's left out
 * or the character has none (not humanoid, or a rig reused from the imported file).
 */
export async function exportBodyRig(): Promise<BodyRig | null> {
  const { character, joints, rigType, bodyShape, exportBody } = useStore.getState();
  const built = character?.built;
  if (!exportBody || !built || !joints || rigType !== 'humanoid') return null;
  return buildBodyMesh(built, joints, bodyShape, bodySkinColor(), await loadReferenceBody());
}

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

const fitted = new WeakMap<RiggedCharacter, { key: string; girth: Girth }>();

/**
 * How much each part of the body is thinned to sit inside the character's
 * clothes (its own surface), down to a slim adult at most. Measured once per
 * rig and proportions; the girth sliders then act on top, so the user can
 * still make the body bigger than the clothes.
 */
function insideClothes(built: RiggedCharacter, ref: ReferenceBody, prop: JointMap, human: JointMap, shape: BodyShape): Girth {
  const proportions: BodyShape = {};
  for (const k of [...PROPORTION_CONTROLS, 'head'] as const) if (shape[k] !== undefined) proportions[k] = shape[k];
  const key = JSON.stringify(proportions);
  const cached = fitted.get(built);
  if (cached?.key === key) return cached.girth;
  const g = built.mesh.geometry;
  const positions = g.getAttribute('position').array as Float32Array;
  g.computeBoundingBox();
  const height = g.boundingBox!.max.y - g.boundingBox!.min.y;
  const solid = tsKernels.voxelize({ positions, index: g.index ? Uint32Array.from(g.index.array) : null, dx: height / 200 });
  const girth = clothesGirth(ref, prop, solid, proportions, { rest: human });
  fitted.set(built, { key, girth });
  return girth;
}

/** The body with its own skeleton, which follows the character's skeleton (see syncBodyPose). */
export interface BodyRig {
  /** Holds the body's bones and mesh, in the character's rig space. */
  root: Group;
  mesh: SkinnedMesh;
  skeleton: Skeleton;
  /** Body bone and the character bone it follows, with how far the body moves for each unit the character moves. */
  links: Array<{ bone: Bone; source: Bone; restPosition: Bone['position']; sourceRest: Bone['position'] }>;
  /** Body hips height over character hips height: scales root motion so the feet keep pace. */
  stride: number;
}

/**
 * The body as a skinned mesh on its own skeleton, driven by the character's
 * skeleton so it moves with every clip. The skeleton has an average adult's
 * proportions at the rig's height, in the rig's pose (however stylised the
 * rig), then the shape's proportion controls: the reference body fits it
 * without stretching. A generated body stands in when the reference isn't
 * available. Shown in the Body step and written into the exported GLB.
 */
export function buildBodyMesh(built: RiggedCharacter, joints: JointMap, shape: BodyShape, skinColor: string, ref: ReferenceBody | null): BodyRig {
  const human = ref ? humanJoints(ref.joints, joints) : joints;
  const prop = proportionJoints(human, shape);
  const body = ref ? fitReferenceBody(ref, prop, shape, { rest: human, girth: insideClothes(built, ref, prop, human, shape) }) : generateBody(prop, shape);
  // A copy of the character's skeleton with the body's proportions. Rest
  // rotations are identity, as on the character, so poses copy across bone for bone.
  const bones: Bone[] = [];
  const byName = new Map<string, Bone>();
  const links: BodyRig['links'] = [];
  for (const source of built.skeleton.bones) {
    const bone = new Bone();
    bone.name = source.name;
    const parent = source.parent && byName.get(source.parent.name);
    const p = prop.joints[source.name], pp = parent ? prop.joints[parent.name] : undefined;
    if (p && (pp || !parent)) bone.position.set(p[0] - (pp?.[0] ?? 0), p[1] - (pp?.[1] ?? 0), p[2] - (pp?.[2] ?? 0));
    else bone.position.copy(source.userData.restPosition ?? source.position);
    bone.quaternion.copy(source.userData.restQuaternion ?? source.quaternion);
    if (parent) parent.add(bone);
    bones.push(bone);
    byName.set(bone.name, bone);
    links.push({ bone, source, restPosition: bone.position.clone(), sourceRest: (source.userData.restPosition ?? source.position).clone() });
  }
  const root = new Group();
  root.name = 'BodyRig';
  root.matrixAutoUpdate = false;
  root.add(bones[0]);
  const names = bones.map((b) => b.name);
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
  (mesh.material as MeshStandardMaterial).name = 'Skin';
  mesh.frustumCulled = false;
  mesh.userData.rfBody = true;
  root.add(mesh);
  root.updateMatrixWorld(true);
  const skeleton = new Skeleton(bones);
  // Geometry is in rig space, like the character's own mesh.
  mesh.bind(skeleton, new Matrix4());
  const ground = Math.min(...Object.values(joints.tails).map((t) => t[1]), ...Object.values(joints.joints).map((t) => t[1]));
  const groundBody = Math.min(...Object.values(prop.tails).map((t) => t[1]), ...Object.values(prop.joints).map((t) => t[1]));
  const stride = joints.joints.hips && prop.joints.hips ? (prop.joints.hips[1] - groundBody) / (joints.joints.hips[1] - ground || 1) : 1;
  return { root, mesh, skeleton, links, stride };
}

/** Puts the body in the character's current pose (call every frame while it animates). */
export function syncBodyPose(rig: BodyRig, built: RiggedCharacter): void {
  rig.root.matrix.copy(built.root.matrixWorld);
  for (const { bone, source, restPosition, sourceRest } of rig.links) {
    bone.quaternion.copy(source.quaternion);
    bone.scale.copy(source.scale);
    // Moves away from the rest position (root motion, bobbing), scaled to the body's size.
    bone.position.copy(source.position).sub(sourceRest).multiplyScalar(rig.stride).add(restPosition);
  }
  rig.root.updateMatrixWorld(true);
}
