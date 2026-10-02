import type { JointMap } from '../skeleton';

/**
 * Spring-bone chains for hair, found from which triangles are hair (the Parts
 * step's Hair region). Hair that hangs below the skull is grouped by where it
 * falls around the head (a ponytail, the back, each side), and each group gets
 * a chain of joints down its middle, so it can swing.
 */

type V3 = [number, number, number];

export interface HairChains {
  /** New bones, parents before children; chain roots hang off `head`. */
  bones: Array<{ name: string; parent: string }>;
  joints: Record<string, V3>;
  /** Hanging length of the longest hair, in meters (0 = nothing hangs). */
  length: number;
}

export interface HairOptions {
  /** Shortest hanging hair that gets a chain, in meters (default 6 cm). */
  minLength?: number;
  /** Widest stretch of hair one chain covers around the head, in degrees (default 60). */
  maxSpread?: number;
}

const SECTOR_NAMES: Array<[number, string]> = [
  [-150, 'FrontRight'], [-105, 'Right'], [-60, 'BackRight'], [-20, 'Back'], [20, 'BackLeft'], [60, 'Left'], [105, 'FrontLeft'], [150, 'Front'],
];

/** A readable name for a direction around the head (0° = straight back, + = character's left). */
function sectorName(deg: number): string {
  let best = SECTOR_NAMES[0];
  for (const s of SECTOR_NAMES) if (Math.abs(s[0] - deg) < Math.abs(best[0] - deg)) best = s;
  return Math.abs(deg) > 170 ? 'Front' : best[1];
}

export function hairChains(positions: ArrayLike<number>, index: ArrayLike<number>, hairFaces: ArrayLike<number>, map: JointMap, options: HairOptions = {}): HairChains {
  const head = map.joints.head;
  const crown = map.tails.head;
  const out: HairChains = { bones: [], joints: {}, length: 0 };
  if (!head || !crown) return out;
  const [x0, , zc] = head;
  const skull = crown[1] - head[1];
  // Hair below this height hangs free of the skull (the head joint sits at the skull's base).
  const hangTop = head[1] + 0.3 * skull;
  const minLength = options.minLength ?? 0.06;
  const maxSpread = options.maxSpread ?? 60;

  const isHair = new Uint8Array(positions.length / 3);
  for (let t = 0; t < hairFaces.length; t++) {
    if (!hairFaces[t]) continue;
    isHair[index[t * 3]] = isHair[index[t * 3 + 1]] = isHair[index[t * 3 + 2]] = 1;
  }
  const hang: number[] = [];
  const angle = new Float32Array(positions.length / 3);
  for (let v = 0; v < isHair.length; v++) {
    if (!isHair[v]) continue;
    const y = positions[v * 3 + 1];
    if (y > hangTop) continue;
    angle[v] = (Math.atan2(positions[v * 3] - x0, -(positions[v * 3 + 2] - zc)) * 180) / Math.PI;
    hang.push(v);
  }
  if (hang.length < 30) return out;

  // Angles around the head that hanging hair covers, in 10° bins.
  const B = 36;
  const count = new Int32Array(B);
  const lowest = new Float32Array(B).fill(Infinity);
  const binOf = (a: number) => Math.min(B - 1, Math.floor((a + 180) / 10));
  for (const v of hang) {
    const b = binOf(angle[v]);
    count[b]++;
    lowest[b] = Math.min(lowest[b], positions[v * 3 + 1]);
  }
  const minCount = Math.max(8, hang.length * 0.01);
  const long = (b: number) => count[b] >= minCount && hangTop - lowest[b] >= minLength;
  for (let b = 0; b < B; b++) if (long(b)) out.length = Math.max(out.length, hangTop - lowest[b]);
  // Runs of neighbouring bins with long hair (wrapping round the front at ±180°).
  let start = 0;
  while (start < B && long(start)) start++;
  if (start === B) start = 0;
  const runs: number[][] = [];
  let cur: number[] = [];
  for (let i = 0; i < B; i++) {
    const b = (start + i) % B;
    if (long(b)) cur.push(b);
    else if (cur.length) { runs.push(cur); cur = []; }
  }
  if (cur.length) runs.push(cur);

  const used = new Set<string>();
  for (const run of runs) {
    const pieces = Math.max(1, Math.round((run.length * 10) / maxSpread));
    for (let p = 0; p < pieces; p++) {
      const bins = new Set(run.slice(Math.floor((p * run.length) / pieces), Math.floor(((p + 1) * run.length) / pieces)));
      const verts = hang.filter((v) => bins.has(binOf(angle[v])));
      if (verts.length < minCount) continue;
      let lo = Infinity;
      let sx = 0, sz = 0;
      for (const v of verts) {
        lo = Math.min(lo, positions[v * 3 + 1]);
        sx += Math.sin((angle[v] * Math.PI) / 180);
        sz += Math.cos((angle[v] * Math.PI) / 180);
      }
      const mid = (Math.atan2(sx, sz) * 180) / Math.PI;
      let base = `hair${sectorName(mid)}`;
      for (let k = 1; used.has(base); k++) base = `hair${sectorName(mid)}${String.fromCharCode(65 + k)}`;
      used.add(base);
      // Joints evenly down the hanging length, each at the middle of the hair at that height.
      const top = hangTop + 0.15 * skull;
      const len = top - lo;
      const n = Math.min(5, Math.max(2, Math.round(len / 0.08)));
      const band = len / n;
      const centre = (y: number): V3 | null => {
        let ax = 0, ay = 0, az = 0, c = 0;
        for (const v of verts) {
          if (Math.abs(positions[v * 3 + 1] - y) > band * 0.6) continue;
          ax += positions[v * 3];
          ay += positions[v * 3 + 1];
          az += positions[v * 3 + 2];
          c++;
        }
        return c ? [ax / c, ay / c, az / c] : null;
      };
      // The root sits on the skull's surface where this hair leaves it.
      const allHair: number[] = [];
      for (let v = 0; v < isHair.length; v++) {
        if (!isHair[v]) continue;
        const y = positions[v * 3 + 1];
        if (y < hangTop || y > top + band * 0.6) continue;
        const a = (Math.atan2(positions[v * 3] - x0, -(positions[v * 3 + 2] - zc)) * 180) / Math.PI;
        if (bins.has(binOf(a))) allHair.push(v);
      }
      let root: V3 | null = null;
      if (allHair.length) {
        let ax = 0, ay = 0, az = 0;
        for (const v of allHair) { ax += positions[v * 3]; ay += positions[v * 3 + 1]; az += positions[v * 3 + 2]; }
        root = [ax / allHair.length, ay / allHair.length, az / allHair.length];
      }
      const pts: V3[] = [];
      if (root) pts.push(root);
      for (let i = root ? 1 : 0; i <= n; i++) {
        // The last joint stops a little short of the tips so their own vertices bend.
        const y = top - (len * Math.min(i, n - 0.15)) / n;
        const c = centre(y);
        if (c) pts.push([c[0], y, c[2]]);
      }
      if (pts.length < 2) continue;
      let parent = 'head';
      pts.forEach((pt, i) => {
        const name = `${base}${i + 1}`;
        out.bones.push({ name, parent });
        out.joints[name] = pt;
        parent = name;
      });
    }
  }
  return out;
}

/**
 * Keeps hair on the head and its own chains, and everything else off the
 * chains: hair resting on the back mustn't follow the spine, and the scalp
 * mustn't swing. Edits the arrays in place.
 */
export function cleanHairWeights(
  positions: ArrayLike<number>,
  index: ArrayLike<number>,
  hairFaces: ArrayLike<number>,
  skinIndex: Uint16Array,
  skinWeight: Float32Array,
  boneNames: readonly string[],
  map: JointMap,
): void {
  const headI = boneNames.indexOf('head');
  const chain = new Set<number>();
  boneNames.forEach((n, i) => /^hair[A-Z]/.test(n) && chain.add(i));
  if (headI < 0 || !chain.size) return;
  const n = positions.length / 3;
  const isHair = new Uint8Array(n);
  for (let t = 0; t < hairFaces.length; t++) {
    if (!hairFaces[t]) continue;
    isHair[index[t * 3]] = isHair[index[t * 3 + 1]] = isHair[index[t * 3 + 2]] = 1;
  }
  // Segments of the chain bones, to hand stray hair to the nearest.
  const segs: Array<{ bone: number; a: V3; b: V3 }> = [];
  for (const i of chain) {
    const name = boneNames[i];
    const a = map.joints[name];
    const child = boneNames.find((c) => map.joints[c] && c !== name && c.replace(/\d+$/, '') === name.replace(/\d+$/, '') && +c.match(/\d+$/)![0] === +name.match(/\d+$/)![0] + 1);
    const b = child ? map.joints[child] : map.tails[name] ?? a;
    if (a) segs.push({ bone: i, a, b });
  }
  const nearest = (v: number) => {
    let best = -1, bestD = Infinity;
    const p = [positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]];
    for (const s of segs) {
      const d = [s.b[0] - s.a[0], s.b[1] - s.a[1], s.b[2] - s.a[2]];
      const L2 = d[0] ** 2 + d[1] ** 2 + d[2] ** 2 || 1;
      const t = Math.min(1, Math.max(0, ((p[0] - s.a[0]) * d[0] + (p[1] - s.a[1]) * d[1] + (p[2] - s.a[2]) * d[2]) / L2));
      const q = [s.a[0] + t * d[0] - p[0], s.a[1] + t * d[1] - p[1], s.a[2] + t * d[2] - p[2]];
      const dd = q[0] ** 2 + q[1] ** 2 + q[2] ** 2;
      if (dd < bestD) { bestD = dd; best = s.bone; }
    }
    return best;
  };
  // Skin that lost all its weight to the chains takes its neighbours' instead.
  const orphan = new Uint8Array(n);
  for (let v = 0; v < n; v++) {
    let stray = 0;
    let bestChain = -1, bestW = 0;
    for (let k = 0; k < 4; k++) {
      const b = skinIndex[v * 4 + k], w = skinWeight[v * 4 + k];
      if (w <= 0) continue;
      const ok = isHair[v] ? b === headI || chain.has(b) : !chain.has(b);
      if (!ok) {
        stray += w;
        skinWeight[v * 4 + k] = 0;
      } else if (chain.has(b) && w > bestW) { bestW = w; bestChain = b; }
    }
    if (stray <= 0) continue;
    if (isHair[v]) {
      put(v, bestChain >= 0 ? bestChain : nearest(v), stray);
      continue;
    }
    // Body skin keeps its own bones' share; if nothing is left it borrows from around it.
    let left = 0;
    for (let k = 0; k < 4; k++) left += skinWeight[v * 4 + k];
    if (left > 1e-4) for (let k = 0; k < 4; k++) skinWeight[v * 4 + k] /= left;
    else orphan[v] = 1;
  }
  const remaining = orphan.reduce((a, b) => a + b, 0);
  if (remaining) adoptNeighbours(index, orphan, skinIndex, skinWeight, headI);

  function put(v: number, to: number, w: number) {
    let k = -1;
    for (let j = 0; j < 4; j++) if (skinIndex[v * 4 + j] === to && skinWeight[v * 4 + j] > 0) k = j;
    if (k < 0) for (let j = 0; j < 4; j++) if (skinWeight[v * 4 + j] === 0) { k = j; break; }
    skinIndex[v * 4 + k] = to;
    skinWeight[v * 4 + k] += w;
  }
}

/** Gives each orphaned vertex the averaged weights of its weighted neighbours, growing inward. */
function adoptNeighbours(index: ArrayLike<number>, orphan: Uint8Array, skinIndex: Uint16Array, skinWeight: Float32Array, fallback: number): void {
  const n = orphan.length;
  const nb: number[][] = [];
  for (let t = 0; t < index.length; t += 3) {
    for (let a = 0; a < 3; a++) {
      const v = index[t + a];
      if (!orphan[v]) continue;
      (nb[v] ??= []).push(index[t + (a + 1) % 3], index[t + (a + 2) % 3]);
    }
  }
  for (let pass = 0; pass < 50; pass++) {
    const done: number[] = [];
    for (let v = 0; v < n; v++) {
      if (!orphan[v] || !nb[v]) continue;
      const acc = new Map<number, number>();
      for (const u of nb[v]) {
        if (orphan[u]) continue;
        for (let k = 0; k < 4; k++) if (skinWeight[u * 4 + k] > 0) acc.set(skinIndex[u * 4 + k], (acc.get(skinIndex[u * 4 + k]) ?? 0) + skinWeight[u * 4 + k]);
      }
      if (acc.size) done.push(v), (nb[v] as any).acc = acc;
    }
    if (!done.length) break;
    for (const v of done) {
      const top = [...((nb[v] as any).acc as Map<number, number>)].sort((a, b) => b[1] - a[1]).slice(0, 4);
      const sum = top.reduce((a, b) => a + b[1], 0);
      for (let k = 0; k < 4; k++) {
        skinIndex[v * 4 + k] = top[k]?.[0] ?? 0;
        skinWeight[v * 4 + k] = top[k] ? top[k][1] / sum : 0;
      }
      orphan[v] = 0;
    }
  }
  // Islands with no weighted neighbour at all follow the head.
  for (let v = 0; v < n; v++) {
    if (!orphan[v]) continue;
    skinIndex.fill(0, v * 4, v * 4 + 4);
    skinWeight.fill(0, v * 4, v * 4 + 4);
    skinIndex[v * 4] = fallback;
    skinWeight[v * 4] = 1;
  }
}
