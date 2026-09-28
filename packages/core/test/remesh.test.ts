import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createMannequin } from '../src/mesh/mannequin';
import { createWasmKernels } from '../src/kernels';
import { geometryToArrays, quadOutputToArrays, remeshTriangles, toOBJ, triangleCount } from '../src/mesh/remesh';

const wasmPath = fileURLToPath(new URL('../wasm/rigforge_kernels.wasm', import.meta.url));

describe('remeshing', async () => {
  const { geometry } = createMannequin({ pose: 'A', fingers: true });
  const src = geometryToArrays(geometry);
  const kernels = await createWasmKernels(readFileSync(wasmPath));

  it('triangles: hits the target down and up, keeping UVs', async () => {
    const down = await remeshTriangles(src, 3000);
    expect(Math.abs(triangleCount(down) - 3000)).toBeLessThan(150);
    const up = await remeshTriangles(src, triangleCount(src) * 3);
    expect(triangleCount(up) / (triangleCount(src) * 3)).toBeGreaterThan(0.95);
    for (const m of [down, up]) {
      for (let i = 0; i < m.index.length; i++) expect(m.index[i]).toBeLessThan(m.positions.length / 3);
      const uv = Array.from(m.uvs);
      expect(Math.min(...uv)).toBeGreaterThanOrEqual(Math.min(...Array.from(src.uvs)) - 1e-6);
      expect(Math.max(...uv)).toBeLessThanOrEqual(Math.max(...Array.from(src.uvs)) + 1e-6);
    }
  });

  it('quads: mostly quads near the target, UVs in range, texture baked', () => {
    // A two-colour texture split by v, so the bake has something to transfer.
    const tex = new Uint8Array([255, 0, 0, 255, 255, 0, 0, 255, 0, 0, 255, 255, 0, 0, 255, 255]);
    const out = kernels.quadRemesh!({
      positions: src.positions,
      index: src.index,
      targetFaces: 2000,
      resolution: 256,
      padding: 2,
      bake: {
        positions: src.positions, uvs: src.uvs, index: src.index,
        materialOfTriangle: new Uint32Array(src.index.length / 3),
        textures: [{ width: 2, height: 2, data: tex, flipY: false, repeat: false }],
        materials: [{ baseTexture: 0, baseColor: [1, 1, 1, 1], mrTexture: -1, metalness: 0, roughness: 1, emissiveTexture: -1, emissive: [0, 0, 0] }],
        metallicRoughness: true, emissive: false,
      },
    });
    const faces = out.sizes.length;
    const quads = out.sizes.filter((s) => s === 4).length;
    expect(Math.abs(faces / 2000 - 1)).toBeLessThan(0.2);
    expect(quads / faces).toBeGreaterThan(0.8);
    expect(out.charts).toBeGreaterThan(0);
    for (const u of out.uvs) expect(u >= 0 && u <= 1).toBe(true);
    expect(out.baked!.base.length).toBe(256 * 256 * 4);
    expect(out.baked!.metallicRoughness!.length).toBe(256 * 256 * 4);
    expect(out.baked!.covered).toBeGreaterThan(256 * 256 * 0.3);

    const mesh = quadOutputToArrays(out);
    expect(mesh.index.length / 3).toBe(quads * 2 + (faces - quads));
    const obj = toOBJ(mesh);
    const faceLines = obj.split('\n').filter((l) => l.startsWith('f '));
    expect(faceLines.length).toBe(faces);
    expect(faceLines.filter((l) => l.split(' ').length === 5).length).toBe(quads);
    // Positions are welded across UV seams in the OBJ.
    expect(obj.split('\n').filter((l) => l.startsWith('v ')).length).toBe(out.positions.length / 3);
  });
});
