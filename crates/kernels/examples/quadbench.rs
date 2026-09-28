//! Quad remeshing on a dumped mesh: cargo run --release --example quadbench -- mesh.bin target [out.obj]
//! mesh.bin: u32 vertex count, u32 index count, f32 positions, u32 indices.
use rigforge_kernels::quad::{quad_remesh, QuadOptions};
use rigforge_kernels::trimesh::TriMesh;
use rigforge_kernels::atlas::{build_atlas, AtlasOptions};
use std::io::Write;
use std::time::Instant;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let buf = std::fs::read(&args[1]).unwrap();
    let nv = u32::from_le_bytes(buf[0..4].try_into().unwrap()) as usize;
    let ni = u32::from_le_bytes(buf[4..8].try_into().unwrap()) as usize;
    let pos: Vec<f32> = buf[8..8 + nv * 12].chunks_exact(4).map(|c| f32::from_le_bytes(c.try_into().unwrap())).collect();
    let idx: Vec<u32> = buf[8 + nv * 12..8 + nv * 12 + ni * 4].chunks_exact(4).map(|c| u32::from_le_bytes(c.try_into().unwrap())).collect();
    let target: usize = args[2].parse().unwrap();
    let t = Instant::now();
    let tri = TriMesh::welded(&pos, Some(&idx));
    let m = quad_remesh(&tri, &QuadOptions { target_faces: target, ..Default::default() });
    let ms = t.elapsed().as_secs_f64() * 1000.0;
    let quads = m.quad_count();
    let mut valence = std::collections::BTreeMap::new();
    let mut deg = vec![0u32; m.v.len()];
    let mut o = 0;
    for &s in &m.sizes { for k in 0..s as usize { deg[m.idx[o + k] as usize] += 1; } o += s as usize; }
    for d in deg { *valence.entry(d).or_insert(0) += 1; }
    let mut dir = std::collections::HashSet::new();
    let mut o = 0;
    for &s in &m.sizes { for k in 0..s as usize { dir.insert((m.idx[o + k], m.idx[o + (k + 1) % s as usize])); } o += s as usize; }
    let boundary = dir.iter().filter(|(a, b)| !dir.contains(&(*b, *a))).count();
    println!("boundary edges {boundary}");
    println!("input {} tris -> {} faces ({} quads, {} tris), {} verts in {:.0} ms; valence {:?}", tri.f.len(), m.face_count(), quads, m.face_count() - quads, m.v.len(), ms, valence);
    let t = Instant::now();
    let atlas = build_atlas(&m.v, &m.sizes, &m.idx, &AtlasOptions::default());
    println!("atlas: {} charts, utilization {:.2} in {:.0} ms", atlas.chart_count, atlas.utilization, t.elapsed().as_secs_f64() * 1000.0);
    if let Some(out) = args.get(3) {
        let mut f = std::io::BufWriter::new(std::fs::File::create(out).unwrap());
        for p in &m.v { writeln!(f, "v {} {} {}", p[0], p[1], p[2]).unwrap(); }
        for t in &atlas.uv { writeln!(f, "vt {} {}", t[0], 1.0 - t[1]).unwrap(); }
        let mut o = 0;
        for &s in &m.sizes { write!(f, "f").unwrap(); for k in 0..s as usize { write!(f, " {}/{}", m.idx[o + k] + 1, o + k + 1).unwrap(); } writeln!(f).unwrap(); o += s as usize; }
    }
}
