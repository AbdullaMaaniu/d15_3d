/**
 * Dense voxel grid in rig space.
 * data: 0 = empty, 1 = surface (touched by a triangle), 2 = interior (filled).
 */
export interface VoxelGrid {
  origin: [number, number, number];
  dx: number;
  nx: number;
  ny: number;
  nz: number;
  data: Uint8Array;
}

export const EMPTY = 0;
export const SURFACE = 1;
export const INTERIOR = 2;

export function voxelIndex(g: VoxelGrid, x: number, y: number, z: number): number {
  return x + g.nx * (y + g.ny * z);
}

export function worldToVoxel(g: VoxelGrid, p: ArrayLike<number>): [number, number, number] {
  return [
    Math.floor((p[0] - g.origin[0]) / g.dx),
    Math.floor((p[1] - g.origin[1]) / g.dx),
    Math.floor((p[2] - g.origin[2]) / g.dx),
  ];
}

export function voxelCenter(g: VoxelGrid, x: number, y: number, z: number): [number, number, number] {
  return [g.origin[0] + (x + 0.5) * g.dx, g.origin[1] + (y + 0.5) * g.dx, g.origin[2] + (z + 0.5) * g.dx];
}

export function inBounds(g: VoxelGrid, x: number, y: number, z: number): boolean {
  return x >= 0 && y >= 0 && z >= 0 && x < g.nx && y < g.ny && z < g.nz;
}

export function isSolid(g: VoxelGrid, x: number, y: number, z: number): boolean {
  return inBounds(g, x, y, z) && g.data[voxelIndex(g, x, y, z)] !== EMPTY;
}

export function countSolid(g: VoxelGrid): number {
  let c = 0;
  for (let i = 0; i < g.data.length; i++) if (g.data[i] !== EMPTY) c++;
  return c;
}
