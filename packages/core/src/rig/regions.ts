import type { BufferGeometry, Material, Mesh } from 'three';
import { weldByPosition } from '../mesh/analyze';
import { decodeFaceSizes, encodeFaceSizes } from '../mesh/remesh';

/**
 * Body regions ("parts"): a label per triangle (hair, skin, top, ...) so a
 * single-texture model can be split into named materials and recoloured per
 * region in a game. Meshy characters are one mesh with one baked texture, so
 * the regions are found from the texture's colours and the rig's bone
 * influences, then refined with a brush.
 */

export interface RegionDef {
  name: string;
  /** Colour used to show the region in the editor (not exported). */
  color: string;
}

export interface RegionSet {
  defs: RegionDef[];
  /** Region index per triangle, in the rig mesh's original triangle order. */
  faces: Uint8Array;
}

export const HUMANOID_REGIONS: RegionDef[] = [
  { name: 'Hair', color: '#f59e0b' },
  { name: 'Skin', color: '#f472b6' },
  { name: 'Top', color: '#3b82f6' },
  { name: 'Bottoms', color: '#22c55e' },
  { name: 'Shoes', color: '#a855f7' },
];
const HAIR = 0, SKIN = 1, TOP = 2, BOTTOMS = 3, SHOES = 4;

/** Overlay colours for regions the user adds. */
export const REGION_PALETTE = ['#f59e0b', '#f472b6', '#3b82f6', '#22c55e', '#a855f7', '#ef4444', '#14b8a6', '#eab308', '#6366f1', '#84cc16', '#ec4899', '#0ea5e9'];
export const MAX_REGIONS = 16;

/** RGBA8 pixels of a texture (sRGB), as read from an image. */
export interface SampledTexture {
  width: number;
  height: number;
  data: ArrayLike<number>;
  /** three.js flipY: row 0 of the data is v = 1. */
  flipY: boolean;
  repeat: boolean;
  /**
   * UV transform (three.js Texture.matrix elements, column-major 3x3), e.g. from
   * KHR_texture_transform: compressed files often store UVs scaled down.
   */
  transform?: ArrayLike<number> | null;
}

export interface TriangleSource {
  positions: ArrayLike<number>;
  index: ArrayLike<number>;
  uvs?: ArrayLike<number> | null;
  /** Vertex colours (linear RGB, 3 per vertex), multiplied in when the material uses them. */
  colors?: ArrayLike<number> | null;
  materialOfTriangle: ArrayLike<number>;
  materials: Array<{ color: [number, number, number]; texture: SampledTexture | null; vertexColors?: boolean }>;
  /** Polygon sizes (3/4) when the mesh is quads stored as triangle pairs. */
  faceSizes?: Uint8Array | null;
}

/** Per-triangle data the region tools need, computed once per mesh. */
export interface RegionContext {
  triCount: number;
  centroid: Float32Array;
  normal: Float32Array;
  area: Float32Array;
  /** CIE Lab colour per triangle. */
  lab: Float32Array;
  /** Linear RGB colour per triangle. */
  rgb: Float32Array;
  /** Triangles sharing an edge (CSR). */
  adjacency: { offsets: Int32Array; neighbors: Int32Array };
  /** Connected piece of the mesh per triangle. */
  piece: Int32Array;
  pieceCount: number;
  /** First triangle of the polygon each triangle belongs to, and its triangle count. */
  faceStart: Int32Array;
  faceLength: Uint8Array;
  totalArea: number;
  positions: ArrayLike<number>;
  index: ArrayLike<number>;
  /** Distance from each triangle's centre to its farthest corner. */
  reach: Float32Array;
}

// --- colour helpers -------------------------------------------------------------------

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const toSRGB = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
const LINEAR = new Float32Array(256).map((_, i) => toLinear(i / 255));

function labFromLinear(r: number, g: number, b: number, out: Float32Array, o: number): void {
  const x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(x), fy = f(y), fz = f(z);
  out[o] = 116 * fy - 16;
  out[o + 1] = 500 * (fx - fy);
  out[o + 2] = 200 * (fy - fz);
}

/** Colour distance with lightness counting less (baked shading varies lightness, not hue). */
function dist(lab: ArrayLike<number>, i: number, ref: ArrayLike<number>, j = 0): number {
  const dl = (lab[i * 3] - ref[j]) * 0.4, da = lab[i * 3 + 1] - ref[j + 1], db = lab[i * 3 + 2] - ref[j + 2];
  return Math.sqrt(dl * dl + da * da + db * db);
}

function sample(tex: SampledTexture, u: number, v: number, out: number[]): void {
  const m = tex.transform;
  if (m) {
    const tu = m[0] * u + m[3] * v + m[6];
    v = m[1] * u + m[4] * v + m[7];
    u = tu;
  }
  if (tex.repeat) {
    u -= Math.floor(u);
    v -= Math.floor(v);
  } else {
    u = Math.min(1, Math.max(0, u));
    v = Math.min(1, Math.max(0, v));
  }
  const x = Math.min(tex.width - 1, Math.floor(u * tex.width));
  const y = Math.min(tex.height - 1, Math.floor((tex.flipY ? 1 - v : v) * tex.height));
  const o = (y * tex.width + x) * 4;
  out[0] = LINEAR[tex.data[o]];
  out[1] = LINEAR[tex.data[o + 1]];
  out[2] = LINEAR[tex.data[o + 2]];
}

// --- context ---------------------------------------------------------------------------

export function regionContext(src: TriangleSource): RegionContext {
  const { positions, index, uvs, colors } = src;
  const T = index.length / 3;
  const centroid = new Float32Array(T * 3), normal = new Float32Array(T * 3), area = new Float32Array(T), reach = new Float32Array(T);
  const rgb = new Float32Array(T * 3), lab = new Float32Array(T * 3);
  const px = [0, 0, 0];
  let totalArea = 0;
  for (let t = 0; t < T; t++) {
    const a = index[t * 3], b = index[t * 3 + 1], c = index[t * 3 + 2];
    const ax = positions[a * 3], ay = positions[a * 3 + 1], az = positions[a * 3 + 2];
    const e1x = positions[b * 3] - ax, e1y = positions[b * 3 + 1] - ay, e1z = positions[b * 3 + 2] - az;
    const e2x = positions[c * 3] - ax, e2y = positions[c * 3 + 1] - ay, e2z = positions[c * 3 + 2] - az;
    const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    const len = Math.hypot(nx, ny, nz);
    area[t] = len / 2;
    totalArea += len / 2;
    if (len > 0) normal.set([nx / len, ny / len, nz / len], t * 3);
    for (let k = 0; k < 3; k++) centroid[t * 3 + k] = (positions[a * 3 + k] + positions[b * 3 + k] + positions[c * 3 + k]) / 3;
    for (const v of [a, b, c]) {
      const d = Math.hypot(positions[v * 3] - centroid[t * 3], positions[v * 3 + 1] - centroid[t * 3 + 1], positions[v * 3 + 2] - centroid[t * 3 + 2]);
      if (d > reach[t]) reach[t] = d;
    }
    // Colour: the texture at the centre and halfway to each corner, times the material colour.
    const m = src.materials[src.materialOfTriangle[t]] ?? { color: [1, 1, 1] as [number, number, number], texture: null };
    let r = 0, g = 0, bl = 0;
    if (m.texture && uvs) {
      const cu = (uvs[a * 2] + uvs[b * 2] + uvs[c * 2]) / 3, cv = (uvs[a * 2 + 1] + uvs[b * 2 + 1] + uvs[c * 2 + 1]) / 3;
      const pts = [[cu, cv], ...[a, b, c].map((v) => [(cu + uvs[v * 2]) / 2, (cv + uvs[v * 2 + 1]) / 2])];
      for (const [u, v] of pts) {
        sample(m.texture, u, v, px);
        r += px[0];
        g += px[1];
        bl += px[2];
      }
      r /= pts.length;
      g /= pts.length;
      bl /= pts.length;
    } else {
      r = g = bl = 1;
    }
    const mc = m.color.map(toLinear);
    r *= mc[0];
    g *= mc[1];
    bl *= mc[2];
    if (colors && m.vertexColors !== false && (m.vertexColors || !m.texture)) {
      r *= (colors[a * 3] + colors[b * 3] + colors[c * 3]) / 3;
      g *= (colors[a * 3 + 1] + colors[b * 3 + 1] + colors[c * 3 + 1]) / 3;
      bl *= (colors[a * 3 + 2] + colors[b * 3 + 2] + colors[c * 3 + 2]) / 3;
    }
    rgb.set([r, g, bl], t * 3);
    labFromLinear(r, g, bl, lab, t * 3);
  }

  // Edge adjacency over welded vertices (UV seams split vertices, not the surface).
  const { ids, count: W } = weldByPosition(positions);
  const counts = new Int32Array(T + 1);
  const pairs: number[] = [];
  // Edge key -> triangles on it so far (usually one; more on non-manifold edges).
  const open = new Map<number, number | number[]>();
  for (let t = 0; t < T; t++) {
    for (let e = 0; e < 3; e++) {
      const p = ids[index[t * 3 + e]], q = ids[index[t * 3 + ((e + 1) % 3)]];
      if (p === q) continue;
      const key = Math.min(p, q) * W + Math.max(p, q);
      const prev = open.get(key);
      if (prev === undefined) {
        open.set(key, t);
        continue;
      }
      const list = typeof prev === 'number' ? [prev] : prev;
      for (const s of list) {
        if (s === t) continue;
        pairs.push(s, t);
        counts[s + 1]++;
        counts[t + 1]++;
      }
      list.push(t);
      if (typeof prev === 'number') open.set(key, list);
    }
  }
  for (let t = 0; t < T; t++) counts[t + 1] += counts[t];
  const neighbors = new Int32Array(counts[T]);
  const fill = counts.slice(0, T);
  for (let i = 0; i < pairs.length; i += 2) {
    neighbors[fill[pairs[i]]++] = pairs[i + 1];
    neighbors[fill[pairs[i + 1]]++] = pairs[i];
  }
  const adjacency = { offsets: counts, neighbors };

  // Connected pieces.
  const piece = new Int32Array(T).fill(-1);
  let pieceCount = 0;
  const stack: number[] = [];
  for (let t = 0; t < T; t++) {
    if (piece[t] >= 0) continue;
    piece[t] = pieceCount;
    stack.push(t);
    while (stack.length) {
      const x = stack.pop()!;
      for (let j = counts[x]; j < counts[x + 1]; j++) {
        const y = neighbors[j];
        if (piece[y] < 0) {
          piece[y] = pieceCount;
          stack.push(y);
        }
      }
    }
    pieceCount++;
  }

  // Polygons (quads are two consecutive triangles).
  const faceStart = new Int32Array(T), faceLength = new Uint8Array(T).fill(1);
  for (let t = 0; t < T; t++) faceStart[t] = t;
  const sizes = src.faceSizes;
  if (sizes) {
    let t = 0;
    for (let f = 0; f < sizes.length && t < T; f++) {
      const n = sizes[f] === 4 && t + 1 < T ? 2 : 1;
      for (let k = 0; k < n; k++) {
        faceStart[t + k] = t;
        faceLength[t + k] = n;
      }
      t += n;
    }
  }
  return { triCount: T, centroid, normal, area, lab, rgb, adjacency, piece, pieceCount, faceStart, faceLength, totalArea, positions, index, reach };
}

// --- automatic regions ----------------------------------------------------------------

type BodyPart = 'head' | 'neck' | 'torso' | 'shoulder' | 'upperArm' | 'lowerArm' | 'hand' | 'pelvis' | 'upperLeg' | 'lowerLeg' | 'foot' | 'other';

function bodyPart(bone: string): BodyPart {
  if (/^(head|jaw|leftEye|rightEye)$/.test(bone) || /hair|ear|hat/i.test(bone)) return 'head';
  if (bone === 'neck') return 'neck';
  if (/^(spine|chest|upperChest)$/.test(bone)) return 'torso';
  if (bone === 'hips') return 'pelvis';
  const m = /^(left|right)(Shoulder|UpperArm|LowerArm|Hand|Thumb|Index|Middle|Ring|Little|UpperLeg|LowerLeg|Foot|Toes)/.exec(bone);
  if (!m) return 'other';
  switch (m[2]) {
    case 'Shoulder': return 'shoulder';
    case 'UpperArm': return 'upperArm';
    case 'LowerArm': return 'lowerArm';
    case 'UpperLeg': return 'upperLeg';
    case 'LowerLeg': return 'lowerLeg';
    case 'Foot':
    case 'Toes': return 'foot';
    default: return 'hand';
  }
}

/** The bone with the most influence over each triangle (sum over its corners). */
export function triangleBones(index: ArrayLike<number>, skinIndex: ArrayLike<number>, skinWeight: ArrayLike<number>, boneNames: readonly string[]): string[] {
  const T = index.length / 3;
  const out = new Array<string>(T);
  const acc = new Map<number, number>();
  for (let t = 0; t < T; t++) {
    acc.clear();
    for (let c = 0; c < 3; c++) {
      const v = index[t * 3 + c];
      for (let k = 0; k < 4; k++) {
        const w = skinWeight[v * 4 + k];
        if (w > 0) acc.set(skinIndex[v * 4 + k], (acc.get(skinIndex[v * 4 + k]) ?? 0) + w);
      }
    }
    let best = 0, bestW = -1;
    for (const [b, w] of acc) if (w > bestW) { bestW = w; best = b; }
    out[t] = boneNames[best] ?? '';
  }
  return out;
}

/** How plausible a Lab colour is as skin (any tone, light to dark): 1 inside the range, small outside. */
function skinPrior(L: number, a: number, b: number): number {
  const chroma = Math.hypot(a, b), hue = (Math.atan2(b, a) * 180) / Math.PI;
  const ok = L > 15 && L < 97 && chroma > 6 && chroma < 65 && hue > 10 && hue < 80;
  return ok ? 1 : 0.05;
}

/** The most common colour among triangles (area-weighted Lab histogram), averaged within its bin. */
function dominantColor(ctx: RegionContext, tris: number[], prior?: (L: number, a: number, b: number) => number): Float32Array | null {
  if (!tris.length) return null;
  const bins = new Map<number, { w: number; l: number; a: number; b: number }>();
  for (const t of tris) {
    const L = ctx.lab[t * 3], A = ctx.lab[t * 3 + 1], B = ctx.lab[t * 3 + 2];
    const key = Math.floor(L / 12) * 10000 + Math.floor((A + 128) / 8) * 100 + Math.floor((B + 128) / 8);
    const e = bins.get(key) ?? { w: 0, l: 0, a: 0, b: 0 };
    const w = ctx.area[t] * (prior ? prior(L, A, B) : 1);
    e.w += w;
    e.l += L * w;
    e.a += A * w;
    e.b += B * w;
    bins.set(key, e);
  }
  let best: { w: number; l: number; a: number; b: number } | null = null;
  for (const e of bins.values()) if (!best || e.w > best.w) best = e;
  return best && best.w > 0 ? new Float32Array([best.l / best.w, best.a / best.w, best.b / best.w]) : null;
}

function meanColor(ctx: RegionContext, tris: number[]): Float32Array | null {
  let w = 0;
  const m = new Float32Array(3);
  for (const t of tris) {
    for (let k = 0; k < 3; k++) m[k] += ctx.lab[t * 3 + k] * ctx.area[t];
    w += ctx.area[t];
  }
  return w > 0 ? m.map((x) => x / w) : null;
}

export interface AutoRegionOptions {
  /** How close to the skin tone counts as skin (Lab units, lightness down-weighted). */
  skinTolerance?: number;
}

/**
 * Hair / Skin / Top / Bottoms / Shoes for a humanoid, from triangle colours and
 * which bone each triangle follows. Skin is the face's dominant colour; the
 * other regions take the colour of their core body parts and compete for the
 * ambiguous places (a shirt hanging over the hips, trousers over the shoes).
 */
export function autoRegionsHumanoid(ctx: RegionContext, triBones: readonly string[], options: AutoRegionOptions = {}): RegionSet {
  const T = ctx.triCount;
  const part = triBones.map(bodyPart);
  const faces = new Uint8Array(T);

  // Skin tone: the most common skin-like colour on the face (forward-facing head)
  // and hands, which are bare on nearly every character.
  const bare: number[] = [];
  for (let t = 0; t < T; t++) {
    if ((part[t] === 'head' && ctx.normal[t * 3 + 2] > 0.5) || part[t] === 'hand') bare.push(t);
  }
  const skin = dominantColor(ctx, bare, skinPrior);
  const tol = options.skinTolerance ?? 13;
  const isSkin = new Uint8Array(T);
  if (skin) for (let t = 0; t < T; t++) if (dist(ctx.lab, t, skin) < tol) isSkin[t] = 1;

  // Each clothing region: where it certainly is, and where it may reach.
  const core: Record<number, BodyPart[]> = {
    [HAIR]: ['head'],
    [TOP]: ['torso', 'shoulder', 'upperArm'],
    [BOTTOMS]: ['upperLeg', 'lowerLeg'],
    [SHOES]: ['foot'],
  };
  const reach: Record<number, BodyPart[]> = {
    [HAIR]: ['head', 'neck', 'torso', 'shoulder'],
    [TOP]: ['neck', 'torso', 'shoulder', 'upperArm', 'lowerArm', 'hand', 'pelvis', 'upperLeg'],
    [BOTTOMS]: ['torso', 'pelvis', 'upperLeg', 'lowerLeg', 'foot'],
    [SHOES]: ['lowerLeg', 'foot'],
  };
  const labels = [HAIR, TOP, BOTTOMS, SHOES];
  const mean: Record<number, Float32Array | null> = {};
  for (const r of labels) {
    const tris: number[] = [];
    let a = 0;
    for (let t = 0; t < T; t++) if (!isSkin[t] && core[r].includes(part[t])) { tris.push(t); a += ctx.area[t]; }
    // Too little to be a real region (a bald head, bare feet).
    mean[r] = a > ctx.totalArea * 0.004 ? dominantColor(ctx, tris) ?? meanColor(ctx, tris) : null;
  }
  const present = labels.filter((r) => mean[r]);
  for (let t = 0; t < T; t++) {
    if (isSkin[t]) {
      faces[t] = SKIN;
      continue;
    }
    let best = -1, bestD = Infinity;
    for (const r of present) {
      const inReach = part[t] === 'other' || reach[r].includes(part[t]);
      if (!inReach) continue;
      const d = dist(ctx.lab, t, mean[r]!) + (core[r].includes(part[t]) ? 0 : 10);
      if (d < bestD) { bestD = d; best = r; }
    }
    if (best < 0) {
      // Nothing claims it (e.g. bare hands wearing something): the closest by colour overall.
      for (const r of present) {
        const d = dist(ctx.lab, t, mean[r]!);
        if (d < bestD) { bestD = d; best = r; }
      }
    }
    faces[t] = best < 0 ? SKIN : best;
  }
  const set = { defs: HUMANOID_REGIONS.map((d) => ({ ...d })), faces };
  cleanRegions(set, ctx);
  return set;
}

/** Regions by colour alone (any model): k-means in Lab, weighted by area. */
export function autoRegionsByColor(ctx: RegionContext, k: number): RegionSet {
  const T = ctx.triCount;
  k = Math.max(1, Math.min(k, MAX_REGIONS, T));
  const centers = new Float32Array(k * 3);
  // Deterministic farthest-point seeding from the largest triangle's colour.
  let first = 0;
  for (let t = 1; t < T; t++) if (ctx.area[t] > ctx.area[first]) first = t;
  centers.set(ctx.lab.subarray(first * 3, first * 3 + 3), 0);
  const nearest = new Float32Array(T).fill(Infinity);
  for (let c = 1; c < k; c++) {
    let far = 0, farD = -1;
    for (let t = 0; t < T; t++) {
      nearest[t] = Math.min(nearest[t], dist(ctx.lab, t, centers, (c - 1) * 3));
      const d = nearest[t] * Math.sqrt(ctx.area[t]);
      if (d > farD) { farD = d; far = t; }
    }
    centers.set(ctx.lab.subarray(far * 3, far * 3 + 3), c * 3);
  }
  const faces = new Uint8Array(T);
  for (let it = 0; it < 15; it++) {
    const sum = new Float64Array(k * 4);
    for (let t = 0; t < T; t++) {
      let best = 0, bestD = Infinity;
      for (let c = 0; c < k; c++) {
        const d = dist(ctx.lab, t, centers, c * 3);
        if (d < bestD) { bestD = d; best = c; }
      }
      faces[t] = best;
      const w = ctx.area[t];
      sum[best * 4] += ctx.lab[t * 3] * w;
      sum[best * 4 + 1] += ctx.lab[t * 3 + 1] * w;
      sum[best * 4 + 2] += ctx.lab[t * 3 + 2] * w;
      sum[best * 4 + 3] += w;
    }
    for (let c = 0; c < k; c++) if (sum[c * 4 + 3] > 0) for (let j = 0; j < 3; j++) centers[c * 3 + j] = sum[c * 4 + j] / sum[c * 4 + 3];
  }
  const set = { defs: Array.from({ length: k }, (_, i) => ({ name: `Part ${i + 1}`, color: REGION_PALETTE[i % REGION_PALETTE.length] })), faces };
  cleanRegions(set, ctx);
  // Biggest first; drop empty regions.
  const areas = regionAreas(set, ctx);
  const order = areas.map((a, i) => [a, i] as const).filter(([a]) => a > 0).sort((x, y) => y[0] - x[0]).map(([, i]) => i);
  const remap = new Uint8Array(k);
  order.forEach((old, i) => (remap[old] = i));
  for (let t = 0; t < T; t++) set.faces[t] = remap[set.faces[t]];
  set.defs = order.map((_, i) => ({ name: `Part ${i + 1}`, color: REGION_PALETTE[i % REGION_PALETTE.length] }));
  return set;
}

/** Area of each region. */
export function regionAreas(set: RegionSet, ctx: RegionContext): number[] {
  const out = new Array(set.defs.length).fill(0);
  for (let t = 0; t < ctx.triCount; t++) if (set.faces[t] < out.length) out[set.faces[t]] += ctx.area[t];
  return out;
}

/**
 * Removes speckles: lone triangles take their neighbours' region, then small
 * islands join the region around them, and small separate pieces
 * that are mostly one region become entirely that region. Quads stay whole.
 */
export function cleanRegions(set: RegionSet, ctx: RegionContext): void {
  const T = ctx.triCount;
  const R = set.defs.length;
  const { offsets, neighbors } = ctx.adjacency;
  const votes = new Float32Array(R);
  const next = new Uint8Array(T);
  // Lone triangles that no neighbour agrees with take the neighbours' majority.
  for (let it = 0; it < 2; it++) {
    for (let t = 0; t < T; t++) {
      votes.fill(0);
      let agree = false;
      for (let j = offsets[t]; j < offsets[t + 1]; j++) {
        const f = set.faces[neighbors[j]];
        if (f === set.faces[t]) agree = true;
        votes[f] += 1;
      }
      let best = set.faces[t];
      if (!agree) for (let r = 0; r < R; r++) if (votes[r] > (best === set.faces[t] ? 0 : votes[best])) best = r;
      next[t] = best;
    }
    set.faces.set(next);
  }

  // Islands smaller than 0.15% of the surface.
  const minArea = ctx.totalArea * 0.0015;
  for (let round = 0; round < 3; round++) {
    const comp = new Int32Array(T).fill(-1);
    let changed = false;
    const stack: number[] = [];
    for (let s = 0; s < T; s++) {
      if (comp[s] >= 0) continue;
      const label = set.faces[s];
      const members: number[] = [];
      let a = 0;
      comp[s] = s;
      stack.push(s);
      votes.fill(0);
      while (stack.length) {
        const x = stack.pop()!;
        members.push(x);
        a += ctx.area[x];
        for (let j = offsets[x]; j < offsets[x + 1]; j++) {
          const y = neighbors[j];
          if (set.faces[y] !== label) votes[set.faces[y]] += 1;
          else if (comp[y] < 0) {
            comp[y] = s;
            stack.push(y);
          }
        }
      }
      if (a >= minArea) continue;
      let best = -1;
      for (let r = 0; r < R; r++) if (votes[r] > 0 && (best < 0 || votes[r] > votes[best])) best = r;
      if (best < 0) continue; // a whole separate piece: handled below
      for (const m of members) set.faces[m] = best;
      changed = true;
    }
    if (!changed) break;
  }

  // Small separate pieces (buttons, eyes) go entirely to their majority region.
  const pieceArea = new Float64Array(ctx.pieceCount);
  const pieceVotes = new Float64Array(ctx.pieceCount * R);
  for (let t = 0; t < T; t++) {
    pieceArea[ctx.piece[t]] += ctx.area[t];
    pieceVotes[ctx.piece[t] * R + set.faces[t]] += ctx.area[t];
  }
  const pieceLabel = new Int16Array(ctx.pieceCount).fill(-1);
  for (let p = 0; p < ctx.pieceCount; p++) {
    if (pieceArea[p] > ctx.totalArea * 0.03) continue;
    let best = 0;
    for (let r = 1; r < R; r++) if (pieceVotes[p * R + r] > pieceVotes[p * R + best]) best = r;
    if (pieceVotes[p * R + best] >= 0.85 * pieceArea[p]) pieceLabel[p] = best;
  }
  for (let t = 0; t < T; t++) if (pieceLabel[ctx.piece[t]] >= 0) set.faces[t] = pieceLabel[ctx.piece[t]];
  unifyFaces(set, ctx);
}

/** Quads (two triangles) get one region: the first triangle's. */
function unifyFaces(set: RegionSet, ctx: RegionContext): void {
  for (let t = 0; t < ctx.triCount; t++) if (ctx.faceStart[t] !== t) set.faces[t] = set.faces[ctx.faceStart[t]];
}

function label(set: RegionSet, ctx: RegionContext, t: number, region: number): boolean {
  const s = ctx.faceStart[t];
  if (set.faces[s] === region && set.faces[s + ctx.faceLength[s] - 1] === region) return false;
  for (let k = 0; k < ctx.faceLength[s]; k++) set.faces[s + k] = region;
  return true;
}

// --- editing -----------------------------------------------------------------------------

/** Squared distance from p to triangle t (closest point, Ericson's method). */
function triangleDistance2(ctx: RegionContext, t: number, px: number, py: number, pz: number): number {
  const P = ctx.positions, I = ctx.index;
  const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3;
  const abx = P[b] - P[a], aby = P[b + 1] - P[a + 1], abz = P[b + 2] - P[a + 2];
  const acx = P[c] - P[a], acy = P[c + 1] - P[a + 1], acz = P[c + 2] - P[a + 2];
  const apx = px - P[a], apy = py - P[a + 1], apz = pz - P[a + 2];
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  const at = (u: number, v: number) => {
    const qx = P[a] + abx * u + acx * v - px, qy = P[a + 1] + aby * u + acy * v - py, qz = P[a + 2] + abz * u + acz * v - pz;
    return qx * qx + qy * qy + qz * qz;
  };
  if (d1 <= 0 && d2 <= 0) return at(0, 0);
  const bpx = px - P[b], bpy = py - P[b + 1], bpz = pz - P[b + 2];
  const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return at(1, 0);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return at(d1 / (d1 - d3), 0);
  const cpx = px - P[c], cpy = py - P[c + 1], cpz = pz - P[c + 2];
  const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return at(0, 1);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return at(0, d2 / (d2 - d6));
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return at(1 - w, w);
  }
  const denom = 1 / (va + vb + vc);
  return at(vb * denom, vc * denom);
}

/** Paints every triangle the brush sphere touches. Returns how many changed. */
export function paintRegion(set: RegionSet, ctx: RegionContext, center: readonly number[], radius: number, region: number): number {
  const r2 = radius * radius;
  let n = 0;
  for (let t = 0; t < ctx.triCount; t++) {
    const dx = ctx.centroid[t * 3] - center[0], dy = ctx.centroid[t * 3 + 1] - center[1], dz = ctx.centroid[t * 3 + 2] - center[2];
    const d2 = dx * dx + dy * dy + dz * dz;
    const far = radius + ctx.reach[t];
    if (d2 > far * far) continue;
    if ((d2 <= r2 || triangleDistance2(ctx, t, center[0], center[1], center[2]) <= r2) && label(set, ctx, t, region)) n++;
  }
  return n;
}

/** Floods from `seed` over touching triangles of a similar colour. */
export function fillSimilar(set: RegionSet, ctx: RegionContext, seed: number, region: number, tolerance = 12): number {
  const ref = ctx.lab.slice(seed * 3, seed * 3 + 3);
  const seen = new Uint8Array(ctx.triCount);
  const stack = [seed];
  seen[seed] = 1;
  let n = 0;
  const { offsets, neighbors } = ctx.adjacency;
  while (stack.length) {
    const t = stack.pop()!;
    if (label(set, ctx, t, region)) n++;
    for (let j = offsets[t]; j < offsets[t + 1]; j++) {
      const u = neighbors[j];
      if (seen[u]) continue;
      seen[u] = 1;
      if (dist(ctx.lab, u, ref) <= tolerance) stack.push(u);
    }
  }
  return n;
}

/** Assigns the whole connected piece under `seed`. */
export function fillPiece(set: RegionSet, ctx: RegionContext, seed: number, region: number): number {
  const p = ctx.piece[seed];
  let n = 0;
  for (let t = 0; t < ctx.triCount; t++) if (ctx.piece[t] === p && label(set, ctx, t, region)) n++;
  return n;
}

/** The triangle whose centre is nearest `point` (for mirrored edits). */
export function nearestTriangle(ctx: RegionContext, point: readonly number[]): number {
  let best = 0, bestD = Infinity;
  for (let t = 0; t < ctx.triCount; t++) {
    const dx = ctx.centroid[t * 3] - point[0], dy = ctx.centroid[t * 3 + 1] - point[1], dz = ctx.centroid[t * 3 + 2] - point[2];
    const d = dx * dx + dy * dy + dz * dz;
    if (d < bestD) { bestD = d; best = t; }
  }
  return best;
}

/** Removes a region; its triangles go to `into` (indices above it shift down). */
export function removeRegion(set: RegionSet, region: number, into: number): RegionSet {
  const target = into > region ? into - 1 : into;
  const faces = set.faces.map((f) => (f === region ? target : f > region ? f - 1 : f));
  return { defs: set.defs.filter((_, i) => i !== region), faces };
}

/** Average colour of each region (sRGB hex), area-weighted in linear light. */
export function regionBaseColors(set: RegionSet, ctx: RegionContext): string[] {
  const R = set.defs.length;
  const acc = new Float64Array(R * 4);
  for (let t = 0; t < ctx.triCount; t++) {
    const r = set.faces[t], w = ctx.area[t];
    acc[r * 4] += ctx.rgb[t * 3] * w;
    acc[r * 4 + 1] += ctx.rgb[t * 3 + 1] * w;
    acc[r * 4 + 2] += ctx.rgb[t * 3 + 2] * w;
    acc[r * 4 + 3] += w;
  }
  return Array.from({ length: R }, (_, r) => {
    const w = acc[r * 4 + 3] || 1;
    const c = [0, 1, 2].map((k) => Math.round(Math.min(1, Math.max(0, toSRGB(acc[r * 4 + k] / w))) * 255));
    return `#${c.map((x) => x.toString(16).padStart(2, '0')).join('')}`;
  });
}

// --- applying to a mesh -------------------------------------------------------------------

interface Original {
  index: Uint32Array;
  groups: Array<{ start: number; count: number; materialIndex: number }>;
  material: Material | Material[];
  faceSizes?: string;
}

/**
 * Splits the mesh into one material per region (per original material): the
 * triangles are reordered so each region is one draw group, and each group gets
 * a clone of its original material named after the region, tagged
 * `userData.rigforge.region = { name, baseColor }` (exported as glTF extras).
 * Vertices, weights and textures are untouched. `null` restores the mesh.
 *
 * Sets `mesh.userData.rfTriOrder` (new triangle -> original triangle).
 */
export function applyRegions(mesh: Mesh, set: RegionSet | null, baseColors: string[] = []): void {
  const g = mesh.geometry as BufferGeometry;
  if (!g.index) throw new Error('Regions need an indexed mesh.');
  const ud = mesh.userData as { rfOriginal?: Original; rfRegionMats?: Map<string, Material>; rfTriOrder?: Uint32Array; rfBaseMaterial?: Material | Material[] };
  if (!ud.rfOriginal) {
    ud.rfOriginal = {
      index: Uint32Array.from(g.index.array as ArrayLike<number>),
      groups: g.groups.map((x) => ({ start: x.start, count: x.count, materialIndex: x.materialIndex ?? 0 })),
      material: mesh.material,
      faceSizes: typeof g.userData.faceSizes === 'string' ? g.userData.faceSizes : undefined,
    };
  }
  const orig = ud.rfOriginal!;
  const T = orig.index.length / 3;
  const origMats = Array.isArray(orig.material) ? orig.material : [orig.material];
  if (!set) {
    g.index.array.set(orig.index);
    g.index.needsUpdate = true;
    g.clearGroups();
    for (const x of orig.groups) g.addGroup(x.start, x.count, x.materialIndex);
    if (orig.faceSizes !== undefined) g.userData.faceSizes = orig.faceSizes;
    mesh.material = orig.material;
    ud.rfBaseMaterial = orig.material;
    delete ud.rfTriOrder;
    return;
  }
  if (set.faces.length !== T) throw new Error(`Regions cover ${set.faces.length} triangles, the mesh has ${T}.`);
  const matOf = new Uint16Array(T);
  for (const x of orig.groups) matOf.fill(x.materialIndex, x.start / 3, (x.start + x.count) / 3);
  const M = origMats.length;
  const keyOf = (t: number) => set.faces[t] * M + Math.min(matOf[t], M - 1);
  const K = set.defs.length * M;
  // Stable counting sort keeps each quad's two triangles together.
  const counts = new Int32Array(K + 1);
  for (let t = 0; t < T; t++) counts[keyOf(t) + 1]++;
  for (let k = 0; k < K; k++) counts[k + 1] += counts[k];
  const starts = counts.slice(0, K);
  const order = new Uint32Array(T);
  for (let t = 0; t < T; t++) order[starts[keyOf(t)]++] = t;
  const idx = g.index.array as Uint32Array | Uint16Array;
  for (let i = 0; i < T; i++) {
    const t = order[i];
    idx[i * 3] = orig.index[t * 3];
    idx[i * 3 + 1] = orig.index[t * 3 + 1];
    idx[i * 3 + 2] = orig.index[t * 3 + 2];
  }
  g.index.needsUpdate = true;
  // Materials: reuse clones across calls (painting re-applies often).
  ud.rfRegionMats ??= new Map();
  const mats: Material[] = [];
  g.clearGroups();
  for (let k = 0; k < K; k++) {
    const n = counts[k + 1] - counts[k];
    if (!n) continue;
    const r = Math.floor(k / M), m = k % M;
    const key = `${r}:${m}`;
    let mat = ud.rfRegionMats.get(key);
    if (!mat) {
      mat = origMats[m].clone();
      ud.rfRegionMats.set(key, mat);
    }
    const def = set.defs[r];
    mat.name = M > 1 ? `${def.name} ${m + 1}` : def.name;
    mat.userData = { ...origMats[m].userData, rigforge: { region: { name: def.name, baseColor: baseColors[r] ?? '#808080' } } };
    g.addGroup(counts[k] * 3, n * 3, mats.length);
    mats.push(mat);
  }
  mesh.material = mats;
  ud.rfBaseMaterial = mats;
  ud.rfTriOrder = order;
  // Polygon sizes follow the new triangle order.
  if (orig.faceSizes !== undefined) {
    const sizes = decodeFaceSizes({ userData: { faceSizes: orig.faceSizes } } as unknown as BufferGeometry)!;
    const startOf = new Int32Array(T).fill(-1);
    let t = 0;
    for (let f = 0; f < sizes.length && t < T; f++) {
      startOf[t] = sizes[f] === 4 ? 4 : 3;
      t += sizes[f] === 4 ? 2 : 1;
    }
    const out: number[] = [];
    for (let i = 0; i < T; i++) if (startOf[order[i]] > 0) out.push(startOf[order[i]]);
    g.userData.faceSizes = encodeFaceSizes(Uint8Array.from(out));
  }
}

/** Region names and base colours on a mesh built with applyRegions (or loaded from a GLB). */
export function readRegions(mesh: Mesh): Array<{ name: string; baseColor: string }> {
  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  const out = new Map<string, string>();
  for (const m of mats) {
    const r = (m.userData?.rigforge as { region?: { name: string; baseColor: string } } | undefined)?.region;
    if (r && !out.has(r.name)) out.set(r.name, r.baseColor);
  }
  return [...out].map(([name, baseColor]) => ({ name, baseColor }));
}

/**
 * The hair triangles for hair physics: a region's triangles plus whatever
 * continues them in the same colour (a ponytail lying on the back, which a
 * clothing region may have claimed for being on the torso). 1 = hair.
 */
export function hairTriangles(set: RegionSet, ctx: RegionContext, region: number, tolerance = 14): Uint8Array {
  const out = new Uint8Array(ctx.triCount);
  const seeds: number[] = [];
  for (let t = 0; t < ctx.triCount; t++) if (set.faces[t] === region) { out[t] = 1; seeds.push(t); }
  const hair = dominantColor(ctx, seeds);
  if (!hair) return out;
  const { offsets, neighbors } = ctx.adjacency;
  const stack = [...seeds];
  while (stack.length) {
    const t = stack.pop()!;
    for (let k = offsets[t]; k < offsets[t + 1]; k++) {
      const u = neighbors[k];
      if (out[u] || dist(ctx.lab, u, hair) > tolerance) continue;
      out[u] = 1;
      stack.push(u);
    }
  }
  return out;
}
