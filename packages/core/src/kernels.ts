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
}

export const tsKernels: Kernels = {
  name: 'ts',
  voxelize: voxelizeTS,
  boneDistances: boneDistancesTS,
};

interface WasmExports {
  memory: WebAssembly.Memory;
  rf_alloc(bytes: number): number;
  rf_free(ptr: number, bytes: number): void;
  rf_voxelize(posPtr: number, nVerts: number, idxPtr: number, nIdx: number, dx: number, pad: number, headerPtr: number): number;
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
    boneDistances({ grid, boneCount, segments, points, maxDistance }) {
      const gridPtr = copyIn(grid.data);
      const segPtr = copyIn(segments);
      const ptsPtr = copyIn(points);
      const nPts = points.length / 3;
      const outBytes = nPts * boneCount * 4;
      const outPtr = ex.rf_alloc(Math.max(4, outBytes));
      ex.rf_bone_distances(
        gridPtr, grid.nx, grid.ny, grid.nz, grid.origin[0], grid.origin[1], grid.origin[2], grid.dx,
        boneCount, segPtr, segments.length / 7, ptsPtr, nPts, maxDistance, outPtr,
      );
      const out = new Float32Array(ex.memory.buffer, outPtr, nPts * boneCount).slice();
      ex.rf_free(outPtr, Math.max(4, outBytes));
      ex.rf_free(gridPtr, Math.max(4, grid.data.byteLength));
      ex.rf_free(segPtr, Math.max(4, segments.byteLength));
      ex.rf_free(ptsPtr, Math.max(4, points.byteLength));
      return out;
    },
  };
}
