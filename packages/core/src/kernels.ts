import type { VoxelGrid } from './voxel/grid';
import { voxelizeTS, type VoxelizeInput } from './voxel/voxelize';
import { boneDistancesTS, type GeodesicInput } from './voxel/geodesic';

/**
 * Heavy compute kernels. A pure TypeScript implementation is always available;
 * the Rust/WASM build (crates/kernels) provides the same API several times faster.
 */
export interface Kernels {
  name: 'ts' | 'wasm';
  voxelize(input: VoxelizeInput): VoxelGrid;
  boneDistances(input: GeodesicInput): Float32Array;
  /** Set up once, then compute bones one at a time (lets workers share a model's bones). */
  geodesicSession(input: GeodesicInput): GeodesicSession;
  /** Field-aligned quad remeshing, UV atlas and texture bake (Rust/WASM only). */
  quadRemesh?(input: QuadRemeshInput): QuadRemeshOutput;
}

export interface QuadRemeshInput {
  positions: Float32Array;
  index: Uint32Array | null;
  /** Approximate number of output faces. */
  targetFaces: number;
  seed?: number;
  /** Atlas size in texels (square). */
  resolution: number;
  /** Empty texels around charts. */
  padding?: number;
  /** Texture transfer from the original surface; null = UVs only. */
  bake?: BakeSource | null;
}

export interface BakeTexture {
  width: number;
  height: number;
  /** RGBA8, first row at the top of the image. */
  data: Uint8Array;
  /** three.js flipY (v = 0 is the bottom row). */
  flipY: boolean;
  repeat: boolean;
}

export interface BakeMaterial {
  /** Texture indices, -1 = none. */
  baseTexture: number;
  baseColor: [number, number, number, number];
  mrTexture: number;
  metalness: number;
  roughness: number;
  emissiveTexture: number;
  emissive: [number, number, number];
}

export interface BakeSource {
  positions: Float32Array;
  uvs: Float32Array;
  /** RGBA vertex colours, optional. */
  colors?: Float32Array | null;
  index: Uint32Array;
  materialOfTriangle: Uint32Array;
  textures: BakeTexture[];
  materials: BakeMaterial[];
  metallicRoughness: boolean;
  emissive: boolean;
}

export interface QuadRemeshOutput {
  /** Polygon mesh: vertex positions/normals, face sizes (3 or 4), each corner's vertex. */
  positions: Float32Array;
  normals: Float32Array;
  sizes: Uint8Array;
  corners: Uint32Array;
  /** UV per corner (v down, glTF convention). */
  uvs: Float32Array;
  /** Render triangles as corner-index triples; quads are two consecutive triangles. */
  triangles: Uint32Array;
  charts: number;
  baked: { base: Uint8Array; metallicRoughness: Uint8Array | null; emissive: Uint8Array | null; covered: number } | null;
}

export interface GeodesicSession {
  /** Distance from every query point to one bone. */
  bone(bone: number): Float32Array;
  free(): void;
}

export const tsKernels: Kernels = {
  name: 'ts',
  voxelize: voxelizeTS,
  boneDistances: boneDistancesTS,
  geodesicSession(input) {
    const n = input.points.length / 3;
    return {
      bone(b) {
        const all = boneDistancesTS({ ...input, bones: [b, b + 1] });
        const col = new Float32Array(n);
        for (let p = 0; p < n; p++) col[p] = all[p * input.boneCount + b];
        return col;
      },
      free() {},
    };
  },
};

/**
 * Fills the [point * boneCount + bone] matrix from per-bone columns computed by
 * several sessions (typically one per worker). Bones are handed out one at a time,
 * so fast and slow bones balance out across workers.
 */
export async function distancesFromSessions(
  input: GeodesicInput,
  workers: Array<(bone: number) => Promise<Float32Array>>,
  onBone?: (done: number) => void,
): Promise<Float32Array> {
  const B = input.boneCount;
  const n = input.points.length / 3;
  const out = new Float32Array(n * B);
  const queue = Array.from({ length: B }, (_, b) => b);
  let done = 0;
  await Promise.all(
    workers.map(async (run) => {
      for (let b = queue.shift(); b !== undefined; b = queue.shift()) {
        const col = await run(b);
        for (let p = 0; p < n; p++) out[p * B + b] = col[p];
        onBone?.(++done);
      }
    }),
  );
  return out;
}

interface WasmExports {
  memory: WebAssembly.Memory;
  rf_alloc(bytes: number): number;
  rf_free(ptr: number, bytes: number): void;
  rf_voxelize(posPtr: number, nVerts: number, idxPtr: number, nIdx: number, dx: number, pad: number, headerPtr: number): number;
  rf_quad_remesh(pos: number, nVerts: number, idx: number, nIdx: number, target: number, seed: number): number;
  rf_quad_info(r: number, out: number): void;
  rf_quad_positions(r: number): number;
  rf_quad_normals(r: number): number;
  rf_quad_sizes(r: number): number;
  rf_quad_corners(r: number): number;
  rf_quad_triangles(r: number): number;
  rf_quad_uv(r: number): number;
  rf_quad_atlas(r: number, resolution: number, padding: number): number;
  rf_quad_free(r: number): void;
  rf_baker_new(pos: number, nVerts: number, uv: number, color: number, idx: number, nIdx: number, materialOf: number): number;
  rf_baker_texture(b: number, w: number, h: number, data: number, flipY: number, repeat: number): number;
  rf_baker_material(b: number, baseTex: number, r: number, g: number, bl: number, a: number, mrTex: number, metallic: number, roughness: number, emTex: number, er: number, eg: number, eb: number): void;
  rf_baker_bake(b: number, r: number, resolution: number, padding: number, outBase: number, outMr: number, outEm: number): number;
  rf_baker_free(b: number): void;
  rf_geo_new(gridPtr: number, nx: number, ny: number, nz: number, ox: number, oy: number, oz: number, dx: number, segPtr: number, segCount: number, ptsPtr: number, nPts: number, maxDistance: number): number;
  rf_geo_bone(session: number, bone: number, outPtr: number): void;
  rf_geo_free(session: number): void;
  rf_bone_distances(
    gridPtr: number,
    nx: number,
    ny: number,
    nz: number,
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    boneCount: number,
    segPtr: number,
    segCount: number,
    ptsPtr: number,
    nPts: number,
    maxDistance: number,
    boneStart: number,
    boneEnd: number,
    outPtr: number,
  ): void;
}

/**
 * Instantiates the Rust kernels from compiled WASM bytes (see `@rigforge/core/wasm/rigforge_kernels.wasm`).
 * Falls back to throwing; callers should catch and use `tsKernels`.
 */
export async function createWasmKernels(bytes: BufferSource): Promise<Kernels> {
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const ex = instance.exports as unknown as WasmExports;

  const copyIn = (arr: Float32Array | Uint32Array | Uint8Array): number => {
    const ptr = ex.rf_alloc(Math.max(4, arr.byteLength));
    new Uint8Array(ex.memory.buffer, ptr, arr.byteLength).set(new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength));
    return ptr;
  };

  return {
    name: 'wasm',
    voxelize({ positions, index, dx, pad = 2 }) {
      const posPtr = copyIn(positions);
      const idxPtr = index ? copyIn(index) : 0;
      const headerPtr = ex.rf_alloc(32);
      const dataPtr = ex.rf_voxelize(posPtr, positions.length / 3, idxPtr, index ? index.length : 0, dx, pad, headerPtr);
      const header = new Float32Array(ex.memory.buffer, headerPtr, 8).slice();
      const nx = header[0], ny = header[1], nz = header[2];
      const total = nx * ny * nz;
      const data = new Uint8Array(ex.memory.buffer, dataPtr, total).slice();
      ex.rf_free(dataPtr, total);
      ex.rf_free(headerPtr, 32);
      ex.rf_free(posPtr, Math.max(4, positions.byteLength));
      if (index) ex.rf_free(idxPtr, Math.max(4, index.byteLength));
      return { origin: [header[3], header[4], header[5]], dx, nx, ny, nz, data };
    },
    boneDistances({ grid, boneCount, segments, points, maxDistance, bones }) {
      const gridPtr = copyIn(grid.data);
      const segPtr = copyIn(segments);
      const ptsPtr = copyIn(points);
      const nPts = points.length / 3;
      const outBytes = nPts * boneCount * 4;
      const outPtr = ex.rf_alloc(Math.max(4, outBytes));
      ex.rf_bone_distances(
        gridPtr, grid.nx, grid.ny, grid.nz, grid.origin[0], grid.origin[1], grid.origin[2], grid.dx,
        boneCount, segPtr, segments.length / 7, ptsPtr, nPts, maxDistance, bones?.[0] ?? 0, bones?.[1] ?? boneCount, outPtr,
      );
      const out = new Float32Array(ex.memory.buffer, outPtr, nPts * boneCount).slice();
      ex.rf_free(outPtr, Math.max(4, outBytes));
      ex.rf_free(gridPtr, Math.max(4, grid.data.byteLength));
      ex.rf_free(segPtr, Math.max(4, segments.byteLength));
      ex.rf_free(ptsPtr, Math.max(4, points.byteLength));
      return out;
    },
    quadRemesh({ positions, index, targetFaces, seed = 1, resolution, padding = 4, bake }) {
      const allocs: Array<[number, number]> = [];
      const input = (arr: Float32Array | Uint32Array | Uint8Array) => {
        const ptr = copyIn(arr);
        allocs.push([ptr, Math.max(4, arr.byteLength)]);
        return ptr;
      };
      const release = () => {
        for (const [ptr, bytes] of allocs.splice(0)) ex.rf_free(ptr, bytes);
      };
      const result = ex.rf_quad_remesh(input(positions), positions.length / 3, index ? input(index) : 0, index ? index.length : 0, targetFaces, seed);
      release();
      try {
        const charts = ex.rf_quad_atlas(result, resolution, padding);
        const infoPtr = ex.rf_alloc(20);
        ex.rf_quad_info(result, infoPtr);
        const [nv, nf, nc, nt] = new Uint32Array(ex.memory.buffer, infoPtr, 5).slice();
        ex.rf_free(infoPtr, 20);
        let baked: QuadRemeshOutput['baked'] = null;
        if (bake) {
          const baker = ex.rf_baker_new(
            input(bake.positions), bake.positions.length / 3, input(bake.uvs), bake.colors ? input(bake.colors) : 0,
            input(bake.index), bake.index.length, input(bake.materialOfTriangle),
          );
          for (const t of bake.textures) {
            ex.rf_baker_texture(baker, t.width, t.height, input(t.data), t.flipY ? 1 : 0, t.repeat ? 1 : 0);
          }
          release();
          for (const m of bake.materials) {
            ex.rf_baker_material(baker, m.baseTexture, ...m.baseColor, m.mrTexture, m.metalness, m.roughness, m.emissiveTexture, ...m.emissive);
          }
          const bytes = resolution * resolution * 4;
          const outBase = ex.rf_alloc(bytes);
          const outMr = bake.metallicRoughness ? ex.rf_alloc(bytes) : 0;
          const outEm = bake.emissive ? ex.rf_alloc(bytes) : 0;
          const covered = ex.rf_baker_bake(baker, result, resolution, Math.ceil(padding), outBase, outMr, outEm);
          const read = (ptr: number) => (ptr ? new Uint8Array(ex.memory.buffer, ptr, bytes).slice() : null);
          baked = { base: read(outBase)!, metallicRoughness: read(outMr), emissive: read(outEm), covered };
          for (const ptr of [outBase, outMr, outEm]) if (ptr) ex.rf_free(ptr, bytes);
          ex.rf_baker_free(baker);
        }
        // Read after baking: allocations above may have grown (and moved) wasm memory.
        const buf = ex.memory.buffer;
        return {
          positions: new Float32Array(buf, ex.rf_quad_positions(result), nv * 3).slice(),
          normals: new Float32Array(buf, ex.rf_quad_normals(result), nv * 3).slice(),
          sizes: new Uint8Array(buf, ex.rf_quad_sizes(result), nf).slice(),
          corners: new Uint32Array(buf, ex.rf_quad_corners(result), nc).slice(),
          uvs: new Float32Array(buf, ex.rf_quad_uv(result), nc * 2).slice(),
          triangles: new Uint32Array(buf, ex.rf_quad_triangles(result), nt * 3).slice(),
          charts,
          baked,
        };
      } finally {
        release();
        ex.rf_quad_free(result);
      }
    },
    geodesicSession({ grid, segments, points, maxDistance }) {
      const gridPtr = copyIn(grid.data);
      const segPtr = copyIn(segments);
      const ptsPtr = copyIn(points);
      const nPts = points.length / 3;
      const session = ex.rf_geo_new(
        gridPtr, grid.nx, grid.ny, grid.nz, grid.origin[0], grid.origin[1], grid.origin[2], grid.dx,
        segPtr, segments.length / 7, ptsPtr, nPts, maxDistance,
      );
      ex.rf_free(gridPtr, Math.max(4, grid.data.byteLength));
      ex.rf_free(segPtr, Math.max(4, segments.byteLength));
      ex.rf_free(ptsPtr, Math.max(4, points.byteLength));
      const outPtr = ex.rf_alloc(Math.max(4, nPts * 4));
      let live = true;
      return {
        bone(b) {
          if (!live) throw new Error('Geodesic session was freed');
          ex.rf_geo_bone(session, b, outPtr);
          return new Float32Array(ex.memory.buffer, outPtr, nPts).slice();
        },
        free() {
          if (!live) return;
          live = false;
          ex.rf_geo_free(session);
          ex.rf_free(outPtr, Math.max(4, nPts * 4));
        },
      };
    },
  };
}
