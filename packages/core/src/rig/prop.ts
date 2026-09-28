import {
  AnimationClip,
  Bone,
  Float32BufferAttribute,
  Group,
  Quaternion,
  QuaternionKeyframeTrack,
  Skeleton,
  SkinnedMesh,
  Uint16BufferAttribute,
  Vector3,
  VectorKeyframeTrack,
  type BufferGeometry,
  type KeyframeTrack,
  type Material,
} from 'three';
import { weldByPosition } from '../mesh/analyze';
import type { RiggedCharacter } from './build';

type V3 = [number, number, number];

export interface MeshPart {
  id: number;
  triangles: number;
  center: V3;
  min: V3;
  max: V3;
}

export interface PartSplit {
  /** Part id for every vertex. */
  vertexPart: Int32Array;
  parts: MeshPart[];
}

/** Splits a mesh into connected parts (islands of triangles sharing vertices by position). */
export function splitParts(geometry: BufferGeometry, minTriangles = 1): PartSplit {
  const pos = geometry.attributes.position.array as ArrayLike<number>;
  const n = pos.length / 3;
  const { ids, count } = weldByPosition(pos);
  const parent = new Int32Array(count).map((_, i) => i);
  const find = (a: number): number => {
    while (parent[a] !== a) a = parent[a] = parent[parent[a]];
    return a;
  };
  const index = geometry.index ? (geometry.index.array as ArrayLike<number>) : Array.from({ length: n }, (_, i) => i);
  const union = (a: number, b: number) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };
  for (let t = 0; t + 2 < index.length; t += 3) {
    union(ids[index[t]], ids[index[t + 1]]);
    union(ids[index[t + 1]], ids[index[t + 2]]);
  }
  const rootToPart = new Map<number, number>();
  const tris = new Map<number, number>();
  for (let t = 0; t + 2 < index.length; t += 3) {
    const r = find(ids[index[t]]);
    tris.set(r, (tris.get(r) ?? 0) + 1);
  }
  // Order parts by size (largest first) for stable, readable ids.
  const roots = [...tris.entries()].sort((a, b) => b[1] - a[1]);
  roots.forEach(([r], i) => rootToPart.set(r, i));
  const vertexPart = new Int32Array(n);
  const parts: MeshPart[] = roots.map(([, t], id) => ({ id, triangles: t, center: [0, 0, 0], min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] }));
  for (let v = 0; v < n; v++) {
    const p = rootToPart.get(find(ids[v])) ?? 0;
    vertexPart[v] = p;
    const part = parts[p];
    for (let k = 0; k < 3; k++) {
      part.min[k] = Math.min(part.min[k], pos[v * 3 + k]);
      part.max[k] = Math.max(part.max[k], pos[v * 3 + k]);
    }
  }
  for (const part of parts) part.center = [0, 1, 2].map((k) => (part.min[k] + part.max[k]) / 2) as V3;
  // Fold tiny fragments into the largest part.
  if (minTriangles > 1) for (let v = 0; v < n; v++) if (parts[vertexPart[v]].triangles < minTriangles) vertexPart[v] = 0;
  return { vertexPart, parts };
}

export interface PropBone {
  name: string;
  parent: string | null;
  /** Pivot (joint) position in rig space. */
  pivot: V3;
}

export interface PropRig {
  bones: PropBone[];
  /** Bone name for each part id (unassigned parts follow the root bone). */
  partBone: Record<number, string>;
}

/** Builds a rigidly skinned prop: every part moves with exactly one bone. */
export function buildPropCharacter(geometry: BufferGeometry, materials: Material | Material[], split: PartSplit, rig: PropRig, name = 'Prop'): RiggedCharacter {
  const bones: Record<string, Bone> = {};
  const list: Bone[] = [];
  const ordered = orderBones(rig.bones);
  for (const def of ordered) {
    const bone = new Bone();
    bone.name = def.name;
    const pp = def.parent ? rig.bones.find((b) => b.name === def.parent)!.pivot : [0, 0, 0];
    bone.position.set(def.pivot[0] - pp[0], def.pivot[1] - pp[1], def.pivot[2] - pp[2]);
    bone.userData.restQuaternion = bone.quaternion.clone();
    bone.userData.restPosition = bone.position.clone();
    bones[def.name] = bone;
    list.push(bone);
    if (def.parent) bones[def.parent].add(bone);
  }
  const boneIndex = new Map(list.map((b, i) => [b.name, i]));
  const n = geometry.attributes.position.count;
  const si = new Uint16Array(n * 4), sw = new Float32Array(n * 4);
  for (let v = 0; v < n; v++) {
    si[v * 4] = boneIndex.get(rig.partBone[split.vertexPart[v]] ?? list[0].name) ?? 0;
    sw[v * 4] = 1;
  }
  const geo = geometry.clone();
  geo.setAttribute('skinIndex', new Uint16BufferAttribute(si, 4));
  geo.setAttribute('skinWeight', new Float32BufferAttribute(sw, 4));
  const mesh = new SkinnedMesh(geo, materials);
  mesh.name = `${name}Mesh`;
  mesh.frustumCulled = false;
  const root = new Group();
  root.name = name;
  root.add(mesh);
  for (const b of list) if (!b.parent) root.add(b);
  root.updateMatrixWorld(true);
  const skeleton = new Skeleton(list);
  mesh.bind(skeleton);
  root.userData.rigforge = { version: 1, kind: 'prop' };
  return { root, mesh, skeleton, bones, defs: ordered.map((b) => ({ name: b.name, parent: b.parent, primaryChild: null, side: null, isFinger: false })) };
}

/** Parents before children. */
function orderBones(bones: PropBone[]): PropBone[] {
  const out: PropBone[] = [];
  const done = new Set<string>();
  const visit = (b: PropBone, depth = 0) => {
    if (done.has(b.name) || depth > bones.length) return;
    if (b.parent) {
      const p = bones.find((x) => x.name === b.parent);
      if (p) visit(p, depth + 1);
    }
    done.add(b.name);
    out.push(b);
  };
  bones.forEach((b) => visit(b));
  return out;
}

// --- Prop animation ------------------------------------------------------------------

/** Keys on prop bones: rotation / translation offsets from each bone's rest transform. */
export interface PropKeys {
  duration: number;
  interpolation?: 'linear' | 'smooth';
  bones: Record<string, { times: number[]; rot?: number[]; pos?: number[] }>;
}

export type PropMotion =
  | { type: 'spin'; bone: string; axis: V3; turns: number; duration: number }
  | { type: 'swing'; bone: string; axis: V3; degrees: number; duration: number; pingPong: boolean }
  | { type: 'slide'; bone: string; offset: V3; duration: number; pingPong: boolean }
  | { type: 'bob'; bone: string; height: number; duration: number }
  /** A travelling wave down a chain (tails, tentacles, snakes). */
  | { type: 'wave'; bone: string; chain: string[]; axis: V3; degrees: number; duration: number; waves?: number };

/** Generates keys for common mechanical motions. */
export function propMotionKeys(m: PropMotion): PropKeys {
  if (m.type === 'wave') {
    const steps = 16;
    const keys: PropKeys = { duration: m.duration, bones: {} };
    const axis = new Vector3(...m.axis).normalize();
    const waves = m.waves ?? 1;
    m.chain.forEach((bone, k) => {
      const times: number[] = [], rot: number[] = [];
      // Amplitude grows toward the tip; each link lags the previous one.
      const amp = ((m.degrees * Math.PI) / 180) * (0.5 + (0.5 * (k + 1)) / m.chain.length);
      const lag = (k / Math.max(1, m.chain.length)) * waves * Math.PI * 2;
      for (let i = 0; i <= steps; i++) {
        const f = i / steps;
        times.push(f * m.duration);
        rot.push(...new Quaternion().setFromAxisAngle(axis, Math.sin(f * Math.PI * 2 - lag) * amp).toArray());
      }
      keys.bones[bone] = { times, rot };
    });
    return keys;
  }
  const steps = m.type === 'spin' ? Math.max(4, Math.ceil(Math.abs(m.turns) * 4)) : 16;
  const times: number[] = [];
  const rot: number[] = [];
  const pos: number[] = [];
  const q = new Quaternion();
  for (let i = 0; i <= steps; i++) {
    const f = i / steps;
    const t = f * m.duration;
    times.push(t);
    if (m.type === 'spin') {
      q.setFromAxisAngle(new Vector3(...m.axis).normalize(), f * m.turns * Math.PI * 2);
      rot.push(...q.toArray());
    } else if (m.type === 'swing') {
      const k = m.pingPong ? 0.5 - 0.5 * Math.cos(f * Math.PI * 2) : 0.5 - 0.5 * Math.cos(f * Math.PI);
      q.setFromAxisAngle(new Vector3(...m.axis).normalize(), (k * m.degrees * Math.PI) / 180);
      rot.push(...q.toArray());
    } else if (m.type === 'slide') {
      const k = m.pingPong ? 0.5 - 0.5 * Math.cos(f * Math.PI * 2) : 0.5 - 0.5 * Math.cos(f * Math.PI);
      pos.push(m.offset[0] * k, m.offset[1] * k, m.offset[2] * k);
    } else {
      pos.push(0, m.height * (0.5 - 0.5 * Math.cos(f * Math.PI * 2)), 0);
    }
  }
  return {
    duration: m.duration,
    bones: { [m.bone]: { times, rot: rot.length ? rot : undefined, pos: pos.length ? pos : undefined } },
  };
}

/** Bakes prop keys to an AnimationClip against the prop's rest pose. */
export function bakePropClip(character: Pick<RiggedCharacter, 'bones'>, keys: PropKeys, name: string, fps = 30): AnimationClip {
  const tracks: KeyframeTrack[] = [];
  const frames = Math.max(2, Math.round(keys.duration * fps) + 1);
  const times = Float32Array.from({ length: frames }, (_, i) => (i / (frames - 1)) * keys.duration);
  const smooth = keys.interpolation === 'smooth';
  for (const [boneName, ch] of Object.entries(keys.bones)) {
    const bone = character.bones[boneName];
    if (!bone || !ch.times.length) continue;
    const restQ = (bone.userData.restQuaternion as Quaternion | undefined) ?? bone.quaternion.clone();
    const restP = (bone.userData.restPosition as Vector3 | undefined) ?? bone.position.clone();
    if (ch.rot) {
      const values = new Float32Array(frames * 4);
      const qa = new Quaternion(), qb = new Quaternion();
      times.forEach((t, i) => {
        const [a, b, f] = seg(ch.times, t, smooth);
        qa.fromArray(ch.rot!, a * 4);
        qb.fromArray(ch.rot!, b * 4);
        restQ.clone().multiply(qa.slerp(qb, f)).toArray(values, i * 4);
      });
      tracks.push(new QuaternionKeyframeTrack(`${bone.name}.quaternion`, times, values));
    }
    if (ch.pos) {
      const values = new Float32Array(frames * 3);
      const va = new Vector3(), vb = new Vector3();
      times.forEach((t, i) => {
        const [a, b, f] = seg(ch.times, t, smooth);
        va.fromArray(ch.pos!, a * 3).lerp(vb.fromArray(ch.pos!, b * 3), f).add(restP).toArray(values, i * 3);
      });
      tracks.push(new VectorKeyframeTrack(`${bone.name}.position`, times, values));
    }
  }
  return new AnimationClip(name, keys.duration, tracks);
}

function seg(times: number[], t: number, smooth: boolean): [number, number, number] {
  if (t <= times[0]) return [0, 0, 0];
  const last = times.length - 1;
  if (t >= times[last]) return [last, last, 0];
  let i = 0;
  while (times[i + 1] < t) i++;
  let f = (t - times[i]) / (times[i + 1] - times[i]);
  if (smooth) f = f * f * (3 - 2 * f);
  return [i, i + 1, f];
}

/** Sets (or replaces) a key for one prop bone from its current local transform. */
export function setPropKey(keys: PropKeys, bone: { name: string; quaternion: Quaternion; position: Vector3; userData: Record<string, unknown> }, time: number): PropKeys {
  const restQ = (bone.userData.restQuaternion as Quaternion | undefined) ?? bone.quaternion.clone();
  const restP = (bone.userData.restPosition as Vector3 | undefined) ?? bone.position.clone();
  const rot = restQ.clone().invert().multiply(bone.quaternion).toArray();
  const pos = bone.position.clone().sub(restP).toArray();
  const next: PropKeys = { ...keys, bones: { ...keys.bones } };
  const ch = next.bones[bone.name] ? { times: [...next.bones[bone.name].times], rot: [...(next.bones[bone.name].rot ?? [])], pos: [...(next.bones[bone.name].pos ?? [])] } : { times: [], rot: [], pos: [] };
  // Older channels may lack rot/pos arrays: fill with identity.
  while (ch.rot.length < ch.times.length * 4) ch.rot.push(0, 0, 0, 1);
  while (ch.pos.length < ch.times.length * 3) ch.pos.push(0, 0, 0);
  let i = ch.times.findIndex((x) => Math.abs(x - time) < 1 / 120);
  if (i < 0) {
    i = ch.times.findIndex((x) => x > time);
    if (i < 0) i = ch.times.length;
    ch.times.splice(i, 0, time);
    ch.rot.splice(i * 4, 0, ...rot);
    ch.pos.splice(i * 3, 0, ...pos);
  } else {
    ch.rot.splice(i * 4, 4, ...rot);
    ch.pos.splice(i * 3, 3, ...pos);
  }
  next.bones[bone.name] = ch;
  return next;
}

export function deletePropKeys(keys: PropKeys, time: number, bone?: string): PropKeys {
  const next: PropKeys = { ...keys, bones: {} };
  for (const [name, ch] of Object.entries(keys.bones)) {
    const i = bone && bone !== name ? -1 : ch.times.findIndex((x) => Math.abs(x - time) < 1 / 120);
    if (i < 0) {
      next.bones[name] = ch;
      continue;
    }
    const c = { times: [...ch.times], rot: ch.rot ? [...ch.rot] : undefined, pos: ch.pos ? [...ch.pos] : undefined };
    c.times.splice(i, 1);
    c.rot?.splice(i * 4, 4);
    c.pos?.splice(i * 3, 3);
    if (c.times.length) next.bones[name] = c;
  }
  return next;
}

export function propKeyTimes(keys: PropKeys | undefined, bone?: string): number[] {
  if (!keys) return [];
  const set = new Set<number>();
  for (const [name, ch] of Object.entries(keys.bones)) if (!bone || bone === name) ch.times.forEach((t) => set.add(Math.round(t * 1000) / 1000));
  return [...set].sort((a, b) => a - b);
}
