import { Bone, BufferGeometry, Float32BufferAttribute, Group, Matrix4, Vector3, MeshStandardMaterial, Skeleton, SkinnedMesh, Uint16BufferAttribute, Uint32BufferAttribute } from 'three';
import { boneEnd, clothesGirth, decodeReferenceBody, fitReferenceBody, generateBody, humanJoints, proportionJoints, tsKernels, PROPORTION_CONTROLS, type BodyMesh, type BodyShape, type GarmentSeparation, type Girth, type JointMap, type ReferenceBody } from '@rigforge/core';
import type { RiggedCharacter } from '@rigforge/core';
import referenceUrl from '@rigforge/core/assets/reference-body.bin?url';
import { garmentRegions, useStore } from '../store';

const DEFAULT_SKIN = '#d9a07a';

/** Skin colour from the character's Skin part (from the Parts step, or found automatically). */
export function bodySkinColor(): string {
  return garmentRegions()?.skinColor ?? DEFAULT_SKIN;
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
function insideClothes(built: RiggedCharacter, ref: ReferenceBody, joints: JointMap, prop: JointMap, human: JointMap, shape: BodyShape, bodyRest: Map<string, Vector3>): Girth {
  const proportions: BodyShape = {};
  for (const k of [...PROPORTION_CONTROLS, 'head'] as const) if (shape[k] !== undefined) proportions[k] = shape[k];
  const key = JSON.stringify(proportions);
  const cached = fitted.get(built);
  if (cached?.key === key) return cached.girth;
  const g = built.mesh.geometry;
  const positions = clothesOnBody(built, restMap(built, joints, prop, bodyRest));
  g.computeBoundingBox();
  const height = g.boundingBox!.max.y - g.boundingBox!.min.y;
  const solid = tsKernels.voxelize({ positions, index: g.index ? Uint32Array.from(g.index.array) : null, dx: height / 200 });
  const girth = clothesGirth(ref, prop, solid, proportions, { rest: human });
  fitted.set(built, { key, girth });
  return girth;
}

/** The body with its own skeleton, which follows the character's skeleton (see syncBodyPose). */
/**
 * How each bone of the character moves from its rest to the body's: from its
 * joint `from` (rig space) to the body's joint `to`, stretched along the bone
 * by `stretch` (body length over character length). The rest rotations are
 * the same, so that's all there is to it.
 */
export interface BoneMove {
  from: Vector3;
  to: Vector3;
  dir: Vector3;
  stretch: number;
  /** Rig space to the character bone's own space at rest. */
  toLocal: Matrix4;
}

function restMap(built: RiggedCharacter, joints: JointMap, prop: JointMap, bodyRest: Map<string, Vector3>): BoneMove[] {
  const mesh = built.mesh;
  return mesh.skeleton.bones.map((bone, i) => {
    const toLocal = mesh.skeleton.boneInverses[i].clone().multiply(mesh.bindMatrix);
    const from = new Vector3().applyMatrix4(toLocal.clone().invert());
    const to = bodyRest.get(bone.name)?.clone() ?? from.clone();
    const e = boneEnd(joints, bone.name), be = boneEnd(prop, bone.name);
    const a = joints.joints[bone.name], b = prop.joints[bone.name];
    let dir = new Vector3(0, 1, 0), stretch = 1;
    // The head (hair, hats) keeps its shape: only the limbs and torso stretch to the body's proportions.
    if (a && b && e && be && bone.name !== 'head') {
      const rd = new Vector3(e[0] - a[0], e[1] - a[1], e[2] - a[2]);
      const l = rd.length();
      if (l > 1e-6) {
        dir = rd.divideScalar(l);
        stretch = Math.hypot(be[0] - b[0], be[1] - b[1], be[2] - b[2]) / l;
      }
    }
    return { from, to, dir, stretch, toLocal };
  });
}

/** The character's rest surface moved onto the body's skeleton (rig space), as the body's skinning will place it. */
export function clothesOnBody(built: RiggedCharacter, moves: BoneMove[]): Float32Array {
  const g = built.mesh.geometry;
  return restOnBody(moves, g.getAttribute('position').array, g.getAttribute('skinIndex').array, g.getAttribute('skinWeight').array);
}

/**
 * Rest positions of a surface skinned to the character's skeleton (rig space),
 * moved onto the body's skeleton as `dressMesh` places them: for comparing
 * the clothes with the body at rest.
 */
export function restOnBody(moves: BoneMove[], positions: ArrayLike<number>, skinIndex: ArrayLike<number>, skinWeight: ArrayLike<number>): Float32Array {
  const V = positions.length / 3;
  const out = new Float32Array(V * 3);
  const p = new Vector3(), d = new Vector3(), q = new Vector3();
  for (let v = 0; v < V; v++) {
    p.set(positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]);
    q.set(0, 0, 0);
    for (let k = 0; k < 4; k++) {
      const w = skinWeight[v * 4 + k];
      if (w <= 0) continue;
      const m = moves[skinIndex[v * 4 + k]];
      d.subVectors(p, m.from);
      d.addScaledVector(m.dir, (m.stretch - 1) * d.dot(m.dir)).add(m.to);
      q.addScaledVector(d, w);
    }
    out[v * 3] = q.x;
    out[v * 3 + 1] = q.y;
    out[v * 3 + 2] = q.z;
  }
  return out;
}

/**
 * Puts the character's clothes on the body: its mesh follows the body's
 * skeleton instead of its own, moved and stretched bone by bone from the
 * character's proportions to the body's, so the sleeves, trousers and shoes
 * stay on the body's limbs in every pose. `mesh` is the character's own by
 * default, or a separated garment on its skeleton. Returns the undo.
 */
export function dressBody(rig: BodyRig, built: RiggedCharacter, mesh: SkinnedMesh = built.mesh): () => void {
  return dressMesh(rig, mesh);
}

/**
 * The separated garments and head cut as they sit on the body, for finding
 * the body's covered triangles. The cut, across the neck, moves with the neck.
 */
export function dressedSeparation(rig: BodyRig, sep: GarmentSeparation): Pick<GarmentSeparation, 'pieces' | 'headCut'> {
  const pieces = sep.pieces.map((p) => ({ ...p, positions: restOnBody(rig.moves, p.positions, p.skinIndex, p.skinWeight) }));
  const cut = sep.headCut;
  const neck = rig.skeleton.bones.findIndex((b) => b.name === 'neck');
  if (!cut || neck < 0) return { pieces, headCut: cut };
  const move = (q: [number, number, number]) => Array.from(restOnBody(rig.moves, q, [neck, 0, 0, 0], [1, 0, 0, 0])) as [number, number, number];
  return { pieces, headCut: { ...cut, point: move(cut.point), center: move(cut.center) } };
}

/** `dressBody` for any mesh bound to the character's skeleton, such as the separated garments. Returns the undo. */
export function dressMesh(rig: BodyRig, mesh: SkinnedMesh): () => void {
  const skeleton = mesh.skeleton, bindMatrix = mesh.bindMatrix.clone();
  const inverses = rig.moves.map((m, i) => {
    const dl = m.dir.clone().transformDirection(m.toLocal);
    const s = m.stretch - 1;
    const S = new Matrix4().set(
      1 + s * dl.x * dl.x, s * dl.x * dl.y, s * dl.x * dl.z, 0,
      s * dl.y * dl.x, 1 + s * dl.y * dl.y, s * dl.y * dl.z, 0,
      s * dl.z * dl.x, s * dl.z * dl.y, 1 + s * dl.z * dl.z, 0,
      0, 0, 0, 1,
    );
    return S.multiply(skeleton.boneInverses[i]);
  });
  const byName = new Map(rig.skeleton.bones.map((b) => [b.name, b]));
  mesh.bind(new Skeleton(skeleton.bones.map((b) => byName.get(b.name) ?? b), inverses), bindMatrix);
  return () => mesh.bind(skeleton, bindMatrix);
}

export interface BodyRig {
  /** Holds the body's bones and mesh, in the character's rig space. */
  root: Group;
  mesh: SkinnedMesh;
  skeleton: Skeleton;
  /** Body bone and the character bone it follows, with how far the body moves for each unit the character moves. */
  links: Array<{ bone: Bone; source: Bone; restPosition: Bone['position']; sourceRest: Bone['position'] }>;
  /** Body hips height over character hips height: scales root motion so the feet keep pace. */
  stride: number;
  /** The fitted body (rig space, rest pose) and its joints, which the cloth collides with. */
  body: BodyMesh;
  joints: JointMap;
  /** How the character's bones map onto the body's, to dress the body in the character's clothes. */
  moves: BoneMove[];
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
  root.updateMatrixWorld(true);
  const rest = new Map(bones.map((b) => [b.name, b.getWorldPosition(new Vector3())]));
  const body = ref ? fitReferenceBody(ref, prop, shape, { rest: human, girth: insideClothes(built, ref, joints, prop, human, shape, rest) }) : generateBody(prop, shape);
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
  return { root, mesh, skeleton, links, stride, moves: restMap(built, joints, prop, rest), body, joints: prop };
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
