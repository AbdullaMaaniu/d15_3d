//! Small 3D math helpers and a BVH for closest-point queries on triangle meshes.

pub type V3 = [f32; 3];

#[inline(always)]
pub fn add(a: V3, b: V3) -> V3 {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}
#[inline(always)]
pub fn sub(a: V3, b: V3) -> V3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
#[inline(always)]
pub fn mul(a: V3, s: f32) -> V3 {
    [a[0] * s, a[1] * s, a[2] * s]
}
#[inline(always)]
pub fn dot(a: V3, b: V3) -> f32 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
#[inline(always)]
pub fn cross(a: V3, b: V3) -> V3 {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}
#[inline(always)]
pub fn len2(a: V3) -> f32 {
    dot(a, a)
}
#[inline(always)]
pub fn len(a: V3) -> f32 {
    dot(a, a).sqrt()
}
#[inline(always)]
pub fn normalize(a: V3) -> V3 {
    let l = len(a);
    if l > 1e-20 {
        mul(a, 1.0 / l)
    } else {
        [0.0, 0.0, 0.0]
    }
}
/// Removes the component of `v` along the unit vector `n`.
#[inline(always)]
pub fn project_out(v: V3, n: V3) -> V3 {
    sub(v, mul(n, dot(v, n)))
}

/// Any unit vector perpendicular to the unit vector `n`.
pub fn any_perpendicular(n: V3) -> V3 {
    let a = if n[0].abs() < 0.9 { [1.0, 0.0, 0.0] } else { [0.0, 1.0, 0.0] };
    normalize(project_out(a, n))
}

/// Deterministic xorshift random numbers.
pub struct Rng(u64);
impl Rng {
    pub fn new(seed: u64) -> Self {
        Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1)
    }
    pub fn next_u32(&mut self) -> u32 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        (x >> 32) as u32
    }
    /// Uniform in [-1, 1).
    pub fn signed(&mut self) -> f32 {
        (self.next_u32() as f32 / 4294967296.0) * 2.0 - 1.0
    }
}

/// Closest point on triangle (a, b, c) to p. Returns (point, barycentric u, v, w) with point = u*a + v*b + w*c.
/// Ericson, Real-Time Collision Detection, 5.1.5.
pub fn closest_on_triangle(p: V3, a: V3, b: V3, c: V3) -> (V3, [f32; 3]) {
    let ab = sub(b, a);
    let ac = sub(c, a);
    let ap = sub(p, a);
    let d1 = dot(ab, ap);
    let d2 = dot(ac, ap);
    if d1 <= 0.0 && d2 <= 0.0 {
        return (a, [1.0, 0.0, 0.0]);
    }
    let bp = sub(p, b);
    let d3 = dot(ab, bp);
    let d4 = dot(ac, bp);
    if d3 >= 0.0 && d4 <= d3 {
        return (b, [0.0, 1.0, 0.0]);
    }
    let vc = d1 * d4 - d3 * d2;
    if vc <= 0.0 && d1 >= 0.0 && d3 <= 0.0 {
        let v = d1 / (d1 - d3);
        return (add(a, mul(ab, v)), [1.0 - v, v, 0.0]);
    }
    let cp = sub(p, c);
    let d5 = dot(ab, cp);
    let d6 = dot(ac, cp);
    if d6 >= 0.0 && d5 <= d6 {
        return (c, [0.0, 0.0, 1.0]);
    }
    let vb = d5 * d2 - d1 * d6;
    if vb <= 0.0 && d2 >= 0.0 && d6 <= 0.0 {
        let w = d2 / (d2 - d6);
        return (add(a, mul(ac, w)), [1.0 - w, 0.0, w]);
    }
    let va = d3 * d6 - d5 * d4;
    if va <= 0.0 && (d4 - d3) >= 0.0 && (d5 - d6) >= 0.0 {
        let w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
        return (add(b, mul(sub(c, b), w)), [0.0, 1.0 - w, w]);
    }
    let denom = 1.0 / (va + vb + vc);
    let v = vb * denom;
    let w = vc * denom;
    (add(a, add(mul(ab, v), mul(ac, w))), [1.0 - v - w, v, w])
}

#[derive(Clone, Copy)]
struct Node {
    min: V3,
    max: V3,
    /// Leaf: first triangle in `order`; inner: index of the left child (right = left + 1).
    start: u32,
    /// Leaf: triangle count (> 0); inner: 0.
    count: u32,
}

/// Bounding volume hierarchy over triangles, for nearest-surface queries.
pub struct Bvh {
    nodes: Vec<Node>,
    order: Vec<u32>,
    tris: Vec<[V3; 3]>,
    normals: Vec<V3>,
}

pub struct Hit {
    pub tri: u32,
    pub point: V3,
    pub bary: [f32; 3],
    pub dist2: f32,
}

fn aabb_dist2(p: V3, min: V3, max: V3) -> f32 {
    let mut d = 0.0;
    for k in 0..3 {
        let v = if p[k] < min[k] { min[k] - p[k] } else if p[k] > max[k] { p[k] - max[k] } else { 0.0 };
        d += v * v;
    }
    d
}

impl Bvh {
    pub fn new(positions: &[V3], faces: &[[u32; 3]]) -> Self {
        let tris: Vec<[V3; 3]> = faces.iter().map(|f| [positions[f[0] as usize], positions[f[1] as usize], positions[f[2] as usize]]).collect();
        let normals = tris.iter().map(|t| normalize(cross(sub(t[1], t[0]), sub(t[2], t[0])))).collect();
        let centroids: Vec<V3> = tris.iter().map(|t| mul(add(add(t[0], t[1]), t[2]), 1.0 / 3.0)).collect();
        let mut order: Vec<u32> = (0..tris.len() as u32).collect();
        let mut nodes = Vec::with_capacity(tris.len() * 2 / 3 + 1);
        nodes.push(Node { min: [0.0; 3], max: [0.0; 3], start: 0, count: tris.len() as u32 });
        let mut stack = vec![0usize];
        while let Some(ni) = stack.pop() {
            let (start, count) = (nodes[ni].start as usize, nodes[ni].count as usize);
            let (mut min, mut max) = ([f32::INFINITY; 3], [f32::NEG_INFINITY; 3]);
            let (mut cmin, mut cmax) = ([f32::INFINITY; 3], [f32::NEG_INFINITY; 3]);
            for &t in &order[start..start + count] {
                for v in tris[t as usize] {
                    for k in 0..3 {
                        min[k] = min[k].min(v[k]);
                        max[k] = max[k].max(v[k]);
                    }
                }
                let c = centroids[t as usize];
                for k in 0..3 {
                    cmin[k] = cmin[k].min(c[k]);
                    cmax[k] = cmax[k].max(c[k]);
                }
            }
            nodes[ni].min = min;
            nodes[ni].max = max;
            if count <= 4 {
                continue;
            }
            // Split at the median centroid along the widest axis.
            let axis = (0..3).max_by(|&a, &b| (cmax[a] - cmin[a]).partial_cmp(&(cmax[b] - cmin[b])).unwrap()).unwrap();
            if cmax[axis] - cmin[axis] <= 0.0 {
                continue;
            }
            let mid = count / 2;
            order[start..start + count].select_nth_unstable_by(mid, |&a, &b| centroids[a as usize][axis].partial_cmp(&centroids[b as usize][axis]).unwrap_or(std::cmp::Ordering::Equal));
            let left = nodes.len();
            nodes.push(Node { min: [0.0; 3], max: [0.0; 3], start: start as u32, count: mid as u32 });
            nodes.push(Node { min: [0.0; 3], max: [0.0; 3], start: (start + mid) as u32, count: (count - mid) as u32 });
            nodes[ni].start = left as u32;
            nodes[ni].count = 0;
            stack.push(left);
            stack.push(left + 1);
        }
        Bvh { nodes, order, tris, normals }
    }

    pub fn triangle_count(&self) -> usize {
        self.tris.len()
    }

    /// Closest point on the surface. With `facing`, triangles whose normal points more
    /// than ~100° away from it are ignored, so a query doesn't snap to the far side of a
    /// thin part. `hint` is a triangle to try first (e.g. the previous query's answer).
    pub fn closest(&self, p: V3, facing: Option<V3>, hint: Option<u32>, max_dist2: f32) -> Option<Hit> {
        let mut best: Option<Hit> = None;
        let mut best_d2 = max_dist2;
        let accept = |t: usize| match facing {
            Some(n) => dot(self.normals[t], n) > -0.17,
            None => true,
        };
        if let Some(h) = hint {
            let t = h as usize;
            if t < self.tris.len() && accept(t) {
                let [a, b, c] = self.tris[t];
                let (q, bary) = closest_on_triangle(p, a, b, c);
                let d2 = len2(sub(p, q));
                if d2 < best_d2 {
                    best_d2 = d2;
                    best = Some(Hit { tri: h, point: q, bary, dist2: d2 });
                }
            }
        }
        let mut stack: Vec<u32> = Vec::with_capacity(64);
        stack.push(0);
        while let Some(ni) = stack.pop() {
            let node = self.nodes[ni as usize];
            if aabb_dist2(p, node.min, node.max) >= best_d2 {
                continue;
            }
            if node.count > 0 {
                for &t in &self.order[node.start as usize..(node.start + node.count) as usize] {
                    let tu = t as usize;
                    if !accept(tu) {
                        continue;
                    }
                    let [a, b, c] = self.tris[tu];
                    let (q, bary) = closest_on_triangle(p, a, b, c);
                    let d2 = len2(sub(p, q));
                    if d2 < best_d2 {
                        best_d2 = d2;
                        best = Some(Hit { tri: t, point: q, bary, dist2: d2 });
                    }
                }
            } else {
                // Visit the nearer child first.
                let l = node.start;
                let dl = aabb_dist2(p, self.nodes[l as usize].min, self.nodes[l as usize].max);
                let dr = aabb_dist2(p, self.nodes[l as usize + 1].min, self.nodes[l as usize + 1].max);
                if dl < dr {
                    stack.push(l + 1);
                    stack.push(l);
                } else {
                    stack.push(l);
                    stack.push(l + 1);
                }
            }
        }
        best
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn closest_point_regions() {
        let (a, b, c) = ([0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]);
        let (q, bary) = closest_on_triangle([0.2, 0.2, 1.0], a, b, c);
        assert!((q[0] - 0.2).abs() < 1e-6 && (q[1] - 0.2).abs() < 1e-6 && q[2].abs() < 1e-6);
        assert!((bary[0] - 0.6).abs() < 1e-5);
        let (q, _) = closest_on_triangle([-1.0, -1.0, 0.0], a, b, c);
        assert_eq!(q, a);
        let (q, _) = closest_on_triangle([1.0, 1.0, 0.0], a, b, c);
        assert!((q[0] - 0.5).abs() < 1e-6 && (q[1] - 0.5).abs() < 1e-6);
    }

    #[test]
    fn bvh_matches_brute_force() {
        let mut rng = Rng::new(3);
        let mut pos = Vec::new();
        let mut faces = Vec::new();
        for i in 0..300u32 {
            let o = [rng.signed() * 5.0, rng.signed() * 5.0, rng.signed() * 5.0];
            pos.push(o);
            pos.push(add(o, [rng.signed(), rng.signed(), rng.signed()]));
            pos.push(add(o, [rng.signed(), rng.signed(), rng.signed()]));
            faces.push([i * 3, i * 3 + 1, i * 3 + 2]);
        }
        let bvh = Bvh::new(&pos, &faces);
        for _ in 0..200 {
            let p = [rng.signed() * 6.0, rng.signed() * 6.0, rng.signed() * 6.0];
            let hit = bvh.closest(p, None, None, f32::INFINITY).unwrap();
            let brute = faces
                .iter()
                .map(|f| len2(sub(p, closest_on_triangle(p, pos[f[0] as usize], pos[f[1] as usize], pos[f[2] as usize]).0)))
                .fold(f32::INFINITY, f32::min);
            assert!((hit.dist2 - brute).abs() < 1e-5, "{} vs {}", hit.dist2, brute);
        }
    }
}
