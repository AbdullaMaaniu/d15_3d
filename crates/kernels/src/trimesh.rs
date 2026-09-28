//! Indexed triangle mesh utilities: welding, adaptive subdivision, normals, adjacency.

use crate::geom::*;
use std::collections::HashMap;

#[derive(Clone)]
pub struct TriMesh {
    pub v: Vec<V3>,
    pub f: Vec<[u32; 3]>,
}

impl TriMesh {
    /// Welds vertices at (nearly) the same position, dropping UV/normal seams, and
    /// removes degenerate and duplicate triangles.
    pub fn welded(positions: &[f32], index: Option<&[u32]>) -> TriMesh {
        let n = positions.len() / 3;
        let (mut min, mut max) = ([f32::INFINITY; 3], [f32::NEG_INFINITY; 3]);
        for i in 0..n {
            for k in 0..3 {
                min[k] = min[k].min(positions[i * 3 + k]);
                max[k] = max[k].max(positions[i * 3 + k]);
            }
        }
        let extent = (0..3).map(|k| max[k] - min[k]).fold(0.0f32, f32::max).max(1e-9);
        let q = 1e-6 * extent;
        let mut map: HashMap<(i64, i64, i64), u32> = HashMap::with_capacity(n);
        let mut remap = vec![0u32; n];
        let mut v = Vec::new();
        for i in 0..n {
            let p = [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]];
            let key = ((p[0] / q).round() as i64, (p[1] / q).round() as i64, (p[2] / q).round() as i64);
            remap[i] = *map.entry(key).or_insert_with(|| {
                v.push(p);
                (v.len() - 1) as u32
            });
        }
        let tri_count = index.map_or(n / 3, |ix| ix.len() / 3);
        let mut seen: HashMap<[u32; 3], ()> = HashMap::with_capacity(tri_count);
        let mut f = Vec::with_capacity(tri_count);
        for t in 0..tri_count {
            let (a, b, c) = match index {
                Some(ix) => (ix[t * 3] as usize, ix[t * 3 + 1] as usize, ix[t * 3 + 2] as usize),
                None => (t * 3, t * 3 + 1, t * 3 + 2),
            };
            let tri = [remap[a], remap[b], remap[c]];
            if tri[0] == tri[1] || tri[1] == tri[2] || tri[0] == tri[2] {
                continue;
            }
            let area2 = len2(cross(sub(v[tri[1] as usize], v[tri[0] as usize]), sub(v[tri[2] as usize], v[tri[0] as usize])));
            if area2 <= 0.0 {
                continue;
            }
            // Same triangle listed twice (in any rotation or winding).
            let mut key = tri;
            key.sort_unstable();
            if seen.insert(key, ()).is_some() {
                continue;
            }
            f.push(tri);
        }
        TriMesh { v, f }
    }

    pub fn face_normal(&self, t: usize) -> V3 {
        let [a, b, c] = self.f[t];
        let (a, b, c) = (self.v[a as usize], self.v[b as usize], self.v[c as usize]);
        normalize(cross(sub(b, a), sub(c, a)))
    }

    pub fn area(&self) -> f32 {
        self.f
            .iter()
            .map(|t| 0.5 * len(cross(sub(self.v[t[1] as usize], self.v[t[0] as usize]), sub(self.v[t[2] as usize], self.v[t[0] as usize]))))
            .sum()
    }

    /// Area-weighted vertex normals and vertex areas (a third of each adjacent triangle).
    pub fn normals_and_areas(&self) -> (Vec<V3>, Vec<f32>) {
        let mut n = vec![[0.0f32; 3]; self.v.len()];
        let mut a = vec![0.0f32; self.v.len()];
        for t in &self.f {
            let (p0, p1, p2) = (self.v[t[0] as usize], self.v[t[1] as usize], self.v[t[2] as usize]);
            let c = cross(sub(p1, p0), sub(p2, p0)); // |c| = 2 * area
            let ar = 0.5 * len(c);
            for &i in t {
                n[i as usize] = add(n[i as usize], c);
                a[i as usize] += ar / 3.0;
            }
        }
        for x in n.iter_mut() {
            *x = normalize(*x);
            if len2(*x) == 0.0 {
                *x = [0.0, 1.0, 0.0];
            }
        }
        (n, a)
    }

    /// Unique vertex neighbours in CSR form.
    pub fn adjacency(&self) -> (Vec<u32>, Vec<u32>) {
        let mut edges: Vec<u64> = Vec::with_capacity(self.f.len() * 6);
        for t in &self.f {
            for k in 0..3 {
                let (a, b) = (t[k] as u64, t[(k + 1) % 3] as u64);
                edges.push((a << 32) | b);
                edges.push((b << 32) | a);
            }
        }
        edges.sort_unstable();
        edges.dedup();
        let mut offsets = vec![0u32; self.v.len() + 1];
        for e in &edges {
            offsets[(e >> 32) as usize + 1] += 1;
        }
        for i in 0..self.v.len() {
            offsets[i + 1] += offsets[i];
        }
        let neighbors = edges.iter().map(|e| (*e & 0xffff_ffff) as u32).collect();
        (offsets, neighbors)
    }

    /// Renumbers vertices along a Morton (Z-order) curve so neighbours are close in memory.
    pub fn sort_spatially(&mut self) {
        let n = self.v.len();
        if n == 0 {
            return;
        }
        let (mut min, mut max) = ([f32::INFINITY; 3], [f32::NEG_INFINITY; 3]);
        for p in &self.v {
            for k in 0..3 {
                min[k] = min[k].min(p[k]);
                max[k] = max[k].max(p[k]);
            }
        }
        let ext = (0..3).map(|k| max[k] - min[k]).fold(0.0f32, f32::max).max(1e-12);
        let spread = |x: u32| {
            let mut x = x as u64 & 0x1f_ffff;
            x = (x | x << 32) & 0x1f_0000_0000_ffff;
            x = (x | x << 16) & 0x1f_0000_ff00_00ff;
            x = (x | x << 8) & 0x100f_00f0_0f00_f00f;
            x = (x | x << 4) & 0x10c3_0c30_c30c_30c3;
            x = (x | x << 2) & 0x1249_2492_4924_9249;
            x
        };
        let mut keys: Vec<(u64, u32)> = self
            .v
            .iter()
            .enumerate()
            .map(|(i, p)| {
                let q = |k: usize| (((p[k] - min[k]) / ext) * 2_097_151.0) as u32;
                (spread(q(0)) | spread(q(1)) << 1 | spread(q(2)) << 2, i as u32)
            })
            .collect();
        keys.sort_unstable();
        let mut remap = vec![0u32; n];
        let mut v = Vec::with_capacity(n);
        for (new, (_, old)) in keys.iter().enumerate() {
            remap[*old as usize] = new as u32;
            v.push(self.v[*old as usize]);
        }
        self.v = v;
        for t in self.f.iter_mut() {
            *t = t.map(|i| remap[i as usize]);
        }
    }

    /// Splits every edge longer than `max_len` at its midpoint (red-green refinement,
    /// so neighbouring triangles stay conforming) until none is, or `max_vertices` is reached.
    pub fn subdivide_to(&mut self, max_len: f32, max_vertices: usize) {
        let max2 = max_len * max_len;
        for _pass in 0..12 {
            let mut mids: HashMap<u64, u32> = HashMap::new();
            let key = |a: u32, b: u32| if a < b { ((a as u64) << 32) | b as u64 } else { ((b as u64) << 32) | a as u64 };
            for t in &self.f {
                for k in 0..3 {
                    let (a, b) = (t[k], t[(k + 1) % 3]);
                    if len2(sub(self.v[a as usize], self.v[b as usize])) > max2 {
                        let kk = key(a, b);
                        if !mids.contains_key(&kk) {
                            if self.v.len() >= max_vertices {
                                break;
                            }
                            let m = mul(add(self.v[a as usize], self.v[b as usize]), 0.5);
                            self.v.push(m);
                            mids.insert(kk, (self.v.len() - 1) as u32);
                        }
                    }
                }
            }
            if mids.is_empty() {
                return;
            }
            let mut out = Vec::with_capacity(self.f.len() * 2);
            for &t in &self.f {
                let m: [Option<u32>; 3] = [0, 1, 2].map(|k| mids.get(&key(t[k], t[(k + 1) % 3])).copied());
                let count = m.iter().filter(|x| x.is_some()).count();
                match count {
                    0 => out.push(t),
                    3 => {
                        let (m0, m1, m2) = (m[0].unwrap(), m[1].unwrap(), m[2].unwrap());
                        out.push([t[0], m0, m2]);
                        out.push([m0, t[1], m1]);
                        out.push([m2, m1, t[2]]);
                        out.push([m0, m1, m2]);
                    }
                    1 => {
                        // Rotate so the split edge is (t0, t1).
                        let k = m.iter().position(|x| x.is_some()).unwrap();
                        let (a, b, c) = (t[k], t[(k + 1) % 3], t[(k + 2) % 3]);
                        let mm = m[k].unwrap();
                        out.push([a, mm, c]);
                        out.push([mm, b, c]);
                    }
                    _ => {
                        // Two split edges: rotate so the unsplit one is (t2, t0).
                        let k = m.iter().position(|x| x.is_none()).unwrap();
                        let (a, b, c) = (t[(k + 1) % 3], t[(k + 2) % 3], t[k]);
                        let mab = m[(k + 1) % 3].unwrap();
                        let mbc = m[(k + 2) % 3].unwrap();
                        out.push([mab, b, mbc]);
                        // Quad (a, mab, mbc, c): split along the shorter diagonal.
                        let d1 = len2(sub(self.v[a as usize], self.v[mbc as usize]));
                        let d2 = len2(sub(self.v[mab as usize], self.v[c as usize]));
                        if d1 < d2 {
                            out.push([a, mab, mbc]);
                            out.push([a, mbc, c]);
                        } else {
                            out.push([a, mab, c]);
                            out.push([mab, mbc, c]);
                        }
                    }
                }
            }
            self.f = out;
            if self.v.len() >= max_vertices {
                return;
            }
        }
    }
}

#[cfg(test)]
pub mod tests {
    use super::*;

    /// UV sphere as a test mesh.
    pub fn sphere(rings: u32, segs: u32, r: f32) -> TriMesh {
        let mut v = vec![[0.0, r, 0.0]];
        for i in 1..rings {
            let th = std::f32::consts::PI * i as f32 / rings as f32;
            for j in 0..segs {
                let ph = 2.0 * std::f32::consts::PI * j as f32 / segs as f32;
                v.push([r * th.sin() * ph.cos(), r * th.cos(), -r * th.sin() * ph.sin()]);
            }
        }
        v.push([0.0, -r, 0.0]);
        let bottom = v.len() as u32 - 1;
        let ring = |i: u32, j: u32| 1 + (i - 1) * segs + (j % segs);
        let mut f = Vec::new();
        for j in 0..segs {
            f.push([0, ring(1, j), ring(1, j + 1)]);
            f.push([bottom, ring(rings - 1, j + 1), ring(rings - 1, j)]);
        }
        for i in 1..rings - 1 {
            for j in 0..segs {
                let (a, b, c, d) = (ring(i, j), ring(i + 1, j), ring(i + 1, j + 1), ring(i, j + 1));
                f.push([a, b, c]);
                f.push([a, c, d]);
            }
        }
        TriMesh { v, f }
    }

    pub fn flat(m: &TriMesh) -> (Vec<f32>, Vec<u32>) {
        (m.v.iter().flatten().copied().collect(), m.f.iter().flatten().copied().collect())
    }

    #[test]
    fn welds_seams_and_drops_degenerates() {
        // Two triangles sharing an edge, but with the shared vertices duplicated (a UV seam).
        let p = [0., 0., 0., 1., 0., 0., 0., 1., 0., 1., 0., 0., 0., 1., 0., 1., 1., 0., 0., 0., 0.];
        let i = [0, 1, 2, 3, 5, 4, 0, 0, 1];
        let m = TriMesh::welded(&p, Some(&i));
        assert_eq!(m.v.len(), 4);
        assert_eq!(m.f.len(), 2);
    }

    #[test]
    fn subdivision_is_conforming() {
        let mut m = sphere(6, 8, 1.0);
        let area = m.area();
        m.subdivide_to(0.2, 1_000_000);
        for t in &m.f {
            for k in 0..3 {
                assert!(len(sub(m.v[t[k] as usize], m.v[t[(k + 1) % 3] as usize])) <= 0.2 + 1e-5);
            }
        }
        // Closed and conforming: every edge is shared by exactly two triangles.
        let mut count: HashMap<(u32, u32), i32> = HashMap::new();
        for t in &m.f {
            for k in 0..3 {
                let (a, b) = (t[k], t[(k + 1) % 3]);
                *count.entry((a.min(b), a.max(b))).or_default() += 1;
            }
        }
        assert!(count.values().all(|&c| c == 2));
        assert!((m.area() - area).abs() < 1e-3 * area);
    }
}
