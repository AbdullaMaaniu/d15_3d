import { Material, Mesh, ObjectLoader, Quaternion, type BufferGeometry } from 'three';
import {
  applyNormalization,
  analyzeMesh,
  autoMapBones,
  bindSkeleton,
  setArmSpacing,
  buildSkinnedCharacter,
  computeNormalization,
  decodeClip,
  encodeClip,
  humanoidDefs,
  type DetectResult,
  type EncodedClip,
  type JointMap,
  type KeyLayer,
  type PropKeys,
  type PropRig,
  buildPropCharacter,
  QUADRUPED_DEFS,
  creatureDefs,
  type CreatureBone,
  splitParts,
} from '@rigforge/core';
import { ALL_STEPS, accessoryDefs, type ClipEntry, type RigType, type useStore } from '../store';
import type { RegionDef } from '@rigforge/core';
import type { ControllerSetup, SpringConfig } from '@rigforge/three';

type StoreState = ReturnType<typeof useStore.getState>;

/** Version 1 of the .rigforge project format (gzipped JSON). */
interface ProjectFile {
  format: 'rigforge-project';
  version: 1;
  savedAt: string;
  name: string;
  /** three.js Object3D JSON of the prepared (merged) mesh, textures embedded. */
  mesh: unknown;
  rotation: [number, number, number, number];
  height: number;
  fingers: boolean;
  weightSettings: StoreState['weightSettings'];
  detection: DetectResult | null;
  joints: JointMap | null;
  rig: { skinIndex: string; skinWeight: string } | null;
  clips: Array<{ name: string; source: string; loop: boolean; inPlace: boolean; speed: number; trim?: [number, number]; keys?: KeyLayer; propKeys?: PropKeys; seconds?: number; clip?: EncodedClip }>;
  exportName: string;
  exportPreset: StoreState['exportPreset'];
  step: StoreState['step'];
  rigType?: RigType;
  propRig?: PropRig | null;
  creatureBones?: CreatureBone[];
  extraBones?: CreatureBone[];
  springs?: SpringConfig;
  controller?: ControllerSetup | null;
  /** Degrees added to the measured arm clearance. */
  armSpacing?: number;
  /** Recolourable regions: names, a region per triangle (base64 bytes) and preview colours. */
  parts?: { defs: RegionDef[]; faces: string; tints: Array<string | null> } | null;
  /** Whether the prop rig was built (props don't store weights: they're rigid). */
  propBuilt?: boolean;
}

const b64 = {
  encode(bytes: Uint8Array): string {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  },
  decode(text: string): Uint8Array {
    const s = atob(text);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  },
};

async function gzip(text: string): Promise<Blob> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Response(stream).blob();
}

async function gunzip(blob: Blob): Promise<string> {
  const head = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
  if (head[0] !== 0x1f || head[1] !== 0x8b) return blob.text(); // plain JSON is accepted too
  return new Response(blob.stream().pipeThrough(new DecompressionStream('gzip'))).text();
}

export function canSave(s: StoreState): string | null {
  if (!s.prepared) return 'Import a model first.';
  if (s.character && !s.character.built) return 'Projects that reuse the imported file\'s own rig can\'t be saved yet.';
  return null;
}

export async function saveProject(s: StoreState): Promise<Blob> {
  const why = canSave(s);
  if (why) throw new Error(why);
  const prepared = s.prepared!;
  const mesh = new Mesh(prepared.geometry, prepared.materials);
  const built = s.character?.built ?? null;
  const file: ProjectFile = {
    format: 'rigforge-project',
    version: 1,
    savedAt: new Date().toISOString(),
    name: s.exportName,
    mesh: mesh.toJSON(),
    rotation: s.rotation.toArray() as [number, number, number, number],
    height: s.height,
    fingers: s.fingers,
    weightSettings: s.weightSettings,
    detection: s.detection,
    joints: s.joints,
    rigType: s.rigType,
    propRig: s.propRig,
    creatureBones: s.creatureBones,
    extraBones: s.extraBones,
    springs: s.springs,
    controller: s.controller,
    parts: s.parts ? { defs: s.parts.defs, faces: b64.encode(s.parts.faces), tints: s.parts.tints } : null,
    armSpacing: s.armSpacing,
    propBuilt: s.rigType === 'prop' && !!built,
    rig: built && s.rigType !== 'prop' && s.joints
      ? {
          skinIndex: b64.encode(new Uint8Array((built.mesh.geometry.attributes.skinIndex.array as Uint16Array).slice().buffer)),
          skinWeight: b64.encode(new Uint8Array((built.mesh.geometry.attributes.skinWeight.array as Float32Array).slice().buffer)),
        }
      : null,
    clips: s.clips.map((c) => ({
      name: c.name,
      source: c.source,
      loop: c.loop,
      inPlace: c.inPlace,
      speed: c.speed,
      trim: c.trim,
      keys: c.keys,
      propKeys: c.propKeys,
      seconds: (c.normalized.frames - 1) / c.normalized.fps,
      clip: c.propKeys ? undefined : encodeClip(c.normalized, { id: c.id, category: 'project', source: c.source }),
    })),
    exportName: s.exportName,
    exportPreset: s.exportPreset,
    step: s.step,
  };
  return gzip(JSON.stringify(file));
}

/** Rebuilds editor state from a saved project. */
export async function loadProject(blob: Blob, bake: (entry: Omit<ClipEntry, 'baked'>, binding: NonNullable<StoreState['binding']>) => ClipEntry['baked']): Promise<Partial<StoreState>> {
  const file = JSON.parse(await gunzip(blob)) as ProjectFile;
  if (file.format !== 'rigforge-project') throw new Error('Not a RigForge project file.');
  if (file.version !== 1) throw new Error(`Unsupported project version ${file.version}.`);

  const object = await new ObjectLoader().parseAsync(file.mesh as any);
  const mesh = object as Mesh;
  const geometry = mesh.geometry as BufferGeometry;
  const materials = (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) as Material[];
  const prepared = { geometry, materials };
  const rotation = new Quaternion().fromArray(file.rotation);
  const fit = file.rigType === 'creature' || file.rigType === 'prop' ? 'max' : 'height';
  const normalizedGeometry = applyNormalization(geometry, computeNormalization(geometry, { rotation, targetHeight: file.height, fit }));
  normalizedGeometry.computeVertexNormals();
  const normalized = { geometry: normalizedGeometry, materials };

  const patch: Partial<StoreState> = {
    file: null,
    prepared,
    report: analyzeMesh(geometry, materials),
    existingRig: false,
    rotation,
    height: file.height,
    orientNotes: [],
    normalized,
    fingers: file.fingers,
    weightSettings: file.weightSettings,
    armSpacing: file.armSpacing ?? 0,
    detection: file.detection,
    joints: file.joints,
    character: null,
    binding: null,
    clips: [],
    activeClip: null,
    exportName: file.exportName,
    exportPreset: file.exportPreset,
    exportResult: null,
    unlocked: 2,
    step: 'rig',
    error: null,
  };

  if (file.rigType === 'prop' && file.propRig) {
    const split = splitParts(normalizedGeometry, 4);
    Object.assign(patch, { rigType: 'prop', propSplit: split, propRig: file.propRig, selectedBone: 'root' });
    if (file.propBuilt) {
      const built = buildPropCharacter(normalizedGeometry, materials, split, file.propRig, 'Prop');
      Object.assign(patch, { character: { root: built.root, built }, binding: null, unlocked: ALL_STEPS, step: ['parts', 'animate', 'export'].includes(file.step) ? file.step : 'rig' });
      // Clips bake once the character is in the store (see openProject).
      (patch as any).pendingPropClips = file.clips;
    }
    return patch;
  }
  const quadruped = file.rigType === 'quadruped';
  const creature = file.rigType === 'creature';
  Object.assign(patch, {
    rigType: file.rigType ?? 'humanoid',
    creatureBones: file.creatureBones ?? [],
    extraBones: file.extraBones ?? [],
    springs: file.springs ?? { chains: [], colliders: [] },
    // Re-applied to the mesh once the character is in the store.
    parts: file.parts ? { defs: file.parts.defs, faces: b64.decode(file.parts.faces), tints: file.parts.tints } : null,
    controller: file.controller ?? null,
  });
  const baseDefs = (defs: readonly import('@rigforge/core').BoneDef[]) => [...defs, ...accessoryDefs(file.extraBones ?? [])];

  if (file.rig && file.joints) {
    const si = b64.decode(file.rig.skinIndex);
    const sw = b64.decode(file.rig.skinWeight);
    const skinIndex = new Uint16Array(si.buffer, si.byteOffset, si.byteLength / 2);
    const skinWeight = new Float32Array(sw.buffer, sw.byteOffset, sw.byteLength / 4);
    if (quadruped || creature) {
      const defs = creature ? creatureDefs(file.creatureBones ?? []) : baseDefs(QUADRUPED_DEFS);
      const built = buildSkinnedCharacter(normalizedGeometry, materials, defs, file.joints, skinIndex, skinWeight, creature ? 'Creature' : 'Animal');
      Object.assign(patch, {
        character: { root: built.root, built },
        binding: null,
        unlocked: ALL_STEPS,
        step: ['parts', 'animate', 'export'].includes(file.step) ? file.step : 'rig',
      });
      (patch as any).pendingPropClips = file.clips;
      return patch;
    }
    const built = buildSkinnedCharacter(normalizedGeometry, materials, baseDefs(humanoidDefs(file.fingers)), file.joints, skinIndex, skinWeight, 'Character');
    const binding = bindSkeleton(built.root, autoMapBones(built.root).map);
    setArmSpacing(binding, file.armSpacing ?? 0);
    const clips: ClipEntry[] = file.clips.map((c, i) => {
      const entry = { id: `p${Date.now().toString(36)}${i}`, name: c.name, source: c.source, normalized: decodeClip(c.clip!), loop: c.loop, inPlace: c.inPlace, speed: c.speed, trim: c.trim, keys: c.keys };
      return { ...entry, baked: bake(entry, binding) };
    });
    Object.assign(patch, {
      character: { root: built.root, built },
      binding,
      clips,
      activeClip: clips[0]?.id ?? null,
      playing: clips.length > 0,
      unlocked: ALL_STEPS,
      step: ['parts', 'animate', 'export'].includes(file.step) ? file.step : 'rig',
    });
  }
  return patch;
}

// --- Autosave (IndexedDB) ------------------------------------------------------------

const DB = 'rigforge';
const STORE = 'autosave';

function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const req = fn(d.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export interface AutosaveInfo {
  name: string;
  savedAt: string;
  blob: Blob;
}

export async function writeAutosave(info: AutosaveInfo): Promise<void> {
  try {
    await tx('readwrite', (s) => s.put(info, 'latest'));
  } catch (e) {
    console.warn('[rigforge] autosave failed', e);
  }
}

export async function readAutosave(): Promise<AutosaveInfo | null> {
  try {
    return ((await tx('readonly', (s) => s.get('latest'))) as AutosaveInfo | undefined) ?? null;
  } catch {
    return null;
  }
}

export async function clearAutosave(): Promise<void> {
  try {
    await tx('readwrite', (s) => s.delete('latest'));
  } catch {
    /* ignore */
  }
}
