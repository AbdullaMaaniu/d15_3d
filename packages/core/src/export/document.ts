import { Bone, Group, Matrix3, Matrix4, Quaternion, Vector3, BufferAttribute, BufferGeometry, type AnimationClip } from 'three';
import type { Accessor, Document, Node as GNode, Primitive } from '@gltf-transform/core';
import type { Kernels } from '../kernels';
import { tsKernels } from '../kernels';
import { computeNormalization, guessOrientation } from '../mesh/normalize';
import { detectHumanoid, type DetectResult } from '../rig/landmarks';
import { QUADRUPED_DEFS, detectQuadruped, guessQuadrupedOrientation, type QuadrupedDetectResult } from '../rig/quadruped';
import { computeSkinWeights } from '../rig/weights';
import { humanoidDefs, type BoneDef, type JointMap } from '../skeleton';
import { autoMapBones } from '../anim/bonemap';
import { bakeClip, bindSkeleton } from '../anim/retarget';
import { armClearance } from '../anim/armClearance';
import { decodeClip, type PresetPack } from '../anim/codec';
import { quadrupedGaits } from '../anim/gaits';
import { bakePropClip } from '../rig/prop';

export interface RigDocumentOptions {
  type?: 'humanoid' | 'quadruped';
  /** Target height in meters (default 1.8 humanoid, 0.8 quadruped). */
  height?: number;
  fingers?: boolean;
  /** Preset / gait ids to add, or 'all'. Default: a sensible starter set. */
  clips?: string[] | 'all';
  /** Humanoid preset pack (from @rigforge/presets). */
  presets?: PresetPack | null;
  /** Override the auto-detected orientation. */
  rotation?: Quaternion;
  /** Skinning voxel resolution (default 192). */
  resolution?: number;
  kernels?: Kernels;
  onProgress?: (stage: string) => void;
}

export interface RigDocumentReport {
  type: 'humanoid' | 'quadruped';
  vertices: number;
  triangles: number;
  bones: number;
  clips: string[];
  confidence: number;
  notes: string[];
  timings: Record<string, number>;
}

const DEFAULT_CLIPS = { humanoid: ['idle', 'walk', 'run', 'jump'], quadruped: ['idle', 'walk', 'trot', 'gallop'] };

interface PrimRef {
  node: GNode;
  prim: Primitive;
  start: number;
  count: number;
}

/**
 * Rigs a glTF document in place: bakes every mesh into rig space (upright,
 * facing +Z, real-world scale), detects joints, computes skin weights, and writes
 * a skeleton, a skin and animation clips. Materials and textures are untouched.
 */
export async function rigDocument(doc: Document, options: RigDocumentOptions = {}): Promise<RigDocumentReport> {
  const type = options.type ?? 'humanoid';
  const kernels = options.kernels ?? tsKernels;
  const progress = options.onProgress ?? (() => {});
  const timings: Record<string, number> = {};
  const tick = () => performance.now();
  const root = doc.getRoot();
  const scene = root.getDefaultScene() ?? root.listScenes()[0];
  if (!scene) throw new Error('The file has no scene.');

  // Drop any existing rig or animation: we're replacing them.
  for (const a of root.listAnimations()) a.dispose();
  for (const s of root.listSkins()) s.dispose();

  // --- 1. Bake world transforms into the vertex data and flatten the hierarchy. ------
  progress('Preparing mesh');
  const meshNodes: GNode[] = [];
  scene.traverse((n) => {
    if (n.getMesh()) meshNodes.push(n);
  });
  if (!meshNodes.length) throw new Error('No meshes found.');
  const worlds = new Map(meshNodes.map((n) => [n, new Matrix4().fromArray(n.getWorldMatrix())]));

  // Merged world-space positions for orientation & detection.
  const prims: PrimRef[] = [];
  const merged: number[] = [];
  const mergedIndex: number[] = [];
  const el: number[] = [];
  const v = new Vector3();
  for (const node of meshNodes) {
    const m = worlds.get(node)!;
    for (const prim of node.getMesh()!.listPrimitives()) {
      const pos = prim.getAttribute('POSITION');
      if (!pos) continue;
      const start = merged.length / 3;
      for (let i = 0; i < pos.getCount(); i++) {
        pos.getElement(i, el);
        v.set(el[0], el[1], el[2]).applyMatrix4(m);
        merged.push(v.x, v.y, v.z);
      }
      const idx = prim.getIndices();
      if (idx) for (let i = 0; i < idx.getCount(); i++) mergedIndex.push(start + idx.getScalar(i));
      else for (let i = 0; i < pos.getCount(); i++) mergedIndex.push(start + i);
      prims.push({ node, prim, start, count: pos.getCount() });
    }
  }
  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(new Float32Array(merged), 3));
  const rotation = options.rotation ?? (type === 'quadruped' ? guessQuadrupedOrientation(geo).rotation : guessOrientation(geo).rotation);
  const norm = computeNormalization(geo, { rotation, targetHeight: options.height ?? (type === 'quadruped' ? 0.8 : 1.8) });
  const normalized = new Float32Array(merged.length);
  for (let i = 0; i < merged.length; i += 3) {
    v.set(merged[i], merged[i + 1], merged[i + 2]).applyMatrix4(norm.matrix);
    normalized[i] = v.x;
    normalized[i + 1] = v.y;
    normalized[i + 2] = v.z;
  }

  // Rewrite primitive attributes in rig space (new accessors: inputs may be shared or quantized).
  const buffer = root.listBuffers()[0] ?? doc.createBuffer();
  const rewritten = new Map<Accessor, Accessor>();
  for (const ref of prims) {
    const full = new Matrix4().multiplyMatrices(norm.matrix, worlds.get(ref.node)!);
    const normalMat = new Matrix3().getNormalMatrix(full);
    const flip = full.determinant() < 0;
    const out = new Float32Array(ref.count * 3);
    out.set(normalized.subarray(ref.start * 3, (ref.start + ref.count) * 3));
    ref.prim.setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(out).setBuffer(buffer));
    const nrm = ref.prim.getAttribute('NORMAL');
    if (nrm) {
      const arr = new Float32Array(nrm.getCount() * 3);
      for (let i = 0; i < nrm.getCount(); i++) {
        nrm.getElement(i, el);
        v.set(el[0], el[1], el[2]).applyMatrix3(normalMat).normalize();
        arr.set([v.x, v.y, v.z], i * 3);
      }
      ref.prim.setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(arr).setBuffer(buffer));
    }
    const tan = ref.prim.getAttribute('TANGENT');
    if (tan) {
      const m3 = new Matrix3().setFromMatrix4(full);
      const arr = new Float32Array(tan.getCount() * 4);
      for (let i = 0; i < tan.getCount(); i++) {
        tan.getElement(i, el);
        v.set(el[0], el[1], el[2]).applyMatrix3(m3).normalize();
        arr.set([v.x, v.y, v.z, flip ? -el[3] : el[3]], i * 4);
      }
      ref.prim.setAttribute('TANGENT', doc.createAccessor().setType('VEC4').setArray(arr).setBuffer(buffer));
    }
    if (flip) {
      const idx = ref.prim.getIndices();
      if (idx) {
        const key = rewritten.get(idx);
        if (key) ref.prim.setIndices(key);
        else {
          const a = new Uint32Array(idx.getCount());
          for (let i = 0; i < a.length; i += 3) {
            a[i] = idx.getScalar(i);
            a[i + 1] = idx.getScalar(i + 2);
            a[i + 2] = idx.getScalar(i + 1);
          }
          const acc = doc.createAccessor().setType('SCALAR').setArray(a).setBuffer(buffer);
          rewritten.set(idx, acc);
          ref.prim.setIndices(acc);
        }
      }
    }
    // Morph targets would now be in the wrong space; drop them.
    for (const t of ref.prim.listTargets()) ref.prim.removeTarget(t);
  }
  for (const node of meshNodes) {
    node.getParentNode()?.removeChild(node);
    for (const s of root.listScenes()) if (s.listChildren().includes(node)) s.removeChild(node);
    node.setTranslation([0, 0, 0]).setRotation([0, 0, 0, 1]).setScale([1, 1, 1]);
    scene.addChild(node);
  }

  // --- 2. Joints and weights. --------------------------------------------------------
  progress('Detecting joints');
  let t0 = tick();
  const index = new Uint32Array(mergedIndex);
  let joints: JointMap;
  let defs: readonly BoneDef[];
  let notes: string[];
  let confidence: number;
  if (type === 'quadruped') {
    const d: QuadrupedDetectResult = detectQuadruped(normalized, index, { kernels });
    joints = d;
    defs = QUADRUPED_DEFS;
    notes = d.notes;
    confidence = d.confidence;
  } else {
    const d: DetectResult = detectHumanoid(normalized, index, { kernels, fingers: options.fingers !== false });
    joints = d;
    defs = humanoidDefs(options.fingers !== false);
    notes = d.notes;
    confidence = d.confidence;
  }
  timings.detect = tick() - t0;
  progress('Computing skin weights');
  t0 = tick();
  const w = computeSkinWeights(normalized, index, defs, joints, { kernels, resolution: options.resolution });
  timings.weights = tick() - t0;

  // --- 3. Skeleton, skin and weights. -----------------------------------------------
  progress('Writing skeleton');
  const nodes = new Map<string, GNode>();
  for (const d of defs) {
    const p = joints.joints[d.name];
    const pp = d.parent ? joints.joints[d.parent] : [0, 0, 0];
    const n = doc.createNode(d.name).setTranslation([p[0] - pp[0], p[1] - pp[1], p[2] - pp[2]]);
    nodes.set(d.name, n);
    if (d.parent) nodes.get(d.parent)!.addChild(n);
    else scene.addChild(n);
  }
  const ibm = new Float32Array(defs.length * 16);
  defs.forEach((d, i) => {
    const p = joints.joints[d.name];
    const m = new Matrix4().makeTranslation(-p[0], -p[1], -p[2]);
    ibm.set(m.elements, i * 16);
  });
  const skin = doc.createSkin('Skin').setSkeleton(nodes.get(defs[0].name)!)
    .setInverseBindMatrices(doc.createAccessor().setType('MAT4').setArray(ibm).setBuffer(buffer));
  for (const d of defs) skin.addJoint(nodes.get(d.name)!);
  for (const ref of prims) {
    ref.prim.setAttribute('JOINTS_0', doc.createAccessor().setType('VEC4').setArray(w.skinIndex.slice(ref.start * 4, (ref.start + ref.count) * 4)).setBuffer(buffer));
    ref.prim.setAttribute('WEIGHTS_0', doc.createAccessor().setType('VEC4').setArray(w.skinWeight.slice(ref.start * 4, (ref.start + ref.count) * 4)).setBuffer(buffer));
  }
  for (const node of meshNodes) node.setSkin(skin);

  // --- 4. Animations. ---------------------------------------------------------------
  progress('Baking animations');
  const bones: Record<string, Bone> = {};
  const group = new Group();
  for (const d of defs) {
    const b = new Bone();
    b.name = d.name;
    const p = joints.joints[d.name];
    const pp = d.parent ? joints.joints[d.parent] : [0, 0, 0];
    b.position.set(p[0] - pp[0], p[1] - pp[1], p[2] - pp[2]);
    b.userData.restQuaternion = b.quaternion.clone();
    b.userData.restPosition = b.position.clone();
    bones[d.name] = b;
    if (d.parent) bones[d.parent].add(b);
    else group.add(b);
  }
  group.updateMatrixWorld(true);
  const clips: AnimationClip[] = [];
  const want = options.clips ?? DEFAULT_CLIPS[type];
  if (type === 'quadruped') {
    for (const g of quadrupedGaits(joints)) {
      if (want !== 'all' && !want.includes(g.id)) continue;
      const c = bakePropClip({ bones }, g.keys, g.name);
      c.userData = { rigforge: { loop: g.loop, inPlace: true } };
      clips.push(c);
    }
  } else if (options.presets) {
    const binding = bindSkeleton(group, autoMapBones(group).map);
    // The group has no mesh to measure; use the rig's own vertices and weights.
    binding.autoArmClearance = armClearance(normalized, w.skinIndex, w.skinWeight, defs.map((d) => d.name), (c) => joints.joints[c]);
    binding.armClearance = { ...binding.autoArmClearance };
    for (const e of options.presets.clips) {
      if (want !== 'all' && !want.includes(e.id)) continue;
      const n = decodeClip(e);
      const c = bakeClip(binding, n, { inPlace: true, name: e.name });
      c.userData = { rigforge: { loop: e.loop, inPlace: true } };
      clips.push(c);
    }
  }
  for (const clip of clips) {
    const anim = doc.createAnimation(clip.name).setExtras({ rigforge: clip.userData.rigforge });
    for (const track of clip.tracks) {
      const dot = track.name.lastIndexOf('.');
      const node = nodes.get(track.name.slice(0, dot));
      const prop = track.name.slice(dot + 1);
      if (!node || (prop !== 'quaternion' && prop !== 'position')) continue;
      const sampler = doc.createAnimationSampler()
        .setInput(doc.createAccessor().setType('SCALAR').setArray(new Float32Array(track.times)).setBuffer(buffer))
        .setOutput(doc.createAccessor().setType(prop === 'quaternion' ? 'VEC4' : 'VEC3').setArray(new Float32Array(track.values)).setBuffer(buffer))
        .setInterpolation('LINEAR');
      anim.addSampler(sampler).addChannel(
        doc.createAnimationChannel().setTargetNode(node).setTargetPath(prop === 'quaternion' ? 'rotation' : 'translation').setSampler(sampler),
      );
    }
  }
  root.getAsset().generator = 'RigForge';

  let triangles = 0;
  for (const ref of prims) triangles += (ref.prim.getIndices()?.getCount() ?? ref.count) / 3;
  return {
    type,
    vertices: normalized.length / 3,
    triangles,
    bones: defs.length,
    clips: clips.map((c) => c.name),
    confidence,
    notes,
    timings: { detect: timings.detect, weights: timings.weights },
  };
}
