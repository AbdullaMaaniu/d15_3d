import { PropertyBinding, type Vector3, type AnimationClip, type Bone, type KeyframeTrack, type Object3D, type SkinnedMesh } from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { Document, WebIO, type Texture } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTMeshoptCompression, EXTTextureWebP } from '@gltf-transform/extensions';
import { dedup, inspect, prune, quantize, reorder, resample } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';

export type ExportPreset = 'web' | 'mobile' | 'lossless';

export interface ExportOptions {
  preset?: ExportPreset;
  /** Longest texture edge in pixels (defaults: web 2048, mobile 1024, lossless: unchanged). */
  maxTextureSize?: number;
  /** Re-encode textures as WebP (default: web/mobile true). Requires OffscreenCanvas (browser). */
  webp?: boolean;
  /** Meshopt geometry + animation compression (default: web/mobile true). */
  meshopt?: boolean;
  /** Keyframe reduction (default true). */
  resample?: boolean;
  onProgress?: (stage: string) => void;
  /**
   * Extra meshes skinned to the character's own skeleton, written beside its
   * mesh: separated garments, for instance. Each is placed next to the character
   * mesh only while serializing.
   */
  layers?: SkinnedMesh[];
  /** Second skeletons that copy the character's pose bone for bone, such as the generated body. */
  followers?: Follower[];
}

/**
 * A skeleton with its own proportions that copies the character's pose: each
 * bone takes its source's rotation and scale, and its source's move away from
 * rest times `stride`. Exported as its own bones (prefixed with the root's
 * name) with tracks in every clip, so any glTF player animates it; the bones
 * carry `extras.rigforge.follows` so @rigforge/three keeps it in step with IK,
 * look-at and root motion too.
 */
export interface Follower {
  /** Holds the follower's bones and meshes, in rig space, at rest. */
  root: Object3D;
  links: Array<{ bone: Bone; source: Bone }>;
  stride: number;
}

export interface SizeBreakdown {
  total: number;
  geometry: number;
  textures: number;
  animation: number;
}

export interface ExportResult {
  glb: Uint8Array;
  before: SizeBreakdown;
  after: SizeBreakdown;
  warnings: string[];
}

const PRESETS: Record<ExportPreset, Required<Pick<ExportOptions, 'webp' | 'meshopt' | 'resample'>> & { maxTextureSize: number }> = {
  web: { webp: true, meshopt: true, resample: true, maxTextureSize: 2048 },
  mobile: { webp: true, meshopt: true, resample: true, maxTextureSize: 1024 },
  lossless: { webp: false, meshopt: false, resample: false, maxTextureSize: Infinity },
};

/** Serializes a three.js object and its clips to an unoptimized GLB. */
export async function toGLB(root: Object3D, clips: AnimationClip[]): Promise<Uint8Array> {
  const exporter = new GLTFExporter();
  const result = await exporter.parseAsync(root, { binary: true, animations: clips, onlyVisible: false });
  return new Uint8Array(result as ArrayBuffer);
}

const followerName = (f: Follower, name: string) => `${f.root.name}_${name}`;

/** Names the follower's bones apart from the character's and tags them for the runtime; returns an undo. */
function prepareFollower(f: Follower): () => void {
  const saved = f.links.map(({ bone }) => ({ bone, name: bone.name, userData: bone.userData }));
  const rootData = f.root.userData;
  for (const { bone, source } of f.links) {
    bone.name = followerName(f, source.name);
    bone.userData = { ...bone.userData, rigforge: { follows: source.name } };
  }
  f.root.userData = { ...rootData, rigforge: { ...(rootData.rigforge ?? {}), follower: { stride: f.stride } } };
  return () => {
    for (const s of saved) {
      s.bone.name = s.name;
      s.bone.userData = s.userData;
    }
    f.root.userData = rootData;
  };
}

/** The clip plus a copy of each followed bone's tracks for its follower (positions scaled to its size). */
function withFollowerTracks(clip: AnimationClip, followers: Follower[]): AnimationClip {
  if (!followers.length) return clip;
  const extra: KeyframeTrack[] = [];
  for (const track of clip.tracks) {
    const { nodeName, propertyName } = PropertyBinding.parseTrackName(track.name);
    for (const f of followers) {
      const link = f.links.find((l) => l.source.name === nodeName);
      if (!link) continue;
      const copy = track.clone();
      copy.name = `${followerName(f, nodeName)}.${propertyName}`;
      if (propertyName === 'position') {
        const rest = link.bone.position, src = (link.source.userData.restPosition as Vector3 | undefined) ?? link.source.position;
        const v = copy.values;
        for (let i = 0; i < v.length; i += 3) {
          v[i] = (v[i] - src.x) * f.stride + rest.x;
          v[i + 1] = (v[i + 1] - src.y) * f.stride + rest.y;
          v[i + 2] = (v[i + 2] - src.z) * f.stride + rest.z;
        }
      }
      extra.push(copy);
    }
  }
  const out = clip.clone();
  out.tracks.push(...extra);
  out.userData = clip.userData;
  return out;
}

/** Runs `fn` with each layer parented beside the root's skinned mesh, sharing its bind space. */
async function withLayers<T>(root: Object3D, layers: Object3D[], fn: () => Promise<T>): Promise<T> {
  if (!layers.length) return fn();
  let host: SkinnedMesh | null = null;
  root.traverse((o) => {
    if (!host && (o as SkinnedMesh).isSkinnedMesh && !layers.includes(o as SkinnedMesh)) host = o as SkinnedMesh;
  });
  const parent = (host as SkinnedMesh | null)?.parent ?? root;
  const saved = layers.map((l) => ({ layer: l, parent: l.parent, bind: (l as SkinnedMesh).bindMatrix?.clone() }));
  const skinned = (l: Object3D): l is SkinnedMesh => !!(l as SkinnedMesh).isSkinnedMesh;
  for (const l of layers) {
    if (host && skinned(l)) l.bind(l.skeleton, (host as SkinnedMesh).bindMatrix);
    parent.add(l);
  }
  root.updateMatrixWorld(true);
  try {
    return await fn();
  } finally {
    for (const { layer, parent: was, bind } of saved) {
      if (was) was.add(layer);
      else layer.removeFromParent();
      if (bind) (layer as SkinnedMesh).bind((layer as SkinnedMesh).skeleton, bind);
    }
  }
}

export async function createIO(): Promise<WebIO> {
  await MeshoptEncoder.ready;
  await MeshoptDecoder.ready;
  return new WebIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ 'meshopt.encoder': MeshoptEncoder, 'meshopt.decoder': MeshoptDecoder });
}

export function sizeBreakdown(doc: Document, total: number): SizeBreakdown {
  const report = inspect(doc);
  const sum = (items: Array<{ size?: number }>) => items.reduce((a, b) => a + (b.size ?? 0), 0);
  return {
    total,
    geometry: sum(report.meshes.properties as any),
    textures: sum(report.textures.properties as any),
    animation: sum(report.animations.properties as any),
  };
}

/**
 * Exports a rigged character with its animation clips as an optimized GLB:
 * dedup/prune, keyframe reduction, optional texture downscale + WebP and
 * meshopt compression (decoded by three.js via MeshoptDecoder).
 */
export async function exportCharacter(root: Object3D, clips: AnimationClip[], options: ExportOptions = {}): Promise<ExportResult> {
  const preset = PRESETS[options.preset ?? 'web'];
  const webp = options.webp ?? preset.webp;
  const meshopt = options.meshopt ?? preset.meshopt;
  const doResample = options.resample ?? preset.resample;
  const maxTex = options.maxTextureSize ?? preset.maxTextureSize;
  const progress = options.onProgress ?? (() => {});
  const warnings: string[] = [];

  progress('Serializing glTF');
  const followers = options.followers ?? [];
  const restore = followers.map(prepareFollower);
  const allClips = clips.map((c) => withFollowerTracks(c, followers));
  let raw: Uint8Array;
  try {
    raw = await withLayers(root, [...(options.layers ?? []), ...followers.map((f) => f.root)], () => toGLB(root, allClips));
  } finally {
    for (const r of restore) r();
  }
  const io = await createIO();
  const doc = await io.readBinary(raw);
  const before = sizeBreakdown(doc, raw.byteLength);

  // Carry clip settings (loop, in-place) as glTF extras so runtimes can pick them up.
  const settings = new Map(clips.map((c) => [c.name, c.userData?.rigforge]));
  for (const anim of doc.getRoot().listAnimations()) {
    const s = settings.get(anim.getName());
    if (s) anim.setExtras({ ...anim.getExtras(), rigforge: s });
  }
  doc.getRoot().getAsset().generator = 'RigForge';

  warnings.push(...(await optimizeDocument(doc, { webp, meshopt, resample: doResample, maxTextureSize: maxTex, onProgress: progress })));

  progress('Writing GLB');
  const glb = await io.writeBinary(doc);
  const after = sizeBreakdown(doc, glb.byteLength);
  return { glb, before, after, warnings };
}

/**
 * Optimizes a glTF document in place (dedup/prune, keyframe reduction, texture
 * downscale/WebP where a canvas is available, meshopt). Returns warnings.
 */
export async function optimizeDocument(
  doc: Document,
  options: { webp?: boolean; meshopt?: boolean; resample?: boolean; maxTextureSize?: number; onProgress?: (stage: string) => void } = {},
): Promise<string[]> {
  const warnings: string[] = [];
  const progress = options.onProgress ?? (() => {});
  const maxTex = options.maxTextureSize ?? Infinity;
  progress('Optimizing');
  await doc.transform(dedup(), prune({ keepAttributes: true }));
  if (options.resample !== false) await doc.transform(resample({ tolerance: 1e-4 }));
  if (options.webp || Number.isFinite(maxTex)) {
    progress('Compressing textures');
    const ok = await compressTextures(doc, { webp: !!options.webp, maxSize: maxTex });
    if (!ok) warnings.push('Texture compression needs OffscreenCanvas (a browser); textures were left unchanged.');
  }
  if (options.meshopt) {
    progress('Compressing geometry and animation');
    await MeshoptEncoder.ready;
    await doc.transform(reorder({ encoder: MeshoptEncoder }), quantize());
    doc.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({
      method: EXTMeshoptCompression.EncoderMethod.FILTER,
    });
  }
  return warnings;
}

export const EXPORT_PRESETS = PRESETS;

async function compressTextures(doc: Document, opts: { webp: boolean; maxSize: number }): Promise<boolean> {
  const textures = doc.getRoot().listTextures();
  if (!textures.length) return true;
  if (typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap === 'undefined') return false;
  let converted = false;
  for (const tex of textures) {
    const out = await reencode(tex, opts);
    if (out) {
      tex.setImage(out.bytes).setMimeType(out.mime);
      if (out.mime === 'image/webp') {
        tex.setURI(tex.getURI().replace(/\.(png|jpe?g)$/i, '.webp'));
        converted = true;
      }
    }
  }
  if (converted) doc.createExtension(EXTTextureWebP).setRequired(true);
  return true;
}

async function reencode(tex: Texture, opts: { webp: boolean; maxSize: number }): Promise<{ bytes: Uint8Array; mime: string } | null> {
  const image = tex.getImage();
  const mime = tex.getMimeType();
  if (!image || !/image\/(png|jpeg|webp)/.test(mime)) return null;
  const bitmap = await createImageBitmap(new Blob([image as BlobPart], { type: mime }));
  const scale = Math.min(1, opts.maxSize / Math.max(bitmap.width, bitmap.height));
  if (scale === 1 && !opts.webp) return null;
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  const type = opts.webp ? 'image/webp' : mime;
  const blob = await canvas.convertToBlob({ type, quality: 0.9 });
  // Some browsers silently fall back to PNG when WebP encoding is unsupported.
  return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: blob.type || type };
}
