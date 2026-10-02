import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { clothesGirth, decodeReferenceBody, fitReferenceBody } from '../src/body/reference';
import { createClothedSample } from '../src/body/clothedSample';
import { coveredBodyTriangles, separateGarments, type GarmentPiece } from '../src/body/garments';
import { autoRegionsHumanoid, regionContext, triangleBones, type RegionSet } from '../src/rig/regions';
import { tsKernels } from '../src/kernels';

const ref = decodeReferenceBody(readFileSync(new URL('../assets/reference-body.bin', import.meta.url)));
const sample = createClothedSample(ref);
const T = sample.index.length / 3;
const ctx = regionContext({
  positions: sample.positions,
  index: sample.index,
  colors: sample.colors,
  materialOfTriangle: new Uint16Array(T),
  materials: [{ color: [1, 1, 1], texture: null, vertexColors: true }],
});
const regions = autoRegionsHumanoid(ctx, triangleBones(sample.index, sample.skinIndex, sample.skinWeight, ref.bones));
const source = { positions: sample.positions, normals: sample.normals, index: sample.index, skinIndex: sample.skinIndex, skinWeight: sample.skinWeight, bones: ref.bones, regions, joints: ref.joints };
const sep = separateGarments(source);
const piece = (name: string) => sep.pieces.find((p) => p.name === name)!;

/** Colour of a piece's triangle centre, from the source vertices it was cut from. */
function triangleColor(p: GarmentPiece, t: number): number[] {
  const c = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    const v = p.index[t * 3 + k];
    for (let s = 0; s < 3; s++) {
      const w = p.sourceWeight[v * 3 + s];
      for (let j = 0; j < 3; j++) c[j] += (sample.colors[p.source[v * 3 + s] * 3 + j] * w) / 3;
    }
  }
  return c;
}

describe('garment separation', () => {
  it('cuts a clothed character into its garments, keeping its head', () => {
    expect(regions.defs.map((d) => d.name)).toEqual(['Hair', 'Skin', 'Top', 'Bottoms', 'Shoes']);
    expect(sep.pieces.map((p) => `${p.name}:${p.kind}`)).toEqual(['Hair:hair', 'Top:garment', 'Bottoms:garment', 'Shoes:garment', 'Head:head']);
    expect(sep.notes).toEqual([]);
    // Openings: a T-shirt has a collar, a hem and two sleeves; trousers a waist and two legs; each shoe one.
    expect(piece('Top').openings.length).toBe(4);
    expect(piece('Bottoms').openings.length).toBe(3);
    expect(piece('Shoes').openings.length).toBe(2);
    expect(piece('Hair').openings.length).toBe(1);
  });

  it('covers the surface exactly: garments, head and skin add up, with no gaps where pieces meet', () => {
    let total = 0;
    for (let t = 0; t < T; t++) total += ctx.area[t];
    const pieces = sep.pieces.reduce((s, p) => s + p.area, 0);
    expect(Math.abs(pieces + sep.skinArea - total) / total).toBeLessThan(1e-4);
    // The shirt's hem and the trousers' waistband are the same loop.
    const loopLength = (p: GarmentPiece, loop: Uint32Array) => {
      let l = 0;
      for (let i = 0; i < loop.length; i++) {
        const a = loop[i], b = loop[(i + 1) % loop.length];
        l += Math.hypot(p.positions[a * 3] - p.positions[b * 3], p.positions[a * 3 + 1] - p.positions[b * 3 + 1], p.positions[a * 3 + 2] - p.positions[b * 3 + 2]);
      }
      return l;
    };
    const lowest = (p: GarmentPiece, which: 'top' | 'bottom') => {
      const ys = p.openings.map((o) => [...o].reduce((s, v) => s + p.positions[v * 3 + 1], 0) / o.length);
      const i = ys.indexOf(which === 'bottom' ? Math.min(...ys) : Math.max(...ys));
      return loopLength(p, p.openings[i]);
    };
    expect(lowest(piece('Top'), 'bottom')).toBeCloseTo(lowest(piece('Bottoms'), 'top'), 6);
  });

  it('leaves no skin in the garments', () => {
    const skin = regions.defs.findIndex((d) => d.name === 'Skin');
    const skinRgb = [0, 0, 0];
    let n = 0;
    for (let t = 0; t < T; t++) {
      if (regions.faces[t] !== skin) continue;
      for (let j = 0; j < 3; j++) skinRgb[j] += ctx.rgb[t * 3 + j];
      n++;
    }
    for (let j = 0; j < 3; j++) skinRgb[j] /= n;
    for (const name of ['Top', 'Bottoms', 'Shoes']) {
      const p = piece(name);
      let skinny = 0;
      for (let t = 0; t < p.index.length / 3; t++) {
        const c = triangleColor(p, t);
        if (Math.hypot(c[0] - skinRgb[0], c[1] - skinRgb[1], c[2] - skinRgb[2]) < 0.08) skinny++;
      }
      expect(skinny, name).toBe(0);
    }
  });

  it('keeps the skin weights, normalized', () => {
    for (const p of sep.pieces) {
      for (let v = 0; v < p.positions.length / 3; v++) {
        const s = p.skinWeight[v * 4] + p.skinWeight[v * 4 + 1] + p.skinWeight[v * 4 + 2] + p.skinWeight[v * 4 + 3];
        expect(Math.abs(s - 1)).toBeLessThan(1e-5);
      }
      // Garments follow their own body parts.
      expect(p.groups).toEqual([{ start: 0, count: p.index.length, materialIndex: 0 }]);
    }
    const top = piece('Top');
    const bones = new Set<string>();
    for (let v = 0; v < top.positions.length / 3; v++) bones.add(ref.bones[top.skinIndex[v * 4]]);
    expect(bones.has('chest')).toBe(true);
    expect(bones.has('leftHand')).toBe(false);
  });

  it('can leave the head to the body, and keeps everything when nothing is skin', () => {
    const noHead = separateGarments(source, { keepHead: false });
    expect(noHead.pieces.map((p) => p.name)).toEqual(['Hair', 'Top', 'Bottoms', 'Shoes']);
    expect(noHead.skinArea).toBeGreaterThan(sep.skinArea);

    const noSkin: RegionSet = { defs: regions.defs.map((d) => ({ ...d, name: d.name === 'Skin' ? 'Body' : d.name })), faces: regions.faces };
    const all = separateGarments({ ...source, regions: noSkin });
    expect(all.skinArea).toBe(0);
    expect(all.notes[0]).toMatch(/No part is named Skin/);
  });

  it('hides the body under the clothes but not at the openings', () => {
    const grid = tsKernels.voxelize({ positions: sample.positions, index: sample.index, dx: 1.8 / 200 });
    const body = fitReferenceBody(ref, ref.joints, {}, { girth: clothesGirth(ref, ref.joints, grid) });
    const hidden = coveredBodyTriangles(body, sep.pieces, { headCut: sep.headCut });
    let count = 0, bareHidden = 0, bare = 0;
    for (let t = 0; t < hidden.length; t++) {
      count += hidden[t];
      // Triangles on the hands and forearms are bare skin.
      const v = body.index[t * 3];
      const bone = body.bones[body.skinIndex[v * 4]];
      if (/Hand$|LowerArm$/.test(bone)) {
        bare++;
        bareHidden += hidden[t];
      }
    }
    expect(count / hidden.length).toBeGreaterThan(0.4);
    // The body's face is under the character's own head.
    expect(sep.headCut).not.toBeNull();
    let face = 0, faceHidden = 0;
    for (let t = 0; t < hidden.length; t++) {
      const v = body.index[t * 3];
      if (body.positions[v * 3 + 1] > 1.6 && body.positions[v * 3 + 2] > 0.05) {
        face++;
        faceHidden += hidden[t];
      }
    }
    expect(faceHidden).toBe(face);
    expect(bare).toBeGreaterThan(500);
    expect(bareHidden / bare).toBeLessThan(0.02);
  });
});
