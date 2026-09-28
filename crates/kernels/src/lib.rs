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

/// Monotone priority queue for Dijkstra (a radix heap): keys are the bit patterns
/// of non-negative f32 distances, which sort like the floats. Pushes must not be
/// smaller than the last popped key, which Dijkstra guarantees.
struct RadixHeap {
    buckets: Vec<Vec<u64>>,
    last: u32,
    len: usize,
}

impl RadixHeap {
    fn new() -> Self {
        RadixHeap { buckets: (0..33).map(|_| Vec::new()).collect(), last: 0, len: 0 }
    }
    fn clear(&mut self) {
        for b in &mut self.buckets {
            b.clear();
        }
        self.last = 0;
        self.len = 0;
    }
    #[inline(always)]
    fn bucket(&self, key: u32) -> usize {
        (32 - (key ^ self.last).leading_zeros()) as usize
    }
    #[inline(always)]
    fn push(&mut self, key: f32, value: u32) {
        let k = key.to_bits();
        let b = self.bucket(k);
        self.buckets[b].push(((k as u64) << 32) | value as u64);
        self.len += 1;
    }
    fn pop(&mut self) -> Option<(f32, u32)> {
        if self.len == 0 {
            return None;
        }
        if self.buckets[0].is_empty() {
            let i = (1..33).find(|&i| !self.buckets[i].is_empty()).unwrap();
            let items = std::mem::take(&mut self.buckets[i]);
            self.last = items.iter().map(|e| (e >> 32) as u32).min().unwrap();
            for e in &items {
                let b = self.bucket((e >> 32) as u32);
                self.buckets[b].push(*e);
            }
            // Hand the allocation back so the bucket doesn't reallocate next time.
            let mut items = items;
            items.clear();
            self.buckets[i] = items;
        }
        self.len -= 1;
        let e = self.buckets[0].pop().unwrap();
        Some((f32::from_bits((e >> 32) as u32), e as u32))
    }
}

/// Geodesic distances for one grid, computed one bone at a time.
///
/// Same results as [`bone_distances`], restructured for speed: the grid border is
/// cleared so the 26 neighbours of a solid voxel are always in bounds, empty voxels
/// hold -inf so one comparison rejects them, the queue is a radix heap, and per-bone
/// state is reset only where it was touched. Setting up once and then asking for
/// bones individually lets several workers share the bones of one model.
pub struct GeodesicSession {
    nx: usize,
    ny: usize,
    nz: usize,
    dx: f32,
    origin: [f32; 3],
    data: Vec<u8>,
    dist: Vec<f32>,
    offs: [isize; 26],
    lens: [f32; 26],
    segments: Vec<f32>,
    pt_voxel: Vec<u32>,
    pt_residual: Vec<f32>,
    max_distance: f32,
    touched: Vec<u32>,
    heap: RadixHeap,
}

impl GeodesicSession {
    pub fn new(grid: Grid, segments: &[f32], points: &[f32], max_distance: f32) -> Self {
        let Grid { origin: o, dx, nx, ny, nz, data } = grid;
        let total = nx * ny * nz;
        let inv = 1.0 / dx;
        // dist: +inf for solid voxels (not reached yet), -inf for empty ones and the border.
        let mut dist = vec![f32::NEG_INFINITY; total];
        if nx >= 3 && ny >= 3 && nz >= 3 {
            for z in 1..nz - 1 {
                for y in 1..ny - 1 {
                    let row = nx * (y + ny * z);
                    for x in 1..nx - 1 {
                        if data[row + x] != EMPTY {
                            dist[row + x] = f32::INFINITY;
                        }
                    }
                }
            }
        }
        let mut offs = [0isize; 26];
        let mut lens = [0f32; 26];
        let mut k = 0;
        for z in -1i32..=1 {
            for y in -1i32..=1 {
                for x in -1i32..=1 {
                    if x == 0 && y == 0 && z == 0 {
                        continue;
                    }
                    offs[k] = x as isize + nx as isize * (y as isize + ny as isize * z as isize);
                    lens[k] = (((x * x + y * y + z * z) as f32).sqrt()) * dx;
                    k += 1;
                }
            }
        }
        // Vertex -> nearest solid voxel and residual distance (same search as the reference).
        let n_pts = points.len() / 3;
        let mut pt_voxel = vec![u32::MAX; n_pts];
        let mut pt_residual = vec![0f32; n_pts];
        for p in 0..n_pts {
            let (px, py, pz) = (points[p * 3], points[p * 3 + 1], points[p * 3 + 2]);
            let vx = ((px - o[0]) * inv).floor() as i64;
            let vy = ((py - o[1]) * inv).floor() as i64;
            let vz = ((pz - o[2]) * inv).floor() as i64;
            let mut best = u32::MAX;
            let mut best_d = f32::INFINITY;
            let mut r = 0i64;
            while r <= 2 && best == u32::MAX {
                for z in vz - r..=vz + r {
                    for y in vy - r..=vy + r {
                        for x in vx - r..=vx + r {
                            if x < 0 || y < 0 || z < 0 || x >= nx as i64 || y >= ny as i64 || z >= nz as i64 {
                                continue;
                            }
                            let i = x as usize + nx * (y as usize + ny * z as usize);
                            if data[i] == EMPTY {
                                continue;
                            }
                            let cx = o[0] + (x as f32 + 0.5) * dx;
                            let cy = o[1] + (y as f32 + 0.5) * dx;
                            let cz = o[2] + (z as f32 + 0.5) * dx;
                            let d = ((px - cx).powi(2) + (py - cy).powi(2) + (pz - cz).powi(2)).sqrt();
                            if d < best_d {
                                best_d = d;
                                best = i as u32;
                            }
                        }
                    }
                }
                r += 1;
            }
            pt_voxel[p] = best;
            pt_residual[p] = if best != u32::MAX { best_d } else { 0.0 };
        }
        GeodesicSession {
            nx, ny, nz, dx, origin: o, data, dist, offs, lens,
            segments: segments.to_vec(), pt_voxel, pt_residual, max_distance,
            touched: Vec::new(), heap: RadixHeap::new(),
        }
    }

    pub fn point_count(&self) -> usize {
        self.pt_voxel.len()
    }

    /// Distances from every point to `bone`, written to `out[p * stride]`.
    pub fn bone(&mut self, bone: usize, out: &mut [f32], stride: usize) {
        let n_pts = self.pt_voxel.len();
        for p in 0..n_pts {
            out[p * stride] = f32::INFINITY;
        }
        let (nx, ny, nz, dx, o) = (self.nx, self.ny, self.nz, self.dx, self.origin);
        if nx < 3 || ny < 3 || nz < 3 || nx * ny * nz > u32::MAX as usize {
            return;
        }
        let inv = 1.0 / dx;
        let (offs, lens, max_distance) = (self.offs, self.lens, self.max_distance);
        let dist = &mut self.dist;
        let touched = &mut self.touched;
        let heap = &mut self.heap;
        for &t in touched.iter() {
            dist[t as usize] = f32::INFINITY;
        }
        touched.clear();
        heap.clear();
        let segments = &self.segments;
        for s in 0..segments.len() / 7 {
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
                if dist[i] >= 0.0 {
                    if dist[i] > 0.0 {
                        if dist[i] == f32::INFINITY {
                            touched.push(i as u32);
                        }
                        dist[i] = 0.0;
                        heap.push(0.0, i as u32);
                    }
                } else if self.data[i] == EMPTY {
                    // Seed passes through empty space (bone slightly outside the mesh): seed solid neighbours.
                    for n in 0..26 {
                        let j = (i as isize + offs[n]) as usize;
                        if lens[n] < dist[j] {
                            if dist[j] == f32::INFINITY {
                                touched.push(j as u32);
                            }
                            dist[j] = lens[n];
                            heap.push(lens[n], j as u32);
                        }
                    }
                }
            }
        }
        while let Some((d, i)) = heap.pop() {
            let i = i as usize;
            // SAFETY: only solid voxels are queued; they are at least one voxel inside
            // the grid, so i + offs[n] is in bounds for every neighbour offset.
            unsafe {
                if d > *dist.get_unchecked(i) {
                    continue;
                }
                if d > max_distance {
                    break;
                }
                for n in 0..26 {
                    let j = (i as isize + *offs.get_unchecked(n)) as usize;
                    let nd = d + *lens.get_unchecked(n);
                    let dj = dist.get_unchecked_mut(j);
                    if nd < *dj {
                        if *dj == f32::INFINITY {
                            touched.push(j as u32);
                        }
                        *dj = nd;
                        heap.push(nd, j as u32);
                    }
                }
            }
        }
        for p in 0..n_pts {
            let v = self.pt_voxel[p];
            if v == u32::MAX {
                continue;
            }
            let d = dist[v as usize];
            if d >= 0.0 && d <= max_distance {
                out[p * stride] = d + self.pt_residual[p];
            }
        }
    }
}

/// All-bones convenience over [`GeodesicSession`]: only bones in `bones` are
/// computed (their columns of the `[point * bone_count + bone]` output; the rest stay +inf).
pub fn bone_distances_fast(grid: &Grid, bone_count: usize, bones: std::ops::Range<usize>, segments: &[f32], points: &[f32], max_distance: f32) -> Vec<f32> {
    let n_pts = points.len() / 3;
    let mut out = vec![f32::INFINITY; n_pts * bone_count];
    let grid = Grid { origin: grid.origin, dx: grid.dx, nx: grid.nx, ny: grid.ny, nz: grid.nz, data: grid.data.clone() };
    let mut session = GeodesicSession::new(grid, segments, points, max_distance);
    for bone in bones.start..bones.end.min(bone_count) {
        session.bone(bone, &mut out[bone..], bone_count);
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
    bone_start: usize,
    bone_end: usize,
    out: *mut f32,
) {
    let data = unsafe { std::slice::from_raw_parts(grid_data, nx * ny * nz) }.to_vec();
    let grid = Grid { origin: [ox, oy, oz], dx, nx, ny, nz, data };
    let segments = unsafe { std::slice::from_raw_parts(segs, seg_count * 7) };
    let points = unsafe { std::slice::from_raw_parts(pts, n_pts * 3) };
    let result = bone_distances_fast(&grid, bone_count, bone_start..bone_end, segments, points, max_distance);
    unsafe { std::ptr::copy_nonoverlapping(result.as_ptr(), out, result.len()) };
}

/// Starts a geodesic session (copies what it needs; the inputs can be freed after).
#[no_mangle]
pub extern "C" fn rf_geo_new(
    grid_data: *const u8,
    nx: usize,
    ny: usize,
    nz: usize,
    ox: f32,
    oy: f32,
    oz: f32,
    dx: f32,
    segs: *const f32,
    seg_count: usize,
    pts: *const f32,
    n_pts: usize,
    max_distance: f32,
) -> *mut GeodesicSession {
    let data = unsafe { std::slice::from_raw_parts(grid_data, nx * ny * nz) }.to_vec();
    let segments = unsafe { std::slice::from_raw_parts(segs, seg_count * 7) };
    let points = unsafe { std::slice::from_raw_parts(pts, n_pts * 3) };
    let grid = Grid { origin: [ox, oy, oz], dx, nx, ny, nz, data };
    Box::into_raw(Box::new(GeodesicSession::new(grid, segments, points, max_distance)))
}

/// Writes one bone's distance to each point (n_pts floats) into `out`.
#[no_mangle]
pub extern "C" fn rf_geo_bone(session: *mut GeodesicSession, bone: usize, out: *mut f32) {
    let s = unsafe { &mut *session };
    let out = unsafe { std::slice::from_raw_parts_mut(out, s.point_count()) };
    s.bone(bone, out, 1);
}

#[no_mangle]
pub extern "C" fn rf_geo_free(session: *mut GeodesicSession) {
    if !session.is_null() {
        drop(unsafe { Box::from_raw(session) });
    }
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

    #[test]
    fn fast_kernel_matches_reference() {
        // A lumpy solid: a cube with a second cube attached, several bones, points everywhere.
        let (p, i) = cube();
        let mut pos = p.clone();
        pos.extend(p.iter().enumerate().map(|(k, v)| if k % 3 == 0 { v + 0.9 } else { v * 0.5 }));
        let mut idx = i.clone();
        idx.extend(i.iter().map(|v| v + 8));
        let g = voxelize(&pos, Some(&idx), 0.043, 2);
        let segs = [
            0.0, 0.5, 0.1, 0.5, 0.5, 0.9, 0.5, //
            1.0, 0.2, 0.5, 0.5, 0.8, 0.5, 0.5, //
            1.0, 0.8, 0.5, 0.5, 1.6, 0.25, 0.25, //
            2.0, 1.5, 0.2, 0.2, 1.5, 0.2, 0.2, //
            3.0, 5.0, 5.0, 5.0, 5.0, 5.0, 5.0, // outside the grid: never seeded
        ];
        let mut pts = Vec::new();
        for k in 0..400 {
            let t = k as f32 / 400.0;
            pts.extend([t * 1.9, (t * 7.0).fract(), (t * 13.0).fract()]);
        }
        let reference = bone_distances(&g, 4, &segs, &pts, 1.2);
        let fast = bone_distances_fast(&g, 4, 0..4, &segs, &pts, 1.2);
        assert_eq!(reference.len(), fast.len());
        for (a, b) in reference.iter().zip(&fast) {
            assert!(a == b || (a.is_infinite() && b.is_infinite()), "{a} vs {b}");
        }
        // A bone range fills only its columns.
        let part = bone_distances_fast(&g, 4, 1..3, &segs, &pts, 1.2);
        for (k, (a, b)) in reference.iter().zip(&part).enumerate() {
            if (1..3).contains(&(k % 4)) { assert!(a == b || a.is_infinite() && b.is_infinite()); } else { assert!(b.is_infinite()); }
        }
    }
}
