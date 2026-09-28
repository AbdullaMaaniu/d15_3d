import { describe, expect, it } from 'vitest';
import { createMannequin } from '../src/mesh/mannequin';
import { detectHumanoid } from '../src/rig/landmarks';

const MAIN = [
  'hips', 'neck', 'head',
  'leftUpperArm', 'leftLowerArm', 'leftHand', 'rightUpperArm', 'rightLowerArm', 'rightHand',
  'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'rightUpperLeg', 'rightLowerLeg', 'rightFoot',
];

function report(pose: 'T' | 'A', fingers: boolean) {
  const { geometry, truth } = createMannequin({ pose, fingers });
  const positions = geometry.attributes.position.array as Float32Array;
  const index = new Uint32Array(geometry.index!.array);
  const t0 = performance.now();
  const result = detectHumanoid(positions, index, { fingers: true });
  const ms = performance.now() - t0;
  const errors: Record<string, number> = {};
  for (const name of Object.keys(truth.joints)) {
    const a = truth.joints[name], b = result.joints[name];
    if (!b) continue;
    errors[name] = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  }
  return { result, errors, ms };
}

describe('detectHumanoid', () => {
  for (const pose of ['T', 'A'] as const) {
    it(`finds the main joints of a ${pose}-pose mannequin`, () => {
      const { result, errors, ms } = report(pose, true);
      if (process.env.RF_DEBUG) console.log(pose, result.pose, Math.round(ms), 'ms', result.notes, Object.fromEntries(Object.entries(errors).map(([k, v]) => [k, +v.toFixed(3)])));
      expect(result.pose).toBe(pose);
      expect(result.notes).toEqual([]);
      for (const name of MAIN) expect(errors[name], name).toBeLessThan(0.07);
    });
  }

  it('detects separate fingers', () => {
    const { result, errors } = report('T', true);
    expect(result.fingers?.left.method).toBe('detected');
    expect(result.fingers?.right.method).toBe('detected');
    for (const f of ['Index', 'Middle', 'Ring', 'Little']) {
      expect(errors[`left${f}Proximal`], f).toBeLessThan(0.035);
      expect(errors[`right${f}Proximal`], f).toBeLessThan(0.035);
    }
  });

  it('falls back to template fingers on mitten hands', () => {
    const { result } = report('T', false);
    expect(result.fingers?.left.method).toBe('template');
    expect(result.joints.leftIndexProximal).toBeDefined();
    expect(result.joints.rightThumbDistal).toBeDefined();
  });
});
