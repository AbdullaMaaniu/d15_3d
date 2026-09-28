//! Texture transfer: for every texel of a new UV atlas, find the matching point on the
//! original surface (closest point facing the same way) and sample the original
//! material there. Base colour, metallic-roughness and emissive are baked; empty texels
//! around charts are filled by dilation so filtering and mipmaps don't bleed black.

use crate::geom::*;

pub struct Texture {
    pub w: u32,
    pub h: u32,
    /// RGBA8, row 0 at the top of the image.
    pub data: Vec<u8>,
    /// three.js `flipY`: v = 0 is the bottom row instead of the top.
    pub flip_y: bool,
    pub repeat: bool,
}

impl Texture {
    /// Bilinear sample at (u, v), channels in 0..1.
    pub fn sample(&self, u: f32, v: f32) -> [f32; 4] {
        let (w, h) = (self.w as i64, self.h as i64);
        if w == 0 || h == 0 {
            return [1.0; 4];
        }
        let v = if self.flip_y { 1.0 - v } else { v };
        let x = u * w as f32 - 0.5;
        let y = v * h as f32 - 0.5;
        let (x0, y0) = (x.floor(), y.floor());
        let (fx, fy) = (x - x0, y - y0);
        let wrap = |i: i64, n: i64| if self.repeat { i.rem_euclid(n) } else { i.clamp(0, n - 1) };
        let px = |i: i64, j: i64| {
            let o = ((wrap(j, h) * w + wrap(i, w)) * 4) as usize;
            [self.data[o] as f32, self.data[o + 1] as f32, self.data[o + 2] as f32, self.data[o + 3] as f32]
        };
        let (xi, yi) = (x0 as i64, y0 as i64);
        let (a, b, c, d) = (px(xi, yi), px(xi + 1, yi), px(xi, yi + 1), px(xi + 1, yi + 1));
        let mut out = [0.0f32; 4];
        for k in 0..4 {
            let top = a[k] + (b[k] - a[k]) * fx;
            let bot = c[k] + (d[k] - c[k]) * fx;
            out[k] = (top + (bot - top) * fy) / 255.0;
        }
        out
    }
}

#[derive(Clone, Copy)]
pub struct Material {
    /// Texture indices (-1 = none) and factors, as in glTF.
    pub base_tex: i32,
    pub base: [f32; 4],
    pub mr_tex: i32,
    pub metallic: f32,
    pub roughness: f32,
    pub em_tex: i32,
    pub emissive: [f32; 3],
}

pub struct Baker {
    bvh: Bvh,
    uv: Vec<[f32; 2]>,
    color: Option<Vec<[f32; 4]>>,
    tris: Vec<[u32; 3]>,
    material_of: Vec<u32>,
    pub textures: Vec<Texture>,
    pub materials: Vec<Material>,
}

pub struct BakeOutput {
    pub base: Vec<u8>,
    pub mr: Option<Vec<u8>>,
    pub emissive: Option<Vec<u8>>,
    /// Texels that were inside a chart.
    pub covered: usize,
}

impl Baker {
    /// `material_of` gives each source triangle's material; `color` is optional vertex colour.
    pub fn new(positions: &[V3], uv: Vec<[f32; 2]>, color: Option<Vec<[f32; 4]>>, tris: Vec<[u32; 3]>, material_of: Vec<u32>) -> Self {
        let bvh = Bvh::new(positions, &tris);
        Baker { bvh, uv, color, tris, material_of, textures: Vec::new(), materials: Vec::new() }
    }

    fn material(&self, t: usize) -> Material {
        let m = self.material_of.get(t).copied().unwrap_or(0) as usize;
        self.materials.get(m).copied().unwrap_or(Material { base_tex: -1, base: [1.0; 4], mr_tex: -1, metallic: 0.0, roughness: 1.0, em_tex: -1, emissive: [0.0; 3] })
    }

    fn tex(&self, i: i32) -> Option<&Texture> {
        if i < 0 { None } else { self.textures.get(i as usize) }
    }

    /// Samples the source material at a surface point and writes it at byte offset `o`.
    fn shade(&self, t: usize, bary: [f32; 3], o: usize, base: &mut [u8], mr: Option<&mut [u8]>, em: Option<&mut [u8]>) {
        let to8 = |x: f32| (x.clamp(0.0, 1.0) * 255.0 + 0.5) as u8;
        let [a, b, c] = self.tris[t];
        let (ua, ub, uc) = (self.uv[a as usize], self.uv[b as usize], self.uv[c as usize]);
        let u = ua[0] * bary[0] + ub[0] * bary[1] + uc[0] * bary[2];
        let vv = ua[1] * bary[0] + ub[1] * bary[1] + uc[1] * bary[2];
        let m = self.material(t);
        let mut col = m.base;
        if let Some(tx) = self.tex(m.base_tex) {
            let s = tx.sample(u, vv);
            for k in 0..4 {
                col[k] *= s[k];
            }
        }
        if let Some(vc) = &self.color {
            let (x, y, z) = (vc[a as usize], vc[b as usize], vc[c as usize]);
            for k in 0..4 {
                col[k] *= x[k] * bary[0] + y[k] * bary[1] + z[k] * bary[2];
            }
        }
        base[o..o + 4].copy_from_slice(&col.map(to8));
        if let Some(out) = mr {
            let (mut rough, mut metal) = (m.roughness, m.metallic);
            if let Some(tx) = self.tex(m.mr_tex) {
                let s = tx.sample(u, vv);
                rough *= s[1];
                metal *= s[2];
            }
            out[o..o + 4].copy_from_slice(&[255, to8(rough), to8(metal), 255]);
        }
        if let Some(out) = em {
            let mut e = m.emissive;
            if let Some(tx) = self.tex(m.em_tex) {
                let s = tx.sample(u, vv);
                for k in 0..3 {
                    e[k] *= s[k];
                }
            }
            out[o..o + 4].copy_from_slice(&[to8(e[0]), to8(e[1]), to8(e[2]), 255]);
        }
    }

    /// Bakes onto a target mesh: vertex positions `v`, per-corner UVs (0..1, v down) and
    /// triangles given as triples of corner indices (with `corner_vertex` mapping corners to vertices).
    #[allow(clippy::too_many_arguments)]
    pub fn bake(&self, v: &[V3], corner_vertex: &[u32], uv: &[[f32; 2]], tri_corners: &[[u32; 3]], resolution: u32, padding: u32, want_mr: bool, want_em: bool) -> BakeOutput {
        let res = resolution as usize;
        let mut base = vec![0u8; res * res * 4];
        let mut mr = if want_mr { Some(vec![0u8; res * res * 4]) } else { None };
        let mut em = if want_em { Some(vec![0u8; res * res * 4]) } else { None };
        // 0 = empty, 1 = texel centre inside a triangle, 2 = within half a texel of one.
        let mut state = vec![0u8; res * res];
        let mut covered = 0;
        let mut hint: Option<u32> = None;
        for t in tri_corners {
            let p = t.map(|c| v[corner_vertex[c as usize] as usize]);
            let q = t.map(|c| [uv[c as usize][0] * res as f32, uv[c as usize][1] * res as f32]);
            let n = normalize(cross(sub(p[1], p[0]), sub(p[2], p[0])));
            let d = (q[1][0] - q[0][0]) * (q[2][1] - q[0][1]) - (q[2][0] - q[0][0]) * (q[1][1] - q[0][1]);
            if d.abs() < 1e-12 {
                continue;
            }
            // Edge lengths in texels, to include texels whose centre is up to half a texel outside.
            let el = [0, 1, 2].map(|k| {
                let (a, b) = (q[(k + 1) % 3], q[(k + 2) % 3]);
                ((b[0] - a[0]).powi(2) + (b[1] - a[1]).powi(2)).sqrt().max(1e-6)
            });
            let x0 = (q[0][0].min(q[1][0]).min(q[2][0]) - 1.0).floor().max(0.0) as usize;
            let x1 = (q[0][0].max(q[1][0]).max(q[2][0]) + 1.0).ceil().min(res as f32 - 1.0) as usize;
            let y0 = (q[0][1].min(q[1][1]).min(q[2][1]) - 1.0).floor().max(0.0) as usize;
            let y1 = (q[0][1].max(q[1][1]).max(q[2][1]) + 1.0).ceil().min(res as f32 - 1.0) as usize;
            for y in y0..=y1 {
                for x in x0..=x1 {
                    let (px, py) = (x as f32 + 0.5, y as f32 + 0.5);
                    let mut w = [0.0f32; 3];
                    for k in 0..3 {
                        let (a, b) = (q[(k + 1) % 3], q[(k + 2) % 3]);
                        w[k] = ((b[0] - a[0]) * (py - a[1]) - (b[1] - a[1]) * (px - a[0])) / d;
                    }
                    // Signed distance (texels) outside each edge: w_k * 2 * area / edge length.
                    let outside = (0..3).map(|k| -w[k] * d.abs() / el[k]).fold(f32::NEG_INFINITY, f32::max);
                    if outside > 0.5 {
                        continue;
                    }
                    let cell = y * res + x;
                    let kind = if outside > 0.0 { 2 } else { 1 };
                    if state[cell] != 0 && (kind == 2 || state[cell] == 1) {
                        continue; // already covered (as well or better) by a neighbour
                    }
                    let mut wc = w.map(|x| x.max(0.0));
                    let sum = wc[0] + wc[1] + wc[2];
                    if sum <= 0.0 {
                        continue;
                    }
                    wc = wc.map(|x| x / sum);
                    let point = add(add(mul(p[0], wc[0]), mul(p[1], wc[1])), mul(p[2], wc[2]));
                    let Some(hit) = self.bvh.closest(point, Some(n), hint, f32::INFINITY) else { continue };
                    hint = Some(hit.tri);
                    if state[cell] == 0 {
                        covered += 1;
                    }
                    state[cell] = kind;
                    self.shade(hit.tri as usize, hit.bary, cell * 4, &mut base, mr.as_deref_mut(), em.as_deref_mut());
                }
            }
        }
        let mut mask: Vec<bool> = state.iter().map(|&s| s != 0).collect();
        let mut images: Vec<&mut Vec<u8>> = vec![&mut base];
        if let Some(x) = mr.as_mut() {
            images.push(x);
        }
        if let Some(x) = em.as_mut() {
            images.push(x);
        }
        dilate(&mut images, &mut mask, res, padding.max(1) as usize + 2);
        BakeOutput { base, mr, emissive: em, covered }
    }
}

/// Grows covered texels outward `passes` times (averaging covered neighbours), then
/// fills whatever is left with each image's mean colour.
fn dilate(images: &mut [&mut Vec<u8>], mask: &mut [bool], res: usize, passes: usize) {
    let mut frontier: Vec<usize> = Vec::new();
    for _ in 0..passes {
        frontier.clear();
        for y in 0..res {
            for x in 0..res {
                let i = y * res + x;
                if mask[i] {
                    continue;
                }
                let near = (y.saturating_sub(1)..(y + 2).min(res)).any(|yy| (x.saturating_sub(1)..(x + 2).min(res)).any(|xx| mask[yy * res + xx]));
                if near {
                    frontier.push(i);
                }
            }
        }
        if frontier.is_empty() {
            break;
        }
        for img in images.iter_mut() {
            for &i in &frontier {
                let (x, y) = (i % res, i / res);
                let mut acc = [0u32; 4];
                let mut n = 0;
                for yy in y.saturating_sub(1)..(y + 2).min(res) {
                    for xx in x.saturating_sub(1)..(x + 2).min(res) {
                        let j = yy * res + xx;
                        if mask[j] {
                            for k in 0..4 {
                                acc[k] += img[j * 4 + k] as u32;
                            }
                            n += 1;
                        }
                    }
                }
                for k in 0..4 {
                    img[i * 4 + k] = (acc[k] / n.max(1)) as u8;
                }
            }
        }
        for &i in &frontier {
            mask[i] = true;
        }
    }
    for img in images.iter_mut() {
        let (mut acc, mut n) = ([0u64; 4], 0u64);
        for i in 0..res * res {
            if mask[i] {
                for k in 0..4 {
                    acc[k] += img[i * 4 + k] as u64;
                }
                n += 1;
            }
        }
        if n == 0 {
            continue;
        }
        let mean = acc.map(|a| (a / n) as u8);
        for i in 0..res * res {
            if !mask[i] {
                img[i * 4..i * 4 + 4].copy_from_slice(&mean);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::atlas::{build_atlas, AtlasOptions};
    use crate::quad::{quad_remesh, QuadOptions};
    use crate::trimesh::tests::sphere;

    #[test]
    fn baked_colours_follow_the_surface() {
        // Source: a sphere whose texture is red on top (v < 0.5) and blue below, via a
        // latitude UV mapping; the remeshed sphere must keep red up and blue down.
        let s = sphere(40, 60, 1.0);
        let uv: Vec<[f32; 2]> = s.v.iter().map(|p| [0.5, (1.0 - p[1]) * 0.5]).collect();
        let tex = Texture { w: 2, h: 2, data: vec![255, 0, 0, 255, 255, 0, 0, 255, 0, 0, 255, 255, 0, 0, 255, 255], flip_y: false, repeat: false };
        let mut baker = Baker::new(&s.v, uv, None, s.f.clone(), vec![0; s.f.len()]);
        baker.textures.push(tex);
        baker.materials.push(Material { base_tex: 0, base: [1.0; 4], mr_tex: -1, metallic: 0.0, roughness: 1.0, em_tex: -1, emissive: [0.0; 3] });
        let m = quad_remesh(&s, &QuadOptions { target_faces: 600, ..Default::default() });
        let res = 256;
        let atlas = build_atlas(&m.v, &m.sizes, &m.idx, &AtlasOptions { resolution: res, padding: 2.0, max_angle_deg: 55.0 });
        let mut tris = Vec::new();
        let mut o = 0u32;
        for &sz in &m.sizes {
            for k in 1..sz as u32 - 1 {
                tris.push([o, o + k, o + k + 1]);
            }
            o += sz as u32;
        }
        let out = baker.bake(&m.v, &m.idx, &atlas.uv, &tris, res, 2, false, false);
        assert!(out.covered > (res * res) as usize / 3);
        // Sample the bake at each corner's UV: colour must match the corner's hemisphere.
        let mut wrong = 0;
        for (c, &vi) in m.idx.iter().enumerate() {
            let y = m.v[vi as usize][1];
            if y.abs() < 0.15 {
                continue;
            }
            let [u, v] = atlas.uv[c];
            let (x, yy) = ((u * res as f32) as usize, (v * res as f32) as usize);
            let px = &out.base[(yy.min(res as usize - 1) * res as usize + x.min(res as usize - 1)) * 4..][..4];
            let red = px[0] > px[2];
            if red != (y > 0.0) {
                wrong += 1;
            }
        }
        assert!(wrong * 50 < m.idx.len(), "{wrong} of {} corners got the wrong colour", m.idx.len());
    }
}
