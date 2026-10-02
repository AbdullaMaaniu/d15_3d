import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createMannequin } from '../src/mesh/mannequin';
import { clothesGirth, decodeReferenceBody, encodeReferenceBody, fitReferenceBody } from '../src/body/reference';
import { voxelizeTS as voxelize } from '../src/voxel/voxelize';
import { humanJoints } from '../src/body/proportions';

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

  it('fitted to its own skeleton, only takes the average build', () => {
    const body = fitReferenceBody(ref, ref.joints);
    const J = ref.joints.joints;
    let worst = 0, head = 0;
    for (let v = 0; v < body.positions.length / 3; v++) {
      const d = Math.hypot(...[0, 1, 2].map((i) => body.positions[v * 3 + i] - ref.positions[v * 3 + i]));
      worst = Math.max(worst, d);
      // The head is left as it is (the fuller neck reaches a few millimetres into it).
      if (ref.positions[v * 3 + 1] > J.head[1] + 0.03) head = Math.max(head, d);
    }
    expect(worst).toBeGreaterThan(0.01); // a fuller waist
    expect(worst).toBeLessThan(0.06);
    expect(head).toBeLessThan(0.005);
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

  it('gives a stylised rig an average human skeleton in its own pose', () => {
    const { truth } = createMannequin({ pose: 'A' });
    const human = humanJoints(ref.joints, truth);
    const R = ref.joints.joints, H = human.joints, T = truth.joints;
    const dist = (m: Record<string, number[]>, a: string, b: string) => Math.hypot(...[0, 1, 2].map((i) => m[b][i] - m[a][i]));
    const stand = (m: Record<string, number[]>) => m.head[1] - (m.leftFoot[1] + m.rightFoot[1]) / 2;
    const size = stand(T) / stand(R);
    expect(stand(H)).toBeCloseTo(stand(T), 1);
    for (const [a, b] of [['leftUpperLeg', 'leftLowerLeg'], ['leftLowerLeg', 'leftFoot'], ['leftUpperArm', 'leftLowerArm'], ['leftLowerArm', 'leftHand'], ['hips', 'leftUpperLeg']]) {
      // Human lengths at the rig's height...
      expect(dist(H, a, b)).toBeCloseTo(dist(R, a, b) * size, 4);
      // ...along the rig's own bones, so its animation copies across.
      const d = [0, 1, 2].map((i) => (H[b][i] - H[a][i]) / dist(H, a, b)), t = [0, 1, 2].map((i) => (T[b][i] - T[a][i]) / dist(T, a, b));
      expect(d[0] * t[0] + d[1] * t[1] + d[2] * t[2]).toBeGreaterThan(0.9999);
    }
    // Standing on the rig's ground.
    const low = (m: { joints: Record<string, number[]>; tails: Record<string, number[]> }) => Math.min(...[...Object.values(m.joints), ...Object.values(m.tails)].map((p) => p[1]));
    expect(low(human)).toBeCloseTo(low(truth), 4);
  });

  it('thins each part to fit inside clothes, but no thinner than a slim adult', () => {
    const parts = ['hips', 'spine', 'chest', 'upperChest', 'leftUpperArm', 'leftLowerArm', 'leftUpperLeg', 'leftLowerLeg'];
    const solidOf = (girth: Record<string, number>) => {
      const b = fitReferenceBody(ref, ref.joints, {}, { girth });
      return voxelize({ positions: b.positions, index: b.index, dx: 1.8 / 300 });
    };
    // Clothes that fit the body as it is: nothing to do.
    expect(clothesGirth(ref, ref.joints, solidOf({}))).toEqual({});
    // Clothes 8% tighter all round: each part thins to about that.
    const tight = clothesGirth(ref, ref.joints, solidOf(Object.fromEntries(parts.map((b) => [b, 0.92]))));
    for (const b of parts) {
      expect(tight[b]).toBeGreaterThan(0.86);
      expect(tight[b]).toBeLessThan(0.96);
    }
    // A stick-thin mannequin: every part stops at a slim adult's girth.
    const { geometry, truth } = createMannequin({ pose: 'A', detail: 16 });
    const human = humanJoints(ref.joints, truth);
    const thin = clothesGirth(ref, human, voxelize({ positions: geometry.getAttribute('position').array as Float32Array, index: Uint32Array.from(geometry.index!.array), dx: 1.8 / 200 }));
    expect(thin.spine).toBeCloseTo(0.82, 3);
    expect(thin.chest).toBeCloseTo(0.87, 3);
    expect(thin.leftUpperLeg).toBeCloseTo(0.85, 3);
  });
});
