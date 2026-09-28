import { describe, expect, it } from 'vitest';
import { BufferAttribute, BufferGeometry } from 'three';
import { applyBrush, createPaintContext, restoreWeights, snapshotWeights } from '../src/rig/paint';

/** A strip of vertices along X, weighted 50/50 to bones 0 and 1. */
function strip() {
  const n = 11;
  const pos = new Float32Array(n * 2 * 3);
  const idx: number[] = [];
  for (let i = 0; i < n; i++) {
    pos.set([i * 0.1, 0, 0], i * 6);
    pos.set([i * 0.1, 0.1, 0], i * 6 + 3);
    if (i < n - 1) idx.push(2 * i, 2 * i + 2, 2 * i + 1, 2 * i + 1, 2 * i + 2, 2 * i + 3);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.setIndex(idx);
  const si = new Uint16Array(n * 2 * 4), sw = new Float32Array(n * 2 * 4);
  for (let v = 0; v < n * 2; v++) {
    si.set([0, 1, 0, 0], v * 4);
    sw.set([0.5, 0.5, 0, 0], v * 4);
  }
  g.setAttribute('skinIndex', new BufferAttribute(si, 4));
  g.setAttribute('skinWeight', new BufferAttribute(sw, 4));
  return g;
}

const weightOf = (g: BufferGeometry, v: number, bone: number) => {
  let w = 0;
  for (let k = 0; k < 4; k++) if (g.attributes.skinIndex.array[v * 4 + k] === bone) w += g.attributes.skinWeight.array[v * 4 + k] as number;
  return w;
};
const sumOf = (g: BufferGeometry, v: number) => [0, 1, 2, 3].reduce((s, k) => s + (g.attributes.skinWeight.array[v * 4 + k] as number), 0);

describe('weight painting', () => {
  it('adds weight with falloff and keeps weights normalized', () => {
    const g = strip();
    const ctx = createPaintContext(g, 3);
    const touched = applyBrush(ctx, { center: [0, 0, 0], radius: 0.25, strength: 1, mode: 'add', bone: 0 });
    expect(touched.length).toBeGreaterThan(0);
    expect(weightOf(g, 0, 0)).toBeCloseTo(1, 5);
    expect(weightOf(g, 2, 0)).toBeGreaterThan(0.5);
    expect(weightOf(g, 2, 0)).toBeLessThan(1);
    expect(weightOf(g, 20, 0)).toBeCloseTo(0.5, 5);
    for (let v = 0; v < 22; v++) expect(sumOf(g, v)).toBeCloseTo(1, 5);
  });

  it('adds a bone that was not an influence yet', () => {
    const g = strip();
    const ctx = createPaintContext(g, 3);
    applyBrush(ctx, { center: [0.5, 0, 0], radius: 0.05, strength: 0.6, mode: 'add', bone: 2 });
    expect(weightOf(g, 10, 2)).toBeCloseTo(0.6, 5);
    expect(sumOf(g, 10)).toBeCloseTo(1, 5);
  });

  it('subtracts, smooths and undoes', () => {
    const g = strip();
    const ctx = createPaintContext(g, 3);
    const snap = snapshotWeights(ctx);
    applyBrush(ctx, { center: [1, 0, 0], radius: 0.05, strength: 1, mode: 'subtract', bone: 1 });
    expect(weightOf(g, 20, 1)).toBeCloseTo(0, 5);
    expect(weightOf(g, 20, 0)).toBeCloseTo(1, 5);
    applyBrush(ctx, { center: [1, 0, 0], radius: 0.05, strength: 1, mode: 'smooth', bone: 0 });
    expect(weightOf(g, 20, 1)).toBeGreaterThan(0.2);
    restoreWeights(ctx, snap);
    expect(weightOf(g, 20, 1)).toBeCloseTo(0.5, 5);
  });
});
