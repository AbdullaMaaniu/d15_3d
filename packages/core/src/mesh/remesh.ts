import { BufferAttribute, BufferGeometry } from 'three';
import { MeshoptSimplifier } from 'meshoptimizer';
import type { QuadRemeshOutput } from '../kernels';

export type Topology = 'triangles' | 'quads';

/** Face counts offered by the editor (same steps as Meshy's remesh). */
export const REMESH_TARGETS = [3000, 10000, 30000, 60000, 100000, 150000] as const;

/** A flat description of a (possibly multi-material) triangle mesh, worker-friendly. */
export interface MeshArrays {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  colors: Float32Array | null;
  index: Uint32Array;
  groups: Array<{ start: number; count: number; materialIndex: number }>;
  /** Polygon sizes (3 or 4) in triangle order, for quad-dominant meshes. */
  faceSizes?: Uint8Array;
}

export function geometryToArrays(g: BufferGeometry): MeshArrays {
  const n = g.attributes.position.count;
  const index = g.index ? new Uint32Array(g.index.array) : Uint32Array.from({ length: n }, (_, i) => i);
  const copy = (name: string, size: number, fill = 0) => {
    const a = g.attributes[name];
    if (!a) return new Float32Array(n * size).fill(fill);
    const out = new Float32Array(n * size);
    for (let i = 0; i < n; i++) for (let k = 0; k < size; k++) out[i * size + k] = a.getComponent(i, k);
    return out;
  };
  return {
    positions: copy('position', 3),
    normals: copy('normal', 3),
    uvs: copy('uv', 2),
    colors: g.attributes.color ? copy('color', 3, 1) : null,
    index,
    groups: g.groups.length ? g.groups.map((x) => ({ start: x.start, count: x.count, materialIndex: x.materialIndex ?? 0 })) : [{ start: 0, count: index.length, materialIndex: 0 }],
  };
}

export function arraysToGeometry(m: MeshArrays): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(m.positions, 3));
  g.setAttribute('normal', new BufferAttribute(m.normals, 3));
  g.setAttribute('uv', new BufferAttribute(m.uvs, 2));
  if (m.colors) g.setAttribute('color', new BufferAttribute(m.colors, 3));
  g.setIndex(new BufferAttribute(m.index, 1));
  for (const grp of m.groups) g.addGroup(grp.start, grp.count, grp.materialIndex);
  if (m.faceSizes) g.userData.faceSizes = encodeFaceSizes(m.faceSizes);
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

/** Face sizes are kept in geometry.userData as a string of '3'/'4' (survives toJSON). */
export function encodeFaceSizes(sizes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < sizes.length; i += 8192) s += String.fromCharCode(...Array.from(sizes.subarray(i, i + 8192), (x) => 48 + x));
  return s;
}

export function decodeFaceSizes(g: BufferGeometry): Uint8Array | null {
  const s = g.userData?.faceSizes;
  if (typeof s !== 'string') return null;
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) - 48;
  return out;
}

export function triangleCount(m: MeshArrays): number {
  return m.index.length / 3;
}

/** Splits every triangle into four at its edge midpoints (shape and UVs unchanged). */
function subdivideMidpoints(m: MeshArrays): MeshArrays {
  const nv = m.positions.length / 3;
  const mids = new Map<number, number>();
  const pos = Array.from(m.positions), nrm = Array.from(m.normals), uv = Array.from(m.uvs);
  const col = m.colors ? Array.from(m.colors) : null;
  const mid = (a: number, b: number) => {
    const key = a < b ? a * nv + b : b * nv + a;
    let v = mids.get(key);
    if (v === undefined) {
      v = pos.length / 3;
      for (let k = 0; k < 3; k++) pos.push((pos[a * 3 + k] + pos[b * 3 + k]) / 2);
      const n = [0, 1, 2].map((k) => nrm[a * 3 + k] + nrm[b * 3 + k]);
      const l = Math.hypot(n[0], n[1], n[2]) || 1;
      nrm.push(n[0] / l, n[1] / l, n[2] / l);
      for (let k = 0; k < 2; k++) uv.push((uv[a * 2 + k] + uv[b * 2 + k]) / 2);
      if (col) for (let k = 0; k < 3; k++) col.push((col[a * 3 + k] + col[b * 3 + k]) / 2);
      mids.set(key, v);
    }
    return v;
  };
  const index: number[] = [];
  const groups = m.groups.map((g) => {
    const start = index.length;
    for (let i = g.start; i < g.start + g.count; i += 3) {
      const [a, b, c] = [m.index[i], m.index[i + 1], m.index[i + 2]];
      const [ab, bc, ca] = [mid(a, b), mid(b, c), mid(c, a)];
      index.push(a, ab, ca, ab, b, bc, ca, bc, c, ab, bc, ca);
    }
    return { start, count: index.length - start, materialIndex: g.materialIndex };
  });
  return {
    positions: new Float32Array(pos),
    normals: new Float32Array(nrm),
    uvs: new Float32Array(uv),
    colors: col ? new Float32Array(col) : null,
    index: new Uint32Array(index),
    groups,
  };
}

/**
 * Merges vertices with the same position, UV and colour (normals are averaged), so a
 * triangle soup becomes a connected mesh the simplifier can work on. UV seams stay split.
 */
function weld(m: MeshArrays): MeshArrays {
  const nv = m.positions.length / 3;
  const map = new Uint32Array(nv);
  const seen = new Map<string, number>();
  const keep: number[] = [];
  for (let i = 0; i < nv; i++) {
    let key = `${m.positions[i * 3]},${m.positions[i * 3 + 1]},${m.positions[i * 3 + 2]},${m.uvs[i * 2]},${m.uvs[i * 2 + 1]}`;
    if (m.colors) key += `,${m.colors[i * 3]},${m.colors[i * 3 + 1]},${m.colors[i * 3 + 2]}`;
    let j = seen.get(key);
    if (j === undefined) {
      j = keep.length;
      seen.set(key, j);
      keep.push(i);
    }
    map[i] = j;
  }
  if (keep.length === nv) return m;
  const n = keep.length;
  const normals = new Float32Array(n * 3);
  for (let i = 0; i < nv; i++) for (let k = 0; k < 3; k++) normals[map[i] * 3 + k] += m.normals[i * 3 + k];
  for (let j = 0; j < n; j++) {
    const l = Math.hypot(normals[j * 3], normals[j * 3 + 1], normals[j * 3 + 2]) || 1;
    for (let k = 0; k < 3; k++) normals[j * 3 + k] /= l;
  }
  const take = (src: Float32Array, size: number) => {
    const out = new Float32Array(n * size);
    keep.forEach((i, j) => out.set(src.subarray(i * size, i * size + size), j * size));
    return out;
  };
  return { ...m, positions: take(m.positions, 3), normals, uvs: take(m.uvs, 2), colors: m.colors ? take(m.colors, 3) : null, index: m.index.map((i) => map[i]) };
}

/** Drops unused vertices. */
function compact(m: MeshArrays): MeshArrays {
  const nv = m.positions.length / 3;
  const map = new Int32Array(nv).fill(-1);
  let n = 0;
  for (const i of m.index) if (map[i] < 0) map[i] = n++;
  const take = (src: Float32Array, size: number) => {
    const out = new Float32Array(n * size);
    for (let i = 0; i < nv; i++) if (map[i] >= 0) for (let k = 0; k < size; k++) out[map[i] * size + k] = src[i * size + k];
    return out;
  };
  return {
    positions: take(m.positions, 3),
    normals: take(m.normals, 3),
    uvs: take(m.uvs, 2),
    colors: m.colors ? take(m.colors, 3) : null,
    index: m.index.map((i) => map[i]),
    groups: m.groups,
  };
}

/**
 * Triangle remesh to `target` triangles, keeping the original UVs and textures:
 * seam-aware simplification (meshoptimizer, with the "regularize" option for evenly
 * sized triangles), after midpoint subdivision when the target is above the source.
 * Vertices shared between materials are locked so material borders don't crack.
 */
export async function remeshTriangles(src: MeshArrays, target: number): Promise<MeshArrays> {
  await MeshoptSimplifier.ready;
  let m = weld(src);
  while (triangleCount(m) < target * 0.98) m = subdivideMidpoints(m);
  if (triangleCount(m) <= target * 1.02) return compact(m);

  const nv = m.positions.length / 3;
  const lock = new Uint8Array(nv);
  if (m.groups.length > 1) {
    const owner = new Int32Array(nv).fill(-1);
    m.groups.forEach((g, gi) => {
      for (let i = g.start; i < g.start + g.count; i++) {
        const v = m.index[i];
        if (owner[v] === -1) owner[v] = gi;
        else if (owner[v] !== gi) lock[v] = 1;
      }
    });
  }
  // Attributes steer the simplifier to keep shading and texture layout: normals and UVs.
  const attrs = new Float32Array(nv * 5);
  for (let i = 0; i < nv; i++) {
    attrs.set(m.normals.subarray(i * 3, i * 3 + 3), i * 5);
    attrs.set(m.uvs.subarray(i * 2, i * 2 + 2), i * 5 + 3);
  }
  const total = triangleCount(m);
  const index: number[] = [];
  const groups = m.groups.map((g) => {
    const tris = m.index.subarray(g.start, g.start + g.count);
    const want = Math.max(1, Math.round((target * (g.count / 3)) / total)) * 3;
    const [out] = MeshoptSimplifier.simplifyWithAttributes(tris, m.positions, 3, attrs, 5, [0.5, 0.5, 0.5, 1, 1], lock, want, 1, ['Regularize']);
    const start = index.length;
    for (const i of out) index.push(i);
    return { start, count: out.length, materialIndex: g.materialIndex };
  });
  return compact({ ...m, index: new Uint32Array(index), groups });
}

/**
 * Turns a quad remesh into render arrays: one vertex per (vertex, UV) pair, smooth
 * normals shared across UV seams, quads as consecutive triangle pairs.
 */
export function quadOutputToArrays(q: QuadRemeshOutput): MeshArrays {
  const corners = q.corners.length;
  const renderOf = new Uint32Array(corners);
  const seen = new Map<number, number[]>(); // vertex -> [u, v, render index, ...]
  const pos: number[] = [], nrm: number[] = [], uv: number[] = [];
  for (let c = 0; c < corners; c++) {
    const v = q.corners[c];
    const u = q.uvs[c * 2], w = q.uvs[c * 2 + 1];
    let list = seen.get(v);
    if (!list) seen.set(v, (list = []));
    let found = -1;
    for (let k = 0; k < list.length; k += 3) if (list[k] === u && list[k + 1] === w) found = list[k + 2];
    if (found < 0) {
      found = pos.length / 3;
      list.push(u, w, found);
      pos.push(q.positions[v * 3], q.positions[v * 3 + 1], q.positions[v * 3 + 2]);
      nrm.push(q.normals[v * 3], q.normals[v * 3 + 1], q.normals[v * 3 + 2]);
      uv.push(u, w);
    }
    renderOf[c] = found;
  }
  const index = q.triangles.map((c) => renderOf[c]);
  return {
    positions: new Float32Array(pos),
    normals: new Float32Array(nrm),
    uvs: new Float32Array(uv),
    colors: null,
    index,
    groups: [{ start: 0, count: index.length, materialIndex: 0 }],
    faceSizes: q.sizes,
  };
}

/**
 * Wavefront OBJ of a mesh, writing quads as quads (from `faceSizes`) and sharing
 * positions across UV seams so it opens as one connected surface in a DCC tool.
 * `vDown`: the UVs follow glTF (v = 0 at the image top), so they're flipped for OBJ.
 */
export function toOBJ(m: MeshArrays, materialLib?: string, vDown = true): string {
  const nv = m.positions.length / 3;
  // Weld render vertices by position for `v` lines; `vt`/`vn` stay per render vertex.
  const key = (i: number) => `${m.positions[i * 3]},${m.positions[i * 3 + 1]},${m.positions[i * 3 + 2]}`;
  const posOf = new Uint32Array(nv);
  const unique = new Map<string, number>();
  const lines: string[] = ['# RigForge remesh'];
  if (materialLib) lines.push(`mtllib ${materialLib}`, 'usemtl material0');
  for (let i = 0; i < nv; i++) {
    const k = key(i);
    let p = unique.get(k);
    if (p === undefined) {
      p = unique.size;
      unique.set(k, p);
      lines.push(`v ${m.positions[i * 3]} ${m.positions[i * 3 + 1]} ${m.positions[i * 3 + 2]}`);
    }
    posOf[i] = p;
  }
  for (let i = 0; i < nv; i++) lines.push(`vt ${m.uvs[i * 2]} ${vDown ? 1 - m.uvs[i * 2 + 1] : m.uvs[i * 2 + 1]}`);
  for (let i = 0; i < nv; i++) lines.push(`vn ${m.normals[i * 3]} ${m.normals[i * 3 + 1]} ${m.normals[i * 3 + 2]}`);
  const corner = (i: number) => `${posOf[i] + 1}/${i + 1}/${i + 1}`;
  const sizes = m.faceSizes;
  let t = 0;
  const triCount = m.index.length / 3;
  for (let f = 0; t < triCount; f++) {
    const a = [m.index[t * 3], m.index[t * 3 + 1], m.index[t * 3 + 2]];
    if (sizes && sizes[f] === 4 && t + 1 < triCount) {
      const b = [m.index[t * 3 + 3], m.index[t * 3 + 4], m.index[t * 3 + 5]];
      const extra = b.find((x) => !a.includes(x))!;
      // Insert the second triangle's free vertex between the shared diagonal's ends.
      let quad = a;
      for (let k = 0; k < 3; k++) {
        const [p, q] = [a[k], a[(k + 1) % 3]];
        if (b.includes(p) && b.includes(q)) {
          quad = [...a.slice(0, k + 1), extra, ...a.slice(k + 1)];
          break;
        }
      }
      lines.push(`f ${quad.map(corner).join(' ')}`);
      t += 2;
    } else {
      lines.push(`f ${a.map(corner).join(' ')}`);
      t += 1;
    }
  }
  return lines.join('\n') + '\n';
}
