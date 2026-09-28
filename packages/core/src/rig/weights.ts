import type { Kernels } from '../kernels';
import type { GeodesicInput } from '../voxel/geodesic';
import { tsKernels } from '../kernels';
import { weldByPosition } from '../mesh/analyze';
import type { BoneDef, JointMap } from '../skeleton';

export interface WeightOptions {
  kernels?: Kernels;
  /** Voxels along the model height (default 192). */
  resolution?: number;
  /** Falloff exponent: higher = tighter joints (default 4). */
  falloff?: number;
  /** Laplacian smoothing iterations over the mesh surface (default 2). */
  smoothIterations?: number;
  /** Max influences per vertex (glTF default 4). */
  maxInfluences?: number;
  onProgress?: (stage: string, fraction: number) => void;
}

export interface SkinWeights {
  skinIndex: Uint16Array;
  skinWeight: Float32Array;
  /** Vertices that could not be reached through the volume and used Euclidean fallback. */
  fallbackVertices: number;
  kernel: 'ts' | 'wasm';
  timings: Record<string, number>;
}

type V3 = [number, number, number];

/** Seed segments per bone, flattened for the kernels: [bone, a.xyz, b.xyz]. */
export function boneSegments(defs: readonly BoneDef[], map: JointMap): Float32Array {
  const segs: number[] = [];
  const index = new Map(defs.map((d, i) => [d.name, i]));
  const children = new Map<string, string[]>();
  for (const d of defs) if (d.parent) children.set(d.parent, [...(children.get(d.parent) ?? []), d.name]);
  defs.forEach((def, i) => {
    const a = map.joints[def.name];
    if (!a) return;
    const push = (b: V3 | undefined) => {
      if (b) segs.push(i, a[0], a[1], a[2], b[0], b[1], b[2]);
    };
    if (def.name.endsWith('Hand') && def.side) {
      // Palm: from the wrist toward each finger's base so the palm isn't claimed by fingers.
      const side = def.name.startsWith('left') ? 'left' : 'right';
      const bases = ['IndexProximal', 'MiddleProximal', 'RingProximal', 'LittleProximal'].map((f) => map.joints[`${side}${f}`]).filter(Boolean);
      if (bases.length && index.has(`${side}MiddleProximal`)) {
        for (const b of bases) push(b);
        return;
      }
    }
    // Branching bones (pelvis, chest, ...) own the volume toward each of their children.
    const kids = children.get(def.name) ?? [];
    if (kids.length > 1) {
      for (const k of kids) push(map.joints[k]);
      return;
    }
    const child = def.primaryChild ? map.joints[def.primaryChild] : undefined;
    const target = child && index.has(def.primaryChild!) ? child : map.tails[def.name] ?? child;
    if (target) push(target);
    else segs.push(i, a[0], a[1], a[2], a[0], a[1], a[2]);
  });
  return new Float32Array(segs);
}

/**
 * Geodesic voxel binding (after Dionne & de Lasa 2013):
 * distance from each vertex to each bone is measured through the solid voxel volume,
 * weights fall off as 1/d^k, get smoothed over the surface, limited to 4 influences and normalized.
 */
export function computeSkinWeights(
  positions: Float32Array,
  index: Uint32Array | null,
  defs: readonly BoneDef[],
  map: JointMap,
  options: WeightOptions = {},
): SkinWeights {
  const job = prepareSkinWeights(positions, index, defs, map, options);
  const t0 = job.now();
  const dist = (options.kernels ?? tsKernels).boneDistances(job.input);
  job.timings.distances = job.now() - t0;
  return job.finish(dist);
}

/** Computes the geodesic distances in parallel (e.g. across workers), then the weights. */
export async function computeSkinWeightsAsync(
  positions: Float32Array,
  index: Uint32Array | null,
  defs: readonly BoneDef[],
  map: JointMap,
  distances: (input: GeodesicInput, onBone: (done: number) => void) => Promise<Float32Array>,
  options: WeightOptions = {},
): Promise<SkinWeights> {
  const job = prepareSkinWeights(positions, index, defs, map, options);
  const t0 = job.now();
  const progress = options.onProgress ?? (() => {});
  const dist = await distances(job.input, (done) => progress('Measuring geodesic distances', 0.2 + (0.6 * done) / defs.length));
  job.timings.distances = job.now() - t0;
  return job.finish(dist);
}

/** Everything before and after the geodesic distances, which callers may compute however they like. */
function prepareSkinWeights(
  positions: Float32Array,
  index: Uint32Array | null,
  defs: readonly BoneDef[],
  map: JointMap,
  options: WeightOptions,
) {
  const kernels = options.kernels ?? tsKernels;
  const k = options.falloff ?? 4;
  const maxInf = options.maxInfluences ?? 4;
  const smoothIt = options.smoothIterations ?? 2;
  const progress = options.onProgress ?? (() => {});
  const timings: Record<string, number> = {};
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

  // Voxel size from the largest dimension (height for characters, length for long creatures).
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      if (positions[i + k] < lo[k]) lo[k] = positions[i + k];
      if (positions[i + k] > hi[k]) hi[k] = positions[i + k];
    }
  }
  const H = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
  const dx = H / (options.resolution ?? 192);

  progress('Voxelizing', 0.05);
  let t0 = now();
  const grid = kernels.voxelize({ positions, index, dx, pad: 2 });
  timings.voxelize = now() - t0;

  const B = defs.length;
  const segments = boneSegments(defs, map);
  const { ids, count: welded } = weldByPosition(positions);
  // One query point per welded vertex.
  const rep = new Int32Array(welded).fill(-1);
  for (let i = 0; i < ids.length; i++) if (rep[ids[i]] < 0) rep[ids[i]] = i;
  const pts = new Float32Array(welded * 3);
  for (let w = 0; w < welded; w++) {
    const i = rep[w];
    pts[w * 3] = positions[i * 3];
    pts[w * 3 + 1] = positions[i * 3 + 1];
    pts[w * 3 + 2] = positions[i * 3 + 2];
  }

  progress('Measuring geodesic distances', 0.2);
  const input: GeodesicInput = { grid, boneCount: B, segments, points: pts, maxDistance: 0.45 * H };
  return { input, timings, now, finish: (dist: Float32Array) => finishSkinWeights(dist) };

  function finishSkinWeights(dist: Float32Array): SkinWeights {
    progress('Computing weights', 0.8);
    t0 = now();
    const eps = 0.25 * dx;
    // x^k; integer exponents (the usual case) by multiplication, which is much faster than Math.pow.
    const falloff = Number.isInteger(k) && k >= 1 && k <= 8
      ? (x: number) => { let r = x; for (let i = 1; i < k; i++) r *= x; return r; }
      : (x: number) => Math.pow(x, k);
    const dense = new Float32Array(welded * B);
    let fallback = 0;
    const segCount = segments.length / 7;
    for (let w = 0; w < welded; w++) {
      let any = false;
      for (let b = 0; b < B; b++) if (Number.isFinite(dist[w * B + b])) { any = true; break; }
      if (!any) {
        // Disconnected part (e.g. floating accessory): Euclidean distance to bone segments.
        fallback++;
        for (let b = 0; b < B; b++) dist[w * B + b] = Infinity;
        for (let s = 0; s < segCount; s++) {
          const b = segments[s * 7];
          const d = pointSegmentDistance(pts, w, segments, s);
          if (d < dist[w * B + b]) dist[w * B + b] = d;
        }
      }
      let sum = 0;
      for (let b = 0; b < B; b++) {
        const d = dist[w * B + b];
        const v = Number.isFinite(d) ? 1 / falloff(Math.max(d, eps)) : 0;
        dense[w * B + b] = v;
        sum += v;
      }
      if (sum > 0) for (let b = 0; b < B; b++) dense[w * B + b] /= sum;
    }

    if (smoothIt > 0 && index) {
      const adj = buildAdjacency(index, ids, welded);
      const tmp = new Float32Array(dense.length);
      const acc = new Float64Array(B);
      for (let it = 0; it < smoothIt; it++) {
        for (let w = 0; w < welded; w++) {
          const s0 = adj.offsets[w], s1 = adj.offsets[w + 1];
          const cnt = s1 - s0;
          const row = w * B;
          if (!cnt) {
            for (let b = 0; b < B; b++) tmp[row + b] = dense[row + b];
            continue;
          }
          // Whole neighbour rows at a time: contiguous reads instead of a stride of B.
          acc.fill(0);
          for (let j = s0; j < s1; j++) {
            const nrow = adj.neighbors[j] * B;
            for (let b = 0; b < B; b++) acc[b] += dense[nrow + b];
          }
          for (let b = 0; b < B; b++) tmp[row + b] = 0.5 * dense[row + b] + 0.5 * (acc[b] / cnt);
        }
        dense.set(tmp);
      }
    }

    // After smoothing, which would blur the seam back out; its own blend band keeps it smooth.
    splitShoulders(dense, pts, defs, map);

    // Top-N influences per welded vertex (partial selection; ties keep the lower bone
    // index, like a stable sort), then expand to all vertices.
    const wIndex = new Uint16Array(welded * 4);
    const wWeight = new Float32Array(welded * 4);
    const top = new Int32Array(maxInf);
    const topV = new Float64Array(maxInf);
    for (let w = 0; w < welded; w++) {
      const row = w * B;
      let n = 0;
      for (let b = 0; b < B; b++) {
        const v = dense[row + b];
        if (n === maxInf && v <= topV[n - 1]) continue;
        let j = n < maxInf ? n++ : n - 1;
        while (j > 0 && topV[j - 1] < v) {
          top[j] = top[j - 1];
          topV[j] = topV[j - 1];
          j--;
        }
        top[j] = b;
        topV[j] = v;
      }
      let sum = 0;
      for (let j = 0; j < n; j++) sum += topV[j] > 0.01 ? topV[j] : 0;
      for (let j = 0; j < 4; j++) {
        const inTop = j < n;
        const v = inTop && sum > 0 && topV[j] > 0.01 ? topV[j] / sum : 0;
        wIndex[w * 4 + j] = inTop ? top[j] : 0;
        wWeight[w * 4 + j] = v;
      }
      if (sum === 0) {
        wIndex[w * 4] = n ? top[0] : 0;
        wWeight[w * 4] = 1;
      }
    }
    const nVerts = positions.length / 3;
    const skinIndex = new Uint16Array(nVerts * 4);
    const skinWeight = new Float32Array(nVerts * 4);
    for (let i = 0; i < nVerts; i++) {
      const w = ids[i];
      for (let j = 0; j < 4; j++) {
        skinIndex[i * 4 + j] = wIndex[w * 4 + j];
        skinWeight[i * 4 + j] = wWeight[w * 4 + j];
      }
    }
    timings.weights = now() - t0;
    progress('Done', 1);
    return { skinIndex, skinWeight, fallbackVertices: fallback, kernel: kernels.name, timings };
  }
}

function pointSegmentDistance(pts: Float32Array, w: number, segs: Float32Array, s: number): number {
  const px = pts[w * 3], py = pts[w * 3 + 1], pz = pts[w * 3 + 2];
  const ax = segs[s * 7 + 1], ay = segs[s * 7 + 2], az = segs[s * 7 + 3];
  const bx = segs[s * 7 + 4], by = segs[s * 7 + 5], bz = segs[s * 7 + 6];
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const l2 = abx * abx + aby * aby + abz * abz;
  let t = l2 > 0 ? ((px - ax) * abx + (py - ay) * aby + (pz - az) * abz) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + abx * t), py - (ay + aby * t), pz - (az + abz * t));
}

/** Unique welded-vertex neighbours in CSR form (sorted edge keys instead of per-vertex Sets). */
function buildAdjacency(index: Uint32Array, ids: Uint32Array, welded: number) {
  const keys = new Float64Array(index.length * 2);
  let m = 0;
  const add = (a: number, b: number) => {
    if (a === b) return;
    keys[m++] = a * welded + b;
    keys[m++] = b * welded + a;
  };
  for (let t = 0; t < index.length; t += 3) {
    const a = ids[index[t]], b = ids[index[t + 1]], c = ids[index[t + 2]];
    add(a, b);
    add(b, c);
    add(a, c);
  }
  const sorted = keys.subarray(0, m).sort();
  const offsets = new Int32Array(welded + 1);
  const neighbors = new Int32Array(m);
  let n = 0;
  for (let i = 0; i < m; i++) {
    const k = sorted[i];
    if (i > 0 && k === sorted[i - 1]) continue;
    const a = Math.floor(k / welded);
    neighbors[n++] = k - a * welded;
    offsets[a + 1]++;
  }
  for (let w = 0; w < welded; w++) offsets[w + 1] += offsets[w];
  return { offsets, neighbors: neighbors.subarray(0, n) };
}

/**
 * A clean seam at each shoulder. Distance-based weights leave everything around the
 * shoulder joint (a short sleeve, the top of the arm) shared between the torso and
 * the arm, so a lowered arm drags half the sleeve along and the armpit caves in.
 * Cut through the shoulder joint square to the upper arm: arm-side vertices that
 * already lean on the arm go with it entirely; body-side vertices give their upper
 * arm weight to the collarbone. A short blend band keeps the seam from creasing.
 * `dense` holds normalized rows of B weights.
 */
export function splitShoulders(dense: Float32Array, pts: Float32Array, defs: readonly BoneDef[], map: JointMap): void {
  const B = defs.length;
  const index = new Map(defs.map((d, i) => [d.name, i]));
  const childrenOf = new Map<string, string[]>();
  for (const d of defs) if (d.parent) childrenOf.set(d.parent, [...(childrenOf.get(d.parent) ?? []), d.name]);
  const count = pts.length / 3;
  for (const side of ['left', 'right']) {
    const ua = index.get(`${side}UpperArm`), collar = index.get(`${side}Shoulder`) ?? index.get(defs.find((d) => d.name === `${side}UpperArm`)?.parent ?? '');
    const P = map.joints[`${side}UpperArm`], E = map.joints[`${side}LowerArm`];
    if (ua === undefined || collar === undefined || !P || !E) continue;
    // The arm: the upper arm and everything below it.
    const arm = new Uint8Array(B);
    const stack = [`${side}UpperArm`];
    while (stack.length) {
      const n = stack.pop()!;
      const i = index.get(n);
      if (i !== undefined) arm[i] = 1;
      stack.push(...(childrenOf.get(n) ?? []));
    }
    const len = Math.hypot(E[0] - P[0], E[1] - P[1], E[2] - P[2]);
    if (!(len > 0)) continue;
    const a = [(E[0] - P[0]) / len, (E[1] - P[1]) / len, (E[2] - P[2]) / len];
    const band = 0.12 * len, reach = 0.8 * len;
    for (let w = 0; w < count; w++) {
      const dx = pts[w * 3] - P[0], dy = pts[w * 3 + 1] - P[1], dz = pts[w * 3 + 2] - P[2];
      const along = dx * a[0] + dy * a[1] + dz * a[2];
      if (along > len || along < -reach) continue;
      const radial = Math.hypot(dx - along * a[0], dy - along * a[1], dz - along * a[2]);
      if (radial > reach) continue;
      const row = w * B;
      let armW = 0;
      for (let b = 0; b < B; b++) if (arm[b]) armW += dense[row + b];
      const x = Math.max(0, Math.min(1, (along + band) / (2 * band)));
      const t = x * x * (3 - 2 * x); // 0 on the body side, 1 on the arm side
      if (armW >= 0.2 && armW < 1) {
        // Hand the body's share to the upper arm.
        const move = t * (1 - armW);
        const keep = 1 - move / (1 - armW);
        for (let b = 0; b < B; b++) if (!arm[b]) dense[row + b] *= keep;
        dense[row + ua] += move;
      }
      if (t < 1) {
        // Body side of the cut: the torso stays with the body.
        const move = (1 - t) * dense[row + ua];
        dense[row + ua] -= move;
        dense[row + collar] += move;
      }
    }
  }
}
