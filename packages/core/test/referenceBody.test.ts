import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createMannequin } from '../src/mesh/mannequin';
import { decodeReferenceBody, encodeReferenceBody, fitReferenceBody, insideSlim } from '../src/body/reference';
import { tsKernels } from '../src/kernels';

const ref = decodeReferenceBody(readFileSync(new URL('../assets/reference-body.bin', import.meta.url)));

const bounds = (p: Float32Array) => {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i++) {
    lo[i % 3] = Math.min(lo[i % 3], p[i]);
    hi[i % 3] = Math.max(hi[i % 3], p[i]);
  }
  return { lo, hi };
};

describe('reference body', () => {
  it('is a rigged 1.80 m human standing on the ground', () => {
    const { lo, hi } = bounds(ref.positions);
    expect(lo[1]).toBeCloseTo(0, 3);
    expect(hi[1]).toBeCloseTo(1.8, 2);
    expect(ref.index.length / 3).toBeGreaterThan(20000);
    for (const b of ['hips', 'head', 'leftUpperArm', 'rightLowerLeg', 'leftFoot']) expect(ref.joints.joints[b]).toBeDefined();
    // Round-trips through its file format.
    const again = decodeReferenceBody(encodeReferenceBody(ref));
    expect(again.positions).toEqual(ref.positions);
    expect(again.index).toEqual(ref.index);
    expect(again.bones).toEqual(ref.bones);
  });

  it('fitted to its own skeleton, stays as it is', () => {
    const body = fitReferenceBody(ref, ref.joints);
    let worst = 0;
    for (let i = 0; i < body.positions.length; i++) worst = Math.max(worst, Math.abs(body.positions[i] - ref.positions[i]));
    expect(worst).toBeLessThan(1e-4);
  });

  it("takes another rig's proportions and stays weighted to it", () => {
    const { truth } = createMannequin({ pose: 'T' });
    const body = fitReferenceBody(ref, truth);
    const { lo, hi } = bounds(body.positions);
    // T-pose: the arms reach out to the hands, the head keeps human proportions above its joint, the feet reach the ground.
    expect(hi[0]).toBeGreaterThan(truth.joints.leftHand[0]);
    expect(lo[0]).toBeLessThan(truth.joints.rightHand[0]);
    expect(hi[1]).toBeGreaterThan(truth.joints.head[1] + 0.1);
    expect(lo[1]).toBeLessThan(0.02);
    for (let v = 0; v < body.positions.length / 3; v++) {
      const s = body.skinWeight[v * 4] + body.skinWeight[v * 4 + 1] + body.skinWeight[v * 4 + 2] + body.skinWeight[v * 4 + 3];
      expect(Math.abs(s - 1)).toBeLessThan(1e-3);
    }
    for (const b of ['hips', 'head', 'leftUpperArm', 'rightLowerLeg', 'leftFoot']) expect(body.bones).toContain(b);
    // Normals point outwards: at the top of the head, up.
    let top = 0;
    for (let v = 1; v < body.positions.length / 3; v++) if (body.positions[v * 3 + 1] > body.positions[top * 3 + 1]) top = v;
    expect(body.normals[top * 3 + 1]).toBeGreaterThan(0.5);
  });

  it('shape controls change only their area', () => {
    const base = fitReferenceBody(ref, ref.joints);
    const big = fitReferenceBody(ref, ref.joints, { biceps: 1.4 });
    const J = ref.joints.joints;
    const moved = (lo: number[], hi: number[]) => {
      let m = 0;
      for (let v = 0; v < base.positions.length / 3; v++) {
        const p = [0, 1, 2].map((i) => ref.positions[v * 3 + i]);
        if (p.some((x, i) => x < lo[i] || x > hi[i])) continue;
        m = Math.max(m, Math.hypot(...[0, 1, 2].map((i) => big.positions[v * 3 + i] - base.positions[v * 3 + i])));
      }
      return m;
    };
    const sh = J.leftUpperArm, el = J.leftLowerArm;
    const mid = [(sh[0] + el[0]) / 2, (sh[1] + el[1]) / 2, (sh[2] + el[2]) / 2];
    // The front of the left upper arm grows by centimetres; the legs don't move.
    expect(moved([mid[0] - 0.03, mid[1] - 0.03, mid[2]], [mid[0] + 0.03, mid[1] + 0.03, 1])).toBeGreaterThan(0.01);
    expect(moved([-1, 0, -1], [1, J.leftLowerLeg[1], 1])).toBeLessThan(1e-6);
  });

  it('slims to sit inside a thinner character, and not at all inside itself', () => {
    const self = tsKernels.voxelize({ positions: ref.positions, index: ref.index, dx: 1.8 / 200 });
    expect(insideSlim(ref, ref.joints, self)).toBe(1);

    const { geometry, truth } = createMannequin({ pose: 'A' });
    const pos = geometry.getAttribute('position').array as Float32Array;
    const solid = tsKernels.voxelize({ positions: pos, index: Uint32Array.from(geometry.index!.array), dx: 1.8 / 200 });
    const slim = insideSlim(ref, truth, solid);
    expect(slim).toBeLessThan(1);
    expect(slim).toBeGreaterThanOrEqual(0.85);
    // More of the body ends up inside the mannequin (hands and shoulders are bigger than its stubs).
    const insideShare = (b: { positions: Float32Array }) => {
      let n = 0;
      for (let v = 0; v < b.positions.length / 3; v++) {
        const [x, y, z] = [0, 1, 2].map((i) => Math.floor((b.positions[v * 3 + i] - solid.origin[i]) / solid.dx));
        if (x >= 0 && y >= 0 && z >= 0 && x < solid.nx && y < solid.ny && z < solid.nz && solid.data[x + solid.nx * (y + solid.ny * z)]) n++;
      }
      return n / (b.positions.length / 3);
    };
    const before = insideShare(fitReferenceBody(ref, truth));
    const after = insideShare(fitReferenceBody(ref, truth, {}, slim));
    console.log('inside the mannequin', before.toFixed(2), '->', after.toFixed(2));
    expect(after).toBeGreaterThan(before);
  });
});
