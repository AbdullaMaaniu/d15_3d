import { weldByPosition } from '../mesh/analyze';
import { triangleBones, type RegionSet } from '../rig/regions';
import type { JointMap } from '../skeleton';

/**
 * Garment separation: cuts a single-surface character (a Meshy export, where
 * the clothes are baked into one mesh with the skin) into one open mesh per
 * garment, using the regions from the Parts step. The bare skin is left out,
 * since the fitted body replaces it; the character's own head can be kept as a
 * piece so its face survives.
 *
 * Region borders are triangle staircases, so each region's share of the
 * surface around every vertex is smoothed and the triangles are cut where the
 * winning region changes: cuffs, collars and waistbands come out as smooth
 * loops. Neighbouring pieces cut a shared edge at the same point, so they meet
 * without gaps. Every output vertex records the source vertices it was blended
 * from, so any attribute (tangents, colours, morph targets) can be carried over.
 */

export type GarmentKind = 'garment' | 'hair' | 'head';

export interface GarmentSource {
  /** Rig-space bind pose positions, as the skinned character mesh has them. */
  positions: ArrayLike<number>;
  /** Triangles in the regions' (original) order. */
  index: ArrayLike<number>;
  normals?: ArrayLike<number> | null;
  uvs?: ArrayLike<number> | null;
  /** 4 bone indices (into `bones`) and weights per vertex. */
  skinIndex: ArrayLike<number>;
  skinWeight: ArrayLike<number>;
  bones: readonly string[];
  /** Material per triangle (default 0). */
  materialOfTriangle?: ArrayLike<number> | null;
  /** Region per triangle (Parts step). The region named "Skin" is replaced by the body. */
  regions: RegionSet;
  /** The rig's joints: the kept head is cut across the middle of the neck. Without them, it's the skin on the head bone. */
  joints?: JointMap | null;
}

export interface GarmentOptions {
  /** Keep the character's own head (skin on the head bone) as a piece over the body's head. Default true. */
  keepHead?: boolean;
  /** Patches smaller than this fraction of the surface take the region around them. Default 0.0015. */
  minIsland?: number;
  /** Smoothing passes over the cut lines. Default 3. */
  smoothing?: number;
}

export interface GarmentPiece {
  /** Region name ("Top", "Bottoms", ...), or "Head". */
  name: string;
  kind: GarmentKind;
  /** Region index in the RegionSet, or -1 for the kept head. */
  region: number;
  /** Rig space, bind pose (like the character mesh). */
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array | null;
  /** 4 bone indices (into the source's `bones`) and weights per vertex. */
  skinIndex: Uint16Array;
  skinWeight: Float32Array;
  index: Uint32Array;
  /** Index ranges by source material, in index units (like three.js groups). */
  groups: Array<{ start: number; count: number; materialIndex: number }>;
  /** Up to 3 source vertices per vertex and their blend weights (cut vertices lie between source vertices). */
  source: Uint32Array;
  sourceWeight: Float32Array;
  /** Source triangle each triangle was cut from. */
  sourceTriangle: Uint32Array;
  /**
   * Open borders (collar, cuffs, waistband, ...), each a loop of vertex
   * indices, longest first: where cloth simulation pins or stitches the piece.
   */
  openings: Uint32Array[];
  /** Surface area (m²). */
  area: number;
}

/** Where the kept head was cut from the neck: a plane, limited to a ball around the neck. */
export interface HeadCut {
  point: [number, number, number];
  /** Unit normal, pointing up the neck. */
  normal: [number, number, number];
  center: [number, number, number];
  radius: number;
}

export interface GarmentSeparation {
  pieces: GarmentPiece[];
  /** The kept head's cut (with joints): the body above it is replaced by the head. */
  headCut: HeadCut | null;
  /** Area of bare skin left out (replaced by the body), m². */
  skinArea: number;
  /** Things worth telling the user (no Skin part, ...). */
  notes: string[];
}

const SKIN = -1;
/** A bare vertex's lead for skin when placing a cut: the cut lands closer to it the more the garment owns the other end. */
const BARE = 0.15;

/** Splits a character into garment pieces. */
export function separateGarments(src: GarmentSource, options: GarmentOptions = {}): GarmentSeparation {
  const keepHead = options.keepHead ?? true;
  const minIsland = options.minIsland ?? 0.0015;
  const smoothing = options.smoothing ?? 3;
  const { positions, index, regions } = src;
  const T = index.length / 3;
  if (regions.faces.length !== T) throw new Error(`Regions cover ${regions.faces.length} triangles, the mesh has ${T}.`);
  const notes: string[] = [];
  const R = regions.defs.length;
  const skinRegion = regions.defs.findIndex((d) => d.name.trim().toLowerCase() === 'skin');
  if (skinRegion < 0) notes.push('No part is named Skin, so every part was kept as clothing.');
  const HEAD = R; // label for the kept head

  // Labels per triangle: a region, the kept head, or skin.
  const label = new Int16Array(T);
  const head = keepHead && skinRegion >= 0 ? headTest(src) : null;
  for (let t = 0; t < T; t++) {
    const r = regions.faces[t];
    label[t] = r === skinRegion ? (head?.onHead(t) ? HEAD : SKIN) : r;
  }

  // Welded topology: vertices split along UV seams are one point of the surface.
  const weld = weldByPosition(positions);
  const W = weld.count;
  const wid = weld.ids;
  const area = new Float64Array(T);
  let total = 0;
  for (let t = 0; t < T; t++) {
    area[t] = triArea(positions, index[t * 3], index[t * 3 + 1], index[t * 3 + 2]);
    total += area[t];
  }
  const adj = triangleAdjacency(index, wid, W);

  cleanIslands(label, adj, area, total * minIsland);

  // Labels in use, compacted: slot per label for the vertex fields.
  const slotOf = new Map<number, number>();
  const labelOfSlot: number[] = [];
  for (let t = 0; t < T; t++) if (!slotOf.has(label[t])) { slotOf.set(label[t], labelOfSlot.length); labelOfSlot.push(label[t]); }
  const K = labelOfSlot.length;

  // Each label's share of the surface around every welded vertex, smoothed.
  let field = new Float32Array(W * K);
  const vArea = new Float32Array(W);
  for (let t = 0; t < T; t++) {
    const s = slotOf.get(label[t])!;
    for (let c = 0; c < 3; c++) {
      const v = wid[index[t * 3 + c]];
      field[v * K + s] += area[t];
      vArea[v] += area[t];
    }
  }
  for (let v = 0; v < W; v++) if (vArea[v] > 0) for (let s = 0; s < K; s++) field[v * K + s] /= vArea[v];
  const nb = vertexNeighbors(index, wid, W);
  // Only vertices near a border change: the band within `smoothing` rings of one.
  const band = new Uint8Array(W);
  for (let v = 0; v < W; v++) {
    for (let s = 0; s < K; s++) {
      const f = field[v * K + s];
      if (f > 0 && f < 1) { band[v] = 1; break; }
    }
  }
  for (let r = 0; r < smoothing; r++) {
    const grow = band.slice();
    for (let v = 0; v < W; v++) if (band[v]) for (let j = nb.offsets[v]; j < nb.offsets[v + 1]; j++) grow[nb.neighbors[j]] = 1;
    band.set(grow);
  }
  for (let it = 0; it < smoothing; it++) {
    const next = field.slice();
    for (let v = 0; v < W; v++) {
      const n = nb.offsets[v + 1] - nb.offsets[v];
      if (!band[v] || !n) continue;
      for (let s = 0; s < K; s++) {
        let sum = 0;
        for (let j = nb.offsets[v]; j < nb.offsets[v + 1]; j++) sum += field[nb.neighbors[j] * K + s];
        next[v * K + s] = 0.5 * field[v * K + s] + (0.5 * sum) / n;
      }
    }
    field = next;
  }
  const winner = new Int32Array(W);
  for (let v = 0; v < W; v++) {
    let best = 0;
    for (let s = 1; s < K; s++) if (field[v * K + s] > field[v * K + best]) best = s;
    winner[v] = best;
  }
  // Every corner of a skin triangle stays skin, so the cut runs through the
  // garment's own border triangles: a garment may lose a sliver of its edge,
  // but never takes a piece of skin.
  const skinSlot = slotOf.get(SKIN);
  const bare = new Uint8Array(W);
  const headSlot = slotOf.get(HEAD);
  // Where the head meets the body's neck, the cut is the plane itself.
  const above = head?.above && headSlot !== undefined && skinSlot !== undefined ? new Float32Array(W) : null;
  if (above) {
    for (let v = 0; v < positions.length / 3; v++) above[wid[v]] = head!.above!(v);
    for (let v = 0; v < W; v++) if (winner[v] === headSlot || winner[v] === skinSlot) winner[v] = above[v] > 0 ? headSlot! : skinSlot!;
  }
  if (skinSlot !== undefined) {
    for (let t = 0; t < T; t++) {
      if (label[t] !== SKIN) continue;
      for (let c = 0; c < 3; c++) {
        const v = wid[index[t * 3 + c]];
        if (winner[v] === headSlot) continue; // the head and the body's neck are both skin: cut smoothly
        bare[v] = 1;
        winner[v] = skinSlot;
      }
    }
  }

  // Cut every triangle where the winning label changes.
  const builders = new Map<number, PieceBuilder>();
  const builder = (slot: number) => {
    let b = builders.get(slot);
    if (!b) builders.set(slot, (b = new PieceBuilder()));
    return b;
  };
  const share = (v: number, sa: number, sb: number) => {
    // How much more label sa than sb a vertex has (a bare vertex is always skin's).
    if (above && sa === headSlot && sb === skinSlot) return above[v];
    if (above && sa === skinSlot && sb === headSlot) return -above[v];
    if (bare[v] && sb === skinSlot && sa !== headSlot) return -BARE;
    if (bare[v] && sa === skinSlot && sb !== headSlot) return BARE;
    return field[v * K + sa] - field[v * K + sb];
  };
  const crossing = (a: number, b: number, sa: number, sb: number): number => {
    // Where label sa's share equals sb's along the edge a -> b (welded values).
    const ga = share(wid[a], sa, sb), gb = share(wid[b], sa, sb);
    return ga > 0 && gb < 0 ? ga / (ga - gb) : 0.5;
  };
  const corner = [0, 0, 0], wv = [0, 0, 0];
  let skinArea = 0;
  for (let t = 0; t < T; t++) {
    for (let c = 0; c < 3; c++) {
      corner[c] = index[t * 3 + c];
      wv[c] = winner[wid[corner[c]]];
    }
    const mat = src.materialOfTriangle?.[t] ?? 0;
    if (wv[0] === wv[1] && wv[1] === wv[2]) {
      if (labelOfSlot[wv[0]] === SKIN) skinArea += area[t];
      else builder(wv[0]).polygon([vKey(corner[0]), vKey(corner[1]), vKey(corner[2])], t, mat);
      continue;
    }
    // Edge crossings (shared edges are cut identically by both triangles).
    const pts: Array<VertexRef | null> = [null, null, null];
    for (let i = 0; i < 3; i++) {
      const j = (i + 1) % 3;
      if (wv[i] === wv[j]) continue;
      const [a, b, sa, sb] = corner[i] < corner[j] ? [corner[i], corner[j], wv[i], wv[j]] : [corner[j], corner[i], wv[j], wv[i]];
      pts[i] = eKey(a, b, crossing(a, b, sa, sb));
    }
    const distinct = new Set(wv).size;
    if (distinct === 2) {
      // One corner alone: a triangle for it, a quad for the other two.
      const k = wv[0] === wv[1] ? 2 : wv[1] === wv[2] ? 0 : 1;
      const k1 = (k + 1) % 3, k2 = (k + 2) % 3;
      const alone = [vKey(corner[k]), pts[k]!, pts[k2]!];
      const rest = [pts[k]!, vKey(corner[k1]), vKey(corner[k2]), pts[k2]!];
      emit(wv[k], alone);
      emit(wv[k1], rest);
    } else {
      // Three labels meet: each corner gets a kite to the centre.
      const centre = cKey(corner[0], corner[1], corner[2]);
      for (let i = 0; i < 3; i++) emit(wv[i], [vKey(corner[i]), pts[i]!, centre, pts[(i + 2) % 3]!]);
    }
    function emit(slot: number, poly: VertexRef[]) {
      if (labelOfSlot[slot] === SKIN) skinArea += polyArea(positions, poly);
      else builder(slot).polygon(poly, t, mat);
    }
  }

  const pieces: GarmentPiece[] = [];
  for (const [slot, b] of builders) {
    const l = labelOfSlot[slot];
    const name = l === HEAD ? 'Head' : regions.defs[l].name;
    const kind: GarmentKind = l === HEAD ? 'head' : /hair/i.test(name) ? 'hair' : 'garment';
    const piece = b.build(src, name, kind, l === HEAD ? -1 : l);
    if (piece.index.length) pieces.push(piece);
  }
  pieces.sort((a, b) => (a.region < 0 ? 1e9 : a.region) - (b.region < 0 ? 1e9 : b.region));
  const headCut = head?.cut && pieces.some((p) => p.kind === 'head') ? head.cut : null;
  return { pieces, headCut, skinArea, notes };
}

/**
 * Which skin triangles belong to the kept head, and (with joints) the height
 * of a point above the cut: a plane across the middle of the neck, square to it.
 */
function headTest(src: GarmentSource): { onHead: (t: number) => boolean; above: ((v: number) => number) | null; cut: HeadCut | null } {
  const { positions: p, index } = src;
  const neck = src.joints?.joints.neck, head = src.joints?.joints.head;
  if (neck && head) {
    const l = Math.hypot(head[0] - neck[0], head[1] - neck[1], head[2] - neck[2]) || 1;
    const d = [(head[0] - neck[0]) / l, (head[1] - neck[1]) / l, (head[2] - neck[2]) / l];
    const mid = [(neck[0] + head[0]) / 2, (neck[1] + head[1]) / 2, (neck[2] + head[2]) / 2];
    const above = (v: number) => (p[v * 3] - mid[0]) * d[0] + (p[v * 3 + 1] - mid[1]) * d[1] + (p[v * 3 + 2] - mid[2]) * d[2];
    // Only near the head, so hands raised above the neck stay the body's.
    const top = src.joints!.tails.head ?? [head[0] + d[0] * l * 2, head[1] + d[1] * l * 2, head[2] + d[2] * l * 2];
    const reach = Math.hypot(top[0] - neck[0], top[1] - neck[1], top[2] - neck[2]) * 1.1;
    const near = (v: number) => Math.hypot(p[v * 3] - neck[0], p[v * 3 + 1] - neck[1], p[v * 3 + 2] - neck[2]) < reach;
    return {
      onHead: (t) => near(index[t * 3]) && above(index[t * 3]) + above(index[t * 3 + 1]) + above(index[t * 3 + 2]) > 0,
      above: (v) => (near(v) ? above(v) : -1),
      cut: { point: mid as [number, number, number], normal: d as [number, number, number], center: [...neck], radius: reach },
    };
  }
  const bones = triangleBones(index, src.skinIndex, src.skinWeight, src.bones);
  return { onHead: (t) => bones[t] === 'head', above: null, cut: null };
}

// --- vertices of the cut mesh ------------------------------------------------------------

/** A source vertex, a point on a source edge, or a triangle's centre. */
interface VertexRef {
  key: string;
  src: number[];
  w: number[];
}
const vKey = (a: number): VertexRef => ({ key: `v${a}`, src: [a], w: [1] });
const eKey = (a: number, b: number, t: number): VertexRef => ({ key: `e${a}_${b}`, src: [a, b], w: [1 - t, t] });
const cKey = (a: number, b: number, c: number): VertexRef => ({ key: `c${a}_${b}_${c}`, src: [a, b, c], w: [1 / 3, 1 / 3, 1 / 3] });

class PieceBuilder {
  verts = new Map<string, number>();
  refs: VertexRef[] = [];
  tris: number[] = [];
  triSource: number[] = [];
  triMat: number[] = [];

  vertex(r: VertexRef): number {
    let i = this.verts.get(r.key);
    if (i === undefined) {
      i = this.refs.length;
      this.verts.set(r.key, i);
      this.refs.push(r);
    }
    return i;
  }

  polygon(poly: VertexRef[], sourceTriangle: number, mat: number): void {
    const ids = poly.map((r) => this.vertex(r));
    for (let i = 1; i + 1 < ids.length; i++) {
      const a = ids[0], b = ids[i], c = ids[i + 1];
      if (a === b || b === c || a === c) continue;
      this.tris.push(a, b, c);
      this.triSource.push(sourceTriangle);
      this.triMat.push(mat);
    }
  }

  build(src: GarmentSource, name: string, kind: GarmentKind, region: number): GarmentPiece {
    const V = this.refs.length;
    const positions = new Float32Array(V * 3), normals = new Float32Array(V * 3);
    const uvs = src.uvs ? new Float32Array(V * 2) : null;
    const skinIndex = new Uint16Array(V * 4), skinWeight = new Float32Array(V * 4);
    const source = new Uint32Array(V * 3), sourceWeight = new Float32Array(V * 3);
    const acc = new Map<number, number>();
    for (let v = 0; v < V; v++) {
      const r = this.refs[v];
      acc.clear();
      for (let k = 0; k < r.src.length; k++) {
        const s = r.src[k], w = r.w[k];
        source[v * 3 + k] = s;
        sourceWeight[v * 3 + k] = w;
        for (let j = 0; j < 3; j++) positions[v * 3 + j] += src.positions[s * 3 + j] * w;
        if (src.normals) for (let j = 0; j < 3; j++) normals[v * 3 + j] += src.normals[s * 3 + j] * w;
        if (uvs) for (let j = 0; j < 2; j++) uvs[v * 2 + j] += src.uvs![s * 2 + j] * w;
        for (let j = 0; j < 4; j++) {
          const bw = src.skinWeight[s * 4 + j];
          if (bw > 0) acc.set(src.skinIndex[s * 4 + j], (acc.get(src.skinIndex[s * 4 + j]) ?? 0) + bw * w);
        }
      }
      // Strongest four influences, renormalized.
      const top = [...acc].sort((a, b) => b[1] - a[1]).slice(0, 4);
      const sum = top.reduce((s, x) => s + x[1], 0) || 1;
      top.forEach(([bone, w], j) => {
        skinIndex[v * 4 + j] = bone;
        skinWeight[v * 4 + j] = w / sum;
      });
      if (!top.length) skinWeight[v * 4] = 1;
    }
    // Triangles grouped by material.
    const Tn = this.triSource.length;
    const order = [...Array(Tn).keys()].sort((a, b) => this.triMat[a] - this.triMat[b] || a - b);
    const index = new Uint32Array(Tn * 3), sourceTriangle = new Uint32Array(Tn);
    const groups: GarmentPiece['groups'] = [];
    order.forEach((t, i) => {
      index.set(this.tris.slice(t * 3, t * 3 + 3), i * 3);
      sourceTriangle[i] = this.triSource[t];
      const m = this.triMat[t];
      const g = groups[groups.length - 1];
      if (g && g.materialIndex === m) g.count += 3;
      else groups.push({ start: i * 3, count: 3, materialIndex: m });
    });
    if (!src.normals) computeNormals(positions, index, normals);
    else for (let v = 0; v < V; v++) {
      const l = Math.hypot(normals[v * 3], normals[v * 3 + 1], normals[v * 3 + 2]) || 1;
      for (let j = 0; j < 3; j++) normals[v * 3 + j] /= l;
    }
    let area = 0;
    for (let t = 0; t < Tn; t++) area += triArea(positions, index[t * 3], index[t * 3 + 1], index[t * 3 + 2]);
    return { name, kind, region, positions, normals, uvs, skinIndex, skinWeight, index, groups, source, sourceWeight, sourceTriangle, openings: openings(positions, index), area };
  }
}

// --- body hidden under the clothes -------------------------------------------------------------

export interface CoverOptions {
  /** Farthest a garment may be outside the body and still hide it (m). Default 0.12. */
  maxGap?: number;
  /** How far the body may poke out of a garment and still be hidden (m). Default 0.04. */
  inside?: number;
  /** Body kept visible this far in from a garment's edge, so openings never show a gap (m). Default 0.03. */
  margin?: number;
  /** The kept head's cut: the body above it is hidden outright, and below it is left to the neck. */
  headCut?: HeadCut | null;
}

/**
 * Which body triangles are hidden under the garments (1 = hidden): the body
 * vertex's outward normal meets a garment, and it's not near a garment's edge.
 * Hiding them keeps the body from poking through clothes as it moves, and
 * saves triangles on export.
 */
export function coveredBodyTriangles(
  body: { positions: ArrayLike<number>; normals: ArrayLike<number>; index: ArrayLike<number> },
  pieces: readonly (Pick<GarmentPiece, 'positions' | 'index'> & { kind?: GarmentKind })[],
  options: CoverOptions = {},
): Uint8Array {
  const maxGap = options.maxGap ?? 0.12;
  const inside = options.inside ?? 0.04;
  const margin = options.margin ?? 0.03;
  const cut = options.headCut ?? null;
  const grid = new TriangleGrid(cut ? pieces.filter((p) => p.kind !== 'head') : pieces, 0.04);
  const V = body.positions.length / 3;
  const weld = weldByPosition(body.positions);
  const covered = new Uint8Array(weld.count).fill(1);
  const seen = new Uint8Array(weld.count);
  for (let v = 0; v < V; v++) {
    const w = weld.ids[v];
    const p = [body.positions[v * 3], body.positions[v * 3 + 1], body.positions[v * 3 + 2]];
    const n = [body.normals[v * 3], body.normals[v * 3 + 1], body.normals[v * 3 + 2]];
    const o = [p[0] - n[0] * inside, p[1] - n[1] * inside, p[2] - n[2] * inside];
    const hit = grid.raycast(o, n, inside + maxGap);
    if (!seen[w]) covered[w] = hit ? 1 : 0;
    else if (!hit) covered[w] = 0;
    seen[w] = 1;
  }
  // Keep a margin visible around everything uncovered (garment edges, gaps).
  const nb = vertexNeighbors(body.index, weld.ids, weld.count);
  const reps = new Int32Array(weld.count).fill(-1);
  for (let v = 0; v < V; v++) if (reps[weld.ids[v]] < 0) reps[weld.ids[v]] = v;
  const dist = new Float32Array(weld.count).fill(Infinity);
  const heap = new MinHeap();
  for (let w = 0; w < weld.count; w++) if (!covered[w]) { dist[w] = 0; heap.push(w, 0); }
  while (heap.size) {
    const [w, d] = heap.pop();
    if (d > dist[w] || d >= margin) continue;
    covered[w] = 0;
    const a = reps[w];
    for (let j = nb.offsets[w]; j < nb.offsets[w + 1]; j++) {
      const u = nb.neighbors[j], b = reps[u];
      const nd = d + Math.hypot(body.positions[a * 3] - body.positions[b * 3], body.positions[a * 3 + 1] - body.positions[b * 3 + 1], body.positions[a * 3 + 2] - body.positions[b * 3 + 2]);
      if (nd < dist[u]) { dist[u] = nd; heap.push(u, nd); }
    }
  }
  if (cut) {
    // Above the head's cut, the character's own head replaces the body's.
    for (let v = 0; v < V; v++) {
      const q = [body.positions[v * 3], body.positions[v * 3 + 1], body.positions[v * 3 + 2]];
      const up = (q[0] - cut.point[0]) * cut.normal[0] + (q[1] - cut.point[1]) * cut.normal[1] + (q[2] - cut.point[2]) * cut.normal[2];
      if (up > 0 && Math.hypot(q[0] - cut.center[0], q[1] - cut.center[1], q[2] - cut.center[2]) < cut.radius) covered[weld.ids[v]] = 1;
    }
  }
  const T = body.index.length / 3;
  const hidden = new Uint8Array(T);
  for (let t = 0; t < T; t++) hidden[t] = covered[weld.ids[body.index[t * 3]]] & covered[weld.ids[body.index[t * 3 + 1]]] & covered[weld.ids[body.index[t * 3 + 2]]];
  return hidden;
}

/** A uniform grid over triangles for short rays. */
class TriangleGrid {
  cells = new Map<number, number[]>();
  tris: Float32Array;
  lo = [Infinity, Infinity, Infinity];
  constructor(pieces: readonly Pick<GarmentPiece, 'positions' | 'index'>[], public size: number) {
    let n = 0;
    for (const p of pieces) n += p.index.length / 3;
    this.tris = new Float32Array(n * 9);
    let t = 0;
    for (const p of pieces) {
      for (let i = 0; i < p.index.length; i += 3, t++) {
        for (let c = 0; c < 3; c++) for (let j = 0; j < 3; j++) this.tris[t * 9 + c * 3 + j] = p.positions[p.index[i + c] * 3 + j];
      }
    }
    for (let t2 = 0; t2 < n; t2++) {
      const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      for (let c = 0; c < 3; c++) for (let j = 0; j < 3; j++) {
        const x = this.tris[t2 * 9 + c * 3 + j];
        lo[j] = Math.min(lo[j], x);
        hi[j] = Math.max(hi[j], x);
      }
      for (let x = this.cell(lo[0]); x <= this.cell(hi[0]); x++)
        for (let y = this.cell(lo[1]); y <= this.cell(hi[1]); y++)
          for (let z = this.cell(lo[2]); z <= this.cell(hi[2]); z++) {
            const k = this.key(x, y, z);
            const list = this.cells.get(k);
            if (list) list.push(t2);
            else this.cells.set(k, [t2]);
          }
    }
  }
  cell(x: number) {
    return Math.floor(x / this.size);
  }
  key(x: number, y: number, z: number) {
    return ((x + 1024) * 2048 + (y + 1024)) * 2048 + (z + 1024);
  }
  /** Whether the segment o + d·s (0 ≤ s ≤ len) hits a triangle. */
  raycast(o: number[], d: number[], len: number): boolean {
    // Amanatides-Woo walk through the cells along the segment.
    const c = [this.cell(o[0]), this.cell(o[1]), this.cell(o[2])];
    const step = [0, 0, 0], tMax = [0, 0, 0], tDelta = [0, 0, 0];
    for (let j = 0; j < 3; j++) {
      step[j] = d[j] > 0 ? 1 : d[j] < 0 ? -1 : 0;
      const bound = (c[j] + (step[j] > 0 ? 1 : 0)) * this.size;
      tMax[j] = step[j] ? (bound - o[j]) / d[j] : Infinity;
      tDelta[j] = step[j] ? this.size / Math.abs(d[j]) : Infinity;
    }
    const tested = new Set<number>();
    for (let guard = 0; guard < 64; guard++) {
      const list = this.cells.get(this.key(c[0], c[1], c[2]));
      if (list) for (const t of list) {
        if (tested.has(t)) continue;
        tested.add(t);
        if (rayTriangle(o, d, this.tris, t * 9, len)) return true;
      }
      const j = tMax[0] < tMax[1] ? (tMax[0] < tMax[2] ? 0 : 2) : tMax[1] < tMax[2] ? 1 : 2;
      if (tMax[j] > len) break;
      c[j] += step[j];
      tMax[j] += tDelta[j];
    }
    return false;
  }
}

function rayTriangle(o: number[], d: number[], p: Float32Array, i: number, len: number): boolean {
  const e1x = p[i + 3] - p[i], e1y = p[i + 4] - p[i + 1], e1z = p[i + 5] - p[i + 2];
  const e2x = p[i + 6] - p[i], e2y = p[i + 7] - p[i + 1], e2z = p[i + 8] - p[i + 2];
  const px = d[1] * e2z - d[2] * e2y, py = d[2] * e2x - d[0] * e2z, pz = d[0] * e2y - d[1] * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(det) < 1e-12) return false;
  const inv = 1 / det;
  const tx = o[0] - p[i], ty = o[1] - p[i + 1], tz = o[2] - p[i + 2];
  const u = (tx * px + ty * py + tz * pz) * inv;
  if (u < 0 || u > 1) return false;
  const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
  const v = (d[0] * qx + d[1] * qy + d[2] * qz) * inv;
  if (v < 0 || u + v > 1) return false;
  const s = (e2x * qx + e2y * qy + e2z * qz) * inv;
  return s >= 0 && s <= len;
}

class MinHeap {
  ids: number[] = [];
  keys: number[] = [];
  get size() {
    return this.ids.length;
  }
  push(id: number, key: number) {
    const { ids, keys } = this;
    let i = ids.length;
    ids.push(id);
    keys.push(key);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p] <= keys[i]) break;
      [ids[p], ids[i]] = [ids[i], ids[p]];
      [keys[p], keys[i]] = [keys[i], keys[p]];
      i = p;
    }
  }
  pop(): [number, number] {
    const { ids, keys } = this;
    const top: [number, number] = [ids[0], keys[0]];
    const lastId = ids.pop()!, lastKey = keys.pop()!;
    if (ids.length) {
      ids[0] = lastId;
      keys[0] = lastKey;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < ids.length && keys[l] < keys[m]) m = l;
        if (r < ids.length && keys[r] < keys[m]) m = r;
        if (m === i) break;
        [ids[m], ids[i]] = [ids[i], ids[m]];
        [keys[m], keys[i]] = [keys[i], keys[m]];
        i = m;
      }
    }
    return top;
  }
}

// --- helpers -----------------------------------------------------------------------------

function triArea(p: ArrayLike<number>, a: number, b: number, c: number): number {
  const ux = p[b * 3] - p[a * 3], uy = p[b * 3 + 1] - p[a * 3 + 1], uz = p[b * 3 + 2] - p[a * 3 + 2];
  const vx = p[c * 3] - p[a * 3], vy = p[c * 3 + 1] - p[a * 3 + 1], vz = p[c * 3 + 2] - p[a * 3 + 2];
  return 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
}

function polyArea(p: ArrayLike<number>, poly: VertexRef[]): number {
  const pt = (r: VertexRef) => {
    const out = [0, 0, 0];
    r.src.forEach((s, k) => { for (let j = 0; j < 3; j++) out[j] += p[s * 3 + j] * r.w[k]; });
    return out;
  };
  const pts = poly.map(pt);
  let a = 0;
  for (let i = 1; i + 1 < pts.length; i++) {
    const u = [0, 1, 2].map((j) => pts[i][j] - pts[0][j]), v = [0, 1, 2].map((j) => pts[i + 1][j] - pts[0][j]);
    a += 0.5 * Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]);
  }
  return a;
}

function computeNormals(p: Float32Array, index: Uint32Array, out: Float32Array): void {
  out.fill(0);
  for (let t = 0; t < index.length; t += 3) {
    const a = index[t], b = index[t + 1], c = index[t + 2];
    const ux = p[b * 3] - p[a * 3], uy = p[b * 3 + 1] - p[a * 3 + 1], uz = p[b * 3 + 2] - p[a * 3 + 2];
    const vx = p[c * 3] - p[a * 3], vy = p[c * 3 + 1] - p[a * 3 + 1], vz = p[c * 3 + 2] - p[a * 3 + 2];
    const n = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
    for (const v of [a, b, c]) for (let j = 0; j < 3; j++) out[v * 3 + j] += n[j];
  }
  for (let v = 0; v < out.length / 3; v++) {
    const l = Math.hypot(out[v * 3], out[v * 3 + 1], out[v * 3 + 2]) || 1;
    for (let j = 0; j < 3; j++) out[v * 3 + j] /= l;
  }
}

/** Triangles sharing an edge of the welded surface (CSR). */
function triangleAdjacency(index: ArrayLike<number>, wid: Uint32Array, W: number): { offsets: Int32Array; neighbors: Int32Array } {
  const T = index.length / 3;
  const edges = new Map<number, number[]>();
  for (let t = 0; t < T; t++) {
    for (let c = 0; c < 3; c++) {
      const a = wid[index[t * 3 + c]], b = wid[index[t * 3 + ((c + 1) % 3)]];
      if (a === b) continue;
      const k = a < b ? a * W + b : b * W + a;
      const list = edges.get(k);
      if (list) list.push(t);
      else edges.set(k, [t]);
    }
  }
  const lists: number[][] = Array.from({ length: T }, () => []);
  for (const tris of edges.values()) for (const a of tris) for (const b of tris) if (a !== b) lists[a].push(b);
  return csr(lists);
}

/** Neighbouring welded vertices (CSR). */
function vertexNeighbors(index: ArrayLike<number>, wid: Uint32Array, W: number): { offsets: Int32Array; neighbors: Int32Array } {
  const sets: Array<Set<number>> = Array.from({ length: W }, () => new Set());
  for (let t = 0; t < index.length; t += 3) {
    for (let c = 0; c < 3; c++) {
      const a = wid[index[t + c]], b = wid[index[t + ((c + 1) % 3)]];
      if (a === b) continue;
      sets[a].add(b);
      sets[b].add(a);
    }
  }
  return csr(sets.map((s) => [...s]));
}

function csr(lists: number[][]): { offsets: Int32Array; neighbors: Int32Array } {
  const offsets = new Int32Array(lists.length + 1);
  for (let i = 0; i < lists.length; i++) offsets[i + 1] = offsets[i] + lists[i].length;
  const neighbors = new Int32Array(offsets[lists.length]);
  for (let i = 0; i < lists.length; i++) neighbors.set(lists[i], offsets[i]);
  return { offsets, neighbors };
}

/**
 * Small patches (skin specks in a shirt, a stray triangle of shirt on the arm)
 * take the label they share the longest border with. Separate pieces with no
 * border (buttons, eyes) keep theirs.
 */
function cleanIslands(label: Int16Array, adj: { offsets: Int32Array; neighbors: Int32Array }, area: Float64Array, minArea: number): void {
  const T = label.length;
  const comp = new Int32Array(T).fill(-1);
  const comps: Array<{ tris: number[]; area: number }> = [];
  for (let s = 0; s < T; s++) {
    if (comp[s] >= 0) continue;
    const id = comps.length;
    const tris = [s];
    comp[s] = id;
    let a = 0;
    for (let i = 0; i < tris.length; i++) {
      const t = tris[i];
      a += area[t];
      for (let j = adj.offsets[t]; j < adj.offsets[t + 1]; j++) {
        const u = adj.neighbors[j];
        if (comp[u] < 0 && label[u] === label[s]) {
          comp[u] = id;
          tris.push(u);
        }
      }
    }
    comps.push({ tris, area: a });
  }
  const order = comps.map((_, i) => i).filter((i) => comps[i].area < minArea).sort((a, b) => comps[a].area - comps[b].area);
  for (const i of order) {
    const { tris } = comps[i];
    const own = label[tris[0]];
    const votes = new Map<number, number>();
    for (const t of tris) {
      for (let j = adj.offsets[t]; j < adj.offsets[t + 1]; j++) {
        const l = label[adj.neighbors[j]];
        if (l !== own) votes.set(l, (votes.get(l) ?? 0) + 1);
      }
    }
    let best = own, bestN = 0;
    for (const [l, n] of votes) if (n > bestN) { best = l; bestN = n; }
    if (best !== own) for (const t of tris) label[t] = best;
  }
}

/** Boundary loops of a triangle mesh (by position, so UV seams don't count), longest first. */
function openings(positions: Float32Array, index: Uint32Array): Uint32Array[] {
  const weld = weldByPosition(positions);
  const W = weld.count;
  const id = weld.ids;
  const directed = new Map<number, number>();
  const key = (a: number, b: number) => a * W + b;
  for (let t = 0; t < index.length; t += 3) {
    for (let c = 0; c < 3; c++) {
      const a = id[index[t + c]], b = id[index[t + ((c + 1) % 3)]];
      if (a !== b) directed.set(key(a, b), (directed.get(key(a, b)) ?? 0) + 1);
    }
  }
  // Border half-edges: no triangle runs the other way.
  const next = new Map<number, number[]>();
  for (const k of directed.keys()) {
    const a = Math.floor(k / W), b = k - a * W;
    if (directed.has(key(b, a))) continue;
    const list = next.get(a);
    if (list) list.push(b);
    else next.set(a, [b]);
  }
  const rep = new Int32Array(W).fill(-1);
  for (let v = 0; v < id.length; v++) if (rep[id[v]] < 0) rep[id[v]] = v;
  const loops: Array<{ verts: number[]; length: number }> = [];
  for (const start of [...next.keys()]) {
    while (next.get(start)?.length) {
      const verts: number[] = [];
      let v = start, length = 0;
      for (let guard = 0; guard <= directed.size; guard++) {
        const outs = next.get(v);
        if (!outs?.length) break;
        const u = outs.pop()!;
        verts.push(rep[v]);
        length += Math.hypot(positions[rep[v] * 3] - positions[rep[u] * 3], positions[rep[v] * 3 + 1] - positions[rep[u] * 3 + 1], positions[rep[v] * 3 + 2] - positions[rep[u] * 3 + 2]);
        v = u;
        if (v === start) break;
      }
      if (verts.length >= 3) loops.push({ verts, length });
    }
  }
  loops.sort((a, b) => b.length - a.length);
  return loops.map((l) => Uint32Array.from(l.verts));
}
