import { FINGER_SEGMENTS, type Finger, type Side } from '../skeleton';

type V3 = [number, number, number];

export interface FingerDetection {
  /** 'detected': fingers found as separate geometry; 'template': placed from hand proportions. */
  method: 'detected' | 'template';
  fingersFound: number;
  thumbFound: boolean;
}

export interface FingerInput {
  side: Side;
  wrist: V3;
  /** Fingertip-most point of the hand (end of the arm trace). */
  tip: V3;
  height: number;
}

interface HandFrame {
  origin: V3;
  a: V3; // along the hand, wrist -> fingertips
  s: V3; // across the hand, oriented toward the thumb (front, +Z)
  n: V3; // through the palm
  length: number;
}

const FINGER_ORDER: Finger[] = ['Index', 'Middle', 'Ring', 'Little'];
const TEMPLATE = {
  knuckle: 0.52,
  length: { Index: 0.42, Middle: 0.48, Ring: 0.45, Little: 0.36 } as Record<string, number>,
  spread: { Index: 0.33, Middle: 0.11, Ring: -0.11, Little: -0.33 } as Record<string, number>,
};

/**
 * Places 15 finger bones on one hand. Slices the hand across its length and
 * counts separate "runs" of geometry across the palm; where four or five runs
 * appear, those are the fingers. Hands whose fingers are fused (common in AI
 * generated meshes) fall back to proportional placement inside the hand volume.
 */
export function detectFingers(
  positions: Float32Array,
  index: Uint32Array | null,
  input: FingerInput,
): { joints: Record<string, V3>; tails: Record<string, V3>; detection: FingerDetection } {
  const { side, wrist, tip } = input;
  const axis = sub(tip, wrist);
  const Lh = len(axis);
  const a = norm(axis);
  const pts = sampleHand(positions, index, wrist, a, Lh);
  const frame = handFrame(pts, wrist, a, Lh);

  // Local coordinates.
  const n = pts.length / 3;
  const T = new Float32Array(n), S = new Float32Array(n), N = new Float32Array(n);
  let sMin = Infinity, sMax = -Infinity;
  const [fa0, fa1, fa2] = frame.a, [fs0, fs1, fs2] = frame.s, [fn0, fn1, fn2] = frame.n;
  for (let i = 0; i < n; i++) {
    const d0 = pts[i * 3] - wrist[0], d1 = pts[i * 3 + 1] - wrist[1], d2 = pts[i * 3 + 2] - wrist[2];
    T[i] = d0 * fa0 + d1 * fa1 + d2 * fa2;
    S[i] = d0 * fs0 + d1 * fs1 + d2 * fs2;
    N[i] = d0 * fn0 + d1 * fn1 + d2 * fn2;
    if (T[i] > 0.25 * Lh) {
      if (S[i] < sMin) sMin = S[i];
      if (S[i] > sMax) sMax = S[i];
    }
  }
  if (!Number.isFinite(sMin)) { sMin = -0.25 * Lh; sMax = 0.25 * Lh; }

  // Occupancy image in (t, s).
  const tBins = 110;
  const tRes = (1.15 * Lh) / tBins;
  const sRes = Lh / 130;
  const sBins = Math.max(8, Math.ceil((sMax - sMin) / sRes) + 3);
  const img = new Uint8Array(tBins * sBins);
  const nSum = new Float32Array(tBins * sBins);
  const nCnt = new Uint16Array(tBins * sBins);
  for (let i = 0; i < n; i++) {
    const tb = Math.floor(T[i] / tRes);
    const sb = Math.floor((S[i] - sMin) / sRes) + 1;
    if (tb < 0 || tb >= tBins || sb < 0 || sb >= sBins) continue;
    const k = tb * sBins + sb;
    img[k] = 1;
    nSum[k] += N[i];
    nCnt[k]++;
  }
  const sOf = (sb: number) => sMin + (sb - 1 + 0.5) * sRes;
  const tOf = (tb: number) => (tb + 0.5) * tRes;
  const tbOf = (t: number) => Math.min(tBins - 1, Math.max(0, Math.floor(t / tRes)));
  /** Runs of occupied s-bins in one t-slice, optionally limited to [lo, hi]. */
  const runsAt = (tb: number, lo = 0, hi = sBins - 1): Array<[number, number]> => {
    const runs: Array<[number, number]> = [];
    let start = -1;
    for (let sb = lo; sb <= hi + 1; sb++) {
      const on = sb <= hi && img[tb * sBins + sb] === 1;
      if (on && start < 0) start = sb;
      if (!on && start >= 0) { runs.push([start, sb - 1]); start = -1; }
    }
    return runs;
  };
  const meanN = (tb: number, s0: number, s1: number) => {
    let sum = 0, c = 0;
    for (let sb = s0; sb <= s1; sb++) { sum += nSum[tb * sBins + sb]; c += nCnt[tb * sBins + sb]; }
    return c ? sum / c : 0;
  };
  const median = (xs: number[]) => {
    const s = xs.slice().sort((p, q) => p - q);
    return s.length ? s[Math.floor(s.length / 2)] : 0;
  };

  // 1. Palm: the widest run in the lower half of the hand (thumb excluded as a separate run).
  const palmLo: number[] = [], palmHi: number[] = [];
  for (let tb = tbOf(0.15 * Lh); tb <= tbOf(0.4 * Lh); tb++) {
    const runs = runsAt(tb);
    if (!runs.length) continue;
    const widest = runs.reduce((p, q) => (q[1] - q[0] > p[1] - p[0] ? q : p));
    palmLo.push(widest[0]);
    palmHi.push(widest[1]);
  }
  const p0 = palmLo.length ? median(palmLo) : 1;
  const p1 = palmHi.length ? median(palmHi) : sBins - 2;
  const palmCenterS = palmLo.length ? sOf((p0 + p1) / 2) : (sMin + sMax) / 2;
  const palmWidth = palmLo.length ? Math.max((p1 - p0 + 1) * sRes, 0.15 * Lh) : Math.max(sMax - sMin, 0.2 * Lh);
  const lo = Math.max(0, p0 - 2), hi = Math.min(sBins - 1, p1 + 2);

  // 2. Fingers: slices beyond the palm with the most separate runs inside the palm's band.
  //    Merged neighbors (a run much wider than the typical finger) are split.
  const fingerRunsAt = (tb: number): Array<[number, number]> => {
    const runs = runsAt(tb, lo, hi).filter((r) => r[1] - r[0] + 1 >= 2);
    if (!runs.length) return runs;
    const single = Math.max(2, Math.round(palmWidth / sRes / 4.4));
    const out: Array<[number, number]> = [];
    for (const r of runs) {
      const w = r[1] - r[0] + 1;
      const parts = Math.min(4, Math.max(1, Math.round(w / single)));
      if (parts <= 1 || w < 1.6 * single) { out.push(r); continue; }
      for (let k = 0; k < parts; k++) {
        const a = r[0] + Math.round((k * w) / parts);
        const b = r[0] + Math.round(((k + 1) * w) / parts) - 1;
        out.push([a, b]);
      }
    }
    return out;
  };
  const exactBins: number[] = [];
  const splitBins: number[] = [];
  for (let tb = tbOf(0.35 * Lh); tb <= tbOf(1.0 * Lh); tb++) {
    const raw = runsAt(tb, lo, hi).filter((r) => r[1] - r[0] + 1 >= 2).length;
    if (raw === 4) exactBins.push(tb);
    else if (raw >= 2 && fingerRunsAt(tb).length === 4) splitBins.push(tb);
  }

  const joints: Record<string, V3> = {};
  const tails: Record<string, V3> = {};
  const toWorld = (t: number, s: number, nn: number): V3 => [
    wrist[0] + frame.a[0] * t + frame.s[0] * s + frame.n[0] * nn,
    wrist[1] + frame.a[1] * t + frame.s[1] * s + frame.n[1] * nn,
    wrist[2] + frame.a[2] * t + frame.s[2] * s + frame.n[2] * nn,
  ];
  const placeChain = (finger: Finger, samples: Array<{ t: number; s: number; n: number }>, knuckleT: number, tipT: number) => {
    const at = (t: number) => {
      let best = samples[0];
      for (const smp of samples) if (Math.abs(smp.t - t) < Math.abs(best.t - t)) best = smp;
      return toWorld(t, best.s, best.n);
    };
    const L = Math.max(tipT - knuckleT, 0.05 * Lh);
    const [s0, s1, s2] = FINGER_SEGMENTS[finger];
    joints[`${side}${finger}${s0}`] = at(knuckleT);
    joints[`${side}${finger}${s1}`] = at(knuckleT + 0.45 * L);
    joints[`${side}${finger}${s2}`] = at(knuckleT + 0.75 * L);
    tails[`${side}${finger}${s2}`] = at(knuckleT + L);
  };
  const palmN = (t: number) => meanN(tbOf(t), lo, hi);
  const templateFinger = (finger: Finger) => {
    const s = palmCenterS + TEMPLATE.spread[finger] * palmWidth;
    const k = TEMPLATE.knuckle * Lh;
    // Clamp the tip to the geometry actually present in this finger's band.
    let maxT = 0;
    for (let i = 0; i < n; i++) if (Math.abs(S[i] - s) < 0.12 * palmWidth && T[i] > maxT) maxT = T[i];
    const tipT = maxT > k + 0.1 * Lh ? Math.min(maxT, k + TEMPLATE.length[finger] * Lh * 1.2) : k + TEMPLATE.length[finger] * Lh;
    const samples = [0, 0.25, 0.5, 0.75, 1].map((f) => {
      const t = k + f * (tipT - k);
      return { t, s, n: palmN(t) };
    });
    placeChain(finger, samples, k, tipT);
  };
  const templateThumb = () => {
    const pos = (t: number, f: number): V3 => toWorld(t * Lh, palmCenterS + f * palmWidth, palmN(t * Lh));
    joints[`${side}ThumbMetacarpal`] = pos(0.12, 0.3);
    joints[`${side}ThumbProximal`] = pos(0.3, 0.5);
    joints[`${side}ThumbDistal`] = pos(0.42, 0.62);
    tails[`${side}ThumbDistal`] = pos(0.55, 0.72);
  };

  let detection: FingerDetection = { method: 'template', fingersFound: 0, thumbFound: false };
  const bins = exactBins.length >= 3 ? exactBins : splitBins.length >= 3 ? splitBins : null;
  if (bins) {
    const tStar = bins[Math.floor(bins.length / 2)];
    // Four separate runs are the fingers as they are; splitting a wide one there would make five.
    const starRuns = bins === exactBins ? runsAt(tStar, lo, hi).filter((r) => r[1] - r[0] + 1 >= 2) : fingerRunsAt(tStar);
    const fingerRuns = starRuns.sort((r1, r2) => r2[0] - r1[0]); // thumb side (+s) first
    const widthAtStar = fingerRuns.map((r) => r[1] - r[0] + 1);
    const overlapping = (tb: number, cur: [number, number]) => {
      let best: [number, number] | undefined;
      let bestOverlap = 0;
      for (const q of fingerRunsAt(tb)) {
        const ov = Math.min(q[1], cur[1] + 1) - Math.max(q[0], cur[0] - 1) + 1;
        if (ov > bestOverlap) { bestOverlap = ov; best = q; }
      }
      return best;
    };
    fingerRuns.forEach((run, fi) => {
      const finger = FINGER_ORDER[fi];
      const samples: Array<{ t: number; s: number; n: number }> = [];
      let cur = run;
      let tipBin = tStar;
      let misses = 0;
      for (let tb = tStar; tb < tBins; tb++) {
        const r = overlapping(tb, cur);
        if (!r) {
          if (++misses > 2) break;
          continue;
        }
        misses = 0;
        cur = r;
        tipBin = tb;
        samples.push({ t: tOf(tb), s: sOf((r[0] + r[1]) / 2), n: meanN(tb, r[0], r[1]) });
      }
      // Knuckle: walk toward the wrist until the finger merges into the palm.
      cur = run;
      let knuckleBin = tStar;
      misses = 0;
      for (let tb = tStar - 1; tb >= 0; tb--) {
        const raw = runsAt(tb, lo, hi).find((q) => q[1] >= cur[0] - 1 && q[0] <= cur[1] + 1);
        if (!raw) {
          if (++misses > 2) break;
          continue;
        }
        misses = 0;
        if (raw[1] - raw[0] + 1 > 2.6 * widthAtStar[fi]) break;
        const r = overlapping(tb, cur) ?? raw;
        cur = r;
        knuckleBin = tb;
        samples.unshift({ t: tOf(tb), s: sOf((r[0] + r[1]) / 2), n: meanN(tb, r[0], r[1]) });
      }
      placeChain(finger, samples, tOf(knuckleBin), tOf(tipBin) + 0.5 * tRes);
    });

    // 3. Thumb: geometry beyond the palm's thumb-side edge.
    const edge = sOf(p1) + 1.5 * sRes;
    const thumbPts: V3[] = [];
    for (let i = 0; i < n; i++) if (S[i] > edge && T[i] < 0.9 * Lh && T[i] > 0.02 * Lh) thumbPts.push([T[i], S[i], N[i]]);
    if (thumbPts.length > 20) {
      // Base: closest to the palm edge; tip: farthest from the base.
      let base = thumbPts[0], tipP = thumbPts[0];
      for (const p of thumbPts) if (p[1] < base[1] || (p[1] === base[1] && p[0] < base[0])) base = p;
      let far = -1;
      for (const p of thumbPts) {
        const d = Math.hypot(p[0] - base[0], p[1] - base[1], p[2] - base[2]);
        if (d > far) { far = d; tipP = p; }
      }
      const lerpP = (f: number): V3 => toWorld(base[0] + (tipP[0] - base[0]) * f, base[1] + (tipP[1] - base[1]) * f, base[2] + (tipP[2] - base[2]) * f);
      joints[`${side}ThumbMetacarpal`] = toWorld(Math.max(0.06 * Lh, base[0] - 0.1 * Lh), palmCenterS + 0.25 * palmWidth, palmN(base[0]));
      joints[`${side}ThumbProximal`] = lerpP(0.05);
      joints[`${side}ThumbDistal`] = lerpP(0.55);
      tails[`${side}ThumbDistal`] = lerpP(1);
      detection = { method: 'detected', fingersFound: fingerRuns.length, thumbFound: true };
    } else {
      templateThumb();
      detection = { method: 'detected', fingersFound: fingerRuns.length, thumbFound: false };
    }
  } else {
    for (const f of FINGER_ORDER) templateFinger(f);
    templateThumb();
  }
  return { joints, tails, detection };
}

function sampleHand(positions: Float32Array, index: Uint32Array | null, wrist: V3, a: V3, Lh: number): Float32Array {
  let out = new Float32Array(3 * 65536);
  let m = 0;
  const spacing = Lh / 260;
  const triCount = index ? index.length / 3 : positions.length / 9;
  const [wx, wy, wz] = wrist, [a0, a1, a2] = a;
  const tLo = -0.05 * Lh, tHi = 1.15 * Lh, r2 = 0.8 * 0.8 * Lh * Lh;
  const inRegion = (x: number, y: number, z: number) => {
    const dx = x - wx, dy = y - wy, dz = z - wz;
    const t = dx * a0 + dy * a1 + dz * a2;
    if (t < tLo || t > tHi) return false;
    const rx = dx - a0 * t, ry = dy - a1 * t, rz = dz - a2 * t;
    return rx * rx + ry * ry + rz * rz < r2;
  };
  for (let tIdx = 0; tIdx < triCount; tIdx++) {
    const ia = index ? index[tIdx * 3] : tIdx * 3;
    const ib = index ? index[tIdx * 3 + 1] : tIdx * 3 + 1;
    const ic = index ? index[tIdx * 3 + 2] : tIdx * 3 + 2;
    const ax = positions[ia * 3], ay = positions[ia * 3 + 1], az = positions[ia * 3 + 2];
    const bx = positions[ib * 3], by = positions[ib * 3 + 1], bz = positions[ib * 3 + 2];
    const cx = positions[ic * 3], cy = positions[ic * 3 + 1], cz = positions[ic * 3 + 2];
    if (!inRegion((ax + bx + cx) / 3, (ay + by + cy) / 3, (az + bz + cz) / 3)) continue;
    const e = Math.max(Math.hypot(bx - ax, by - ay, bz - az), Math.hypot(cx - bx, cy - by, cz - bz), Math.hypot(ax - cx, ay - cy, az - cz));
    const k = Math.max(1, Math.min(260, Math.ceil(e / spacing)));
    // Grow once per triangle rather than per point.
    const need = m + 3 * ((k + 1) * (k + 2)) / 2;
    if (need > out.length) {
      const grown = new Float32Array(Math.max(need, out.length * 2));
      grown.set(out.subarray(0, m));
      out = grown;
    }
    for (let i = 0; i <= k; i++)
      for (let j = 0; j <= k - i; j++) {
        const u = i / k, w = j / k;
        const x = ax + (bx - ax) * u + (cx - ax) * w;
        const y = ay + (by - ay) * u + (cy - ay) * w;
        const z = az + (bz - az) * u + (cz - az) * w;
        if (inRegion(x, y, z)) {
          out[m++] = x;
          out[m++] = y;
          out[m++] = z;
        }
      }
  }
  return out.slice(0, m);
}

function handFrame(pts: Float32Array, wrist: V3, a: V3, Lh: number): HandFrame {
  // Default spread axis: world +Z made perpendicular to the hand axis.
  let s = norm(sub([0, 0, 1], scale(a, a[2])));
  if (!Number.isFinite(s[0]) || len(sub([0, 0, 1], scale(a, a[2]))) < 1e-3) s = [0, 0, 1];
  // PCA of the mid-hand cross-section to find the palm's wide axis.
  // Radial offsets of the selected points, stored flat (no per-point allocations).
  const count = pts.length / 3;
  const sel = new Float64Array(pts.length);
  let ns = 0;
  const [a0, a1, a2] = a;
  for (let i = 0; i < count; i++) {
    const d0 = pts[i * 3] - wrist[0], d1 = pts[i * 3 + 1] - wrist[1], d2 = pts[i * 3 + 2] - wrist[2];
    const t = d0 * a0 + d1 * a1 + d2 * a2;
    if (t > 0.2 * Lh && t < 0.6 * Lh) {
      sel[ns * 3] = d0 - a0 * t;
      sel[ns * 3 + 1] = d1 - a1 * t;
      sel[ns * 3 + 2] = d2 - a2 * t;
      ns++;
    }
  }
  if (ns > 30) {
    const m = [0, 0, 0];
    for (let i = 0; i < ns; i++) { m[0] += sel[i * 3]; m[1] += sel[i * 3 + 1]; m[2] += sel[i * 3 + 2]; }
    m[0] /= ns; m[1] /= ns; m[2] /= ns;
    const C = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    for (let i = 0; i < ns; i++) {
      const q0 = sel[i * 3] - m[0], q1 = sel[i * 3 + 1] - m[1], q2 = sel[i * 3 + 2] - m[2];
      C[0] += q0 * q0; C[1] += q0 * q1; C[2] += q0 * q2;
      C[3] += q1 * q0; C[4] += q1 * q1; C[5] += q1 * q2;
      C[6] += q2 * q0; C[7] += q2 * q1; C[8] += q2 * q2;
    }
    // Power iteration for the major axis.
    let v: V3 = [s[0], s[1], s[2]];
    for (let it = 0; it < 30; it++) {
      const w: V3 = [C[0] * v[0] + C[1] * v[1] + C[2] * v[2], C[3] * v[0] + C[4] * v[1] + C[5] * v[2], C[6] * v[0] + C[7] * v[1] + C[8] * v[2]];
      const l = len(w);
      if (l < 1e-12) break;
      v = scale(w, 1 / l);
    }
    const lambda1 = dot(v, [C[0] * v[0] + C[1] * v[1] + C[2] * v[2], C[3] * v[0] + C[4] * v[1] + C[5] * v[2], C[6] * v[0] + C[7] * v[1] + C[8] * v[2]]);
    const u = norm(cross(a, v));
    const lambda2 = dot(u, [C[0] * u[0] + C[1] * u[1] + C[2] * u[2], C[3] * u[0] + C[4] * u[1] + C[5] * u[2], C[6] * u[0] + C[7] * u[1] + C[8] * u[2]]);
    if (lambda1 > 1.5 * lambda2) s = norm(sub(v, scale(a, dot(v, a))));
  }
  if (s[2] < 0) s = scale(s, -1);
  const n = norm(cross(a, s));
  return { origin: wrist, a, s, n, length: Lh };
}

function sub(a: V3, b: V3): V3 { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function scale(a: V3, s: number): V3 { return [a[0] * s, a[1] * s, a[2] * s]; }
function dot(a: V3, b: V3): number { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function cross(a: V3, b: V3): V3 { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function len(a: V3): number { return Math.hypot(a[0], a[1], a[2]); }
function norm(a: V3): V3 { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }
