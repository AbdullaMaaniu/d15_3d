import { Material, Mesh, ObjectLoader, Quaternion, type BufferGeometry } from 'three';
import {
  applyNormalization,
  analyzeMesh,
  autoMapBones,
  bindSkeleton,
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
  splitParts,
} from '@rigforge/core';
import type { ClipEntry, useStore } from '../store';

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
  rigType?: 'humanoid' | 'prop';
  propRig?: PropRig | null;
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
    propBuilt: s.rigType === 'prop' && !!built,
    rig: built && s.rigType !== 'prop'
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
  const normalizedGeometry = applyNormalization(geometry, computeNormalization(geometry, { rotation, targetHeight: file.height }));
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
      Object.assign(patch, { character: { root: built.root, built }, binding: null, unlocked: 4, step: ['animate', 'export'].includes(file.step) ? file.step : 'rig' });
      // Clips bake once the character is in the store (see openProject).
      (patch as any).pendingPropClips = file.clips;
    }
    return patch;
  }
  Object.assign(patch, { rigType: 'humanoid' });

  if (file.rig && file.joints) {
    const si = b64.decode(file.rig.skinIndex);
    const sw = b64.decode(file.rig.skinWeight);
    const skinIndex = new Uint16Array(si.buffer, si.byteOffset, si.byteLength / 2);
    const skinWeight = new Float32Array(sw.buffer, sw.byteOffset, sw.byteLength / 4);
    const built = buildSkinnedCharacter(normalizedGeometry, materials, humanoidDefs(file.fingers), file.joints, skinIndex, skinWeight, 'Character');
    const binding = bindSkeleton(built.root, autoMapBones(built.root).map);
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
      unlocked: 4,
      step: ['animate', 'export'].includes(file.step) ? file.step : 'rig',
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
