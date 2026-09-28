import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createMannequin } from '../src/mesh/mannequin';
import { detectHumanoid } from '../src/rig/landmarks';
import { boneSegments, computeSkinWeights, computeSkinWeightsAsync } from '../src/rig/weights';
import { buildSkinnedCharacter } from '../src/rig/build';
import { humanoidDefs } from '../src/skeleton';
import { createWasmKernels, distancesFromSessions, tsKernels } from '../src/kernels';
import { MeshStandardMaterial, Vector3 } from 'three';

const wasmPath = fileURLToPath(new URL('../wasm/rigforge_kernels.wasm', import.meta.url));

describe('skin weights', async () => {
  const { geometry } = createMannequin({ pose: 'A', fingers: true });
  const positions = geometry.attributes.position.array as Float32Array;
  const index = new Uint32Array(geometry.index!.array);
  const detected = detectHumanoid(positions, index);
  const defs = humanoidDefs(true);
  const wasm = await createWasmKernels(readFileSync(wasmPath));

  it('wasm and ts kernels agree', () => {
    const grid1 = tsKernels.voxelize({ positions, index, dx: 0.02 });
    const grid2 = wasm.voxelize({ positions, index, dx: 0.02 });
    expect([grid2.nx, grid2.ny, grid2.nz]).toEqual([grid1.nx, grid1.ny, grid1.nz]);
    let diff = 0;
    for (let i = 0; i < grid1.data.length; i++) if (grid1.data[i] !== grid2.data[i]) diff++;
    expect(diff / grid1.data.length).toBeLessThan(0.001);
  });

  it('ts and wasm geodesic distances agree, and bone ranges split the work', () => {
    // dx = height / 192 is not representable in f32: the case that used to make the
    // TS kernel re-queue voxels forever.
    const dx = 1.8 / 192;
    const grid = wasm.voxelize({ positions, index, dx });
    const segments = boneSegments(defs, detected);
    const points = positions.slice(0, 3 * 800);
    const input = { grid, boneCount: defs.length, segments, points, maxDistance: 0.8 };
    const a = wasm.boneDistances(input);
    const b = tsKernels.boneDistances(input);
    let worst = 0;
    for (let i = 0; i < a.length; i++) {
      expect(Number.isFinite(a[i])).toBe(Number.isFinite(b[i]));
      if (Number.isFinite(a[i])) worst = Math.max(worst, Math.abs(a[i] - b[i]));
    }
    expect(worst).toBeLessThan(dx);
    const half = Math.floor(defs.length / 2);
    const lo = wasm.boneDistances({ ...input, bones: [0, half] });
    const hi = wasm.boneDistances({ ...input, bones: [half, defs.length] });
    for (let i = 0; i < a.length; i++) {
      const merged = i % defs.length < half ? lo[i] : hi[i];
      expect(merged).toBe(a[i]);
      expect(i % defs.length < half ? hi[i] : lo[i]).toBe(Infinity);
    }
  });

  it('parallel sessions give exactly the single-threaded weights', async () => {
    const sync = computeSkinWeights(positions, index, defs, detected, { kernels: wasm, resolution: 128 });
    let reported = 0;
    const par = await computeSkinWeightsAsync(positions, index, defs, detected, async (input, onBone) => {
      // Three "workers", each with its own session, pulling bones from one queue.
      const sessions = [0, 1, 2].map(() => wasm.geodesicSession(input));
      try {
        return await distancesFromSessions(input, sessions.map((s) => async (b: number) => s.bone(b)), (done) => { reported = done; onBone(done); });
      } finally {
        for (const s of sessions) s.free();
      }
    }, { kernels: wasm, resolution: 128 });
    expect(reported).toBe(defs.length);
    expect(Array.from(par.skinIndex)).toEqual(Array.from(sync.skinIndex));
    expect(Array.from(par.skinWeight)).toEqual(Array.from(sync.skinWeight));
  });

  it('binds vertices to the right bones', () => {
    const t0 = performance.now();
    const w = computeSkinWeights(positions, index, defs, detected, { kernels: wasm });
    if (process.env.RF_DEBUG) console.log('weights', Math.round(performance.now() - t0), 'ms', w.timings, 'fallback', w.fallbackVertices);
    const names = defs.map((d) => d.name);
    const dominant = (p: [number, number, number]) => {
      let best = -1, bestD = Infinity;
      for (let i = 0; i < positions.length / 3; i++) {
        const d = Math.hypot(positions[i * 3] - p[0], positions[i * 3 + 1] - p[1], positions[i * 3 + 2] - p[2]);
        if (d < bestD) { bestD = d; best = i; }
      }
      let bi = 0;
      for (let j = 1; j < 4; j++) if (w.skinWeight[best * 4 + j] > w.skinWeight[best * 4 + bi]) bi = j;
      return names[w.skinIndex[best * 4 + bi]];
    };
    const mid = (a: string, b: string): [number, number, number] => {
      const p = detected.joints[a], q = detected.joints[b];
      return [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2, (p[2] + q[2]) / 2];
    };
    expect(dominant(mid('leftLowerArm', 'leftHand'))).toBe('leftLowerArm');
    expect(dominant(mid('rightUpperArm', 'rightLowerArm'))).toBe('rightUpperArm');
    expect(dominant(mid('leftLowerLeg', 'leftFoot'))).toBe('leftLowerLeg');
    expect(dominant(detected.tails.head)).toBe('head');
    expect(dominant(detected.tails.leftMiddleDistal)).toBe('leftMiddleDistal');
    for (let i = 0; i < w.skinWeight.length; i += 4) {
      const s = w.skinWeight[i] + w.skinWeight[i + 1] + w.skinWeight[i + 2] + w.skinWeight[i + 3];
      expect(Math.abs(s - 1)).toBeLessThan(1e-4);
    }

    const character = buildSkinnedCharacter(geometry, new MeshStandardMaterial(), defs, detected, w.skinIndex, w.skinWeight);
    // Bending the elbow moves the hand but not the shoulder.
    const hand = new Vector3(), shoulder = new Vector3();
    character.bones.leftHand.getWorldPosition(hand);
    character.bones.leftLowerArm.rotation.z = 1.2;
    character.root.updateMatrixWorld(true);
    const hand2 = new Vector3();
    character.bones.leftHand.getWorldPosition(hand2);
    character.bones.leftUpperArm.getWorldPosition(shoulder);
    expect(hand.distanceTo(hand2)).toBeGreaterThan(0.1);
    expect(character.skeleton.bones.length).toBe(defs.length);
  });

  it('ts kernel produces the same dominant bones', () => {
    const a = computeSkinWeights(positions, index, defs, detected, { kernels: wasm, resolution: 96 });
    const b = computeSkinWeights(positions, index, defs, detected, { kernels: tsKernels, resolution: 96 });
    let same = 0;
    const n = positions.length / 3;
    for (let i = 0; i < n; i++) if (a.skinIndex[i * 4] === b.skinIndex[i * 4]) same++;
    expect(same / n).toBeGreaterThan(0.99);
  });
});
