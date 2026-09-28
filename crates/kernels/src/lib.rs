//! RigForge compute kernels.
//!
//! Mirrors the TypeScript reference implementations in
//! `packages/core/src/voxel/{voxelize,geodesic}.ts` and exposes a tiny C ABI so it
//! can be loaded as a plain WebAssembly module without any bindgen glue.

use std::alloc::{alloc, dealloc, Layout};
use std::cmp::Ordering;
use std::collections::BinaryHeap;

const EMPTY: u8 = 0;
const SURFACE: u8 = 1;
const INTERIOR: u8 = 2;

pub struct Grid {
    pub origin: [f32; 3],
    pub dx: f32,
    pub nx: usize,
    pub ny: usize,
    pub nz: usize,
    pub data: Vec<u8>,
}

/// Solid voxelization: triangle sampling, one-voxel morphological closing, exterior flood fill.
pub fn voxelize(positions: &[f32], index: Option<&[u32]>, dx: f32, pad: usize) -> Grid {
    let pad = pad.max(2);
    let n_verts = positions.len() / 3;
    let (mut min, mut max) = ([f32::INFINITY; 3], [f32::NEG_INFINITY; 3]);
    for i in 0..n_verts {
        for k in 0..3 {
            let v = positions[i * 3 + k];
            if v < min[k] {
                min[k] = v;
            }
            if v > max[k] {
                max[k] = v;
            }
        }
    }
    let origin = [min[0] - pad as f32 * dx, min[1] - pad as f32 * dx, min[2] - pad as f32 * dx];
    let nx = ((max[0] - min[0]) / dx).ceil() as usize + 2 * pad + 1;
    let ny = ((max[1] - min[1]) / dx).ceil() as usize + 2 * pad + 1;
    let nz = ((max[2] - min[2]) / dx).ceil() as usize + 2 * pad + 1;
    let total = nx * ny * nz;
    let sxy = nx * ny;
    let mut data = vec![EMPTY; total];
    let inv = 1.0 / dx;

    let tri_count = match index {
        Some(idx) => idx.len() / 3,
        None => n_verts / 3,
    };
    let step = dx * 0.5;
    for t in 0..tri_count {
        let (a, b, c) = match index {
            Some(idx) => (idx[t * 3] as usize, idx[t * 3 + 1] as usize, idx[t * 3 + 2] as usize),
            None => (t * 3, t * 3 + 1, t * 3 + 2),
        };
        let pa = [positions[a * 3], positions[a * 3 + 1], positions[a * 3 + 2]];
        let pb = [positions[b * 3], positions[b * 3 + 1], positions[b * 3 + 2]];
        let pc = [positions[c * 3], positions[c * 3 + 1], positions[c * 3 + 2]];
        let e0 = dist3(&pa, &pb);
        let e1 = dist3(&pb, &pc);
        let e2 = dist3(&pc, &pa);
        let n = ((e0.max(e1).max(e2) / step).ceil() as usize).max(1);
        let inv_n = 1.0 / n as f32;
        for i in 0..=n {
            let u = i as f32 * inv_n;
            for j in 0..=(n - i) {
                let w = j as f32 * inv_n;
                let mut v = [0usize; 3];
                for k in 0..3 {
                    let p = pa[k] + (pb[k] - pa[k]) * u + (pc[k] - pa[k]) * w;
                    v[k] = ((p - origin[k]) * inv).floor() as usize;
                }
                data[v[0] + nx * (v[1] + ny * v[2])] = SURFACE;
            }
        }
    }

    // Closing barrier.
    let mut barrier = vec![0u8; total];
    for z in 1..nz - 1 {
        for y in 1..ny - 1 {
            for x in 1..nx - 1 {
                let i = x + nx * (y + ny * z);
                if data[i] == SURFACE {
                    for j in [i, i - 1, i + 1, i - nx, i + nx, i - sxy, i + sxy] {
                        barrier[j] = 1;
                    }
                }
            }
        }
    }

    // Exterior flood fill.
    let mut exterior = vec![0u8; total];
    let mut queue: Vec<u32> = Vec::with_capacity(total / 2);
    exterior[0] = 1;
    queue.push(0);
    let mut head = 0;
    while head < queue.len() {
        let i = queue[head] as usize;
        head += 1;
        let x = i % nx;
        let y = (i / nx) % ny;
        let z = i / sxy;
        let mut push = |j: usize| {
            if exterior[j] == 0 && barrier[j] == 0 {
                exterior[j] = 1;
                queue.push(j as u32);
            }
        };
        if x > 0 {
            push(i - 1);
        }
        if x < nx - 1 {
            push(i + 1);
        }
        if y > 0 {
            push(i - nx);
        }
        if y < ny - 1 {
            push(i + nx);
        }
        if z > 0 {
            push(i - sxy);
        }
        if z < nz - 1 {
            push(i + sxy);
        }
    }

    // Erode back by one voxel.
    for z in 0..nz {
        for y in 0..ny {
            for x in 0..nx {
                let i = x + nx * (y + ny * z);
                if exterior[i] != 0 || data[i] == SURFACE {
                    continue;
                }
                let touches = (x > 0 && exterior[i - 1] == 1)
                    || (x < nx - 1 && exterior[i + 1] == 1)
                    || (y > 0 && exterior[i - nx] == 1)
                    || (y < ny - 1 && exterior[i + nx] == 1)
                    || (z > 0 && exterior[i - sxy] == 1)
                    || (z < nz - 1 && exterior[i + sxy] == 1);
                if touches {
                    exterior[i] = 2;
                }
            }
        }
    }
    for i in 0..total {
        if data[i] == SURFACE {
            continue;
        }
        data[i] = if exterior[i] != 0 { EMPTY } else { INTERIOR };
    }
    Grid { origin, dx, nx, ny, nz, data }
}

#[derive(Copy, Clone, PartialEq)]
struct Item {
    d: f32,
    c: u32,
}
impl Eq for Item {}
impl Ord for Item {
    fn cmp(&self, other: &Self) -> Ordering {
        other.d.partial_cmp(&self.d).unwrap_or(Ordering::Equal)
    }
}
impl PartialOrd for Item {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

/// Geodesic (through-volume) distance from every query point to every bone.
/// `segments` is [bone, ax, ay, az, bx, by, bz] * n. Output is [point * bone_count + bone].
pub fn bone_distances(grid: &Grid, bone_count: usize, segments: &[f32], points: &[f32], max_distance: f32) -> Vec<f32> {
    let (nx, ny, nz, dx) = (grid.nx, grid.ny, grid.nz, grid.dx);
    let total = nx * ny * nz;
    let sxy = nx * ny;
    let inv = 1.0 / dx;
    let o = grid.origin;

    let mut compact = vec![-1i32; total];
    let mut solid_index: Vec<u32> = Vec::new();
    for i in 0..total {
        if grid.data[i] != EMPTY {
            compact[i] = solid_index.len() as i32;
            solid_index.push(i as u32);
        }
    }
    let solid_count = solid_index.len();

    let mut offs = [0isize; 26];
    let mut dxyz = [[0i32; 3]; 26];
    let mut lens = [0f32; 26];
    let mut k = 0;
    for z in -1i32..=1 {
        for y in -1i32..=1 {
            for x in -1i32..=1 {
                if x == 0 && y == 0 && z == 0 {
                    continue;
                }
                offs[k] = x as isize + nx as isize * (y as isize + ny as isize * z as isize);
                dxyz[k] = [x, y, z];
                lens[k] = (((x * x + y * y + z * z) as f32).sqrt()) * dx;
                k += 1;
            }
        }
    }

    let n_pts = points.len() / 3;
    let mut pt_voxel = vec![-1i32; n_pts];
    let mut pt_residual = vec![0f32; n_pts];
    for p in 0..n_pts {
        let (px, py, pz) = (points[p * 3], points[p * 3 + 1], points[p * 3 + 2]);
        let vx = ((px - o[0]) * inv).floor() as i64;
        let vy = ((py - o[1]) * inv).floor() as i64;
        let vz = ((pz - o[2]) * inv).floor() as i64;
        let mut best = -1i32;
        let mut best_d = f32::INFINITY;
        let mut r = 0i64;
        while r <= 2 && best < 0 {
            for z in vz - r..=vz + r {
                for y in vy - r..=vy + r {
                    for x in vx - r..=vx + r {
                        if x < 0 || y < 0 || z < 0 || x >= nx as i64 || y >= ny as i64 || z >= nz as i64 {
                            continue;
                        }
                        let c = compact[x as usize + nx * (y as usize + ny * z as usize)];
                        if c < 0 {
                            continue;
                        }
                        let cx = o[0] + (x as f32 + 0.5) * dx;
                        let cy = o[1] + (y as f32 + 0.5) * dx;
                        let cz = o[2] + (z as f32 + 0.5) * dx;
                        let d = ((px - cx).powi(2) + (py - cy).powi(2) + (pz - cz).powi(2)).sqrt();
                        if d < best_d {
                            best_d = d;
                            best = c;
                        }
                    }
                }
            }
            r += 1;
        }
        pt_voxel[p] = best;
        pt_residual[p] = if best >= 0 { best_d } else { 0.0 };
    }

    let mut out = vec![f32::INFINITY; n_pts * bone_count];
    let mut dist = vec![f32::INFINITY; solid_count];
    let mut heap: BinaryHeap<Item> = BinaryHeap::with_capacity(solid_count);
    let seg_count = segments.len() / 7;

    for bone in 0..bone_count {
        for d in dist.iter_mut() {
            *d = f32::INFINITY;
        }
        heap.clear();
        for s in 0..seg_count {
            if segments[s * 7] as usize != bone {
                continue;
            }
            let a = [segments[s * 7 + 1], segments[s * 7 + 2], segments[s * 7 + 3]];
            let b = [segments[s * 7 + 4], segments[s * 7 + 5], segments[s * 7 + 6]];
            let len = dist3(&a, &b);
            let steps = ((len / (dx * 0.5)).ceil() as usize).max(1);
            for kk in 0..=steps {
                let t = kk as f32 / steps as f32;
                let vx = ((a[0] + (b[0] - a[0]) * t - o[0]) * inv).floor() as i64;
                let vy = ((a[1] + (b[1] - a[1]) * t - o[1]) * inv).floor() as i64;
                let vz = ((a[2] + (b[2] - a[2]) * t - o[2]) * inv).floor() as i64;
                if vx < 1 || vy < 1 || vz < 1 || vx >= nx as i64 - 1 || vy >= ny as i64 - 1 || vz >= nz as i64 - 1 {
                    continue;
                }
                let i = vx as usize + nx * (vy as usize + ny * vz as usize);
                if compact[i] >= 0 {
                    let c = compact[i] as usize;
                    if dist[c] > 0.0 {
                        dist[c] = 0.0;
                        heap.push(Item { d: 0.0, c: c as u32 });
                    }
                } else {
                    for n in 0..26 {
                        let c = compact[(i as isize + offs[n]) as usize];
                        if c >= 0 && lens[n] < dist[c as usize] {
                            dist[c as usize] = lens[n];
                            heap.push(Item { d: lens[n], c: c as u32 });
                        }
                    }
                }
            }
        }
        while let Some(Item { d, c }) = heap.pop() {
            let c = c as usize;
            if d > dist[c] {
                continue;
            }
            if d > max_distance {
                break;
            }
            let i = solid_index[c] as usize;
            let x = (i % nx) as i32;
            let y = ((i / nx) % ny) as i32;
            let z = (i / sxy) as i32;
            for n in 0..26 {
                let x2 = x + dxyz[n][0];
                let y2 = y + dxyz[n][1];
                let z2 = z + dxyz[n][2];
                if x2 < 0 || y2 < 0 || z2 < 0 || x2 >= nx as i32 || y2 >= ny as i32 || z2 >= nz as i32 {
                    continue;
                }
                let c2 = compact[(i as isize + offs[n]) as usize];
                if c2 < 0 {
                    continue;
                }
                let nd = d + lens[n];
                if nd < dist[c2 as usize] {
                    dist[c2 as usize] = nd;
                    heap.push(Item { d: nd, c: c2 as u32 });
                }
            }
        }
        for p in 0..n_pts {
            let v = pt_voxel[p];
            if v < 0 {
                continue;
            }
            let d = dist[v as usize];
            if d <= max_distance {
                out[p * bone_count + bone] = d + pt_residual[p];
            }
        }
    }
    out
}

fn dist3(a: &[f32; 3], b: &[f32; 3]) -> f32 {
    ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2) + (a[2] - b[2]).powi(2)).sqrt()
}

// ---------------------------------------------------------------------------
// C ABI for WebAssembly.
// ---------------------------------------------------------------------------

#[no_mangle]
pub extern "C" fn rf_alloc(bytes: usize) -> *mut u8 {
    unsafe { alloc(Layout::from_size_align(bytes.max(1), 8).unwrap()) }
}

#[no_mangle]
pub extern "C" fn rf_free(ptr: *mut u8, bytes: usize) {
    unsafe { dealloc(ptr, Layout::from_size_align(bytes.max(1), 8).unwrap()) }
}

/// Returns a pointer to nx*ny*nz voxel bytes (free with rf_free). Writes
/// [nx, ny, nz, ox, oy, oz] as f32 into `header`.
#[no_mangle]
pub extern "C" fn rf_voxelize(pos: *const f32, n_verts: usize, idx: *const u32, n_idx: usize, dx: f32, pad: usize, header: *mut f32) -> *mut u8 {
    let positions = unsafe { std::slice::from_raw_parts(pos, n_verts * 3) };
    let index = if n_idx > 0 { Some(unsafe { std::slice::from_raw_parts(idx, n_idx) }) } else { None };
    let grid = voxelize(positions, index, dx, pad);
    let total = grid.data.len();
    let out = rf_alloc(total);
    unsafe {
        std::ptr::copy_nonoverlapping(grid.data.as_ptr(), out, total);
        let h = std::slice::from_raw_parts_mut(header, 8);
        h[0] = grid.nx as f32;
        h[1] = grid.ny as f32;
        h[2] = grid.nz as f32;
        h[3] = grid.origin[0];
        h[4] = grid.origin[1];
        h[5] = grid.origin[2];
    }
    out
}

#[no_mangle]
pub extern "C" fn rf_bone_distances(
    grid_data: *const u8,
    nx: usize,
    ny: usize,
    nz: usize,
    ox: f32,
    oy: f32,
    oz: f32,
    dx: f32,
    bone_count: usize,
    segs: *const f32,
    seg_count: usize,
    pts: *const f32,
    n_pts: usize,
    max_distance: f32,
    out: *mut f32,
) {
    let data = unsafe { std::slice::from_raw_parts(grid_data, nx * ny * nz) }.to_vec();
    let grid = Grid { origin: [ox, oy, oz], dx, nx, ny, nz, data };
    let segments = unsafe { std::slice::from_raw_parts(segs, seg_count * 7) };
    let points = unsafe { std::slice::from_raw_parts(pts, n_pts * 3) };
    let result = bone_distances(&grid, bone_count, segments, points, max_distance);
    unsafe { std::ptr::copy_nonoverlapping(result.as_ptr(), out, result.len()) };
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cube() -> (Vec<f32>, Vec<u32>) {
        let p = vec![
            0., 0., 0., 1., 0., 0., 1., 1., 0., 0., 1., 0., 0., 0., 1., 1., 0., 1., 1., 1., 1., 0., 1., 1.,
        ];
        let i = vec![
            0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 2, 3, 7, 2, 7, 6, 1, 2, 6, 1, 6, 5, 0, 4, 7, 0, 7, 3,
        ];
        (p, i)
    }

    #[test]
    fn cube_is_filled() {
        let (p, i) = cube();
        let g = voxelize(&p, Some(&i), 0.1, 2);
        let center = (g.nx / 2) + g.nx * ((g.ny / 2) + g.ny * (g.nz / 2));
        assert_eq!(g.data[center], INTERIOR);
        assert_eq!(g.data[0], EMPTY);
    }

    #[test]
    fn distances_grow_away_from_bone() {
        let (p, i) = cube();
        let g = voxelize(&p, Some(&i), 0.05, 2);
        let segs = [0.0, 0.5, 0.1, 0.5, 0.5, 0.2, 0.5];
        let pts = [0.5, 0.15, 0.5, 0.5, 0.9, 0.5];
        let d = bone_distances(&g, 1, &segs, &pts, 10.0);
        assert!(d[0] < d[1]);
        assert!((d[1] - 0.7).abs() < 0.1);
    }
}
