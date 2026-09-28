import type { NormalizedClip } from './retarget';

/** Compact JSON form of a NormalizedClip (int16 quaternions, base64). */
export interface EncodedClip {
  id: string;
  name: string;
  category: string;
  fps: number;
  frames: number;
  loop: boolean;
  bones: string[];
  rot: string;
  hips: string;
  source?: string;
  description?: string;
}

export interface PresetPack {
  version: 1;
  license: string;
  attribution: string;
  clips: EncodedClip[];
}

function toBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(b64: string): Uint8Array {
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(b64, 'base64'));
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function encodeClip(clip: NormalizedClip, info: { id: string; category: string; source?: string; description?: string }): EncodedClip {
  const q = new Int16Array(clip.rotations.length);
  for (let i = 0; i < q.length; i++) q[i] = Math.round(Math.max(-1, Math.min(1, clip.rotations[i])) * 32767);
  const h = new Int16Array(clip.hips.length);
  for (let i = 0; i < h.length; i++) h[i] = Math.round(Math.max(-8, Math.min(8, clip.hips[i])) * 4096);
  return {
    id: info.id,
    name: clip.name,
    category: info.category,
    fps: clip.fps,
    frames: clip.frames,
    loop: clip.loop,
    bones: clip.bones,
    rot: toBase64(new Uint8Array(q.buffer)),
    hips: toBase64(new Uint8Array(h.buffer)),
    source: info.source,
    description: info.description,
  };
}

export function decodeClip(e: EncodedClip): NormalizedClip {
  const qb = fromBase64(e.rot);
  const q = new Int16Array(qb.buffer, qb.byteOffset, qb.byteLength / 2);
  const rotations = new Float32Array(q.length);
  for (let i = 0; i < q.length; i += 4) {
    const x = q[i] / 32767, y = q[i + 1] / 32767, z = q[i + 2] / 32767, w = q[i + 3] / 32767;
    const l = Math.hypot(x, y, z, w) || 1;
    rotations[i] = x / l; rotations[i + 1] = y / l; rotations[i + 2] = z / l; rotations[i + 3] = w / l;
  }
  const hb = fromBase64(e.hips);
  const h = new Int16Array(hb.buffer, hb.byteOffset, hb.byteLength / 2);
  const hips = new Float32Array(h.length);
  for (let i = 0; i < h.length; i++) hips[i] = h[i] / 4096;
  return {
    name: e.name,
    fps: e.fps,
    frames: e.frames,
    bones: e.bones,
    rotations,
    hips,
    loop: e.loop,
    meta: { id: e.id, category: e.category, source: e.source, description: e.description },
  };
}
