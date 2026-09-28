import { EMPTY, type VoxelGrid } from './grid';

export interface GeodesicInput {
  grid: VoxelGrid;
  /** Number of bones (distance fields). */
  boneCount: number;
  /**
   * Seed segments, flattened: [bone, ax, ay, az, bx, by, bz] * segmentCount.
   * A bone may own several segments (e.g. hips -> spine and hips -> each hip joint).
   */
  segments: Float32Array;
  /** Query points (mesh vertices), xyz * count. */
  points: Float32Array;
  /** Distances beyond this are reported as Infinity (speeds up the search). */
  maxDistance: number;
  /**
   * Only compute bones in [start, end); other columns stay Infinity. Lets callers
   * split the work across workers. Default: all bones.
   */
  bones?: [number, number];
}

/**
 * For every bone, runs a multi-source Dijkstra from the voxels its segments pass
 * through, over solid voxels only (26-connectivity). Returns distances from each
 * query point to each bone, laid out [point * boneCount + bone].
 *
 * Geodesic distances through the volume stop weights from leaking across gaps,
 * e.g. from the thigh to the hand resting on it (Dionne & de Lasa 2013).
 */
export function boneDistancesTS({ grid, boneCount, segments, points, maxDistance, bones }: GeodesicInput): Float32Array {
  const { nx, ny, nz, dx, data, origin } = grid;
  const total = nx * ny * nz;
  const sxy = nx * ny;
  const inv = 1 / dx;

  // Compact the solid voxels.
  const compact = new Int32Array(total).fill(-1);
  let solidCount = 0;
  for (let i = 0; i < total; i++) if (data[i] !== EMPTY) compact[i] = solidCount++;
  const solidIndex = new Int32Array(solidCount);
  for (let i = 0; i < total; i++) if (compact[i] >= 0) solidIndex[compact[i]] = i;

  // Neighbor offsets and step lengths.
  const offs: number[] = [];
  const dxs: number[] = [], dys: number[] = [], dzs: number[] = [];
  const lens: number[] = [];
  for (let z = -1; z <= 1; z++)
    for (let y = -1; y <= 1; y++)
      for (let x = -1; x <= 1; x++) {
        if (!x && !y && !z) continue;
        offs.push(x + nx * (y + ny * z));
        dxs.push(x); dys.push(y); dzs.push(z);
        lens.push(Math.fround(Math.fround(Math.sqrt(x * x + y * y + z * z)) * Math.fround(dx)));
      }

  // Vertex -> nearest solid voxel (compact id) and residual distance.
  const nPts = points.length / 3;
  const ptVoxel = new Int32Array(nPts).fill(-1);
  const ptResidual = new Float32Array(nPts);
  for (let p = 0; p < nPts; p++) {
    const px = points[p * 3], py = points[p * 3 + 1], pz = points[p * 3 + 2];
    const vx = Math.floor((px - origin[0]) * inv), vy = Math.floor((py - origin[1]) * inv), vz = Math.floor((pz - origin[2]) * inv);
    let best = -1, bestD = Infinity;
    for (let r = 0; r <= 2 && best < 0; r++) {
      for (let z = vz - r; z <= vz + r; z++)
        for (let y = vy - r; y <= vy + r; y++)
          for (let x = vx - r; x <= vx + r; x++) {
            if (x < 0 || y < 0 || z < 0 || x >= nx || y >= ny || z >= nz) continue;
            const c = compact[x + nx * (y + ny * z)];
            if (c < 0) continue;
            const cx = origin[0] + (x + 0.5) * dx, cy = origin[1] + (y + 0.5) * dx, cz = origin[2] + (z + 0.5) * dx;
            const d = Math.hypot(px - cx, py - cy, pz - cz);
            if (d < bestD) { bestD = d; best = c; }
          }
    }
    ptVoxel[p] = best;
    ptResidual[p] = best >= 0 ? bestD : 0;
  }

  const out = new Float32Array(nPts * boneCount).fill(Infinity);
  const dist = new Float32Array(solidCount);
  const heap = new MinHeap(solidCount * 2 + 16);
  const segCount = segments.length / 7;

  const [b0, b1] = bones ?? [0, boneCount];
  for (let bone = b0; bone < Math.min(b1, boneCount); bone++) {
    dist.fill(Infinity);
    heap.clear();
    // Seed voxels along each segment of this bone.
    for (let s = 0; s < segCount; s++) {
      if (segments[s * 7] !== bone) continue;
      const ax = segments[s * 7 + 1], ay = segments[s * 7 + 2], az = segments[s * 7 + 3];
      const bx = segments[s * 7 + 4], by = segments[s * 7 + 5], bz = segments[s * 7 + 6];
      const len = Math.hypot(bx - ax, by - ay, bz - az);
      const steps = Math.max(1, Math.ceil(len / (dx * 0.5)));
      for (let k = 0; k <= steps; k++) {
        const t = k / steps;
        const px = ax + (bx - ax) * t, py = ay + (by - ay) * t, pz = az + (bz - az) * t;
        const vx = Math.floor((px - origin[0]) * inv), vy = Math.floor((py - origin[1]) * inv), vz = Math.floor((pz - origin[2]) * inv);
        if (vx < 1 || vy < 1 || vz < 1 || vx >= nx - 1 || vy >= ny - 1 || vz >= nz - 1) continue;
        const i = vx + nx * (vy + ny * vz);
        if (compact[i] >= 0) {
          if (dist[compact[i]] > 0) {
            dist[compact[i]] = 0;
            heap.push(0, compact[i]);
          }
        } else {
          // Seed passes through empty space (bone slightly outside the mesh): seed solid neighbors.
          for (let n = 0; n < 26; n++) {
            const c = compact[i + offs[n]];
            if (c >= 0 && lens[n] < dist[c]) {
              dist[c] = lens[n];
              heap.push(lens[n], c);
            }
          }
        }
      }
    }
    // Dijkstra.
    while (heap.size > 0) {
      const d = heap.topKey();
      const c = heap.pop();
      if (d > dist[c]) continue;
      if (d > maxDistance) break;
      const i = solidIndex[c];
      const x = i % nx, y = ((i / nx) | 0) % ny, z = (i / sxy) | 0;
      for (let n = 0; n < 26; n++) {
        const x2 = x + dxs[n], y2 = y + dys[n], z2 = z + dzs[n];
        if (x2 < 0 || y2 < 0 || z2 < 0 || x2 >= nx || y2 >= ny || z2 >= nz) continue;
        const c2 = compact[i + offs[n]];
        if (c2 < 0) continue;
        // Sum in f32 like the stored distances (and the Rust kernel). A float64 sum that
        // is smaller only before rounding would re-queue the voxel with an unchanged
        // distance, over and over.
        const nd = Math.fround(d + lens[n]);
        if (nd < dist[c2]) {
          dist[c2] = nd;
          heap.push(nd, c2);
        }
      }
    }
    for (let p = 0; p < nPts; p++) {
      const v = ptVoxel[p];
      if (v < 0) continue;
      const d = dist[v];
      if (d <= maxDistance) out[p * boneCount + bone] = d + ptResidual[p];
    }
  }
  return out;
}

/** Binary min-heap of (float key, int value) with lazy deletion semantics. */
class MinHeap {
  keys: Float32Array;
  vals: Int32Array;
  size = 0;
  constructor(capacity: number) {
    this.keys = new Float32Array(capacity);
    this.vals = new Int32Array(capacity);
  }
  clear() {
    this.size = 0;
  }
  topKey() {
    return this.keys[0];
  }
  push(key: number, val: number) {
    if (this.size >= this.keys.length) {
      const k = new Float32Array(this.keys.length * 2);
      k.set(this.keys);
      const v = new Int32Array(this.vals.length * 2);
      v.set(this.vals);
      this.keys = k;
      this.vals = v;
    }
    let i = this.size++;
    const keys = this.keys, vals = this.vals;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p] <= key) break;
      keys[i] = keys[p];
      vals[i] = vals[p];
      i = p;
    }
    keys[i] = key;
    vals[i] = val;
  }
  pop(): number {
    const keys = this.keys, vals = this.vals;
    const top = vals[0];
    const n = --this.size;
    if (n > 0) {
      const key = keys[n], val = vals[n];
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && keys[c + 1] < keys[c]) c++;
        if (keys[c] >= key) break;
        keys[i] = keys[c];
        vals[i] = vals[c];
        i = c;
      }
      keys[i] = key;
      vals[i] = val;
    }
    return top;
  }
}
