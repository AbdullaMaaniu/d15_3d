import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createClothSim, fitClothCapsules, type ClothFrame } from '../src/cloth/cloth';
import { CLOTH_MATERIALS, clothMaterial, guessClothMaterial, type ClothMaterial } from '../src/cloth/materials';
import { decodeReferenceBody } from '../src/body/reference';

/** A strip along +x sewn to a non-cloth row at x <= 0. */
function strip(length: number, res = 0.01, width = 0.03) {
  const nx = Math.round(length / res) + 2, nz = Math.round(width / res) + 1;
  const pos: number[] = [];
  for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) pos.push((i - 1) * res, 1, j * res);
  const index: number[] = [], mat: number[] = [];
  for (let i = 0; i < nx - 1; i++)
    for (let j = 0; j < nz - 1; j++) {
      const a = i * nz + j, b = a + nz, c = a + 1, d = b + 1;
      index.push(a, b, c, c, b, d);
      mat.push(i === 0 ? -1 : 0, i === 0 ? -1 : 0);
    }
  return { positions: Float32Array.from(pos), index: Uint32Array.from(index), triangleMaterial: Int16Array.from(mat) };
}

function restFrame(sim: { count: number; vertexOf: Uint32Array }, positions: Float32Array): ClothFrame {
  const targets = new Float32Array(sim.count * 3);
  for (let p = 0; p < sim.count; p++) for (let k = 0; k < 3; k++) targets[p * 3 + k] = positions[sim.vertexOf[p] * 3 + k];
  return { targets };
}

async function droop(m: ClothMaterial): Promise<number> {
  const s = strip(0.12);
  const sim = await createClothSim({ ...s, materials: [m], freedom: 100 });
  const frame = restFrame(sim, s.positions);
  for (let f = 0; f < 180; f++) sim.step(1 / 60, frame);
  let y = 0, n = 0;
  for (let p = 0; p < sim.count; p++)
    if (s.positions[sim.vertexOf[p] * 3] > 0.119) {
      y += sim.positions[p * 3 + 1];
      n++;
    }
  return 1 - y / n;
}

describe('cloth', () => {
  it('drapes by fabric: stiff leather holds out, silk hangs', async () => {
    const silk = await droop(clothMaterial('silk')!);
    const cotton = await droop(clothMaterial('cotton')!);
    const leather = await droop(clothMaterial('leather')!);
    expect(silk).toBeGreaterThan(cotton);
    expect(cotton).toBeGreaterThan(leather);
    // Never longer than the strip (no stretching), and leather still bends a little.
    expect(silk).toBeLessThan(0.125);
    expect(leather).toBeGreaterThan(0.002);
  });

  it('keeps the sewn edge on the skin and stays finite through cuts', async () => {
    const s = strip(0.1);
    const sim = await createClothSim({ ...s, materials: [clothMaterial('denim')!] });
    expect(sim.pinned.some((p) => p)).toBe(true);
    const frame = restFrame(sim, s.positions);
    expect(sim.step(1 / 60, frame)).toBe(false); // first frame starts from the skin
    for (let f = 0; f < 30; f++) {
      // Shake it, then jump it a metre (a cut): it resets instead of exploding.
      const shift = f === 20 ? 1 : Math.sin(f) * 0.05;
      const moved = { targets: frame.targets.map((v, i) => (i % 3 === 0 ? v + shift : v)) };
      sim.step(1 / 60, moved);
      for (let p = 0; p < sim.count; p++) {
        if (sim.pinned[p]) expect(Math.abs(sim.positions[p * 3] - moved.targets[p * 3])).toBeLessThan(1e-5);
      }
    }
    expect(sim.positions.every(Number.isFinite)).toBe(true);
    // The first frame, the jump there and the jump back.
    expect(sim.stats.resets).toBe(3);
  });

  it('follows a cage on fine meshes and keeps cloth out of capsules', async () => {
    // A 40x40 cm sheet hanging in front of a vertical capsule, its top row sewn on.
    const res = 0.005, N = 81;
    const pos: number[] = [];
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) pos.push(-0.2 + i * res, 1.2 - j * res, 0.08);
    const index: number[] = [], mat: number[] = [];
    for (let i = 0; i < N - 1; i++)
      for (let j = 0; j < N - 1; j++) {
        const a = i * N + j, b = a + N, c = a + 1, d = b + 1;
        index.push(a, c, b, b, c, d);
        mat.push(j === 0 ? -1 : 0, j === 0 ? -1 : 0);
      }
    const positions = Float32Array.from(pos);
    const capsule = { a: [0, 0.8, 0] as [number, number, number], b: [0, 1.15, 0] as [number, number, number], ra: 0.05, rb: 0.05 };
    const sim = await createClothSim({ positions, index: Uint32Array.from(index), triangleMaterial: Int16Array.from(mat), materials: [clothMaterial('cotton')!], capsules: [capsule], particleBudget: 600, freedom: 3 });
    expect(sim.cageCount).toBeLessThan(sim.count / 3);
    const frame = restFrame(sim, positions);
    // Push the capsule forward through where the sheet hangs.
    for (let f = 0; f < 60; f++) {
      const z = Math.min(0.12, f * 0.004);
      sim.step(1 / 60, { ...frame, capsules: Float32Array.of(0, 0.8, z, 0, 1.15, z, 0.05, 0.05) });
    }
    let inside = 0;
    for (let p = 0; p < sim.count; p++) {
      const x = sim.positions[p * 3], y = sim.positions[p * 3 + 1], z = sim.positions[p * 3 + 2];
      if (y > 0.82 && y < 1.13 && Math.hypot(x, z - 0.12) < 0.05 - 0.004) inside++;
    }
    expect(inside).toBe(0);
    expect(sim.positions.every(Number.isFinite)).toBe(true);
  });

  it('fits capsules to the limbs and torso of the reference body', () => {
    const ref = decodeReferenceBody(readFileSync(new URL('../assets/reference-body.bin', import.meta.url)));
    const caps = fitClothCapsules(ref, ref.joints.joints);
    const names = caps.map((c) => c.from);
    expect(names).toEqual(expect.arrayContaining(['leftUpperLeg', 'rightLowerLeg', 'leftUpperArm', 'rightLowerArm', 'hips', 'chest']));
    const thigh = caps.find((c) => c.from === 'leftUpperLeg')!;
    expect(thigh.ra).toBeGreaterThan(0.06);
    expect(thigh.ra).toBeLessThan(0.13);
    const forearm = caps.find((c) => c.from === 'leftLowerArm')!;
    expect(forearm.rb).toBeLessThan(thigh.rb);
  });

  it('guesses fabrics from part names and orders presets by weight', () => {
    expect(guessClothMaterial('Skin')).toBe(null);
    expect(guessClothMaterial('Hair')).toBe(null);
    expect(guessClothMaterial('Top')).toBe('cotton');
    expect(guessClothMaterial('Bottoms')).toBe('denim');
    expect(guessClothMaterial('Leather jacket')).toBe('leather');
    expect(guessClothMaterial('Part 3')).toBe(null);
    const d = CLOTH_MATERIALS.map((m) => m.density);
    expect([...d].sort((a, b) => a - b)).toEqual(d);
  });
});
