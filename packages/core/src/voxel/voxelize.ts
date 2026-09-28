import { EMPTY, INTERIOR, SURFACE, type VoxelGrid } from './grid';

export interface VoxelizeInput {
  positions: Float32Array;
  /** Triangle indices; when null the positions are treated as a triangle soup. */
  index: Uint32Array | null;
  /** Voxel edge length in rig units. */
  dx: number;
  /** Empty voxels padded around the bounds (min 2). */
  pad?: number;
}

/**
 * Solid voxelization that tolerates the open, non-manifold "triangle soup" meshes
 * AI generators produce:
 *  1. Rasterize triangles by dense barycentric sampling (surface voxels).
 *  2. Morphological closing (dilate the surface for the flood fill, then erode the
 *     exterior back) so small holes and cracks don't leak the flood fill inside.
 *  3. Flood fill the exterior from the grid border; everything not reached is solid.
 *
 * This is the reference TypeScript implementation; the Rust/WASM kernel mirrors it.
 */
export function voxelizeTS({ positions, index, dx, pad = 2 }: VoxelizeInput): VoxelGrid {
  pad = Math.max(2, pad);
  const nVerts = positions.length / 3;
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < nVerts; i++) {
    const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  // f32 arithmetic so grid dimensions match the Rust kernel exactly.
  const f = Math.fround;
  const fdx = f(dx);
  const padDx = f(pad * fdx);
  const origin: [number, number, number] = [f(minX - padDx), f(minY - padDx), f(minZ - padDx)];
  const nx = Math.ceil(f(f(maxX - minX) / fdx)) + 2 * pad + 1;
  const ny = Math.ceil(f(f(maxY - minY) / fdx)) + 2 * pad + 1;
  const nz = Math.ceil(f(f(maxZ - minZ) / fdx)) + 2 * pad + 1;
  const total = nx * ny * nz;
  const data = new Uint8Array(total);
  const inv = 1 / dx;
  const ox = origin[0], oy = origin[1], oz = origin[2];

  const mark = (x: number, y: number, z: number) => {
    const ix = Math.floor((x - ox) * inv), iy = Math.floor((y - oy) * inv), iz = Math.floor((z - oz) * inv);
    data[ix + nx * (iy + ny * iz)] = SURFACE;
  };

  const triCount = index ? index.length / 3 : nVerts / 3;
  const step = dx * 0.5;
  for (let t = 0; t < triCount; t++) {
    const a = index ? index[t * 3] : t * 3;
    const b = index ? index[t * 3 + 1] : t * 3 + 1;
    const c = index ? index[t * 3 + 2] : t * 3 + 2;
    const ax = positions[a * 3], ay = positions[a * 3 + 1], az = positions[a * 3 + 2];
    const bx = positions[b * 3], by = positions[b * 3 + 1], bz = positions[b * 3 + 2];
    const cx = positions[c * 3], cy = positions[c * 3 + 1], cz = positions[c * 3 + 2];
    const e0 = Math.hypot(bx - ax, by - ay, bz - az);
    const e1 = Math.hypot(cx - bx, cy - by, cz - bz);
    const e2 = Math.hypot(ax - cx, ay - cy, az - cz);
    const n = Math.max(1, Math.ceil(Math.max(e0, e1, e2) / step));
    const invN = 1 / n;
    for (let i = 0; i <= n; i++) {
      const u = i * invN;
      for (let j = 0; j <= n - i; j++) {
        const w = j * invN;
        mark(ax + (bx - ax) * u + (cx - ax) * w, ay + (by - ay) * u + (cy - ay) * w, az + (bz - az) * u + (cz - az) * w);
      }
    }
  }

  // Closing: barrier = surface dilated by one voxel (6-neighborhood).
  const barrier = new Uint8Array(total);
  const sxy = nx * ny;
  for (let z = 1; z < nz - 1; z++)
    for (let y = 1; y < ny - 1; y++)
      for (let x = 1; x < nx - 1; x++) {
        const i = x + nx * (y + ny * z);
        if (data[i] === SURFACE) {
          barrier[i] = 1;
          barrier[i - 1] = 1;
          barrier[i + 1] = 1;
          barrier[i - nx] = 1;
          barrier[i + nx] = 1;
          barrier[i - sxy] = 1;
          barrier[i + sxy] = 1;
        }
      }

  // Flood fill the exterior from the (always empty) border voxel 0.
  const exterior = new Uint8Array(total);
  const queue = new Int32Array(total);
  let head = 0, tail = 0;
  exterior[0] = 1;
  queue[tail++] = 0;
  while (head < tail) {
    const i = queue[head++];
    const x = i % nx;
    const y = ((i / nx) | 0) % ny;
    const z = (i / sxy) | 0;
    const push = (j: number) => {
      if (!exterior[j] && !barrier[j]) {
        exterior[j] = 1;
        queue[tail++] = j;
      }
    };
    if (x > 0) push(i - 1);
    if (x < nx - 1) push(i + 1);
    if (y > 0) push(i - nx);
    if (y < ny - 1) push(i + nx);
    if (z > 0) push(i - sxy);
    if (z < nz - 1) push(i + sxy);
  }

  // Erode: exterior grows back by one voxel over the dilation band (but never over surface).
  for (let z = 0; z < nz; z++)
    for (let y = 0; y < ny; y++)
      for (let x = 0; x < nx; x++) {
        const i = x + nx * (y + ny * z);
        if (exterior[i] || data[i] === SURFACE) continue;
        const touches =
          (x > 0 && exterior[i - 1] === 1) ||
          (x < nx - 1 && exterior[i + 1] === 1) ||
          (y > 0 && exterior[i - nx] === 1) ||
          (y < ny - 1 && exterior[i + nx] === 1) ||
          (z > 0 && exterior[i - sxy] === 1) ||
          (z < nz - 1 && exterior[i + sxy] === 1);
        if (touches) exterior[i] = 2;
      }

  for (let i = 0; i < total; i++) {
    if (data[i] === SURFACE) continue;
    data[i] = exterior[i] ? EMPTY : INTERIOR;
  }
  return { origin, dx, nx, ny, nz, data };
}
