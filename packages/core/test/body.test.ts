import { describe, expect, it } from 'vitest';
import { createMannequin } from '../src/mesh/mannequin';
import { generateBody } from '../src/body/generate';

describe('generated body', () => {
  const { truth } = createMannequin({ pose: 'T' });

  it('builds a closed, outward-facing, weighted body from the joints', () => {
    const t0 = performance.now();
    const body = generateBody(truth);
    const ms = performance.now() - t0;
    console.log('body', body.positions.length / 3, 'verts', body.index.length / 3, 'tris', ms.toFixed(0), 'ms');
    expect(body.index.length / 3).toBeGreaterThan(5000);
    // Closed surface: every edge is shared by exactly two triangles.
    const edges = new Map<string, number>();
    for (let t = 0; t < body.index.length; t += 3) {
      for (let e = 0; e < 3; e++) {
        const a = body.index[t + e], b = body.index[t + ((e + 1) % 3)];
        const k = a < b ? `${a},${b}` : `${b},${a}`;
        edges.set(k, (edges.get(k) ?? 0) + 1);
      }
    }
    const open = [...edges.values()].filter((n) => n !== 2).length;
    expect(open / edges.size).toBeLessThan(0.002);
    // Weights sum to one and cover the limbs.
    for (let v = 0; v < body.positions.length / 3; v++) {
      const s = body.skinWeight[v * 4] + body.skinWeight[v * 4 + 1] + body.skinWeight[v * 4 + 2] + body.skinWeight[v * 4 + 3];
      expect(Math.abs(s - 1)).toBeLessThan(1e-4);
    }
    for (const b of ['hips', 'head', 'leftUpperArm', 'rightLowerLeg', 'leftFoot']) expect(body.bones).toContain(b);
    // The body reaches the hands and feet and the top of the head.
    let minY = Infinity, maxY = -Infinity, maxX = -Infinity;
    for (let v = 0; v < body.positions.length / 3; v++) {
      minY = Math.min(minY, body.positions[v * 3 + 1]);
      maxY = Math.max(maxY, body.positions[v * 3 + 1]);
      maxX = Math.max(maxX, body.positions[v * 3]);
    }
    expect(maxX).toBeGreaterThan(truth.joints.leftHand[0]);
    expect(minY).toBeLessThan(truth.joints.leftFoot[1]);
    expect(maxY).toBeGreaterThan(truth.joints.head[1]);
    // The head ends at the top of the head, not above it.
    expect(maxY).toBeLessThan(truth.tails.head[1] + 0.01);
  });

  it('shape controls change only their area', () => {
    const base = generateBody(truth);
    const big = generateBody(truth, { biceps: 1.5 });
    const width = (b: ReturnType<typeof generateBody>, y0: number, y1: number, x0: number, x1: number) => {
      let lo = Infinity, hi = -Infinity;
      for (let v = 0; v < b.positions.length / 3; v++) {
        const x = b.positions[v * 3], y = b.positions[v * 3 + 1], z = b.positions[v * 3 + 2];
        if (x < x0 || x > x1 || y < y0 || y > y1) continue;
        lo = Math.min(lo, z);
        hi = Math.max(hi, z);
      }
      return hi - lo;
    };
    const sh = truth.joints.leftUpperArm, el = truth.joints.leftLowerArm;
    const mid = (sh[0] + el[0]) / 2;
    // Biceps widen the front of the upper arm (the back is the triceps).
    const front = (b: ReturnType<typeof generateBody>) => {
      let hi = -Infinity;
      for (let v = 0; v < b.positions.length / 3; v++) {
        const x = b.positions[v * 3], y = b.positions[v * 3 + 1];
        if (Math.abs(x - mid) < 0.02 && Math.abs(y - sh[1]) < 0.2) hi = Math.max(hi, b.positions[v * 3 + 2] - sh[2]);
      }
      return hi;
    };
    expect(front(big)).toBeGreaterThan(front(base) * 1.3);
    const kn = truth.joints.leftLowerLeg, an = truth.joints.leftFoot;
    const calfY = kn[1] + (an[1] - kn[1]) * 0.3;
    const calf = (b: any) => width(b, calfY - 0.01, calfY + 0.01, kn[0] - 0.15, kn[0] + 0.15);
    expect(Math.abs(calf(big) - calf(base))).toBeLessThan(0.002);
  });
});
