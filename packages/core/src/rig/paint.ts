import type { BufferGeometry } from 'three';
import { weldByPosition } from '../mesh/analyze';

export type BrushMode = 'add' | 'subtract' | 'smooth';

export interface BrushStroke {
  /** Brush center in the mesh's bind-pose space. */
  center: [number, number, number];
  radius: number;
  /** 0..1 amount per dab. */
  strength: number;
  mode: BrushMode;
  /** Skeleton bone index being painted. */
  bone: number;
}

export interface PaintContext {
  positions: ArrayLike<number>;
  skinIndex: { array: ArrayLike<number> & { [i: number]: number } };
  skinWeight: { array: ArrayLike<number> & { [i: number]: number } };
  /** Welded vertex ids and neighbor lists, for smoothing. */
  weld: { ids: Uint32Array; count: number };
  adjacency: { offsets: Int32Array; neighbors: Int32Array };
  boneCount: number;
}

/** Precomputes what painting needs (weld map, surface adjacency). */
export function createPaintContext(geometry: BufferGeometry, boneCount: number): PaintContext {
  const positions = geometry.attributes.position.array as ArrayLike<number>;
  const weld = weldByPosition(positions);
  const index = geometry.index ? (geometry.index.array as ArrayLike<number>) : Array.from({ length: positions.length / 3 }, (_, i) => i);
  const sets: Array<Set<number>> = Array.from({ length: weld.count }, () => new Set<number>());
  for (let t = 0; t + 2 < index.length; t += 3) {
    const a = weld.ids[index[t]], b = weld.ids[index[t + 1]], c = weld.ids[index[t + 2]];
    if (a !== b) { sets[a].add(b); sets[b].add(a); }
    if (b !== c) { sets[b].add(c); sets[c].add(b); }
    if (a !== c) { sets[a].add(c); sets[c].add(a); }
  }
  const offsets = new Int32Array(weld.count + 1);
  for (let w = 0; w < weld.count; w++) offsets[w + 1] = offsets[w] + sets[w].size;
  const neighbors = new Int32Array(offsets[weld.count]);
  for (let w = 0; w < weld.count; w++) {
    let j = offsets[w];
    for (const n of sets[w]) neighbors[j++] = n;
  }
  return {
    positions,
    skinIndex: geometry.attributes.skinIndex as any,
    skinWeight: geometry.attributes.skinWeight as any,
    weld,
    adjacency: { offsets, neighbors },
    boneCount,
  };
}

/** Reads a vertex's influences as a sparse map bone -> weight. */
function read(ctx: PaintContext, v: number): Map<number, number> {
  const m = new Map<number, number>();
  for (let k = 0; k < 4; k++) {
    const w = ctx.skinWeight.array[v * 4 + k];
    if (w > 0) m.set(ctx.skinIndex.array[v * 4 + k], (m.get(ctx.skinIndex.array[v * 4 + k]) ?? 0) + w);
  }
  return m;
}

/** Writes the 4 strongest influences back, normalized. */
function write(ctx: PaintContext, v: number, m: Map<number, number>): void {
  const top = [...m.entries()].filter(([, w]) => w > 1e-4).sort((a, b) => b[1] - a[1]).slice(0, 4);
  const sum = top.reduce((s, [, w]) => s + w, 0) || 1;
  for (let k = 0; k < 4; k++) {
    const e = top[k];
    ctx.skinIndex.array[v * 4 + k] = e ? e[0] : 0;
    ctx.skinWeight.array[v * 4 + k] = e ? e[1] / sum : 0;
  }
  if (!top.length) ctx.skinWeight.array[v * 4] = 1;
}

/**
 * Applies one brush dab. Add pushes the bone's weight toward 1 and scales the
 * others down; subtract hands the bone's weight to the other influences;
 * smooth blends each vertex toward its neighbors. Returns the vertices changed.
 */
export function applyBrush(ctx: PaintContext, stroke: BrushStroke): number[] {
  const { positions } = ctx;
  const [cx, cy, cz] = stroke.center;
  const r2 = stroke.radius * stroke.radius;
  const touched: number[] = [];
  const falloff: number[] = [];
  const n = positions.length / 3;
  for (let v = 0; v < n; v++) {
    const dx = positions[v * 3] - cx, dy = positions[v * 3 + 1] - cy, dz = positions[v * 3 + 2] - cz;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 > r2) continue;
    const t = Math.sqrt(d2) / stroke.radius;
    touched.push(v);
    falloff.push(1 - t * t * (3 - 2 * t)); // smoothstep falloff
  }
  if (!touched.length) return touched;

  if (stroke.mode === 'smooth') {
    // Average over welded neighbors, computed from a snapshot so the order doesn't matter.
    const rep = new Map<number, number>();
    for (let v = 0; v < n; v++) if (!rep.has(ctx.weld.ids[v])) rep.set(ctx.weld.ids[v], v);
    const results = touched.map((v, i) => {
      const w = ctx.weld.ids[v];
      const acc = new Map<number, number>();
      const s0 = ctx.adjacency.offsets[w], s1 = ctx.adjacency.offsets[w + 1];
      for (let j = s0; j < s1; j++) {
        for (const [b, x] of read(ctx, rep.get(ctx.adjacency.neighbors[j])!)) acc.set(b, (acc.get(b) ?? 0) + x / (s1 - s0));
      }
      const self = read(ctx, v);
      const a = Math.min(1, stroke.strength * falloff[i]);
      const out = new Map<number, number>();
      for (const b of new Set([...self.keys(), ...acc.keys()])) out.set(b, (self.get(b) ?? 0) * (1 - a) + (acc.get(b) ?? 0) * a);
      return out;
    });
    touched.forEach((v, i) => write(ctx, v, results[i]));
    return touched;
  }

  touched.forEach((v, i) => {
    const m = read(ctx, v);
    const a = Math.min(1, stroke.strength * falloff[i]);
    const cur = m.get(stroke.bone) ?? 0;
    const next = stroke.mode === 'add' ? cur + (1 - cur) * a : cur * (1 - a);
    const othersSum = [...m.entries()].reduce((s, [b, w]) => (b === stroke.bone ? s : s + w), 0);
    if (stroke.mode === 'subtract' && othersSum <= 1e-6) return; // nothing to hand the weight to
    const scale = othersSum > 0 ? (1 - next) / othersSum : 0;
    for (const [b, w] of m) if (b !== stroke.bone) m.set(b, w * scale);
    m.set(stroke.bone, next);
    write(ctx, v, m);
  });
  return touched;
}

/** Snapshot for undo. */
export function snapshotWeights(ctx: PaintContext): { index: Uint16Array; weight: Float32Array } {
  return { index: Uint16Array.from(ctx.skinIndex.array as ArrayLike<number>), weight: Float32Array.from(ctx.skinWeight.array as ArrayLike<number>) };
}

export function restoreWeights(ctx: PaintContext, snap: { index: Uint16Array; weight: Float32Array }): void {
  for (let i = 0; i < snap.index.length; i++) {
    ctx.skinIndex.array[i] = snap.index[i];
    ctx.skinWeight.array[i] = snap.weight[i];
  }
}
