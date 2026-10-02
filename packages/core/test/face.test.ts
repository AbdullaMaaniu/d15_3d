import { describe, expect, it } from 'vitest';
import { BoxGeometry, BufferAttribute, BufferGeometry, CylinderGeometry, MeshStandardMaterial } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { createMannequin } from '../src/mesh/mannequin';
import { detectHumanoid } from '../src/rig/landmarks';
import { computeSkinWeights } from '../src/rig/weights';
import { buildSkinnedCharacter } from '../src/rig/build';
import { humanoidDefs } from '../src/skeleton';
import { EXPRESSIONS, applyFaceWeights, attachExpressions, detectFace, faceDefs, faceJoints, jawMask } from '../src/rig/face';
import { cleanHairWeights, hairChains } from '../src/rig/hair';

/** The mannequin with a nose and a chin, so its head has a readable profile. */
function withFace() {
  const { geometry } = createMannequin({ pose: 'A', fingers: false, detail: 40 });
  const nose = new BoxGeometry(0.025, 0.03, 0.05, 6, 6, 6).translate(0, 1.67, 0.115);
  const chin = new BoxGeometry(0.06, 0.05, 0.06, 6, 6, 6).translate(0, 1.585, 0.075);
  const g = mergeGeometries([geometry.toNonIndexed(), nose.toNonIndexed(), chin.toNonIndexed()]);
  const positions = g.attributes.position.array as Float32Array;
  return { positions, index: new Uint32Array(positions.length / 3).map((_, i) => i) };
}

describe('face rig', () => {
  it('places a featureless head by proportion', () => {
    const { geometry } = createMannequin({ pose: 'A', fingers: false });
    const positions = geometry.attributes.position.array as Float32Array;
    const index = new Uint32Array(geometry.index!.array);
    const d = detectHumanoid(positions, index, { fingers: false });
    const f = detectFace(positions, index, d)!;
    expect(f.features).toBe(false);
    expect(f.leftEye[0]).toBeGreaterThan(f.centerX);
    expect(f.rightEye[0]).toBeLessThan(f.centerX);
    expect(f.leftEye[1]).toBeGreaterThan(f.mouth[1]);
    expect(f.mouth[1]).toBeGreaterThan(f.chinBottom[1]);
  });

  it('finds the nose and chin of a head with a profile', () => {
    const { positions, index } = withFace();
    const d = detectHumanoid(positions, index, { fingers: false });
    const f = detectFace(positions, index, d)!;
    expect(f.features).toBe(true);
    expect(Math.abs(f.noseTip[1] - 1.67)).toBeLessThan(0.02);
    expect(Math.abs(f.noseTip[2] - 0.14)).toBeLessThan(0.01);
    // Chin underside at the bottom of the chin box.
    expect(Math.abs(f.chinBottom[1] - 1.56)).toBeLessThan(0.02);
    // Eyes above the nose, the jaw hinge behind the face.
    expect(f.leftEye[1]).toBeGreaterThan(f.noseTip[1]);
    expect(f.jaw[2]).toBeLessThan(f.mouth[2] - 0.05);
  });

  it('gives the jaw the chin and leaves the forehead and the back of the head', () => {
    const { positions, index } = withFace();
    const d = detectHumanoid(positions, index, { fingers: false });
    const f = detectFace(positions, index, d)!;
    const m = jawMask(positions, f);
    const near = (p: number[]) => {
      let best = 0, bd = Infinity;
      for (let v = 0; v < positions.length / 3; v++) {
        const dd = (positions[v * 3] - p[0]) ** 2 + (positions[v * 3 + 1] - p[1]) ** 2 + (positions[v * 3 + 2] - p[2]) ** 2;
        if (dd < bd) { bd = dd; best = v; }
      }
      return m[best];
    };
    expect(near([0, 1.585, 0.105])).toBeGreaterThan(0.9); // chin front
    expect(near([0, 1.76, 0.1])).toBe(0); // forehead
    expect(near([0, 1.66, -0.12])).toBe(0); // back of the head
    expect(near([0, 1.45, 0.05])).toBe(0); // neck
  });

  it('weights the face and builds every expression as a morph target', () => {
    const { positions, index } = withFace();
    const d = detectHumanoid(positions, index, { fingers: false });
    const body = humanoidDefs(false);
    const w = computeSkinWeights(positions, index, body, d, { resolution: 128 });
    const f = detectFace(positions, index, d)!;
    const defs = [...body, ...faceDefs()];
    const names = defs.map((x) => x.name);
    applyFaceWeights(positions, index, w.skinIndex, w.skinWeight, names, f);
    const jaw = names.indexOf('jaw');
    let jawVerts = 0;
    for (let v = 0; v < positions.length / 3; v++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) {
        sum += w.skinWeight[v * 4 + k];
        if (w.skinIndex[v * 4 + k] === jaw && w.skinWeight[v * 4 + k] > 0.5) jawVerts++;
      }
      expect(Math.abs(sum - 1)).toBeLessThan(1e-4);
    }
    expect(jawVerts).toBeGreaterThan(20);

    const fj = faceJoints(f);
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(positions, 3));
    g.setIndex(new BufferAttribute(index, 1));
    const built = buildSkinnedCharacter(g, new MeshStandardMaterial(), defs, { joints: { ...d.joints, ...fj.joints }, tails: { ...d.tails, ...fj.tails } }, w.skinIndex, w.skinWeight);
    attachExpressions(built.mesh, f);
    expect(Object.keys(built.mesh.morphTargetDictionary!)).toEqual([...EXPRESSIONS]);
    const morphs = built.mesh.geometry.morphAttributes.position!;
    for (const name of EXPRESSIONS) {
      const a = morphs[built.mesh.morphTargetDictionary![name]].array as Float32Array;
      let moved = 0, outsideHead = 0;
      for (let v = 0; v < a.length / 3; v++) {
        const len = Math.hypot(a[v * 3], a[v * 3 + 1], a[v * 3 + 2]);
        if (len > 1e-4) moved++;
        // Nothing below the chin or behind the ears moves.
        if (len > 1e-4 && (positions[v * 3 + 1] < 1.5 || positions[v * 3 + 2] < -0.05)) outsideHead++;
      }
      expect(moved, name).toBeGreaterThan(5);
      expect(outsideHead, name).toBe(0);
    }
    // Opening the mouth moves the chin down.
    const aa = morphs[built.mesh.morphTargetDictionary!.aa].array as Float32Array;
    let minDy = 0;
    for (let v = 0; v < aa.length / 3; v++) minDy = Math.min(minDy, aa[v * 3 + 1]);
    expect(minDy).toBeLessThan(-0.005);
  });
});

describe('hair chains', () => {
  /** The mannequin with a ponytail hanging behind the head. */
  function ponytail() {
    const { geometry } = createMannequin({ pose: 'A', fingers: false });
    const tail = new CylinderGeometry(0.03, 0.02, 0.3, 10, 12).translate(0, 1.5, -0.15);
    const cap = new BoxGeometry(0.06, 0.06, 0.06, 2, 2, 2).translate(0, 1.66, -0.13);
    const parts = [geometry.toNonIndexed(), tail.toNonIndexed(), cap.toNonIndexed()];
    const g = mergeGeometries(parts);
    const positions = g.attributes.position.array as Float32Array;
    const index = new Uint32Array(positions.length / 3).map((_, i) => i);
    const bodyTris = parts[0].attributes.position.count / 3;
    const hairFaces = new Uint8Array(index.length / 3).map((_, t) => (t >= bodyTris ? 1 : 0));
    return { positions, index, hairFaces };
  }

  it('hangs one chain down a ponytail and keeps the body off it', () => {
    const { positions, index, hairFaces } = ponytail();
    const d = detectHumanoid(positions, index, { fingers: false });
    const found = hairChains(positions, index, hairFaces, d);
    const roots = found.bones.filter((b) => b.parent === 'head');
    expect(roots.map((b) => b.name)).toEqual(['hairBack1']);
    expect(found.bones.length).toBeGreaterThanOrEqual(3);
    // Joints run down the tail, behind the neck.
    const ys = found.bones.map((b) => found.joints[b.name][1]);
    for (let i = 1; i < ys.length; i++) expect(ys[i]).toBeLessThan(ys[i - 1]);
    for (const b of found.bones.slice(1)) expect(found.joints[b.name][2]).toBeLessThan(-0.1);
    expect(found.length).toBeGreaterThan(0.2);

    const defs = [...humanoidDefs(false), ...found.bones.map((b) => ({ name: b.name, parent: b.parent, primaryChild: found.bones.find((c) => c.parent === b.name)?.name ?? null, side: null, isFinger: false }))];
    const map = { joints: { ...d.joints, ...found.joints }, tails: d.tails };
    const w = computeSkinWeights(positions, index, defs, map, { resolution: 128 });
    const names = defs.map((x) => x.name);
    cleanHairWeights(positions, index, hairFaces, w.skinIndex, w.skinWeight, names, map);
    const isHair = new Uint8Array(positions.length / 3);
    hairFaces.forEach((h, t) => h && (isHair[index[t * 3]] = isHair[index[t * 3 + 1]] = isHair[index[t * 3 + 2]] = 1));
    for (let v = 0; v < isHair.length; v++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) {
        const b = names[w.skinIndex[v * 4 + k]], wt = w.skinWeight[v * 4 + k];
        sum += wt;
        if (wt <= 0) continue;
        if (isHair[v]) expect(b === 'head' || b.startsWith('hair'), b).toBe(true);
        else expect(b.startsWith('hair'), b).toBe(false);
      }
      expect(Math.abs(sum - 1)).toBeLessThan(1e-4);
    }
  });

  it('adds no chains to short hair', () => {
    const { geometry } = createMannequin({ pose: 'A', fingers: false });
    const cap = new BoxGeometry(0.2, 0.06, 0.2, 2, 2, 2).translate(0, 1.77, 0);
    const parts = [geometry.toNonIndexed(), cap.toNonIndexed()];
    const g = mergeGeometries(parts);
    const positions = g.attributes.position.array as Float32Array;
    const index = new Uint32Array(positions.length / 3).map((_, i) => i);
    const bodyTris = parts[0].attributes.position.count / 3;
    const hairFaces = new Uint8Array(index.length / 3).map((_, t) => (t >= bodyTris ? 1 : 0));
    const d = detectHumanoid(positions, index, { fingers: false });
    expect(hairChains(positions, index, hairFaces, d).bones).toEqual([]);
  });
});
