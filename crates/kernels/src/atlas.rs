//! Automatic UV atlas for a polygon mesh: charts grown under a normal-cone limit,
//! projected onto their plane (every face then maps with positive orientation),
//! rotated to their minimum-area bounding rectangle and skyline-packed into a square.

use crate::geom::*;
use std::collections::{BinaryHeap, HashMap};

pub struct Atlas {
    /// UV per face corner (same order as the mesh's corner list), in [0, 1], v down (glTF).
    pub uv: Vec<[f32; 2]>,
    pub chart_of_face: Vec<u32>,
    pub chart_count: usize,
    /// Share of the texture covered by chart rectangles.
    pub utilization: f32,
}

pub struct AtlasOptions {
    pub resolution: u32,
    /// Empty texels around each chart (bleed room for filtering and mipmaps).
    pub padding: f32,
    /// Max angle between a face normal and its chart's projection axis.
    pub max_angle_deg: f32,
}

impl Default for AtlasOptions {
    fn default() -> Self {
        AtlasOptions { resolution: 2048, padding: 4.0, max_angle_deg: 55.0 }
    }
}

#[derive(PartialEq)]
struct Cand(f32, u32);
impl Eq for Cand {}
impl Ord for Cand {
    fn cmp(&self, o: &Self) -> std::cmp::Ordering {
        o.0.partial_cmp(&self.0).unwrap_or(std::cmp::Ordering::Equal)
    }
}
impl PartialOrd for Cand {
    fn partial_cmp(&self, o: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(o))
    }
}

struct Chart {
    /// Corner indices (into the mesh corner list) and their 2D positions.
    corners: Vec<u32>,
    pts: Vec<[f32; 2]>,
    w: f32,
    h: f32,
}

fn cross2(o: [f32; 2], a: [f32; 2], b: [f32; 2]) -> f32 {
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
}

fn convex_hull(mut p: Vec<[f32; 2]>) -> Vec<[f32; 2]> {
    p.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    p.dedup();
    if p.len() < 3 {
        return p;
    }
    let mut lower: Vec<[f32; 2]> = Vec::new();
    for &q in &p {
        while lower.len() >= 2 && cross2(lower[lower.len() - 2], lower[lower.len() - 1], q) <= 0.0 {
            lower.pop();
        }
        lower.push(q);
    }
    let mut upper: Vec<[f32; 2]> = Vec::new();
    for &q in p.iter().rev() {
        while upper.len() >= 2 && cross2(upper[upper.len() - 2], upper[upper.len() - 1], q) <= 0.0 {
            upper.pop();
        }
        upper.push(q);
    }
    lower.pop();
    upper.pop();
    lower.extend(upper);
    lower
}

/// Rotates the points so their bounding rectangle has minimal area (and is wider than
/// tall), and moves them to start at the origin.
fn fit_rectangle(pts: &mut [[f32; 2]]) -> (f32, f32) {
    let hull = convex_hull(pts.to_vec());
    let mut best = (f32::INFINITY, 1.0f32, 0.0f32);
    let n = hull.len();
    for i in 0..n.max(1) {
        let (c, s) = if n >= 2 {
            let (a, b) = (hull[i], hull[(i + 1) % n]);
            let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
            let l = (dx * dx + dy * dy).sqrt();
            if l < 1e-12 {
                continue;
            }
            (dx / l, dy / l)
        } else {
            (1.0, 0.0)
        };
        let (mut x0, mut x1, mut y0, mut y1) = (f32::INFINITY, f32::NEG_INFINITY, f32::INFINITY, f32::NEG_INFINITY);
        for p in &hull {
            let (x, y) = (p[0] * c + p[1] * s, -p[0] * s + p[1] * c);
            x0 = x0.min(x);
            x1 = x1.max(x);
            y0 = y0.min(y);
            y1 = y1.max(y);
        }
        let area = (x1 - x0) * (y1 - y0);
        if area < best.0 {
            best = (area, c, s);
        }
    }
    let (_, mut c, mut s) = best;
    let (mut x0, mut x1, mut y0, mut y1) = (f32::INFINITY, f32::NEG_INFINITY, f32::INFINITY, f32::NEG_INFINITY);
    for p in pts.iter() {
        let (x, y) = (p[0] * c + p[1] * s, -p[0] * s + p[1] * c);
        x0 = x0.min(x);
        x1 = x1.max(x);
        y0 = y0.min(y);
        y1 = y1.max(y);
    }
    if y1 - y0 > x1 - x0 {
        // A further quarter turn, (x, y) -> (y, -x), so it lies flat (orientation kept).
        (c, s) = (-s, c);
    }
    let (mut mx, mut my) = (f32::INFINITY, f32::INFINITY);
    for p in pts.iter_mut() {
        let (x, y) = (p[0] * c + p[1] * s, -p[0] * s + p[1] * c);
        *p = [x, y];
        mx = mx.min(x);
        my = my.min(y);
    }
    let (mut w, mut h) = (0.0f32, 0.0f32);
    for p in pts.iter_mut() {
        p[0] -= mx;
        p[1] -= my;
        w = w.max(p[0]);
        h = h.max(p[1]);
    }
    (w, h)
}

/// Skyline bottom-left packing of rectangles (in texels) into a `size` square.
/// Returns each rectangle's origin, or None if they don't fit.
fn skyline_pack(rects: &[(f32, f32)], order: &[usize], size: f32) -> Option<Vec<(f32, f32)>> {
    // Skyline: segments (x, y, width), sorted by x, covering [0, size).
    let mut sky: Vec<(f32, f32, f32)> = vec![(0.0, 0.0, size)];
    let mut out = vec![(0.0, 0.0); rects.len()];
    for &i in order {
        let (w, h) = rects[i];
        if w > size || h > size {
            return None;
        }
        let mut best: Option<(f32, f32, usize)> = None; // (top y, x, segment index)
        for s in 0..sky.len() {
            let x = sky[s].0;
            if x + w > size + 1e-3 {
                break;
            }
            // Highest segment under [x, x + w).
            let mut y = 0.0f32;
            let mut k = s;
            while k < sky.len() && sky[k].0 < x + w - 1e-4 {
                y = y.max(sky[k].1);
                k += 1;
            }
            if y + h > size {
                continue;
            }
            if best.map_or(true, |b| y + h < b.0 || (y + h == b.0 && x < b.1)) {
                best = Some((y + h, x, s));
            }
        }
        let (top, x, _) = best?;
        out[i] = (x, top - h);
        // Raise the skyline over [x, x + w) to `top`.
        let mut next: Vec<(f32, f32, f32)> = Vec::with_capacity(sky.len() + 2);
        for &(sx, sy, sw) in &sky {
            let (a, b) = (sx, sx + sw);
            if b <= x || a >= x + w {
                next.push((sx, sy, sw));
                continue;
            }
            if a < x {
                next.push((a, sy, x - a));
            }
            if b > x + w {
                next.push((x + w, sy, b - (x + w)));
            }
        }
        next.push((x, top, w));
        next.sort_by(|p, q| p.0.partial_cmp(&q.0).unwrap_or(std::cmp::Ordering::Equal));
        // Merge neighbours at the same height.
        let mut merged: Vec<(f32, f32, f32)> = Vec::with_capacity(next.len());
        for seg in next {
            if let Some(last) = merged.last_mut() {
                if (last.1 - seg.1).abs() < 1e-4 && (last.0 + last.2 - seg.0).abs() < 1e-3 {
                    last.2 += seg.2;
                    continue;
                }
            }
            merged.push(seg);
        }
        sky = merged;
    }
    Some(out)
}

/// Builds the atlas. `sizes`/`idx` describe polygon faces (3 or 4 corners) over `v`.
pub fn build_atlas(v: &[V3], sizes: &[u8], idx: &[u32], opts: &AtlasOptions) -> Atlas {
    let nf = sizes.len();
    let mut start = Vec::with_capacity(nf + 1);
    let mut o = 0u32;
    for &s in sizes {
        start.push(o);
        o += s as u32;
    }
    start.push(o);
    let corners = |f: usize| &idx[start[f] as usize..start[f + 1] as usize];
    // Face normals (Newell) and areas.
    let mut normal = vec![[0.0f32; 3]; nf];
    let mut area = vec![0.0f32; nf];
    for f in 0..nf {
        let c = corners(f);
        let mut n = [0.0f32; 3];
        for k in 0..c.len() {
            let (a, b) = (v[c[k] as usize], v[c[(k + 1) % c.len()] as usize]);
            n = add(n, cross(a, b));
        }
        area[f] = 0.5 * len(n);
        normal[f] = normalize(n);
    }
    // Face adjacency through shared edges.
    let mut edge_faces: HashMap<(u32, u32), Vec<u32>> = HashMap::new();
    for f in 0..nf {
        let c = corners(f);
        for k in 0..c.len() {
            let (a, b) = (c[k], c[(k + 1) % c.len()]);
            edge_faces.entry((a.min(b), a.max(b))).or_default().push(f as u32);
        }
    }
    let mut adj: Vec<Vec<u32>> = vec![Vec::new(); nf];
    for fs in edge_faces.values() {
        for &a in fs {
            for &b in fs {
                if a != b {
                    adj[a as usize].push(b);
                }
            }
        }
    }

    // Grow charts from seeds (largest faces first make calmer charts).
    let cos_max = opts.max_angle_deg.to_radians().cos();
    let mut chart_of = vec![u32::MAX; nf];
    let mut seeds: Vec<u32> = (0..nf as u32).collect();
    seeds.sort_by(|&a, &b| area[b as usize].partial_cmp(&area[a as usize]).unwrap_or(std::cmp::Ordering::Equal));
    let mut axes: Vec<V3> = Vec::new();
    for &seed in &seeds {
        if chart_of[seed as usize] != u32::MAX {
            continue;
        }
        let c = axes.len() as u32;
        let axis = normal[seed as usize];
        axes.push(axis);
        chart_of[seed as usize] = c;
        let mut heap = BinaryHeap::new();
        for &g in &adj[seed as usize] {
            heap.push(Cand(1.0 - dot(normal[g as usize], axis), g));
        }
        while let Some(Cand(_, g)) = heap.pop() {
            let g = g as usize;
            if chart_of[g] != u32::MAX || dot(normal[g], axis) < cos_max {
                continue;
            }
            chart_of[g] = c;
            for &k in &adj[g] {
                if chart_of[k as usize] == u32::MAX {
                    heap.push(Cand(1.0 - dot(normal[k as usize], axis), k));
                }
            }
        }
    }
    let chart_count = axes.len();

    // Project each chart onto the plane of its axis.
    let mut charts: Vec<Chart> = (0..chart_count).map(|_| Chart { corners: Vec::new(), pts: Vec::new(), w: 0.0, h: 0.0 }).collect();
    for f in 0..nf {
        let ch = chart_of[f] as usize;
        let axis = axes[ch];
        let e1 = any_perpendicular(axis);
        let e2 = cross(axis, e1);
        for k in start[f]..start[f + 1] {
            let p = v[idx[k as usize] as usize];
            charts[ch].corners.push(k);
            // Mirror the second axis: glTF's v points down, so front faces must be
            // clockwise in UV for textures to appear unmirrored.
            charts[ch].pts.push([dot(p, e1), -dot(p, e2)]);
        }
    }
    for c in charts.iter_mut() {
        let (w, h) = fit_rectangle(&mut c.pts);
        c.w = w;
        c.h = h;
    }

    // Find the largest scale (texels per unit) at which everything packs.
    let size = opts.resolution as f32;
    let pad = opts.padding;
    let total: f32 = charts.iter().map(|c| c.w * c.h).sum::<f32>().max(1e-12);
    let mut order: Vec<usize> = (0..chart_count).collect();
    order.sort_by(|&a, &b| charts[b].h.partial_cmp(&charts[a].h).unwrap_or(std::cmp::Ordering::Equal));
    let rects_at = |s: f32| charts.iter().map(|c| (c.w * s + 2.0 * pad, c.h * s + 2.0 * pad)).collect::<Vec<_>>();
    let mut hi = (size * size / total).sqrt();
    let mut lo = hi * 0.05;
    let mut best: Option<(f32, Vec<(f32, f32)>)> = None;
    while best.is_none() {
        if let Some(p) = skyline_pack(&rects_at(lo), &order, size) {
            best = Some((lo, p));
        } else {
            lo *= 0.5;
            if lo < 1e-9 {
                break;
            }
        }
    }
    for _ in 0..16 {
        let mid = 0.5 * (lo + hi);
        match skyline_pack(&rects_at(mid), &order, size) {
            Some(p) => {
                lo = mid;
                best = Some((mid, p));
            }
            None => hi = mid,
        }
    }
    let (scale, placed) = best.unwrap_or((0.0, vec![(0.0, 0.0); chart_count]));
    let mut uv = vec![[0.0f32; 2]; idx.len()];
    let mut used = 0.0f32;
    for (i, c) in charts.iter().enumerate() {
        let (x, y) = placed[i];
        used += (c.w * scale + 2.0 * pad) * (c.h * scale + 2.0 * pad);
        for (k, &corner) in c.corners.iter().enumerate() {
            let p = c.pts[k];
            uv[corner as usize] = [(x + pad + p[0] * scale) / size, (y + pad + p[1] * scale) / size];
        }
    }
    Atlas { uv, chart_of_face: chart_of, chart_count, utilization: used / (size * size) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::quad::{quad_remesh, QuadOptions};
    use crate::trimesh::tests::sphere;

    #[test]
    fn packs_charts_without_overlap_or_flips() {
        let s = sphere(30, 40, 1.0);
        let m = quad_remesh(&s, &QuadOptions { target_faces: 800, ..Default::default() });
        let res = 512u32;
        let a = build_atlas(&m.v, &m.sizes, &m.idx, &AtlasOptions { resolution: res, padding: 2.0, max_angle_deg: 55.0 });
        assert!(a.chart_count > 3 && a.chart_count < 200, "{} charts", a.chart_count);
        assert!(a.utilization > 0.45, "utilization {}", a.utilization);
        for t in &a.uv {
            assert!(t[0] >= 0.0 && t[0] <= 1.0 && t[1] >= 0.0 && t[1] <= 1.0);
        }
        // Rasterize every face: no texel is claimed by two charts, and no face is flipped.
        let mut owner = vec![u32::MAX; (res * res) as usize];
        let mut o = 0usize;
        let mut clashes = 0;
        for (f, &sz) in m.sizes.iter().enumerate() {
            let uv: Vec<[f32; 2]> = (0..sz as usize).map(|k| a.uv[o + k]).collect();
            let mut signed = 0.0;
            for k in 0..uv.len() {
                let (p, q) = (uv[k], uv[(k + 1) % uv.len()]);
                signed += p[0] * q[1] - q[0] * p[1];
            }
            // Image space has v pointing down, so front faces are clockwise there.
            assert!(signed < 0.0, "face {f} is flipped in UV space");
            for k in 1..uv.len() - 1 {
                let (p0, p1, p2) = (uv[0], uv[k], uv[k + 1]);
                let (x0, x1) = (p0[0].min(p1[0]).min(p2[0]) * res as f32, p0[0].max(p1[0]).max(p2[0]) * res as f32);
                let (y0, y1) = (p0[1].min(p1[1]).min(p2[1]) * res as f32, p0[1].max(p1[1]).max(p2[1]) * res as f32);
                for y in y0.floor() as i32..=y1.ceil() as i32 {
                    for x in x0.floor() as i32..=x1.ceil() as i32 {
                        let (px, py) = ((x as f32 + 0.5) / res as f32, (y as f32 + 0.5) / res as f32);
                        let d = cross2(p0, p1, p2);
                        let w0 = cross2(p1, p2, [px, py]) / d;
                        let w1 = cross2(p2, p0, [px, py]) / d;
                        let w2 = 1.0 - w0 - w1;
                        if w0 < 0.0 || w1 < 0.0 || w2 < 0.0 || x < 0 || y < 0 || x >= res as i32 || y >= res as i32 {
                            continue;
                        }
                        let cell = &mut owner[(y as u32 * res + x as u32) as usize];
                        if *cell != u32::MAX && *cell != a.chart_of_face[f] {
                            clashes += 1;
                        }
                        *cell = a.chart_of_face[f];
                    }
                }
            }
            o += sz as usize;
        }
        assert_eq!(clashes, 0);
    }
}
