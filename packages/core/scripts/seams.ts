/**
 * Removes the bodysuit seams a generator sculpts into a body mesh (piping beads
 * and the grooves beside them at the collar, back yoke, raglans, cuffs, knees
 * and ankles) while keeping the anatomy around them.
 *
 * Seams are finer than any muscle: they stand out of the surface by a fraction
 * of a millimetre against a ~2.5 mm smoothing of it. Those vertices, widened by
 * a few millimetres, are re-solved as a smooth (biharmonic) patch spanning the
 * untouched surface on either side, so curvature carries across the gap. The
 * hands, soles and head are left alone: their fine detail is anatomy.
 *
 * Input: Y up, feet at 0, facing +Z, metres.
 */

export interface SeamOptions {
  /** Smoothing scale that separates seams from anatomy (m). */
  scale?: number;
  /** Detail height above which a vertex counts as seam (m). */
  threshold?: number;
  /** How far around the seam the surface is re-solved (m). */
  widen?: number;
}

export function removeSeams(p: Float32Array, index: Uint32Array, opts: SeamOptions = {}) {
  const { scale = 0.0025, threshold = 0.0002, widen = 0.008 } = opts;
  const V = p.length / 3;
  const { start, nb, w, area } = cotanLaplacian(p, index);
  const lap = (x: Float64Array, out: Float64Array, free?: Uint8Array) => {
    for (let v = 0; v < V; v++) {
      if (free && !free[v]) {
        out[v] = 0;
        continue;
      }
      let s = 0, d = 0;
      for (let j = start[v]; j < start[v + 1]; j++) {
        s += w[j] * x[nb[j]];
        d += w[j];
      }
      out[v] = d * x[v] - s;
    }
  };

  // Fine detail: the surface's height above an implicit smoothing (M + s²L) B = M p.
  const s2 = scale * scale;
  const tmp = new Float64Array(V);
  const B = new Float64Array(V * 3);
  for (let k = 0; k < 3; k++) {
    const b = new Float64Array(V), x = new Float64Array(V);
    for (let v = 0; v < V; v++) {
      b[v] = area[v] * p[v * 3 + k];
      x[v] = p[v * 3 + k];
    }
    const diag = new Float64Array(V);
    for (let v = 0; v < V; v++) {
      let d = 0;
      for (let j = start[v]; j < start[v + 1]; j++) d += w[j];
      diag[v] = area[v] + s2 * d;
    }
    cg((y, out) => {
      lap(y, tmp);
      for (let v = 0; v < V; v++) out[v] = area[v] * y[v] + s2 * tmp[v];
    }, b, x, diag, 400, 1e-10);
    for (let v = 0; v < V; v++) B[v * 3 + k] = x[v];
  }
  const n = vertexNormals(B, index);
  const seed = new Uint8Array(V);
  const keep = keepOut(p);
  for (let v = 0; v < V; v++) {
    let h = 0;
    for (let k = 0; k < 3; k++) h += (p[v * 3 + k] - B[v * 3 + k]) * n[v * 3 + k];
    if (Math.abs(h) > threshold && !keep[v]) seed[v] = 1;
  }

  // Widen along the surface (Dijkstra from every seam vertex).
  const dist = new Float64Array(V).fill(Infinity);
  const heap = new MinHeap();
  for (let v = 0; v < V; v++) if (seed[v]) {
    dist[v] = 0;
    heap.push(0, v);
  }
  while (heap.size) {
    const [d, v] = heap.pop();
    if (d > dist[v]) continue;
    for (let j = start[v]; j < start[v + 1]; j++) {
      const u = nb[j];
      const e = d + Math.hypot(p[u * 3] - p[v * 3], p[u * 3 + 1] - p[v * 3 + 1], p[u * 3 + 2] - p[v * 3 + 2]);
      if (e < dist[u] && e < widen) {
        dist[u] = e;
        heap.push(e, u);
      }
    }
  }
  const free = new Uint8Array(V);
  let freeCount = 0, seedCount = 0;
  for (let v = 0; v < V; v++) {
    if (dist[v] < widen && !keep[v]) free[v] = 1;
    freeCount += free[v];
    seedCount += seed[v];
  }

  // Biharmonic fill: L M⁻¹ L x = 0 on the free vertices, the rest held fixed.
  const t1 = new Float64Array(V), t2 = new Float64Array(V);
  const bilap = (x: Float64Array, out: Float64Array, only?: Uint8Array) => {
    lap(x, t1);
    for (let v = 0; v < V; v++) t2[v] = t1[v] / area[v];
    lap(t2, out, only);
  };
  const diag = new Float64Array(V);
  for (let v = 0; v < V; v++) {
    let d = 0, dd = 0;
    for (let j = start[v]; j < start[v + 1]; j++) {
      d += w[j];
      dd += (w[j] * w[j]) / area[nb[j]];
    }
    diag[v] = free[v] ? (d * d) / area[v] + dd : 1;
  }
  let moved = 0;
  for (let k = 0; k < 3; k++) {
    const x = new Float64Array(V);
    for (let v = 0; v < V; v++) x[v] = p[v * 3 + k];
    // Solve K_FF δ = -(K x)_F, then x_F += δ.
    const r = new Float64Array(V);
    bilap(x, r, free);
    for (let v = 0; v < V; v++) r[v] = -r[v];
    const delta = new Float64Array(V);
    cg((y, out) => {
      for (let v = 0; v < V; v++) if (!free[v]) y[v] = 0;
      bilap(y, out, free);
    }, r, delta, diag, 4000, 1e-14);
    for (let v = 0; v < V; v++) if (free[v]) {
      p[v * 3 + k] = x[v] + delta[v];
      moved = Math.max(moved, Math.abs(delta[v]));
    }
  }
  return { seams: seedCount, resolved: freeCount, moved };
}

/** Regions whose fine detail is anatomy, not seams: hands, toes and soles, head and neck above the collar. */
function keepOut(p: Float32Array) {
  const V = p.length / 3;
  const keep = new Uint8Array(V);
  for (const side of [1, -1]) {
    // Fingertip: the lowest point out to that side; the hand is within 17.5 cm of it.
    let tip = -1;
    for (let v = 0; v < V; v++) if (p[v * 3] * side > 0.3 && (tip < 0 || p[v * 3 + 1] < p[tip * 3 + 1])) tip = v;
    for (let v = 0; v < V; v++) {
      if (Math.hypot(p[v * 3] - p[tip * 3], p[v * 3 + 1] - p[tip * 3 + 1], p[v * 3 + 2] - p[tip * 3 + 2]) < 0.175) keep[v] = 1;
    }
  }
  // Neck depth, to tilt the collar line (higher at the back).
  let z0 = Infinity, z1 = -Infinity;
  for (let v = 0; v < V; v++) {
    const y = p[v * 3 + 1];
    if (y > 1.5 && y < 1.56 && Math.abs(p[v * 3]) < 0.06) {
      z0 = Math.min(z0, p[v * 3 + 2]);
      z1 = Math.max(z1, p[v * 3 + 2]);
    }
  }
  for (let v = 0; v < V; v++) {
    const y = p[v * 3 + 1];
    const front = Math.min(1, Math.max(0, (p[v * 3 + 2] - z0) / (z1 - z0)));
    if (y < 0.035 || y > 1.565 - 0.045 * front) keep[v] = 1;
  }
  return keep;
}

/** Cotangent weights (negative ones clamped to 0) as CSR, and lumped vertex areas. */
function cotanLaplacian(p: Float32Array, index: Uint32Array) {
  const V = p.length / 3;
  const map = new Map<number, number>();
  const area = new Float64Array(V);
  const ii: number[] = [], jj: number[] = [], ww: number[] = [];
  const add = (a: number, b: number, c: number) => {
    const key = Math.min(a, b) * V + Math.max(a, b);
    const at = map.get(key);
    if (at === undefined) {
      map.set(key, ww.length);
      ii.push(a);
      jj.push(b);
      ww.push(c);
    } else ww[at] += c;
  };
  for (let t = 0; t < index.length; t += 3) {
    const tri = [index[t], index[t + 1], index[t + 2]];
    for (let e = 0; e < 3; e++) {
      const i = tri[e], j = tri[(e + 1) % 3], o = tri[(e + 2) % 3];
      const ax = p[i * 3] - p[o * 3], ay = p[i * 3 + 1] - p[o * 3 + 1], az = p[i * 3 + 2] - p[o * 3 + 2];
      const bx = p[j * 3] - p[o * 3], by = p[j * 3 + 1] - p[o * 3 + 1], bz = p[j * 3 + 2] - p[o * 3 + 2];
      const cr = Math.hypot(ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx);
      const cot = (ax * bx + ay * by + az * bz) / Math.max(cr, 1e-12);
      add(i, j, Math.min(10, Math.max(0, cot)) * 0.5);
      if (e === 0) {
        const a = cr / 6;
        area[i] += a;
        area[j] += a;
        area[o] += a;
      }
    }
  }
  const start = new Uint32Array(V + 1);
  for (let e = 0; e < ii.length; e++) {
    start[ii[e] + 1]++;
    start[jj[e] + 1]++;
  }
  for (let v = 0; v < V; v++) start[v + 1] += start[v];
  const fill = start.slice(0, V);
  const nb = new Uint32Array(ii.length * 2), w = new Float64Array(ii.length * 2);
  for (let e = 0; e < ii.length; e++) {
    nb[fill[ii[e]]] = jj[e];
    w[fill[ii[e]]++] = ww[e];
    nb[fill[jj[e]]] = ii[e];
    w[fill[jj[e]]++] = ww[e];
  }
  for (let v = 0; v < V; v++) area[v] = Math.max(area[v], 1e-12);
  return { start, nb, w, area };
}

function vertexNormals(p: Float64Array, index: Uint32Array) {
  const n = new Float64Array(p.length);
  for (let t = 0; t < index.length; t += 3) {
    const a = index[t] * 3, b = index[t + 1] * 3, c = index[t + 2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    const fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx;
    for (const i of [a, b, c]) {
      n[i] += fx;
      n[i + 1] += fy;
      n[i + 2] += fz;
    }
  }
  for (let i = 0; i < n.length; i += 3) {
    const l = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1;
    n[i] /= l;
    n[i + 1] /= l;
    n[i + 2] /= l;
  }
  return n;
}

/** Jacobi-preconditioned conjugate gradients, solving A x = b in place from x. */
function cg(A: (x: Float64Array, out: Float64Array) => void, b: Float64Array, x: Float64Array, diag: Float64Array, maxIter: number, tol: number) {
  const N = b.length;
  const r = new Float64Array(N), z = new Float64Array(N), d = new Float64Array(N), Ad = new Float64Array(N);
  A(x, Ad);
  let bb = 0;
  for (let i = 0; i < N; i++) {
    r[i] = b[i] - Ad[i];
    bb += b[i] * b[i];
  }
  for (let i = 0; i < N; i++) d[i] = z[i] = r[i] / diag[i];
  let rz = 0;
  for (let i = 0; i < N; i++) rz += r[i] * z[i];
  for (let it = 0; it < maxIter; it++) {
    A(d, Ad);
    let dAd = 0;
    for (let i = 0; i < N; i++) dAd += d[i] * Ad[i];
    if (dAd <= 0) break;
    const a = rz / dAd;
    let rr = 0;
    for (let i = 0; i < N; i++) {
      x[i] += a * d[i];
      r[i] -= a * Ad[i];
      rr += r[i] * r[i];
    }
    if (rr <= tol * tol * Math.max(bb, 1e-30)) break;
    let rz2 = 0;
    for (let i = 0; i < N; i++) rz2 += r[i] * (z[i] = r[i] / diag[i]);
    const beta = rz2 / rz;
    rz = rz2;
    for (let i = 0; i < N; i++) d[i] = z[i] + beta * d[i];
  }
}

class MinHeap {
  private k: number[] = [];
  private v: number[] = [];
  get size() {
    return this.k.length;
  }
  push(key: number, val: number) {
    const k = this.k, v = this.v;
    let i = k.length;
    k.push(key);
    v.push(val);
    while (i > 0) {
      const up = (i - 1) >> 1;
      if (k[up] <= key) break;
      k[i] = k[up];
      v[i] = v[up];
      i = up;
    }
    k[i] = key;
    v[i] = val;
  }
  pop(): [number, number] {
    const k = this.k, v = this.v;
    const top: [number, number] = [k[0], v[0]];
    const lk = k.pop()!, lv = v.pop()!;
    if (k.length) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= k.length) break;
        if (c + 1 < k.length && k[c + 1] < k[c]) c++;
        if (k[c] >= lk) break;
        k[i] = k[c];
        v[i] = v[c];
        i = c;
      }
      k[i] = lk;
      v[i] = lv;
    }
    return top;
  }
}
