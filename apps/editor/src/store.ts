import { create } from 'zustand';
import { AnimationClip, BufferGeometry, Quaternion, Vector3, type Object3D } from 'three';
import {
  alignHeading,
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
import { hasSkeleton, loadFiles, loadSample, type LoadedFile } from './lib/loaders';
import { computeWeights, detectJoints, type WeightSettings } from './lib/rigClient';

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
  baked: AnimationClip;
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

  exportName: string;
  exportPreset: 'web' | 'mobile' | 'lossless';
  exportResult: ExportResult | null;
}

interface Actions {
  goto(step: Step): void;
  setError(e: string | null): void;
  loadFromFiles(files: File[]): Promise<void>;
  loadSampleModel(pose: 'T' | 'A'): Promise<void>;
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
  updateClip(id: string, patch: Partial<Pick<ClipEntry, 'name' | 'loop' | 'inPlace' | 'speed'>>): void;
  removeClip(id: string): void;
  mirror(id: string): void;
  play(id: string | null): void;
  setPlaying(p: boolean): void;
  setTime(t: number): void;
  set<K extends keyof State>(key: K, value: State[K]): void;
}

let clipCounter = 0;

function bake(binding: SkeletonBinding, entry: Omit<ClipEntry, 'baked'>): AnimationClip {
  const clip = bakeClip(binding, { ...entry.normalized, loop: entry.loop }, { inPlace: entry.inPlace, name: entry.name });
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
  exportName: 'character',
  exportPreset: 'web',
  exportResult: null,

  set: (key, value) => set({ [key]: value } as any),
  setError: (error) => set({ error }),

  goto(step) {
    const i = STEPS.indexOf(step);
    if (i <= get().unlocked) set({ step });
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
    const g = guessOrientation(prepared.geometry);
    set({ rotation: g.rotation, orientNotes: g.notes.length ? g.notes : ['Model already looked upright and facing +Z.'] });
  },

  setHeight(h) {
    set({ height: Math.max(0.1, Math.min(20, h)) });
  },

  confirmOrientation() {
    const { prepared, rotation, height } = get();
    if (!prepared) return;
    const n = computeNormalization(prepared.geometry, { rotation, targetHeight: height });
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
    void get().runDetection();
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
      const detection = await detectJoints(positions, index, get().fingers);
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
      const cx = get().detection?.measurements.centerX ?? 0;
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
      const w = await computeWeights(positions, index, joints, fingers, weightSettings, (stage, fraction) => {
        // Progress messages cross the worker boundary asynchronously; drop any that arrive late.
        if (!finished && fraction < 1) set({ busy: `${stage}…`, progress: fraction });
      });
      const built = buildSkinnedCharacter(normalized.geometry, normalized.materials, humanoidDefs(fingers), joints, w.skinIndex, w.skinWeight, 'Character');
      const binding = bindSkeleton(built.root, autoMapBones(built.root).map);
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
      get().setTestClip('walk');
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
    set({ character: null, binding: null, testClip: null, playing: false });
  },

  setTestClip(presetId) {
    const binding = get().binding;
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
    const binding = get().binding;
    if (!binding) return;
    set({
      clips: get().clips.map((c) => {
        if (c.id !== id) return c;
        const next = { ...c, ...patch };
        const needsBake = patch.inPlace !== undefined || patch.loop !== undefined || patch.name !== undefined;
        return needsBake ? { ...next, baked: bake(binding, next) } : next;
      }),
    });
  },

  removeClip(id) {
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

  play(id) {
    set({ activeClip: id, playing: id !== null, testClip: null });
  },
  setPlaying: (playing) => set({ playing }),
  setTime: (time) => set({ time }),
}));

function arrays(geometry: BufferGeometry) {
  const positions = new Float32Array(geometry.attributes.position.array as ArrayLike<number>);
  const index = geometry.index
    ? new Uint32Array(geometry.index.array as ArrayLike<number>)
    : Uint32Array.from({ length: geometry.attributes.position.count }, (_, i) => i);
  return { positions, index };
}

function ingest(file: LoadedFile) {
  const prepared = mergeSceneMeshes(file.scene);
  removeDegenerateTriangles(prepared.geometry);
  const report = analyzeMesh(prepared.geometry, prepared.materials);
  const guess = guessOrientation(prepared.geometry);
  const existingRig = hasSkeleton(file.scene);
  useStore.setState({
    file,
    prepared,
    report,
    existingRig,
    rotation: guess.rotation,
    orientNotes: guess.notes,
    height: 1.8,
    normalized: null,
    detection: null,
    joints: null,
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
  const { binding, clips } = useStore.getState();
  if (!binding) return;
  useStore.setState({ clips: clips.map((c) => ({ ...c, baked: bake(binding, c) })) });
}
