import { BufferAttribute, type BufferGeometry, type Material, type Texture } from 'three';

export interface TextureInfo {
  name: string;
  slot: string;
  width: number;
  height: number;
}

export interface MeshReport {
  triangles: number;
  vertices: number;
  materials: number;
  textures: TextureInfo[];
  bounds: { min: [number, number, number]; max: [number, number, number]; size: [number, number, number] };
  /** Vertices sharing a position with another vertex (UV/normal seams are expected). */
  duplicateVertices: number;
  degenerateTriangles: number;
  boundaryEdges: number;
  nonManifoldEdges: number;
  islands: number;
  issues: string[];
}

/**
 * Welds vertices by position (ignoring normals/UVs) and returns, per vertex, the id
 * of its welded representative. Used for topology analysis and weight smoothing.
 */
export function weldByPosition(positions: ArrayLike<number>, tolerance?: number): { ids: Uint32Array; count: number } {
  const n = positions.length / 3;
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  const diag = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) || 1;
  const tol = tolerance ?? diag * 1e-6;
  const inv = 1 / tol;
  const map = new Map<string, number>();
  const ids = new Uint32Array(n);
  let count = 0;
  for (let i = 0; i < n; i++) {
    const key = `${Math.round(positions[i * 3] * inv)},${Math.round(positions[i * 3 + 1] * inv)},${Math.round(positions[i * 3 + 2] * inv)}`;
    let id = map.get(key);
    if (id === undefined) {
      id = count++;
      map.set(key, id);
    }
    ids[i] = id;
  }
  return { ids, count };
}

function triangleIndices(geometry: BufferGeometry): Uint32Array {
  const idx = geometry.index;
  if (idx) return idx.array instanceof Uint32Array ? idx.array : Uint32Array.from(idx.array as ArrayLike<number>);
  const n = geometry.attributes.position.count;
  const out = new Uint32Array(n);
  for (let i = 0; i < n; i++) out[i] = i;
  return out;
}

export function analyzeMesh(geometry: BufferGeometry, materials: Material[] = []): MeshReport {
  const pos = geometry.attributes.position.array as ArrayLike<number>;
  const vertCount = geometry.attributes.position.count;
  const tris = triangleIndices(geometry);
  const triCount = Math.floor(tris.length / 3);
  const { ids, count: weldedCount } = weldByPosition(pos);

  geometry.computeBoundingBox();
  const bb = geometry.boundingBox!;

  // Degenerate triangles (zero area or repeated welded vertex).
  let degenerate = 0;
  const edgeCounts = new Map<number, number>();
  const parent = new Int32Array(weldedCount);
  for (let i = 0; i < weldedCount; i++) parent[i] = i;
  const find = (a: number): number => {
    while (parent[a] !== a) {
      parent[a] = parent[parent[a]];
      a = parent[a];
    }
    return a;
  };
  const union = (a: number, b: number) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };

  for (let t = 0; t < triCount; t++) {
    const ia = tris[t * 3], ib = tris[t * 3 + 1], ic = tris[t * 3 + 2];
    const a = ids[ia], b = ids[ib], c = ids[ic];
    if (a === b || b === c || a === c) {
      degenerate++;
      continue;
    }
    const ux = pos[ib * 3] - pos[ia * 3], uy = pos[ib * 3 + 1] - pos[ia * 3 + 1], uz = pos[ib * 3 + 2] - pos[ia * 3 + 2];
    const vx = pos[ic * 3] - pos[ia * 3], vy = pos[ic * 3 + 1] - pos[ia * 3 + 1], vz = pos[ic * 3 + 2] - pos[ia * 3 + 2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    if (cx * cx + cy * cy + cz * cz < 1e-24) degenerate++;
    for (const [p, q] of [[a, b], [b, c], [c, a]] as const) {
      const key = p < q ? p * weldedCount + q : q * weldedCount + p;
      edgeCounts.set(key, (edgeCounts.get(key) ?? 0) + 1);
    }
    union(a, b);
    union(b, c);
  }

  let boundary = 0, nonManifold = 0;
  for (const c of edgeCounts.values()) {
    if (c === 1) boundary++;
    else if (c > 2) nonManifold++;
  }
  const roots = new Set<number>();
  const used = new Uint8Array(weldedCount);
  for (let i = 0; i < tris.length; i++) used[ids[tris[i]]] = 1;
  for (let i = 0; i < weldedCount; i++) if (used[i]) roots.add(find(i));

  const textures: TextureInfo[] = [];
  const seen = new Set<Texture>();
  for (const mat of materials) {
    for (const [slot, value] of Object.entries(mat)) {
      const tex = value as Texture | null;
      if (tex && (tex as Texture).isTexture && !seen.has(tex)) {
        seen.add(tex);
        const img = tex.image as { width?: number; height?: number } | undefined;
        textures.push({ name: tex.name || slot, slot, width: img?.width ?? 0, height: img?.height ?? 0 });
      }
    }
  }

  const size: [number, number, number] = [bb.max.x - bb.min.x, bb.max.y - bb.min.y, bb.max.z - bb.min.z];
  const issues: string[] = [];
  if (triCount > 300_000) issues.push(`High triangle count (${triCount.toLocaleString()}). Consider decimating for web use.`);
  if (degenerate > 0) issues.push(`${degenerate} degenerate triangles will be removed.`);
  if (nonManifold > 0) issues.push(`${nonManifold} non-manifold edges (handled by voxel-based skinning).`);
  if (boundary > 0) issues.push(`${boundary} open boundary edges: the mesh is not watertight (handled by voxel closing).`);
  if (roots.size > 1) issues.push(`${roots.size} disconnected parts. Floating parts are weighted to the nearest bone.`);
  const bigTextures = textures.filter((t) => t.width > 2048 || t.height > 2048);
  if (bigTextures.length) issues.push(`${bigTextures.length} textures larger than 2K. Export presets can downscale them.`);

  return {
    triangles: triCount,
    vertices: vertCount,
    materials: materials.length,
    textures,
    bounds: { min: [bb.min.x, bb.min.y, bb.min.z], max: [bb.max.x, bb.max.y, bb.max.z], size },
    duplicateVertices: vertCount - weldedCount,
    degenerateTriangles: degenerate,
    boundaryEdges: boundary,
    nonManifoldEdges: nonManifold,
    islands: roots.size,
    issues,
  };
}

/** Removes zero-area triangles in place (keeps groups consistent). */
export function removeDegenerateTriangles(geometry: BufferGeometry): number {
  const idx = geometry.index;
  if (!idx) return 0;
  const pos = geometry.attributes.position.array as ArrayLike<number>;
  const src = idx.array as ArrayLike<number>;
  const groups = geometry.groups.length ? geometry.groups : [{ start: 0, count: src.length, materialIndex: 0 }];
  const out: number[] = [];
  const newGroups: { start: number; count: number; materialIndex: number }[] = [];
  let removed = 0;
  for (const g of groups) {
    const start = out.length;
    for (let i = g.start; i + 2 < g.start + g.count; i += 3) {
      const a = src[i], b = src[i + 1], c = src[i + 2];
      const ux = pos[b * 3] - pos[a * 3], uy = pos[b * 3 + 1] - pos[a * 3 + 1], uz = pos[b * 3 + 2] - pos[a * 3 + 2];
      const vx = pos[c * 3] - pos[a * 3], vy = pos[c * 3 + 1] - pos[a * 3 + 1], vz = pos[c * 3 + 2] - pos[a * 3 + 2];
      const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
      if (cx * cx + cy * cy + cz * cz < 1e-24) {
        removed++;
        continue;
      }
      out.push(a, b, c);
    }
    newGroups.push({ start, count: out.length - start, materialIndex: g.materialIndex ?? 0 });
  }
  if (removed === 0) return 0;
  geometry.setIndex(new BufferAttribute(new Uint32Array(out), 1));
  geometry.clearGroups();
  for (const g of newGroups) geometry.addGroup(g.start, g.count, g.materialIndex);
  return removed;
}
