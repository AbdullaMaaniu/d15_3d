import type { Kernels } from '../kernels';
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
  t0 = now();
  const dist = kernels.boneDistances({ grid, boneCount: B, segments, points: pts, maxDistance: 0.45 * H });
  timings.distances = now() - t0;

  progress('Computing weights', 0.8);
  t0 = now();
  const eps = 0.25 * dx;
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
      const v = Number.isFinite(d) ? 1 / Math.pow(Math.max(d, eps), k) : 0;
      dense[w * B + b] = v;
      sum += v;
    }
    if (sum > 0) for (let b = 0; b < B; b++) dense[w * B + b] /= sum;
  }

  if (smoothIt > 0 && index) {
    const adj = buildAdjacency(index, ids, welded);
    const tmp = new Float32Array(dense.length);
    for (let it = 0; it < smoothIt; it++) {
      for (let w = 0; w < welded; w++) {
        const s0 = adj.offsets[w], s1 = adj.offsets[w + 1];
        const cnt = s1 - s0;
        for (let b = 0; b < B; b++) {
          let acc = 0;
          for (let j = s0; j < s1; j++) acc += dense[adj.neighbors[j] * B + b];
          const self = dense[w * B + b];
          tmp[w * B + b] = cnt ? 0.5 * self + 0.5 * (acc / cnt) : self;
        }
      }
      dense.set(tmp);
    }
  }

  // Top-N influences per welded vertex, then expand to all vertices.
  const wIndex = new Uint16Array(welded * 4);
  const wWeight = new Float32Array(welded * 4);
  const order = new Int32Array(B);
  for (let w = 0; w < welded; w++) {
    for (let b = 0; b < B; b++) order[b] = b;
    const row = w * B;
    const top = Array.from(order).sort((p, q) => dense[row + q] - dense[row + p]).slice(0, maxInf);
    let sum = 0;
    for (const b of top) sum += dense[row + b] > 0.01 ? dense[row + b] : 0;
    for (let j = 0; j < 4; j++) {
      const b = top[j];
      const v = j < maxInf && b !== undefined && sum > 0 && dense[row + b] > 0.01 ? dense[row + b] / sum : 0;
      wIndex[w * 4 + j] = b ?? 0;
      wWeight[w * 4 + j] = v;
    }
    if (sum === 0) {
      wIndex[w * 4] = top[0] ?? 0;
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

function buildAdjacency(index: Uint32Array, ids: Uint32Array, welded: number) {
  const sets: Array<Set<number>> = Array.from({ length: welded }, () => new Set<number>());
  for (let t = 0; t < index.length; t += 3) {
    const a = ids[index[t]], b = ids[index[t + 1]], c = ids[index[t + 2]];
    if (a !== b) { sets[a].add(b); sets[b].add(a); }
    if (b !== c) { sets[b].add(c); sets[c].add(b); }
    if (a !== c) { sets[a].add(c); sets[c].add(a); }
  }
  const offsets = new Int32Array(welded + 1);
  for (let w = 0; w < welded; w++) offsets[w + 1] = offsets[w] + sets[w].size;
  const neighbors = new Int32Array(offsets[welded]);
  for (let w = 0; w < welded; w++) {
    let j = offsets[w];
    for (const n of sets[w]) neighbors[j++] = n;
  }
  return { offsets, neighbors };
}
