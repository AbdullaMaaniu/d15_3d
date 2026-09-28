//! Field-aligned quad remeshing, after Instant Field-Aligned Meshes (Jakob, Tarini,
//! Panozzo, Sorkine-Hornung 2015):
//!
//! 1. A multi-resolution hierarchy of the input vertex graph.
//! 2. A smooth 4-RoSy orientation field (which way the quad edges run), optimized
//!    coarse to fine by Gauss-Seidel averaging of the closest symmetric directions.
//! 3. A position field: every vertex picks a lattice origin in its tangent plane so
//!    neighbouring lattices agree (spacing = target edge length).
//! 4. Extraction: graph edges whose endpoints round to the same lattice point collapse
//!    into one output vertex; edges one lattice step apart become output edges.
//! 5. Faces are traced from the angular order of edges around each vertex, holes and
//!    irregular polygons are split into quads, and vertices are relaxed and snapped
//!    back onto the input surface.

use crate::geom::*;
use crate::trimesh::TriMesh;

pub struct QuadMesh {
    pub v: Vec<V3>,
    /// Size of each face (3 or 4); `idx` holds the vertex indices of all faces, concatenated.
    pub sizes: Vec<u8>,
    pub idx: Vec<u32>,
    /// Vertex normals interpolated from the input's smooth normals (empty = not computed).
    pub n: Vec<V3>,
}

impl QuadMesh {
    pub fn face_count(&self) -> usize {
        self.sizes.len()
    }
    pub fn quad_count(&self) -> usize {
        self.sizes.iter().filter(|&&s| s == 4).count()
    }
    /// Triangulates quads along their shorter diagonal.
    pub fn triangles(&self) -> Vec<[u32; 3]> {
        let mut out = Vec::with_capacity(self.sizes.len() * 2);
        let mut o = 0;
        for &s in &self.sizes {
            let f = &self.idx[o..o + s as usize];
            if s == 3 {
                out.push([f[0], f[1], f[2]]);
            } else {
                let d02 = len2(sub(self.v[f[0] as usize], self.v[f[2] as usize]));
                let d13 = len2(sub(self.v[f[1] as usize], self.v[f[3] as usize]));
                if d02 <= d13 {
                    out.push([f[0], f[1], f[2]]);
                    out.push([f[0], f[2], f[3]]);
                } else {
                    out.push([f[0], f[1], f[3]]);
                    out.push([f[1], f[2], f[3]]);
                }
            }
            o += s as usize;
        }
        out
    }
}

pub struct QuadOptions {
    pub target_faces: usize,
    pub seed: u64,
    /// Gauss-Seidel sweeps per hierarchy level.
    pub iterations: usize,
    /// Cap on the (subdivided) input size.
    pub max_input_vertices: usize,
}

impl Default for QuadOptions {
    fn default() -> Self {
        QuadOptions { target_faces: 10_000, seed: 1, iterations: 6, max_input_vertices: 2_500_000 }
    }
}

struct Level {
    v: Vec<V3>,
    n: Vec<V3>,
    a: Vec<f32>,
    off: Vec<u32>,
    nbr: Vec<u32>,
    /// Children in the next finer level (u32::MAX = none). Empty on the finest level.
    children: Vec<[u32; 2]>,
}

impl Level {
    fn nbrs(&self, i: usize) -> &[u32] {
        &self.nbr[self.off[i] as usize..self.off[i + 1] as usize]
    }
}

fn csr_from_pairs(n: usize, mut pairs: Vec<u64>) -> (Vec<u32>, Vec<u32>) {
    pairs.sort_unstable();
    pairs.dedup();
    let mut off = vec![0u32; n + 1];
    for p in &pairs {
        off[(p >> 32) as usize + 1] += 1;
    }
    for i in 0..n {
        off[i + 1] += off[i];
    }
    (off, pairs.iter().map(|p| (*p & 0xffff_ffff) as u32).collect())
}

/// Coarsens the graph by merging matched pairs of neighbours until it is small.
fn build_hierarchy(finest: Level) -> Vec<Level> {
    let mut levels = vec![finest];
    while levels.len() < 40 {
        let l = levels.last().unwrap();
        let n = l.v.len();
        if n <= 64 {
            break;
        }
        // Prefer merging neighbours with similar normals. (Also weighing areas makes hubs
        // that stop the coarsening early.)
        let mut cand: Vec<(f32, u32, u32)> = Vec::with_capacity(l.nbr.len() / 2);
        for i in 0..n {
            for &j in l.nbrs(i) {
                if (i as u32) < j {
                    let j = j as usize;
                    cand.push((dot(l.n[i], l.n[j]), i as u32, j as u32));
                }
            }
        }
        cand.sort_unstable_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
        let mut parent = vec![u32::MAX; n];
        let mut children: Vec<[u32; 2]> = Vec::with_capacity(n / 2 + 1);
        for &(_, i, j) in &cand {
            if parent[i as usize] == u32::MAX && parent[j as usize] == u32::MAX {
                parent[i as usize] = children.len() as u32;
                parent[j as usize] = children.len() as u32;
                children.push([i, j]);
            }
        }
        for i in 0..n {
            if parent[i] == u32::MAX {
                parent[i] = children.len() as u32;
                children.push([i as u32, u32::MAX]);
            }
        }
        let m = children.len();
        if m as f32 > 0.92 * n as f32 {
            break;
        }
        let mut v = vec![[0.0f32; 3]; m];
        let mut nn = vec![[0.0f32; 3]; m];
        let mut a = vec![0.0f32; m];
        for (c, ch) in children.iter().enumerate() {
            let mut area = 0.0;
            let (mut ps, mut ns) = ([0.0f32; 3], [0.0f32; 3]);
            for &k in ch {
                if k == u32::MAX {
                    continue;
                }
                let k = k as usize;
                let w = l.a[k].max(1e-12);
                area += w;
                ps = add(ps, mul(l.v[k], w));
                ns = add(ns, mul(l.n[k], w));
            }
            v[c] = mul(ps, 1.0 / area);
            nn[c] = normalize(ns);
            if len2(nn[c]) == 0.0 {
                nn[c] = l.n[ch[0] as usize];
            }
            a[c] = area;
        }
        let mut pairs = Vec::with_capacity(l.nbr.len());
        for i in 0..n {
            for &j in l.nbrs(i) {
                let (pi, pj) = (parent[i] as u64, parent[j as usize] as u64);
                if pi != pj {
                    pairs.push((pi << 32) | pj);
                }
            }
        }
        let (off, nbr) = csr_from_pairs(m, pairs);
        levels.push(Level { v, n: nn, a, off, nbr, children });
    }
    levels
}

#[inline(always)]
fn compat_orientation(q0: V3, n0: V3, q1: V3, n1: V3) -> (V3, V3) {
    let a = [q0, cross(n0, q0)];
    let b = [q1, cross(n1, q1)];
    let (mut best, mut bi, mut bj) = (-1.0f32, 0, 0);
    for i in 0..2 {
        for j in 0..2 {
            let s = dot(a[i], b[j]).abs();
            if s > best {
                best = s;
                bi = i;
                bj = j;
            }
        }
    }
    let sign = if dot(a[bi], b[bj]) < 0.0 { -1.0 } else { 1.0 };
    (a[bi], mul(b[bj], sign))
}

/// Which 90° rotations of q0 and q1 line up best (second index includes the sign: 0..4).
#[inline(always)]
fn compat_orientation_index(q0: V3, n0: V3, q1: V3, n1: V3) -> (usize, usize) {
    let a = [q0, cross(n0, q0)];
    let b = [q1, cross(n1, q1)];
    let (mut best, mut bi, mut bj) = (-1.0f32, 0, 0);
    for i in 0..2 {
        for j in 0..2 {
            let s = dot(a[i], b[j]).abs();
            if s > best {
                best = s;
                bi = i;
                bj = j;
            }
        }
    }
    if dot(a[bi], b[bj]) < 0.0 {
        bj += 2;
    }
    (bi, bj)
}

#[inline(always)]
fn rotate90_by(mut q: V3, n: V3, k: usize) -> V3 {
    for _ in 0..k {
        q = cross(n, q);
    }
    q
}

/// The point closest to both p0 and p1 that lies in both tangent planes (least squares).
#[inline(always)]
fn middle_point(p0: V3, n0: V3, p1: V3, n1: V3) -> V3 {
    let (n0p0, n0p1, n1p0, n1p1, n0n1) = (dot(n0, p0), dot(n0, p1), dot(n1, p0), dot(n1, p1), dot(n0, n1));
    let denom = 1.0 / (1.0 - n0n1 * n0n1 + 1e-4);
    let l0 = 2.0 * (n0p1 - n0p0 - n0n1 * (n1p0 - n1p1)) * denom;
    let l1 = 2.0 * (n1p0 - n1p1 - n0n1 * (n0p1 - n0p0)) * denom;
    sub(mul(add(p0, p1), 0.5), mul(add(mul(n0, l0), mul(n1, l1)), 0.25))
}

#[inline(always)]
fn floor_index(o: V3, q: V3, n: V3, p: V3, inv_h: f32) -> (i32, i32) {
    let t = cross(n, q);
    let d = sub(p, o);
    ((dot(q, d) * inv_h).floor() as i32, (dot(t, d) * inv_h).floor() as i32)
}

#[inline(always)]
fn lattice(o: V3, q: V3, n: V3, i: i32, j: i32, h: f32) -> V3 {
    add(o, add(mul(q, i as f32 * h), mul(cross(n, q), j as f32 * h)))
}

/// Lattice points of both vertices (and their integer indices) that are closest to each other.
#[inline(always)]
#[allow(clippy::too_many_arguments)]
fn compat_position(p0: V3, n0: V3, q0: V3, o0: V3, p1: V3, n1: V3, q1: V3, o1: V3, h: f32, inv_h: f32) -> (V3, V3, (i32, i32), (i32, i32)) {
    let mid = middle_point(p0, n0, p1, n1);
    let (a0, b0) = floor_index(o0, q0, n0, mid, inv_h);
    let (a1, b1) = floor_index(o1, q1, n1, mid, inv_h);
    let mut best = (f32::INFINITY, [0.0; 3], [0.0; 3], (0, 0), (0, 0));
    for i in 0..4 {
        let (x0, y0) = (a0 + (i & 1), b0 + ((i >> 1) & 1));
        let l0 = lattice(o0, q0, n0, x0, y0, h);
        for j in 0..4 {
            let (x1, y1) = (a1 + (j & 1), b1 + ((j >> 1) & 1));
            let l1 = lattice(o1, q1, n1, x1, y1, h);
            let c = len2(sub(l0, l1));
            if c < best.0 {
                best = (c, l0, l1, (x0, y0), (x1, y1));
            }
        }
    }
    (best.1, best.2, best.3, best.4)
}

#[inline(always)]
fn position_round(o: V3, q: V3, n: V3, p: V3, h: f32, inv_h: f32) -> V3 {
    let t = cross(n, q);
    let d = sub(p, o);
    add(o, add(mul(q, (dot(q, d) * inv_h).round() * h), mul(t, (dot(t, d) * inv_h).round() * h)))
}

fn smooth_orientation(l: &Level, q: &mut [V3], iterations: usize) {
    for _ in 0..iterations {
        for i in 0..l.v.len() {
            let ni = l.n[i];
            let mut sum = q[i];
            let mut w = 0.0f32;
            for &j in l.nbrs(i) {
                let j = j as usize;
                let (a, b) = compat_orientation(sum, ni, q[j], l.n[j]);
                sum = add(mul(a, w), b);
                w += 1.0;
                sum = normalize(project_out(sum, ni));
                if len2(sum) == 0.0 {
                    sum = q[i];
                }
            }
            q[i] = sum;
        }
    }
}

/// Lattice points of both vertices that are closest to each other, found cheaply: the
/// lattice point of vertex 0 nearest to the middle point, then vertex 1's nearest to that.
/// (Same quality as searching the 4x4 candidates around the middle, at a fraction of the cost.)
#[inline(always)]
#[allow(clippy::too_many_arguments)]
fn compat_position_fast(p0: V3, n0: V3, q0: V3, t0: V3, o0: V3, p1: V3, n1: V3, q1: V3, t1: V3, o1: V3, h: f32, inv_h: f32) -> (V3, V3) {
    let mid = middle_point(p0, n0, p1, n1);
    let round = |o: V3, q: V3, t: V3, p: V3| {
        let d = sub(p, o);
        add(o, add(mul(q, (dot(q, d) * inv_h).round() * h), mul(t, (dot(t, d) * inv_h).round() * h)))
    };
    let a = round(o0, q0, t0, mid);
    (a, round(o1, q1, t1, a))
}

fn smooth_positions(l: &Level, q: &[V3], o: &mut [V3], h: f32, iterations: usize) {
    let inv_h = 1.0 / h;
    let t: Vec<V3> = (0..l.v.len()).map(|i| cross(l.n[i], q[i])).collect();
    for _ in 0..iterations {
        for i in 0..l.v.len() {
            let (vi, ni, qi, ti) = (l.v[i], l.n[i], q[i], t[i]);
            let mut sum = o[i];
            let mut w = 0.0f32;
            for &j in l.nbrs(i) {
                let j = j as usize;
                let (a, b) = compat_position_fast(vi, ni, qi, ti, sum, l.v[j], l.n[j], q[j], t[j], o[j], h, inv_h);
                sum = mul(add(mul(a, w), b), 1.0 / (w + 1.0));
                w += 1.0;
                sum = sub(sum, mul(ni, dot(ni, sub(sum, vi))));
            }
            o[i] = position_round(sum, qi, ni, vi, h, inv_h);
        }
    }
}

/// Orientation field on every level, finest last (levels[0]).
fn orientation_field(levels: &[Level], rng: &mut Rng, iterations: usize) -> Vec<V3> {
    let top = levels.len() - 1;
    let mut q: Vec<V3> = levels[top]
        .n
        .iter()
        .map(|&n| {
            let r = normalize(project_out([rng.signed(), rng.signed(), rng.signed()], n));
            if len2(r) == 0.0 { any_perpendicular(n) } else { r }
        })
        .collect();
    for li in (0..=top).rev() {
        smooth_orientation(&levels[li], &mut q, if li == 0 { (iterations / 2).max(2) } else { iterations });
        if li > 0 {
            let fine = &levels[li - 1];
            let mut qf = vec![[0.0f32; 3]; fine.v.len()];
            for (c, ch) in levels[li].children.iter().enumerate() {
                for &k in ch {
                    if k != u32::MAX {
                        let r = normalize(project_out(q[c], fine.n[k as usize]));
                        qf[k as usize] = if len2(r) == 0.0 { any_perpendicular(fine.n[k as usize]) } else { r };
                    }
                }
            }
            q = qf;
        }
    }
    q
}

/// Position field given the finest orientation field (coarser levels get it by restriction).
fn position_field(levels: &[Level], q_fine: &[V3], h: f32, iterations: usize) -> Vec<V3> {
    // Restrict the orientation field to every level (first child's value, projected).
    let mut qs: Vec<Vec<V3>> = vec![q_fine.to_vec()];
    for li in 1..levels.len() {
        let prev = &qs[li - 1];
        let l = &levels[li];
        let qv = l
            .children
            .iter()
            .enumerate()
            .map(|(c, ch)| {
                let r = normalize(project_out(prev[ch[0] as usize], l.n[c]));
                if len2(r) == 0.0 { any_perpendicular(l.n[c]) } else { r }
            })
            .collect();
        qs.push(qv);
    }
    let top = levels.len() - 1;
    let mut o = levels[top].v.clone();
    for li in (0..=top).rev() {
        // Levels far coarser than the lattice can't resolve it; only fix up their origins.
        let spacing = (levels[li].a.iter().sum::<f32>() / levels[li].v.len().max(1) as f32).sqrt();
        let it = if li == 0 { (iterations / 2).max(2) } else if spacing > 4.0 * h { 1 } else { iterations };
        smooth_positions(&levels[li], &qs[li], &mut o, h, it);
        if li > 0 {
            let fine = &levels[li - 1];
            let mut of = vec![[0.0f32; 3]; fine.v.len()];
            for (c, ch) in levels[li].children.iter().enumerate() {
                for &k in ch {
                    if k != u32::MAX {
                        let (vk, nk) = (fine.v[k as usize], fine.n[k as usize]);
                        of[k as usize] = sub(o[c], mul(nk, dot(nk, sub(o[c], vk))));
                    }
                }
            }
            o = of;
        }
    }
    o
}

fn find(parent: &mut [u32], mut x: u32) -> u32 {
    while parent[x as usize] != x {
        parent[x as usize] = parent[parent[x as usize] as usize];
        x = parent[x as usize];
    }
    x
}

/// Output vertices (positions, normals) and edges from the fields.
fn extract_graph(l: &Level, q: &[V3], o: &[V3], h: f32) -> (Vec<V3>, Vec<V3>, Vec<Vec<u32>>) {
    let n = l.v.len();
    let inv_h = 1.0 / h;
    let mut parent: Vec<u32> = (0..n as u32).collect();
    let mut keep: Vec<(u32, u32)> = Vec::new();
    for i in 0..n {
        for &j in l.nbrs(i) {
            let j = j as usize;
            if j <= i {
                continue;
            }
            let (ri, rj) = compat_orientation_index(q[i], l.n[i], q[j], l.n[j]);
            let qj = rotate90_by(q[j], l.n[j], (rj + 4 - ri) % 4);
            let (_, _, si, sj) = compat_position(l.v[i], l.n[i], q[i], o[i], l.v[j], l.n[j], qj, o[j], h, inv_h);
            let (dx, dy) = ((si.0 - sj.0).abs(), (si.1 - sj.1).abs());
            if dx + dy == 0 {
                let (a, b) = (find(&mut parent, i as u32), find(&mut parent, j as u32));
                if a != b {
                    parent[a as usize] = b;
                }
            } else if dx + dy == 1 {
                keep.push((i as u32, j as u32));
            }
        }
    }
    let mut cluster = vec![u32::MAX; n];
    let mut count = 0u32;
    for i in 0..n {
        let r = find(&mut parent, i as u32) as usize;
        if cluster[r] == u32::MAX {
            cluster[r] = count;
            count += 1;
        }
        cluster[i] = cluster[r];
    }
    let m = count as usize;
    let mut pos = vec![[0.0f32; 3]; m];
    let mut nrm = vec![[0.0f32; 3]; m];
    let mut w = vec![0.0f32; m];
    for i in 0..n {
        let c = cluster[i] as usize;
        let a = l.a[i].max(1e-12);
        pos[c] = add(pos[c], mul(o[i], a));
        nrm[c] = add(nrm[c], mul(l.n[i], a));
        w[c] += a;
    }
    for c in 0..m {
        pos[c] = mul(pos[c], 1.0 / w[c]);
        nrm[c] = normalize(nrm[c]);
        if len2(nrm[c]) == 0.0 {
            nrm[c] = [0.0, 1.0, 0.0];
        }
    }
    let mut adj: Vec<Vec<u32>> = vec![Vec::new(); m];
    for (i, j) in keep {
        let (a, b) = (cluster[i as usize], cluster[j as usize]);
        if a != b {
            adj[a as usize].push(b);
            adj[b as usize].push(a);
        }
    }
    for list in adj.iter_mut() {
        list.sort_unstable();
        list.dedup();
    }
    (pos, nrm, adj)
}

/// Splits a closed walk that revisits vertices into simple cycles.
fn simple_cycles(walk: &[u32]) -> Vec<Vec<u32>> {
    let mut out = Vec::new();
    let mut stack: Vec<u32> = Vec::new();
    for &v in walk {
        if let Some(p) = stack.iter().position(|&x| x == v) {
            let cyc: Vec<u32> = stack.drain(p..).collect();
            if cyc.len() >= 3 {
                out.push(cyc);
            }
        }
        stack.push(v);
    }
    if stack.len() >= 3 {
        out.push(stack);
    }
    out
}

/// Traces faces from the angular order of edges around each vertex.
fn extract_faces(pos: &mut Vec<V3>, nrm: &mut Vec<V3>, mut adj: Vec<Vec<u32>>) -> QuadMesh {
    // Drop dangling vertices and edges.
    loop {
        let mut changed = false;
        for i in 0..adj.len() {
            if adj[i].len() == 1 {
                let j = adj[i][0] as usize;
                adj[i].clear();
                adj[j].retain(|&x| x as usize != i);
                changed = true;
            }
        }
        if !changed {
            break;
        }
    }
    // Sort neighbours counter-clockwise around each vertex normal.
    for i in 0..adj.len() {
        if adj[i].len() < 2 {
            continue;
        }
        let n = nrm[i];
        let e1 = any_perpendicular(n);
        let e2 = cross(n, e1);
        let p = pos[i];
        let mut with_angle: Vec<(f32, u32)> = adj[i]
            .iter()
            .map(|&j| {
                let d = sub(pos[j as usize], p);
                (dot(d, e2).atan2(dot(d, e1)), j)
            })
            .collect();
        with_angle.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
        adj[i] = with_angle.into_iter().map(|x| x.1).collect();
    }
    let mut off = vec![0usize; adj.len() + 1];
    for i in 0..adj.len() {
        off[i + 1] = off[i] + adj[i].len();
    }
    let mut used = vec![false; off[adj.len()]];
    let mut out = QuadMesh { v: Vec::new(), sizes: Vec::new(), idx: Vec::new(), n: Vec::new() };
    let mut polys: Vec<Vec<u32>> = Vec::new();
    for u in 0..adj.len() {
        for k in 0..adj[u].len() {
            if used[off[u] + k] {
                continue;
            }
            let mut walk = vec![u as u32];
            let (mut a, mut ka) = (u, k);
            let mut closed = false;
            for _ in 0..64 {
                used[off[a] + ka] = true;
                let b = adj[a][ka] as usize;
                // At b, turn to the neighbour just clockwise of where we came from.
                let pos_a = match adj[b].iter().position(|&x| x as usize == a) {
                    Some(p) => p,
                    None => break,
                };
                let kb = (pos_a + adj[b].len() - 1) % adj[b].len();
                if b == u && kb == k {
                    closed = true;
                    break;
                }
                if used[off[b] + kb] {
                    break;
                }
                walk.push(b as u32);
                a = b;
                ka = kb;
            }
            if closed {
                polys.extend(simple_cycles(&walk));
            }
        }
    }
    let push = |out: &mut QuadMesh, f: &[u32]| {
        out.sizes.push(f.len() as u8);
        out.idx.extend_from_slice(f);
    };
    for p in polys {
        let k = p.len();
        match k {
            3 | 4 => push(&mut out, &p),
            5..=24 => {
                // A centre vertex and a ring of quads (only new edges, so the result stays manifold).
                let c = pos.len() as u32;
                let mut centre = [0.0f32; 3];
                let mut cn = [0.0f32; 3];
                for &x in &p {
                    centre = add(centre, pos[x as usize]);
                    cn = add(cn, nrm[x as usize]);
                }
                pos.push(mul(centre, 1.0 / k as f32));
                nrm.push(normalize(cn));
                let mut i = 0;
                while i + 2 <= k {
                    push(&mut out, &[c, p[i], p[(i + 1) % k], p[(i + 2) % k]]);
                    i += 2;
                }
                if i < k {
                    push(&mut out, &[c, p[i], p[(i + 1) % k]]);
                }
            }
            _ => {} // Boundary of an open surface (or a failed region): leave open.
        }
    }
    out.v = pos.clone();
    out
}

/// Removes unused vertices.
fn compact(m: &mut QuadMesh, nrm: &mut Vec<V3>) {
    let mut map = vec![u32::MAX; m.v.len()];
    let mut v = Vec::new();
    let mut n = Vec::new();
    for x in m.idx.iter_mut() {
        let i = *x as usize;
        if map[i] == u32::MAX {
            map[i] = v.len() as u32;
            v.push(m.v[i]);
            n.push(nrm[i]);
        }
        *x = map[i];
    }
    m.v = v;
    *nrm = n;
}

/// Tangential relaxation of the output vertices, snapping them back onto the input surface.
fn relax_and_project(m: &mut QuadMesh, nrm: &mut [V3], bvh: &Bvh, iterations: usize) {
    let nv = m.v.len();
    let mut pairs: Vec<u64> = Vec::new();
    let mut edge_faces: std::collections::HashMap<u64, u8> = std::collections::HashMap::new();
    let mut o = 0;
    for &s in &m.sizes {
        let f = &m.idx[o..o + s as usize];
        for k in 0..s as usize {
            let (a, b) = (f[k] as u64, f[(k + 1) % s as usize] as u64);
            pairs.push((a << 32) | b);
            pairs.push((b << 32) | a);
            *edge_faces.entry(a.min(b) << 32 | a.max(b)).or_default() += 1;
        }
        o += s as usize;
    }
    let mut boundary = vec![false; nv];
    for (&e, &c) in &edge_faces {
        if c == 1 {
            boundary[(e >> 32) as usize] = true;
            boundary[(e & 0xffff_ffff) as usize] = true;
        }
    }
    let (off, nbr) = csr_from_pairs(nv, pairs);
    let snap = |p: V3, n: V3, hint: Option<u32>| bvh.closest(p, Some(n), hint, f32::INFINITY);
    let mut hints = vec![u32::MAX; nv];
    for i in 0..nv {
        if let Some(hit) = snap(m.v[i], nrm[i], None) {
            m.v[i] = hit.point;
            hints[i] = hit.tri;
        }
    }
    for _ in 0..iterations {
        let prev = m.v.clone();
        for i in 0..nv {
            let ns = &nbr[off[i] as usize..off[i + 1] as usize];
            if boundary[i] || ns.is_empty() {
                continue;
            }
            let mut c = [0.0f32; 3];
            for &j in ns {
                c = add(c, prev[j as usize]);
            }
            c = mul(c, 1.0 / ns.len() as f32);
            let moved = add(prev[i], mul(project_out(sub(c, prev[i]), nrm[i]), 0.5));
            let hint = if hints[i] == u32::MAX { None } else { Some(hints[i]) };
            if let Some(hit) = snap(moved, nrm[i], hint) {
                m.v[i] = hit.point;
                hints[i] = hit.tri;
            }
        }
    }
}

/// Runs the whole pipeline on a welded triangle mesh.
pub fn quad_remesh(input: &TriMesh, opts: &QuadOptions) -> QuadMesh {
    // Timings for native debugging only (wasm32-unknown-unknown has no clock).
    let dbg = cfg!(not(target_arch = "wasm32")) && std::env::var("RF_DEBUG").is_ok();
    let t0 = if dbg { Some(std::time::Instant::now()) } else { None };
    let lap = |what: &str| {
        if let Some(t) = t0 {
            eprintln!("  {what}: {:.0} ms", t.elapsed().as_secs_f64() * 1000.0)
        }
    };
    let target = opts.target_faces.max(8) as f32;
    let h0 = (input.area() / target).sqrt();
    // Parts too small for the lattice (eyes, buttons) keep their own triangles.
    // Parts too small or too thin for the lattice (eyes, lenses, straps) keep their own triangles.
    let (big, small) = split_small_components(input, h0, target);
    let area = big.area().max(1e-12);
    let target = (target - small.f.len() as f32).max(8.0);
    let mut h = (area / target).sqrt();
    let mut mesh = big.clone();
    // Input edges up to the target length: finer costs time without better quads.
    mesh.subdivide_to(h, opts.max_input_vertices);
    mesh.sort_spatially();
    lap(&format!("subdivide -> {} verts", mesh.v.len()));
    let (n, a) = mesh.normals_and_areas();
    let (off, nbr) = mesh.adjacency();
    let finest = Level { v: mesh.v.clone(), n, a, off, nbr, children: Vec::new() };
    let levels = build_hierarchy(finest);
    lap(&format!("hierarchy {:?}", levels.iter().map(|l| l.v.len()).collect::<Vec<_>>()));
    let mut rng = Rng::new(opts.seed);
    let q = orientation_field(&levels, &mut rng, opts.iterations);
    lap("orientation");
    let bvh = Bvh::new(&big.v, &big.f);

    let mut best: Option<QuadMesh> = None;
    let mut best_err = f32::INFINITY;
    for _attempt in 0..3 {
        let o = position_field(&levels, &q, h, opts.iterations);
        lap("positions");
        let (mut pos, mut nrm, adj) = extract_graph(&levels[0], &q, &o, h);
        let mut out = extract_faces(&mut pos, &mut nrm, adj);
        compact(&mut out, &mut nrm);
        lap(&format!("extract -> {} faces", out.face_count()));
        let faces = out.face_count().max(1) as f32;
        let err = (faces / target - 1.0).abs();
        let done = err < 0.08;
        if err < best_err {
            relax_and_project(&mut out, &mut nrm, &bvh, 3);
            lap("relax");
            best_err = err;
            best = Some(out);
        }
        if done {
            break;
        }
        // Face count scales with 1/h²: correct the edge length and try again.
        h *= (faces / target).sqrt();
    }
    let mut out = best.unwrap();
    // Shade like the input: its smooth normals, interpolated where each vertex landed.
    let (in_n, _) = big.normals_and_areas();
    out.n = out
        .v
        .iter()
        .map(|&p| match bvh.closest(p, None, None, f32::INFINITY) {
            Some(hit) => {
                let [a, b, c] = big.f[hit.tri as usize];
                let n = add(add(mul(in_n[a as usize], hit.bary[0]), mul(in_n[b as usize], hit.bary[1])), mul(in_n[c as usize], hit.bary[2]));
                normalize(n)
            }
            None => [0.0, 1.0, 0.0],
        })
        .collect();
    let base = out.v.len() as u32;
    let (small_n, _) = small.normals_and_areas();
    out.v.extend_from_slice(&small.v);
    out.n.extend_from_slice(&small_n);
    for t in &small.f {
        out.sizes.push(3);
        out.idx.extend(t.iter().map(|&i| i + base));
    }
    out
}

/// Splits off connected components that can't hold a quad grid at edge length `h`: less
/// than 3 h² of area, or thinner than h (2·volume/area, about a tube's radius, below h/2).
/// They keep their triangles (the quads get the rest of the face budget); only if they
/// would take over half the budget are they simplified by vertex clustering.
fn split_small_components(m: &TriMesh, h: f32, target: f32) -> (TriMesh, TriMesh) {
    let mut parent: Vec<u32> = (0..m.v.len() as u32).collect();
    for t in &m.f {
        for k in 1..3 {
            let (a, b) = (find(&mut parent, t[0]), find(&mut parent, t[k]));
            if a != b {
                parent[a as usize] = b;
            }
        }
    }
    let mut comp_area = vec![0.0f32; m.v.len()];
    let mut comp_vol = vec![0.0f32; m.v.len()];
    for t in &m.f {
        let r = find(&mut parent, t[0]) as usize;
        let (a, b, c) = (m.v[t[0] as usize], m.v[t[1] as usize], m.v[t[2] as usize]);
        comp_area[r] += 0.5 * len(cross(sub(b, a), sub(c, a)));
        comp_vol[r] += dot(a, cross(b, c)) / 6.0;
    }
    // Thickness only means something for closed parts: open sheets (clothing shells) have
    // no inside, and remesh fine as sheets.
    let mut edges: std::collections::HashMap<(u32, u32), u32> = std::collections::HashMap::new();
    for t in &m.f {
        for k in 0..3 {
            let (a, b) = (t[k], t[(k + 1) % 3]);
            *edges.entry((a.min(b), a.max(b))).or_default() += 1;
        }
    }
    let mut comp_open = vec![0u32; m.v.len()];
    let mut comp_edges = vec![0u32; m.v.len()];
    for (&(a, _), &c) in &edges {
        let r = find(&mut parent, a) as usize;
        comp_edges[r] += 1;
        if c == 1 {
            comp_open[r] += 1;
        }
    }
    let small_comp = |r: usize| {
        let closed = comp_open[r] * 50 <= comp_edges[r];
        comp_area[r] < 3.0 * h * h || (closed && 2.0 * comp_vol[r].abs() / comp_area[r].max(1e-12) < 0.5 * h)
    };
    if cfg!(not(target_arch = "wasm32")) && std::env::var("RF_DEBUG").is_ok() {
        let mut tris = vec![0u32; m.v.len()];
        for t in &m.f {
            tris[find(&mut parent, t[0]) as usize] += 1;
        }
        for r in 0..m.v.len() {
            if tris[r] > 0 && small_comp(r) {
                eprintln!("  small part: {} tris, area {:.1} h², thickness {:.2} h, open {}/{}", tris[r], comp_area[r] / (h * h), 2.0 * comp_vol[r].abs() / comp_area[r].max(1e-12) / h, comp_open[r], comp_edges[r]);
            }
        }
    }
    let mut big = TriMesh { v: Vec::new(), f: Vec::new() };
    let mut small = TriMesh { v: Vec::new(), f: Vec::new() };
    let mut map_big = vec![u32::MAX; m.v.len()];
    let mut map_small = vec![u32::MAX; m.v.len()];
    for t in &m.f {
        let r = find(&mut parent, t[0]) as usize;
        let (dst, map) = if small_comp(r) { (&mut small, &mut map_small) } else { (&mut big, &mut map_big) };
        let tri = t.map(|i| {
            if map[i as usize] == u32::MAX {
                map[i as usize] = dst.v.len() as u32;
                dst.v.push(m.v[i as usize]);
            }
            map[i as usize]
        });
        dst.f.push(tri);
    }
    if small.f.len() as f32 > 0.5 * target {
        small = cluster(&small, 0.5 * h);
    }
    (big, small)
}

/// Vertex clustering on a grid (per connected component, so parts never merge).
fn cluster(m: &TriMesh, cell: f32) -> TriMesh {
    let mut parent: Vec<u32> = (0..m.v.len() as u32).collect();
    for t in &m.f {
        for k in 1..3 {
            let (a, b) = (find(&mut parent, t[0]), find(&mut parent, t[k]));
            if a != b {
                parent[a as usize] = b;
            }
        }
    }
    let mut cells: std::collections::HashMap<(u32, i64, i64, i64), u32> = std::collections::HashMap::new();
    let mut sum: Vec<(V3, f32)> = Vec::new();
    let mut remap = vec![0u32; m.v.len()];
    for (i, p) in m.v.iter().enumerate() {
        let r = find(&mut parent, i as u32);
        let key = (r, (p[0] / cell).floor() as i64, (p[1] / cell).floor() as i64, (p[2] / cell).floor() as i64);
        let c = *cells.entry(key).or_insert_with(|| {
            sum.push(([0.0; 3], 0.0));
            (sum.len() - 1) as u32
        });
        sum[c as usize].0 = add(sum[c as usize].0, *p);
        sum[c as usize].1 += 1.0;
        remap[i] = c;
    }
    let mut seen = std::collections::HashSet::new();
    let f = m
        .f
        .iter()
        .map(|t| t.map(|i| remap[i as usize]))
        .filter(|t| t[0] != t[1] && t[1] != t[2] && t[0] != t[2])
        .filter(|t| {
            let mut k = *t;
            k.sort_unstable();
            seen.insert(k)
        })
        .collect();
    TriMesh { v: sum.iter().map(|(p, w)| mul(*p, 1.0 / w.max(1.0))).collect(), f }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::trimesh::tests::sphere;
    use std::collections::HashMap;

    fn torus(rings: u32, segs: u32, big: f32, small: f32) -> TriMesh {
        let mut v = Vec::new();
        for i in 0..rings {
            let th = 2.0 * std::f32::consts::PI * i as f32 / rings as f32;
            for j in 0..segs {
                let ph = 2.0 * std::f32::consts::PI * j as f32 / segs as f32;
                let r = big + small * ph.cos();
                v.push([r * th.cos(), small * ph.sin(), r * th.sin()]);
            }
        }
        let id = |i: u32, j: u32| (i % rings) * segs + (j % segs);
        let mut f = Vec::new();
        for i in 0..rings {
            for j in 0..segs {
                f.push([id(i, j), id(i, j + 1), id(i + 1, j + 1)]);
                f.push([id(i, j), id(i + 1, j + 1), id(i + 1, j)]);
            }
        }
        TriMesh { v, f }
    }

    fn check(m: &QuadMesh, target: usize, euler: i64) {
        let faces = m.face_count();
        let quads = m.quad_count();
        assert!((faces as f32 / target as f32 - 1.0).abs() < 0.2, "faces {faces} for target {target}");
        // Singularities (a sphere needs 8) cost a few non-quads each: a bigger share when tiny.
        let min_share = if target < 1000 { 0.85 } else { 0.9 };
        assert!(quads as f32 > min_share * faces as f32, "{quads} quads of {faces}");
        // Every edge used at most twice, in opposite directions (oriented 2-manifold).
        let mut dir: HashMap<(u32, u32), u32> = HashMap::new();
        let mut o = 0;
        for &s in &m.sizes {
            for k in 0..s as usize {
                let e = (m.idx[o + k], m.idx[o + (k + 1) % s as usize]);
                *dir.entry(e).or_default() += 1;
            }
            o += s as usize;
        }
        assert!(dir.values().all(|&c| c == 1), "an edge is used twice in the same direction");
        let edges = dir.keys().filter(|(a, b)| a < b || !dir.contains_key(&(*b, *a))).count() as i64;
        let boundary = dir.keys().filter(|(a, b)| !dir.contains_key(&(*b, *a))).count();
        if boundary == 0 {
            // A traced face that passes a vertex twice is split there, which can pinch
            // that vertex; allow a couple of those.
            let chi = m.v.len() as i64 - edges + faces as i64;
            assert!((chi - euler).abs() <= 2, "Euler characteristic {chi}, expected {euler}");
        }
    }

    #[test]
    fn sphere_becomes_quads() {
        let s = sphere(40, 60, 1.0);
        for target in [300, 2000] {
            let m = quad_remesh(&s, &QuadOptions { target_faces: target, ..Default::default() });
            check(&m, target, 2);
            // Vertices lie on the sphere.
            for p in &m.v {
                assert!((len(*p) - 1.0).abs() < 0.02);
            }
        }
    }

    #[test]
    fn torus_becomes_quads() {
        let t = torus(80, 40, 1.0, 0.35);
        let m = quad_remesh(&t, &QuadOptions { target_faces: 1500, ..Default::default() });
        check(&m, 1500, 0);
    }
}
