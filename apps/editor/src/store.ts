import { create } from 'zustand';
import { AnimationClip, BufferGeometry, Quaternion, Vector3, type Object3D, type SkinnedMesh } from 'three';
import {
  alignHeading,
  autoTails,
  creatureDefs,
  mirrorSubtree,
  type CreatureBone,
  guessQuadrupedOrientation,
  quadrupedGaits,
  QUADRUPED_DEFS,
  type BoneDef,
  type GaitId,
  bakePropClip,
  buildPropCharacter,
  deletePropKeys,
  propMotionKeys,
  setPropKey,
  splitParts,
  type PartSplit,
  type PropBone,
  type PropKeys,
  type PropMotion,
  type PropRig,
  applyKeyLayer,
  bindPoseClip,
  deleteKeys,
  emptyKeyLayer,
  rigHipsToNormalized,
  rigLocalToNormalized,
  sampleNormalized,
  sampleNormalizedHips,
  setBoneKey,
  setHipsKey,
  type KeyLayer,
  applyBrush,
  createPaintContext,
  restoreWeights,
  snapshotWeights,
  type BrushMode,
  type PaintContext,
  makeSeamlessLoop,
  sliceClip,
  analyzeMesh,
  applyNormalization,
  autoMapBones,
  bakeClip,
  bindSkeleton,
  buildSkinnedCharacter,
  computeNormalization,
  decodeClip,
  extractNormalizedClip,
  guessOrientation,
  humanoidDefs,
  mergeSceneMeshes,
  mirrorBoneName,
  mirrorClip,
  removeDegenerateTriangles,
  symmetrizeJoints,
  type DetectResult,
  type ExportResult,
  type JointMap,
  type MeshReport,
  type NormalizedClip,
  type PreparedMesh,
  type RiggedCharacter,
  type SkeletonBinding,
  type EncodedClip,
} from '@rigforge/core';
import presetPack from '@rigforge/presets/clips.json';
import { hasSkeleton, loadFiles, loadSample, loadSampleAnimal, loadSampleCreature, loadSampleProp, type LoadedFile } from './lib/loaders';
import { computeWeights, detectJoints, detectQuadrupedJoints, type WeightSettings } from './lib/rigClient';
import { canSave, loadProject, saveProject, writeAutosave } from './lib/project';

export type Step = 'import' | 'orient' | 'rig' | 'animate' | 'export';
export const STEPS: Step[] = ['import', 'orient', 'rig', 'animate', 'export'];
export type Shading = 'textured' | 'clay' | 'weights' | 'xray';

export interface ClipEntry {
  id: string;
  name: string;
  source: string;
  normalized: NormalizedClip;
  loop: boolean;
  inPlace: boolean;
  speed: number;
  /** Trim in/out points in seconds of the source clip. */
  trim?: [number, number];
  /** Hand-authored keys layered over the (trimmed) clip. */
  keys?: KeyLayer;
  /** Prop clips: keys on the prop's own bones (no retargeting). */
  propKeys?: PropKeys;
  baked: AnimationClip;
}

export type RigType = 'humanoid' | 'quadruped' | 'creature' | 'prop';

/** Bone definitions for the current skinned rig type. */
export function skeletonDefs(): readonly BoneDef[] {
  const s = useStore.getState();
  if (s.rigType === 'creature') return creatureDefs(s.creatureBones);
  return s.rigType === 'quadruped' ? QUADRUPED_DEFS : humanoidDefs(s.fingers);
}

export interface KeyEditState {
  clipId: string | null;
  bone: string | null;
  mode: 'rotate' | 'translate';
  autoKey: boolean;
}

export interface PaintSettings {
  active: boolean;
  mode: BrushMode;
  radius: number;
  strength: number;
  mirror: boolean;
}

export const PRESETS: EncodedClip[] = (presetPack as { clips: EncodedClip[] }).clips;

/** A rigged character, either built by RigForge or reused from the imported file. */
export interface CharacterState {
  root: Object3D;
  built: RiggedCharacter | null;
}

interface State {
  step: Step;
  unlocked: number;
  error: string | null;
  busy: string | null;
  progress: number;

  file: LoadedFile | null;
  prepared: PreparedMesh | null;
  report: MeshReport | null;
  existingRig: boolean;

  rotation: Quaternion;
  height: number;
  orientNotes: string[];
  normalized: PreparedMesh | null;

  fingers: boolean;
  symmetry: boolean;
  detection: DetectResult | null;
  joints: JointMap | null;
  weightSettings: WeightSettings;
  kernel: string | null;
  rigTimings: Record<string, number> | null;

  rigType: RigType;
  creatureBones: CreatureBone[];
  propSplit: PartSplit | null;
  propRig: PropRig | null;

  character: CharacterState | null;
  binding: SkeletonBinding | null;
  testClip: AnimationClip | null;

  clips: ClipEntry[];
  activeClip: string | null;
  playing: boolean;
  time: number;
  /** One-shot seek request consumed by the viewport. */
  seek: number | null;

  shading: Shading;
  showSkeleton: boolean;
  showFingerMarkers: boolean;
  selectedBone: string | null;

  paint: PaintSettings;
  keyEdit: KeyEditState;
  /** Bumped whenever skin weights change, so views refresh. */
  weightsVersion: number;
  paintUndo: number;

  exportName: string;
  exportPreset: 'web' | 'mobile' | 'lossless';
  exportResult: ExportResult | null;
}

interface Actions {
  goto(step: Step): void;
  setError(e: string | null): void;
  loadFromFiles(files: File[]): Promise<void>;
  loadSampleModel(pose: 'T' | 'A' | 'prop' | 'quadruped' | 'creature'): Promise<void>;
  rotate(axis: 'x' | 'y' | 'z', degrees: number): void;
  autoOrient(): void;
  setHeight(h: number): void;
  confirmOrientation(): void;
  setFingers(on: boolean): void;
  setSymmetry(on: boolean): void;
  runDetection(): Promise<void>;
  moveJoint(name: string, p: [number, number, number], isTail?: boolean): void;
  symmetrize(from: 'left' | 'right'): void;
  setWeightSettings(s: Partial<WeightSettings>): void;
  buildRig(): Promise<void>;
  useExistingRig(): void;
  editJoints(): void;
  setTestClip(presetId: string | null): void;
  addPreset(id: string): void;
  addImportedClips(files: File[]): Promise<void>;
  updateClip(id: string, patch: Partial<Pick<ClipEntry, 'name' | 'loop' | 'inPlace' | 'speed' | 'trim'>>): void;
  removeClip(id: string): void;
  mirror(id: string): void;
  play(id: string | null): void;
  setPlaying(p: boolean): void;
  setTime(t: number): void;
  set<K extends keyof State>(key: K, value: State[K]): void;
  setPaint(patch: Partial<PaintSettings>): void;
  beginStroke(): void;
  dab(point: [number, number, number]): void;
  undoPaint(): void;
  pickBoneAt(point: [number, number, number]): void;
  saveProjectFile(): Promise<void>;
  startKeyEdit(id: string): void;
  stopKeyEdit(): void;
  newClip(seconds: number): void;
  setKeyEdit(patch: Partial<KeyEditState>): void;
  keyCurrentPose(bone?: string): void;
  deleteKeyAt(time: number, bone?: string): void;
  setClipKeys(id: string, keys: KeyLayer | undefined): void;
  setRigType(t: RigType): void;
  addPropBone(): void;
  updatePropBone(name: string, patch: Partial<PropBone>): void;
  removePropBone(name: string): void;
  assignPart(part: number): void;
  buildPropRig(): void;
  addPropMotion(motion: PropMotion, name: string): void;
  addGait(id: GaitId): void;
  addCreatureJoint(p: [number, number, number]): void;
  removeCreatureBone(name: string): void;
  renameCreatureBone(name: string, next: string): void;
  mirrorCreatureBone(name: string): void;
  openProject(blob: Blob): Promise<void>;
}

let clipCounter = 0;

/** Applies the trim range; trimmed loops get their seam blended so they cycle cleanly. */
function trimmed(entry: Omit<ClipEntry, 'baked'>): NormalizedClip {
  const n = entry.normalized;
  if (!entry.trim) return n;
  const a = Math.max(0, Math.round(entry.trim[0] * n.fps));
  const b = Math.min(n.frames - 1, Math.round(entry.trim[1] * n.fps));
  if (b - a < 2) return n;
  if (entry.loop && b + 1 < n.frames) return makeSeamlessLoop(sliceClip(n, a, b + 2));
  return sliceClip(n, a, b + 1);
}

function bakeProp(entry: Omit<ClipEntry, 'baked'>): AnimationClip {
  const built = useStore.getState().character?.built;
  const duration = (entry.normalized.frames - 1) / entry.normalized.fps;
  const clip = built ? bakePropClip(built, { ...entry.propKeys!, duration }, entry.name) : new AnimationClip(entry.name, duration, []);
  clip.userData = { rigforge: { loop: entry.loop, inPlace: false, speed: entry.speed } };
  return clip;
}

/** Bakes a clip entry for whatever kind of character is loaded. */
function bakeEntry(entry: Omit<ClipEntry, 'baked'>): AnimationClip {
  if (entry.propKeys) return bakeProp(entry);
  return bake(useStore.getState().binding!, entry);
}

/** A placeholder timeline for prop clips (they don't use normalized humanoid data). */
function propTimeline(seconds: number, name: string): NormalizedClip {
  const frames = Math.max(2, Math.round(seconds * 30) + 1);
  return { name, fps: 30, frames, bones: [], rotations: new Float32Array(0), hips: new Float32Array(frames * 3), loop: false };
}

function bake(binding: SkeletonBinding, entry: Omit<ClipEntry, 'baked'>): AnimationClip {
  if (entry.propKeys) return bakeProp(entry);
  const clip = bakeClip(binding, { ...applyKeyLayer(trimmed(entry), entry.keys), loop: entry.loop }, { inPlace: entry.inPlace, name: entry.name });
  clip.userData = { rigforge: { loop: entry.loop, inPlace: entry.inPlace, speed: entry.speed } };
  return clip;
}

export const useStore = create<State & Actions>()((set, get) => ({
  step: 'import',
  unlocked: 0,
  error: null,
  busy: null,
  progress: 0,
  file: null,
  prepared: null,
  report: null,
  existingRig: false,
  rotation: new Quaternion(),
  height: 1.8,
  orientNotes: [],
  normalized: null,
  fingers: true,
  symmetry: true,
  detection: null,
  joints: null,
  weightSettings: { resolution: 192, falloff: 4, smoothIterations: 2 },
  kernel: null,
  rigTimings: null,
  rigType: 'humanoid',
  creatureBones: [],
  propSplit: null,
  propRig: null,
  character: null,
  binding: null,
  testClip: null,
  clips: [],
  activeClip: null,
  playing: false,
  time: 0,
  seek: null,
  shading: 'textured',
  showSkeleton: true,
  showFingerMarkers: false,
  selectedBone: null,
  paint: { active: false, mode: 'add', radius: 0.06, strength: 0.35, mirror: true },
  keyEdit: { clipId: null, bone: null, mode: 'rotate', autoKey: true },
  weightsVersion: 0,
  paintUndo: 0,
  exportName: 'character',
  exportPreset: 'web',
  exportResult: null,

  set: (key, value) => set({ [key]: value } as any),
  setError: (error) => set({ error }),

  goto(step) {
    const i = STEPS.indexOf(step);
    if (i <= get().unlocked) set({ step, paint: { ...get().paint, active: false }, keyEdit: { ...get().keyEdit, clipId: null } });
  },

  async loadFromFiles(files) {
    set({ busy: 'Loading model…', error: null });
    try {
      const file = await loadFiles(files);
      ingest(file);
    } catch (e) {
      set({ error: (e as Error).message });
    } finally {
      set({ busy: null });
    }
  },

  async loadSampleModel(pose) {
    if (pose === 'creature') {
      set({ rigType: 'creature' });
      ingest(loadSampleCreature());
      return;
    }
    if (pose === 'quadruped') {
      set({ rigType: 'quadruped' });
      ingest(loadSampleAnimal());
      return;
    }
    if (pose === 'prop') {
      set({ rigType: 'prop' });
      ingest(loadSampleProp());
      return;
    }
    set({ rigType: 'humanoid' });
    ingest(loadSample(pose));
  },

  rotate(axis, degrees) {
    const q = new Quaternion().setFromAxisAngle(
      new Vector3(axis === 'x' ? 1 : 0, axis === 'y' ? 1 : 0, axis === 'z' ? 1 : 0),
      (degrees * Math.PI) / 180,
    );
    set({ rotation: q.multiply(get().rotation), orientNotes: [] });
  },

  autoOrient() {
    const prepared = get().prepared;
    if (!prepared) return;
    const g = orientationFor(get().rigType, prepared.geometry);
    set({ rotation: g.rotation, orientNotes: g.notes.length ? g.notes : ['Model already looked upright and facing +Z.'] });
  },

  setHeight(h) {
    set({ height: Math.max(0.1, Math.min(20, h)) });
  },

  confirmOrientation() {
    const { prepared, rotation, height } = get();
    if (!prepared) return;
    const n = computeNormalization(prepared.geometry, { rotation, targetHeight: height, fit: fitFor(get().rigType) });
    const geometry = applyNormalization(prepared.geometry, n);
    geometry.computeVertexNormals();
    set({
      normalized: { geometry, materials: prepared.materials },
      step: 'rig',
      unlocked: Math.max(get().unlocked, 2),
      detection: null,
      joints: null,
      character: null,
      binding: null,
      clips: [],
      activeClip: null,
      exportResult: null,
    });
    if (get().rigType === 'creature') {
      geometry.computeBoundingBox();
      const c = geometry.boundingBox!.getCenter(new Vector3());
      set({ creatureBones: [{ name: 'root', parent: null }], joints: { joints: { root: [c.x, c.y, c.z] }, tails: {} }, detection: null, selectedBone: 'root' });
      return;
    }
    if (get().rigType === 'prop') {
      const split = splitParts(geometry, 4);
      geometry.computeBoundingBox();
      const bb = geometry.boundingBox!;
      set({
        propSplit: split,
        propRig: { bones: [{ name: 'root', parent: null, pivot: [(bb.min.x + bb.max.x) / 2, bb.min.y, (bb.min.z + bb.max.z) / 2] }], partBone: {} },
        selectedBone: 'root',
      });
    } else void get().runDetection();
  },

  setFingers(on) {
    set({ fingers: on });
    void get().runDetection();
  },
  setSymmetry: (on) => set({ symmetry: on }),

  async runDetection() {
    const normalized = get().normalized;
    if (!normalized) return;
    set({ busy: 'Detecting joints…', error: null, character: null, binding: null, clips: [], activeClip: null });
    try {
      const { positions, index } = arrays(normalized.geometry);
      let detection: DetectResult;
      if (get().rigType === 'quadruped') {
        const d = await detectQuadrupedJoints(positions, index);
        detection = {
          joints: d.joints,
          tails: d.tails,
          confidence: d.confidence,
          notes: d.notes,
          pose: 'unknown',
          fingers: null,
          measurements: { centerX: d.joints.hips[0], crotchY: d.measurements.bellyY, shoulderY: d.measurements.backY, neckY: 0, height: d.measurements.height },
        };
      } else detection = await detectJoints(positions, index, get().fingers);
      set({ detection, joints: { joints: detection.joints, tails: detection.tails } });
    } catch (e) {
      set({ error: `Joint detection failed: ${(e as Error).message}` });
    } finally {
      set({ busy: null });
    }
  },

  moveJoint(name, p, isTail = false) {
    const joints = get().joints;
    if (!joints) return;
    const next: JointMap = { joints: { ...joints.joints }, tails: { ...joints.tails } };
    const target = isTail ? next.tails : next.joints;
    target[name] = p;
    if (get().symmetry) {
      const cx = get().detection?.measurements.centerX ?? joints.joints.root?.[0] ?? 0;
      const mirrored = mirrorBoneName(name);
      if (mirrored !== name) target[mirrored] = [2 * cx - p[0], p[1], p[2]];
      else target[name] = [cx, p[1], p[2]];
    }
    set({ joints: next });
  },

  symmetrize(from) {
    const joints = get().joints;
    if (!joints) return;
    set({ joints: symmetrizeJoints(joints, from, get().detection?.measurements.centerX ?? 0) });
  },

  setWeightSettings: (s) => set({ weightSettings: { ...get().weightSettings, ...s } }),

  async buildRig() {
    const { normalized, joints, fingers, weightSettings } = get();
    if (!normalized || !joints) return;
    set({ busy: 'Computing skin weights…', progress: 0, error: null });
    let finished = false;
    try {
      const { positions, index } = arrays(normalized.geometry);
      const t0 = performance.now();
      const quad = get().rigType === 'quadruped';
      const creature = get().rigType === 'creature';
      const defs = skeletonDefs();
      const rigJoints = creature ? { joints: joints.joints, tails: autoTails(defs, joints.joints, joints.tails) } : joints;
      const kind = creature ? [...defs] : quad ? 'quadruped' : fingers ? 'humanoid' : 'humanoid-nofingers';
      const w = await computeWeights(positions, index, rigJoints, kind, weightSettings, (stage, fraction) => {
        // Progress messages cross the worker boundary asynchronously; drop any that arrive late.
        if (!finished && fraction < 1) set({ busy: `${stage}…`, progress: fraction });
      });
      const built = buildSkinnedCharacter(normalized.geometry, normalized.materials, defs, rigJoints, w.skinIndex, w.skinWeight, quad ? 'Animal' : creature ? 'Creature' : 'Character');
      // Humanoids retarget through a canonical binding; other skeletons use direct bone keys.
      const binding = quad || creature ? null : bindSkeleton(built.root, autoMapBones(built.root).map);
      if (creature) set({ joints: rigJoints });
      const kernel = w.kernel;
      set({
        character: { root: built.root, built },
        binding,
        kernel,
        rigTimings: { ...w.timings, total: performance.now() - t0 },
        unlocked: Math.max(get().unlocked, 4),
        shading: 'textured',
      });
      rebakeAll();
      if (!creature) get().setTestClip('walk');
    } catch (e) {
      set({ error: `Rigging failed: ${(e as Error).message}` });
    } finally {
      finished = true;
      set({ busy: null, progress: 0 });
    }
  },

  useExistingRig() {
    const file = get().file;
    if (!file) return;
    const { map, missing } = autoMapBones(file.scene);
    if (missing.length > 3) {
      set({ error: `The existing skeleton is missing humanoid bones: ${missing.join(', ')}` });
      return;
    }
    const binding = bindSkeleton(file.scene, map);
    set({ character: { root: file.scene, built: null }, binding, unlocked: 4, step: 'animate', joints: null, detection: null });
    // Keep the file's own clips.
    const entries: ClipEntry[] = [];
    for (const clip of file.animations) {
      const normalized = extractNormalizedClip(binding, clip, { fps: 30 });
      const entry = { id: `c${++clipCounter}`, name: clip.name || 'Clip', source: 'Imported with model', normalized, loop: /idle|walk|run/i.test(clip.name), inPlace: false, speed: 1 };
      entries.push({ ...entry, baked: bake(binding, entry) });
    }
    set({ clips: entries, activeClip: entries[0]?.id ?? null, playing: entries.length > 0 });
  },

  editJoints() {
    set({ character: null, binding: null, testClip: null, playing: false, paint: { ...get().paint, active: false } });
  },

  setTestClip(presetId) {
    const binding = get().binding;
    const built = get().character?.built;
    if (get().rigType === 'quadruped' && built && presetId) {
      const gait = quadrupedGaits(get().joints!).find((g) => g.id === presetId);
      if (gait) set({ testClip: bakePropClip(built, gait.keys, `test:${gait.name}`), playing: true });
      return;
    }
    if (!binding || !presetId) {
      set({ testClip: null });
      return;
    }
    const preset = PRESETS.find((p) => p.id === presetId);
    if (!preset) return;
    const normalized = decodeClip(preset);
    set({ testClip: bakeClip(binding, normalized, { inPlace: true, name: `test:${preset.name}` }), playing: true });
  },

  addPreset(id) {
    const binding = get().binding;
    const preset = PRESETS.find((p) => p.id === id);
    if (!binding || !preset) return;
    const normalized = decodeClip(preset);
    let name = preset.name;
    const names = new Set(get().clips.map((c) => c.name));
    for (let i = 2; names.has(name); i++) name = `${preset.name} ${i}`;
    const entry = { id: `c${++clipCounter}`, name, source: preset.source ?? 'Preset', normalized, loop: preset.loop, inPlace: true, speed: 1 };
    const full = { ...entry, baked: bake(binding, entry) };
    set({ clips: [...get().clips, full], activeClip: full.id, playing: true, testClip: null });
  },

  async addImportedClips(files) {
    const binding = get().binding;
    if (!binding) return;
    set({ busy: 'Retargeting animation…', error: null });
    try {
      const file = await loadFiles(files);
      if (!file.animations.length) throw new Error(`${file.name} contains no animations.`);
      const { map, missing, family } = autoMapBones(file.scene);
      if (!map.hips) throw new Error('Could not find a hips bone in the animation file.');
      const source = bindSkeleton(file.scene, map);
      const added: ClipEntry[] = [];
      for (const clip of file.animations) {
        let normalized = extractNormalizedClip(source, clip, { fps: 30, name: clip.name });
        normalized = alignHeading(normalized, 'start');
        const baseName = clip.name && clip.name !== 'mixamo.com' ? clip.name : file.name.replace(/\.[^.]+$/, '');
        const loop = /idle|walk|run|jog|loop/i.test(baseName);
        const entry = { id: `c${++clipCounter}`, name: baseName, source: `${file.name} (${family}${missing.length ? `, missing ${missing.length}` : ''})`, normalized: { ...normalized, loop }, loop, inPlace: true, speed: 1 };
        added.push({ ...entry, baked: bake(get().binding!, entry) });
      }
      set({ clips: [...get().clips, ...added], activeClip: added[0].id, playing: true, testClip: null });
    } catch (e) {
      set({ error: (e as Error).message });
    } finally {
      set({ busy: null });
    }
  },

  updateClip(id, patch) {
    if (!get().character) return;
    set({
      clips: get().clips.map((c) => {
        if (c.id !== id) return c;
        const next = { ...c, ...patch };
        const needsBake = patch.inPlace !== undefined || patch.loop !== undefined || patch.name !== undefined || 'trim' in patch;
        return needsBake ? { ...next, baked: bakeEntry(next) } : next;
      }),
    });
  },

  removeClip(id) {
    if (get().keyEdit.clipId === id) get().stopKeyEdit();
    const clips = get().clips.filter((c) => c.id !== id);
    set({ clips, activeClip: get().activeClip === id ? clips[0]?.id ?? null : get().activeClip });
  },

  mirror(id) {
    const binding = get().binding;
    const c = get().clips.find((x) => x.id === id);
    if (!binding || !c) return;
    const entry = { ...c, id: `c${++clipCounter}`, name: `${c.name} (mirrored)`, normalized: mirrorClip(c.normalized) };
    set({ clips: [...get().clips, { ...entry, baked: bake(binding, entry) }], activeClip: entry.id });
  },

  setPaint(patch) {
    const paint = { ...get().paint, ...patch };
    if (patch.active) {
      // Paint in the bind pose so the brush lines up with the mesh.
      set({ playing: false, testClip: null, shading: 'weights', selectedBone: get().selectedBone ?? 'spine' });
      const root = get().character?.root;
      root?.traverse((o: any) => o.isSkinnedMesh && o.skeleton.pose());
    }
    set({ paint });
  },

  beginStroke() {
    const ctx = paintContext();
    if (!ctx) return;
    undoStack.push(snapshotWeights(ctx.ctx));
    if (undoStack.length > 30) undoStack.shift();
    set({ paintUndo: undoStack.length });
  },

  dab(point) {
    const pc = paintContext();
    const bone = get().selectedBone;
    if (!pc || !bone) return;
    const { mode, radius, strength, mirror } = get().paint;
    const names = pc.mesh.skeleton.bones.map((b) => b.name);
    const bi = names.indexOf(bone);
    if (bi < 0) return;
    applyBrush(pc.ctx, { center: point, radius, strength, mode, bone: bi });
    if (mirror) {
      const cx = get().detection?.measurements.centerX ?? 0;
      const mb = names.indexOf(mirrorBoneName(bone));
      const mp: [number, number, number] = [2 * cx - point[0], point[1], point[2]];
      if (mb >= 0 && Math.abs(mp[0] - point[0]) > radius * 0.5) applyBrush(pc.ctx, { center: mp, radius, strength, mode, bone: mb });
    }
    pc.mesh.geometry.attributes.skinIndex.needsUpdate = true;
    pc.mesh.geometry.attributes.skinWeight.needsUpdate = true;
    set({ weightsVersion: get().weightsVersion + 1 });
  },

  undoPaint() {
    const pc = paintContext();
    const snap = undoStack.pop();
    if (!pc || !snap) return;
    restoreWeights(pc.ctx, snap);
    pc.mesh.geometry.attributes.skinIndex.needsUpdate = true;
    pc.mesh.geometry.attributes.skinWeight.needsUpdate = true;
    set({ weightsVersion: get().weightsVersion + 1, paintUndo: undoStack.length });
  },

  pickBoneAt(point) {
    const pc = paintContext();
    if (!pc) return;
    const pos = pc.mesh.geometry.attributes.position;
    let best = -1, bestD = Infinity;
    for (let i = 0; i < pos.count; i++) {
      const d = (pos.getX(i) - point[0]) ** 2 + (pos.getY(i) - point[1]) ** 2 + (pos.getZ(i) - point[2]) ** 2;
      if (d < bestD) { bestD = d; best = i; }
    }
    if (best < 0) return;
    const si = pc.mesh.geometry.attributes.skinIndex, sw = pc.mesh.geometry.attributes.skinWeight;
    let k = 0;
    for (let j = 1; j < 4; j++) if (sw.getComponent(best, j) > sw.getComponent(best, k)) k = j;
    set({ selectedBone: pc.mesh.skeleton.bones[si.getComponent(best, k)].name });
  },

  startKeyEdit(id) {
    set({ keyEdit: { ...get().keyEdit, clipId: id, bone: get().keyEdit.bone ?? 'leftUpperArm' }, activeClip: id, playing: false, testClip: null, paint: { ...get().paint, active: false }, showSkeleton: true });
  },

  stopKeyEdit() {
    set({ keyEdit: { ...get().keyEdit, clipId: null } });
  },

  newClip(seconds) {
    const binding = get().binding;
    if (get().rigType === 'prop' && get().character) {
      const names = new Set(get().clips.map((c) => c.name));
      let name = 'Animation';
      for (let i = 2; names.has(name); i++) name = `Animation ${i}`;
      const entry = { id: `c${++clipCounter}`, name, source: 'Keyframed', normalized: propTimeline(seconds, name), loop: true, inPlace: false, speed: 1, propKeys: { duration: seconds, bones: {} } as PropKeys };
      set({ clips: [...get().clips, { ...entry, baked: bakeProp(entry) }], time: 0, seek: 0 });
      get().startKeyEdit(entry.id);
      return;
    }
    if (!binding) return;
    const names = new Set(get().clips.map((c) => c.name));
    let name = 'New Clip';
    for (let i = 2; names.has(name); i++) name = `New Clip ${i}`;
    const entry = { id: `c${++clipCounter}`, name, source: 'Keyframed', normalized: bindPoseClip(binding, seconds, 30, name), loop: false, inPlace: false, speed: 1, keys: emptyKeyLayer() };
    set({ clips: [...get().clips, { ...entry, baked: bake(binding, entry) }], time: 0, seek: 0 });
    get().startKeyEdit(entry.id);
  },

  setKeyEdit(patch) {
    set({ keyEdit: { ...get().keyEdit, ...patch } });
  },

  keyCurrentPose(boneName) {
    const { binding, keyEdit, clips, time, character } = get();
    const bone = boneName ?? keyEdit.bone;
    const entry = clips.find((c) => c.id === keyEdit.clipId);
    if (entry?.propKeys) {
      const node = bone ? character?.built?.bones[bone] : undefined;
      if (!node) return;
      const t = Math.round(time * 30) / 30;
      const propKeys = setPropKey(entry.propKeys, node, t);
      set({ clips: clips.map((c) => (c.id === entry.id ? { ...c, propKeys, baked: bakeProp({ ...c, propKeys }) } : c)), time: t, seek: t });
      return;
    }
    const node = bone && binding?.map[bone] ? character?.root.getObjectByName(binding.map[bone]) : undefined;
    if (!binding || !entry || !bone || !node) return;
    const base = trimmed(entry);
    const t = Math.round(time * base.fps) / base.fps;
    let keys = entry.keys ?? emptyKeyLayer();
    const qn = rigLocalToNormalized(binding, bone, node.quaternion);
    const offset = sampleNormalized(base, bone, t).invert().multiply(qn);
    keys = setBoneKey(keys, bone, t, offset);
    if (bone === 'hips') keys = setHipsKey(keys, t, rigHipsToNormalized(binding, node.position).sub(sampleNormalizedHips(base, t)));
    get().setClipKeys(entry.id, keys);
    set({ time: t, seek: t });
  },

  deleteKeyAt(time, bone) {
    const entry = get().clips.find((c) => c.id === get().keyEdit.clipId);
    if (entry?.propKeys) {
      const propKeys = deletePropKeys(entry.propKeys, time, bone);
      set({ clips: get().clips.map((c) => (c.id === entry.id ? { ...c, propKeys, baked: bakeProp({ ...c, propKeys }) } : c)), seek: time });
      return;
    }
    if (!entry?.keys) return;
    get().setClipKeys(entry.id, deleteKeys(entry.keys, time, bone));
    set({ seek: time });
  },

  setRigType(rigType) {
    const prepared = get().prepared;
    const guess = prepared ? orientationFor(rigType, prepared.geometry) : { rotation: new Quaternion(), notes: [] };
    set({ rigType, rotation: guess.rotation, orientNotes: guess.notes, height: defaultHeight(rigType) });
  },

  addPropBone() {
    const rig = get().propRig;
    if (!rig) return;
    const names = new Set(rig.bones.map((b) => b.name));
    let name = 'part';
    for (let i = 1; names.has(name); i++) name = `part${i}`;
    const parent = get().selectedBone && names.has(get().selectedBone!) ? get().selectedBone! : 'root';
    const pivot = [...rig.bones.find((b) => b.name === parent)!.pivot] as [number, number, number];
    set({ propRig: { ...rig, bones: [...rig.bones, { name, parent, pivot }] }, selectedBone: name });
  },

  updatePropBone(name, patch) {
    const rig = get().propRig;
    if (!rig) return;
    const newName = patch.name?.trim().replace(/[^\w-]/g, '_');
    if (newName !== undefined && (!newName || rig.bones.some((b) => b.name === newName && b.name !== name))) return;
    const rename = (n: string | null) => (newName && n === name ? newName : n);
    const bones = rig.bones.map((b) => (b.name === name ? { ...b, ...patch, name: newName ?? b.name } : { ...b, parent: rename(b.parent) }));
    const partBone = Object.fromEntries(Object.entries(rig.partBone).map(([k, v]) => [k, rename(v)!]));
    set({ propRig: { bones, partBone }, selectedBone: newName ?? get().selectedBone });
  },

  removePropBone(name) {
    const rig = get().propRig;
    if (!rig || name === 'root') return;
    const parent = rig.bones.find((b) => b.name === name)?.parent ?? 'root';
    const bones = rig.bones.filter((b) => b.name !== name).map((b) => (b.parent === name ? { ...b, parent } : b));
    const partBone = Object.fromEntries(Object.entries(rig.partBone).map(([k, v]) => [k, v === name ? parent : v]));
    set({ propRig: { bones, partBone }, selectedBone: parent });
  },

  assignPart(part) {
    const rig = get().propRig;
    const bone = get().selectedBone;
    if (!rig || !bone) return;
    const partBone = { ...rig.partBone };
    if (bone === 'root') delete partBone[part];
    else partBone[part] = bone;
    set({ propRig: { ...rig, partBone } });
  },

  buildPropRig() {
    const { normalized, propSplit, propRig } = get();
    if (!normalized || !propSplit || !propRig) return;
    const built = buildPropCharacter(normalized.geometry, normalized.materials, propSplit, propRig, 'Prop');
    set({ character: { root: built.root, built }, binding: null, unlocked: 4, step: 'animate', shading: 'textured' });
    // Keep clips from a previous build; drop keys for bones that no longer exist.
    const names = new Set(propRig.bones.map((b) => b.name));
    set({
      clips: get().clips.map((c) =>
        c.propKeys ? { ...c, propKeys: { ...c.propKeys, bones: Object.fromEntries(Object.entries(c.propKeys.bones).filter(([b]) => names.has(b))) } } : c,
      ),
    });
    rebakeAll();
  },

  addCreatureJoint(p) {
    const { creatureBones, joints, selectedBone } = get();
    if (!joints) return;
    const parent = selectedBone && creatureBones.some((b) => b.name === selectedBone) ? selectedBone : 'root';
    const names = new Set(creatureBones.map((b) => b.name));
    // Name by chain: children of "tail1" become "tail2", otherwise bone1, bone2...
    const m = /^(.*?)(\d+)$/.exec(parent);
    let name = m ? `${m[1]}${+m[2] + 1}` : 'bone1';
    for (let i = 1; names.has(name); i++) name = m ? `${m[1]}${+m[2] + 1 + i}` : `bone${i + 1}`;
    set({
      creatureBones: [...creatureBones, { name, parent }],
      joints: { joints: { ...joints.joints, [name]: p }, tails: joints.tails },
      selectedBone: name,
    });
  },

  removeCreatureBone(name) {
    const { creatureBones, joints } = get();
    if (!joints || name === 'root') return;
    const parent = creatureBones.find((b) => b.name === name)?.parent ?? 'root';
    const rest = { ...joints.joints };
    delete rest[name];
    set({
      creatureBones: creatureBones.filter((b) => b.name !== name).map((b) => (b.parent === name ? { ...b, parent } : b)),
      joints: { joints: rest, tails: {} },
      selectedBone: parent,
    });
  },

  renameCreatureBone(name, next) {
    const { creatureBones, joints } = get();
    const clean = next.trim().replace(/[^\w-]/g, '_');
    if (!joints || !clean || clean === name || creatureBones.some((b) => b.name === clean)) return;
    const jr = Object.fromEntries(Object.entries(joints.joints).map(([k, v]) => [k === name ? clean : k, v]));
    set({
      creatureBones: creatureBones.map((b) => ({ name: b.name === name ? clean : b.name, parent: b.parent === name ? clean : b.parent })),
      joints: { joints: jr, tails: {} },
      selectedBone: clean,
    });
  },

  mirrorCreatureBone(name) {
    const { creatureBones, joints } = get();
    if (!joints || name === 'root') return;
    const cx = joints.joints.root?.[0] ?? 0;
    const m = mirrorSubtree(creatureBones, joints.joints, name, cx);
    set({ creatureBones: [...creatureBones, ...m.bones], joints: { joints: { ...joints.joints, ...m.joints }, tails: {} } });
  },

  addGait(id) {
    const built = get().character?.built;
    const joints = get().joints;
    const gait = joints ? quadrupedGaits(joints).find((g) => g.id === id) : undefined;
    if (!built || !gait) return;
    const names = new Set(get().clips.map((c) => c.name));
    let n = gait.name;
    for (let i = 2; names.has(n); i++) n = `${gait.name} ${i}`;
    const entry = { id: `c${++clipCounter}`, name: n, source: `Gait · ${gait.description}`, normalized: propTimeline(gait.keys.duration, n), loop: gait.loop, inPlace: true, speed: 1, propKeys: gait.keys };
    set({ clips: [...get().clips, { ...entry, baked: bakeProp(entry) }], activeClip: entry.id, playing: true, testClip: null });
  },

  addPropMotion(motion, name) {
    if (!get().character?.built) return;
    const names = new Set(get().clips.map((c) => c.name));
    let n = name;
    for (let i = 2; names.has(n); i++) n = `${name} ${i}`;
    const propKeys = propMotionKeys(motion);
    const loop = motion.type === 'spin' || motion.type === 'bob' || motion.type === 'wave' || ('pingPong' in motion && motion.pingPong);
    const entry = { id: `c${++clipCounter}`, name: n, source: `${motion.type} · ${motion.bone}`, normalized: propTimeline(motion.duration, n), loop, inPlace: false, speed: 1, propKeys };
    set({ clips: [...get().clips, { ...entry, baked: bakeProp(entry) }], activeClip: entry.id, playing: true });
  },

  setClipKeys(id, keys) {
    const binding = get().binding;
    if (!binding) return;
    set({ clips: get().clips.map((c) => (c.id === id ? { ...c, keys, baked: bake(binding, { ...c, keys }) } : c)) });
  },

  async saveProjectFile() {
    try {
      const blob = await saveProject(get());
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${get().exportName || 'character'}.rigforge`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (e) {
      set({ error: (e as Error).message });
    }
  },

  async openProject(blob) {
    set({ busy: 'Opening project…', error: null });
    try {
      const patch = await loadProject(blob, (entry, binding) => bake(binding, entry));
      paintCache = null;
      const pending = (patch as any).pendingPropClips as Array<{ name: string; source: string; loop: boolean; speed: number; propKeys: PropKeys; seconds: number }> | undefined;
      delete (patch as any).pendingPropClips;
      set({ ...patch, paint: { ...get().paint, active: false }, testClip: null, selectedBone: patch.selectedBone ?? null });
      if (pending) {
        const clips = pending.map((c) => {
          const entry = { id: `c${++clipCounter}`, name: c.name, source: c.source, normalized: propTimeline(c.seconds, c.name), loop: c.loop, inPlace: false, speed: c.speed, propKeys: c.propKeys };
          return { ...entry, baked: bakeProp(entry) };
        });
        set({ clips, activeClip: clips[0]?.id ?? null, playing: clips.length > 0 });
      }
    } catch (e) {
      set({ error: `Could not open project: ${(e as Error).message}` });
    } finally {
      set({ busy: null });
    }
  },

  play(id) {
    set({ activeClip: id, playing: id !== null, testClip: null, keyEdit: { ...get().keyEdit, clipId: get().keyEdit.clipId === id ? id : null } });
  },
  setPlaying: (playing) => set({ playing }),
  setTime: (time) => set({ time }),
}));

// Weight painting context for the current character (rebuilt when the character changes).
let paintCache: { mesh: SkinnedMesh; ctx: PaintContext } | null = null;
const undoStack: Array<ReturnType<typeof snapshotWeights>> = [];

function paintContext(): { mesh: SkinnedMesh; ctx: PaintContext } | null {
  const built = useStore.getState().character?.built;
  if (!built) return null;
  if (paintCache?.mesh !== built.mesh) {
    paintCache = { mesh: built.mesh, ctx: createPaintContext(built.mesh.geometry, built.skeleton.bones.length) };
    undoStack.length = 0;
  }
  return paintCache;
}

function arrays(geometry: BufferGeometry) {
  const positions = new Float32Array(geometry.attributes.position.array as ArrayLike<number>);
  const index = geometry.index
    ? new Uint32Array(geometry.index.array as ArrayLike<number>)
    : Uint32Array.from({ length: geometry.attributes.position.count }, (_, i) => i);
  return { positions, index };
}

function orientationFor(rigType: RigType, geometry: BufferGeometry): { rotation: Quaternion; notes: string[] } {
  if (rigType === 'prop' || rigType === 'creature') return { rotation: new Quaternion(), notes: [] };
  if (rigType === 'quadruped') return guessQuadrupedOrientation(geometry);
  return guessOrientation(geometry);
}

/** Characters and animals are sized by height; free-form creatures and props by their largest dimension. */
export function fitFor(rigType: RigType): 'height' | 'max' {
  return rigType === 'creature' || rigType === 'prop' ? 'max' : 'height';
}

function defaultHeight(rigType: RigType): number {
  return rigType === 'humanoid' ? 1.8 : rigType === 'quadruped' ? 0.8 : rigType === 'creature' ? 1 : 1;
}

function ingest(file: LoadedFile) {
  const prepared = mergeSceneMeshes(file.scene);
  removeDegenerateTriangles(prepared.geometry);
  const report = analyzeMesh(prepared.geometry, prepared.materials);
  const rigType = useStore.getState().rigType;
  const guess = orientationFor(rigType, prepared.geometry);
  const existingRig = hasSkeleton(file.scene);
  useStore.setState({
    file,
    prepared,
    report,
    existingRig,
    rotation: guess.rotation,
    orientNotes: guess.notes,
    height: defaultHeight(rigType),
    normalized: null,
    detection: null,
    joints: null,
    propSplit: null,
    propRig: null,
    character: null,
    binding: null,
    clips: [],
    activeClip: null,
    exportResult: null,
    exportName: file.name.replace(/\.[^.]+$/, '').replace(/[^a-z0-9_-]+/gi, '-').toLowerCase() || 'character',
    unlocked: 1,
    step: 'import',
    error: null,
  });
}

function rebakeAll() {
  const { character, clips } = useStore.getState();
  if (!character) return;
  useStore.setState({ clips: clips.map((c) => ({ ...c, baked: bakeEntry(c) })) });
}

// Autosave a couple of seconds after meaningful edits.
let autosaveTimer: ReturnType<typeof setTimeout> | null = null;
useStore.subscribe((s, prev) => {
  const changed =
    s.prepared !== prev.prepared || s.joints !== prev.joints || s.character !== prev.character || s.clips !== prev.clips ||
    s.weightsVersion !== prev.weightsVersion || s.rotation !== prev.rotation || s.height !== prev.height || s.exportName !== prev.exportName;
  if (!changed || canSave(s)) return;
  if (autosaveTimer) clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(async () => {
    const state = useStore.getState();
    if (state.busy || canSave(state)) return;
    try {
      const blob = await saveProject(state);
      await writeAutosave({ name: state.exportName, savedAt: new Date().toISOString(), blob });
    } catch (e) {
      console.warn('[rigforge] autosave failed', e);
    }
  }, 2500);
});
