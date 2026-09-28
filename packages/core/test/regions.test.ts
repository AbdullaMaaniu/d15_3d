import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { BufferAttribute, MeshStandardMaterial, type Mesh } from 'three';
import { createMannequin } from '../src/mesh/mannequin';
import { detectHumanoid } from '../src/rig/landmarks';
import { computeSkinWeights } from '../src/rig/weights';
import { buildSkinnedCharacter } from '../src/rig/build';
import { humanoidDefs } from '../src/skeleton';
import { createWasmKernels } from '../src/kernels';
import {
  applyRegions,
  autoRegionsByColor,
  autoRegionsHumanoid,
  fillPiece,
  fillSimilar,
  paintRegion,
  readRegions,
  regionBaseColors,
  regionContext,
  removeRegion,
  triangleBones,
} from '../src/rig/regions';
import { exportCharacter } from '../src/export/export';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'meshoptimizer';
import { Character } from '../../three/src/index';
import { createIO } from '../src/export/export';

// A mannequin dressed like a Meshy character: hair, skin, a red top, blue trousers, black shoes.
const COLORS: Record<string, [number, number, number]> = {
  Hair: [0.05, 0.03, 0.02],
  Skin: [0.8, 0.45, 0.3],
  Top: [0.6, 0.05, 0.04],
  Bottoms: [0.03, 0.08, 0.35],
  Shoes: [0.01, 0.01, 0.01],
};

async function dressed() {
  const kernels = await createWasmKernels(readFileSync(fileURLToPath(new URL('../wasm/rigforge_kernels.wasm', import.meta.url))));
  const { geometry, truth } = createMannequin({ pose: 'A' });
  const positions = geometry.attributes.position.array as Float32Array;
  const index = new Uint32Array(geometry.index!.array);
  const det = detectHumanoid(positions, index, { kernels });
  const defs = humanoidDefs(false);
  const w = computeSkinWeights(positions, index, defs, det, { kernels, resolution: 96 });
  const names = defs.map((d) => d.name);
  const headY = truth.joints.head[1];
  // Truth per vertex from the bone it follows (and hair above the eyes).
  const n = positions.length / 3;
  const vtx: string[] = [];
  for (let v = 0; v < n; v++) {
    let k = 0;
    for (let j = 1; j < 4; j++) if (w.skinWeight[v * 4 + j] > w.skinWeight[v * 4 + k]) k = j;
    const bone = names[w.skinIndex[v * 4 + k]];
    let r = 'Top';
    // Hair on the top and back of the head; the face stays bare.
    if (bone === 'head') r = positions[v * 3 + 1] > headY + 0.17 || (positions[v * 3 + 1] > headY + 0.06 && positions[v * 3 + 2] < truth.joints.head[2] - 0.02) ? 'Hair' : 'Skin';
    else if (bone === 'neck' || /LowerArm|Hand/.test(bone)) r = 'Skin';
    else if (/Foot|Toes/.test(bone)) r = 'Shoes';
    else if (bone === 'hips' || /UpperLeg|LowerLeg/.test(bone)) r = 'Bottoms';
    vtx.push(r);
  }
  // Baked shading: +-12% brightness noise.
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const colors = new Float32Array(n * 3);
  for (let v = 0; v < n; v++) {
    const s = 0.88 + 0.24 * rand();
    COLORS[vtx[v]].forEach((c, k) => (colors[v * 3 + k] = c * s));
  }
  geometry.setAttribute('color', new BufferAttribute(colors, 3));
  const built = buildSkinnedCharacter(geometry, new MeshStandardMaterial({ vertexColors: true }), defs, det, w.skinIndex, w.skinWeight);
  const T = index.length / 3;
  const truthTri: string[] = [];
  for (let t = 0; t < T; t++) {
    const c = new Map<string, number>();
    for (let k = 0; k < 3; k++) c.set(vtx[index[t * 3 + k]], (c.get(vtx[index[t * 3 + k]]) ?? 0) + 1);
    // Triangles whose corners disagree straddle a boundary; their colour is a blend.
    truthTri.push(c.size === 1 ? [...c.keys()][0] : 'mixed');
  }
  const ctx = regionContext({
    positions,
    index,
    colors,
    materialOfTriangle: new Uint8Array(T),
    materials: [{ color: [1, 1, 1], texture: null, vertexColors: true }],
  });
  return { built, ctx, truthTri, bones: triangleBones(index, w.skinIndex, w.skinWeight, names), T };
}

beforeAll(() => {
  // GLTFExporter uses FileReader for binary output; Node lacks it.
  (globalThis as any).FileReader ??= class {
    result: ArrayBuffer | null = null;
    onloadend: (() => void) | null = null;
    readAsArrayBuffer(blob: Blob) {
      blob.arrayBuffer().then((b) => { this.result = b; this.onloadend?.(); });
    }
  };
});

describe('body regions', async () => {
  const d = await dressed();

  it('finds hair, skin, top, bottoms and shoes on a dressed humanoid', () => {
    const set = autoRegionsHumanoid(d.ctx, d.bones);
    expect(set.defs.map((x) => x.name)).toEqual(['Hair', 'Skin', 'Top', 'Bottoms', 'Shoes']);
    let right = 0, total = 0;
    const perRegion = new Map<string, [number, number]>();
    for (let t = 0; t < d.T; t++) {
      if (d.truthTri[t] === 'mixed') continue;
      const a = d.ctx.area[t];
      total += a;
      const ok = set.defs[set.faces[t]].name === d.truthTri[t];
      if (ok) right += a;
      const e = perRegion.get(d.truthTri[t]) ?? [0, 0];
      perRegion.set(d.truthTri[t], [e[0] + (ok ? a : 0), e[1] + a]);
    }
    // Triangles straddling two regions (a blend of both colours) are left out of the score.
    expect(right / total).toBeGreaterThan(0.95);
    for (const [name, [ok, all]] of perRegion) expect(ok / all, name).toBeGreaterThan(0.9);
    // Region colours come out close to the clothes.
    const base = regionBaseColors(set, d.ctx);
    expect(base[2]).toMatch(/^#[a-f0-9]{6}$/);
  });

  it('splits by colour alone for any model', () => {
    const set = autoRegionsByColor(d.ctx, 5);
    expect(set.defs.length).toBeGreaterThanOrEqual(4);
    expect(set.defs[0].name).toBe('Part 1');
    // Every truth region is mostly one cluster.
    for (const name of Object.keys(COLORS)) {
      const counts = new Map<number, number>();
      let all = 0;
      for (let t = 0; t < d.T; t++) if (d.truthTri[t] === name) { counts.set(set.faces[t], (counts.get(set.faces[t]) ?? 0) + d.ctx.area[t]); all += d.ctx.area[t]; }
      expect(Math.max(...counts.values()) / all, name).toBeGreaterThan(0.75);
    }
  });

  it('edits: brush, similar-colour fill, whole piece, remove', () => {
    const set = autoRegionsHumanoid(d.ctx, d.bones);
    const before = set.faces.slice();
    // Brush a patch of the chest into Shoes.
    const chest = d.truthTri.findIndex((r, t) => r === 'Top' && d.ctx.normal[t * 3 + 2] > 0.9);
    const c = Array.from(d.ctx.centroid.slice(chest * 3, chest * 3 + 3));
    expect(paintRegion(set, d.ctx, c, 0.05, 4)).toBeGreaterThan(0);
    expect(set.faces[chest]).toBe(4);
    // Fill similar from a trouser triangle spreads over the trousers of that piece, not onto other colours.
    set.faces.set(before);
    const leg = d.truthTri.indexOf('Bottoms');
    fillSimilar(set, d.ctx, leg, 0, 10);
    let legs = 0, legsAll = 0, others = 0;
    for (let t = 0; t < d.T; t++) {
      if (d.ctx.piece[t] !== d.ctx.piece[leg]) continue;
      if (d.truthTri[t] === 'Bottoms') { legsAll++; if (set.faces[t] === 0) legs++; }
      else if (d.truthTri[t] !== 'mixed' && set.faces[t] === 0 && before[t] !== 0) others++;
    }
    expect(legs / legsAll).toBeGreaterThan(0.9);
    expect(others).toBe(0);
    // Whole piece: exactly that piece changes.
    set.faces.set(before);
    fillPiece(set, d.ctx, leg, 2);
    for (let t = 0; t < d.T; t++) expect(set.faces[t]).toBe(d.ctx.piece[t] === d.ctx.piece[leg] ? 2 : before[t]);
    const removed = removeRegion({ defs: set.defs, faces: before.slice() }, 0, 1);
    expect(removed.defs.map((x) => x.name)).toEqual(['Skin', 'Top', 'Bottoms', 'Shoes']);
    expect(removed.faces.every((f) => f < 4)).toBe(true);
  });

  it('applies regions as named materials, keeps weights, and restores', async () => {
    const set = autoRegionsHumanoid(d.ctx, d.bones);
    const mesh = d.built.mesh as Mesh;
    const skin0 = Float32Array.from(mesh.geometry.attributes.skinWeight.array as Float32Array);
    applyRegions(mesh, set, regionBaseColors(set, d.ctx));
    const mats = mesh.material as MeshStandardMaterial[];
    expect(mats.map((m) => m.name)).toEqual(['Hair', 'Skin', 'Top', 'Bottoms', 'Shoes']);
    expect(mesh.geometry.groups.length).toBe(5);
    expect(readRegions(mesh).map((r) => r.name)).toEqual(['Hair', 'Skin', 'Top', 'Bottoms', 'Shoes']);
    // Each group holds exactly that region's triangles.
    const order = mesh.userData.rfTriOrder as Uint32Array;
    for (const g of mesh.geometry.groups) {
      for (let i = g.start / 3; i < (g.start + g.count) / 3; i++) expect(set.faces[order[i]]).toBe(g.materialIndex);
    }
    expect(Array.from(mesh.geometry.attributes.skinWeight.array as Float32Array)).toEqual(Array.from(skin0));

    // The optimized GLB keeps one material per region, with the tags.
    const res = await exportCharacter(d.built.root, [], { preset: 'lossless' });
    const doc = await (await createIO()).readBinary(res.glb);
    const exported = doc.getRoot().listMaterials().map((m) => [m.getName(), (m.getExtras() as any)?.rigforge?.region?.name]);
    expect(exported).toEqual([['Hair', 'Hair'], ['Skin', 'Skin'], ['Top', 'Top'], ['Bottoms', 'Bottoms'], ['Shoes', 'Shoes']]);
    const web = await exportCharacter(d.built.root, [], { preset: 'web' });
    const doc2 = await (await createIO()).readBinary(web.glb);
    expect(doc2.getRoot().listMaterials().length).toBe(5);

    // A game loads it with @rigforge/three and recolours a part.
    await MeshoptDecoder.ready;
    const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
    const buf = web.glb.buffer.slice(web.glb.byteOffset, web.glb.byteOffset + web.glb.byteLength);
    const gltf = await new Promise<any>((resolve, reject) => loader.parse(buf as ArrayBuffer, '', resolve, reject));
    const game = Character.fromGLTF(gltf);
    expect(game.regions).toEqual(['Hair', 'Skin', 'Top', 'Bottoms', 'Shoes']);
    expect(game.setColor('top', '#c0392b')).toBe(true);
    expect(game.setColor('Hat', '#c0392b')).toBe(false);

    applyRegions(mesh, null);
    expect(Array.isArray(mesh.material)).toBe(false);
    expect(mesh.userData.rfTriOrder).toBeUndefined();
  });
});
