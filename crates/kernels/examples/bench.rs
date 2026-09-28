//! Native benchmark on dumped kernel inputs:
//!   cargo run --release --example bench -- <dump.bin>...
//! Dumps are written by scripts/bench/dump-geodesic.ts; also times 2 and 4 threads.
use rigforge_kernels::{bone_distances, bone_distances_fast, GeodesicSession, Grid};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Instant;

fn f32s(b: &[u8]) -> Vec<f32> {
    b.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect()
}

fn main() {
    for path in std::env::args().skip(1) {
        let buf = std::fs::read(&path).unwrap();
        let h = f32s(&buf[..44]);
        let (nx, ny, nz) = (h[0] as usize, h[1] as usize, h[2] as usize);
        let (bones, segs, pts) = (h[7] as usize, h[8] as usize, h[9] as usize);
        let total = nx * ny * nz;
        let mut o = 44;
        let data = buf[o..o + total].to_vec();
        o += total;
        let segments = f32s(&buf[o..o + segs * 28]);
        o += segs * 28;
        let points = f32s(&buf[o..o + pts * 12]);
        o += pts * 12;
        let reference = f32s(&buf[o..o + pts * bones * 4]);
        let grid = Grid { origin: [h[3], h[4], h[5]], dx: h[6], nx, ny, nz, data };
        let solid = grid.data.iter().filter(|&&v| v != 0).count();
        let mut best = f64::INFINITY;
        let mut out = Vec::new();
        for _ in 0..3 {
            let t = Instant::now();
            out = if std::env::var("OLD").is_ok() { bone_distances(&grid, bones, &segments, &points, h[10]) } else { bone_distances_fast(&grid, bones, 0..bones, &segments, &points, h[10]) };
            best = best.min(t.elapsed().as_secs_f64() * 1000.0);
        }
        let (mut max_err, mut mismatched) = (0f32, 0usize);
        for (a, b) in out.iter().zip(&reference) {
            if a.is_finite() != b.is_finite() {
                mismatched += 1;
            } else if a.is_finite() {
                max_err = max_err.max((a - b).abs());
            }
        }
        // Threads pulling bones from a shared counter, one session each (like the browser workers).
        for threads in [2usize, 4] {
            let t = Instant::now();
            let next = AtomicUsize::new(0);
            let cols: Vec<Vec<(usize, Vec<f32>)>> = std::thread::scope(|sc| {
                let hs: Vec<_> = (0..threads).map(|_| sc.spawn(|| {
                    let g = Grid { origin: grid.origin, dx: grid.dx, nx, ny, nz, data: grid.data.clone() };
                    let mut s = GeodesicSession::new(g, &segments, &points, h[10]);
                    let mut mine = Vec::new();
                    loop {
                        let b = next.fetch_add(1, Ordering::Relaxed);
                        if b >= bones { break; }
                        let mut col = vec![0f32; pts];
                        s.bone(b, &mut col, 1);
                        mine.push((b, col));
                    }
                    mine
                })).collect();
                hs.into_iter().map(|h| h.join().unwrap()).collect()
            });
            let ms = t.elapsed().as_secs_f64() * 1000.0;
            let mut ok = true;
            for (b, col) in cols.iter().flatten() {
                for p in 0..pts { let r = reference[p * bones + b]; if !(col[p] == r || (r.is_infinite() && col[p].is_infinite())) { ok = false; } }
            }
            println!("   {threads} threads: {ms:.1} ms, identical {ok}");
        }
        println!("{}: grid {}x{}x{} solid {} bones {} pts {} -> {:.1} ms (max err {:.2e}, finite mismatch {})", path.rsplit('/').next().unwrap(), nx, ny, nz, solid, bones, pts, best, max_err, mismatched);
    }
}
