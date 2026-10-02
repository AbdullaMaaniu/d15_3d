import { Matrix4, type SkinnedMesh } from 'three';
import {
  clothMaterial,
  createClothSim,
  fitClothCapsules,
  guessClothMaterial,
  type BodyMesh,
  type ClothFrame,
  type ClothMaterial,
  type ClothMaterialId,
  type ClothSim,
  type JointMap,
  type RiggedCharacter,
} from '@rigforge/core';
import type { PartsState } from './parts';

type ClothCapsuleFit = ReturnType<typeof fitClothCapsules>[number];

/** Fabric per part name; a missing name takes the guess from its name, null is not cloth. */
export type ClothFabrics = Record<string, ClothMaterialId | null>;

export function fabricOf(fabrics: ClothFabrics, partName: string): ClothMaterialId | null {
  return partName in fabrics ? fabrics[partName] : guessClothMaterial(partName);
}

/**
 * Runs the cloth simulation on a rigged character's garments during playback.
 * The simulated positions are written back into the mesh in bind space (each
 * vertex through the inverse of its own skinning matrix), so the GPU skinning
 * puts them exactly where the simulation did and every material and shading
 * mode keeps working. The bind positions are restored when it stops.
 */
export class ClothController {
  readonly sim: ClothSim;
  /** Milliseconds the last step took. */
  ms = 0;
  private mesh: SkinnedMesh;
  private bindPositions: Float32Array;
  private bindNormals: Float32Array | null;
  /** Render vertices that are cloth (not pinned), and their particle. */
  private clothVerts: Uint32Array;
  /** Inverse skinning matrix (3x4, row-major) per entry of clothVerts. */
  private inverse: Float64Array;
  private boneMats: Float64Array;
  private frame: ClothFrame;
  private bodySkin: { index: Uint16Array; weight: Float32Array; normals: Float32Array } | null;
  private capsuleBones: Int32Array;
  private capsuleBind: Float32Array;
  private live = false;

  /** Sets up the cloth for a character: its parts' fabrics, colliding with the body fitted inside it. */
  static async create(built: RiggedCharacter, parts: PartsState, fabrics: ClothFabrics, body: BodyMesh | null, joints: JointMap): Promise<ClothController> {
    const g = built.mesh.geometry;
    const orig = built.mesh.userData.rfOriginal as { index: Uint32Array } | undefined;
    const index = orig?.index ?? (g.index!.array as Uint32Array);
    const materials: ClothMaterial[] = [];
    const perPart = parts.defs.map((d) => {
      const m = clothMaterial(fabricOf(fabrics, d.name) ?? '');
      if (!m) return -1;
      materials.push(m);
      return materials.length - 1;
    });
    const triangleMaterial = new Int16Array(index.length / 3);
    for (let t = 0; t < triangleMaterial.length; t++) triangleMaterial[t] = perPart[parts.faces[t]] ?? -1;
    const capsules = body ? fitClothCapsules(body, joints.joints) : [];
    const bindPositions = new Float32Array(g.attributes.position.array as Float32Array);
    const sim = await createClothSim({
      positions: bindPositions,
      index,
      triangleMaterial,
      materials,
      body: body ? { positions: body.positions, normals: body.normals } : undefined,
      capsules,
    });
    return new ClothController(built, sim, body, capsules, bindPositions);
  }

  private constructor(built: RiggedCharacter, sim: ClothSim, body: BodyMesh | null, capsules: ClothCapsuleFit[], bindPositions: Float32Array) {
    const mesh = built.mesh;
    this.mesh = mesh;
    this.sim = sim;
    const g = mesh.geometry;
    const names = built.skeleton.bones.map((b) => b.name);
    let bodyIndex: Uint16Array | null = null;
    if (body) {
      const remap = body.bones.map((n) => Math.max(0, names.indexOf(n)));
      bodyIndex = Uint16Array.from(body.skinIndex, (i) => remap[i]);
    }
    this.bindPositions = bindPositions;
    this.bindNormals = g.attributes.normal ? new Float32Array(g.attributes.normal.array as Float32Array) : null;
    const verts: number[] = [];
    for (let v = 0; v < sim.particleOf.length; v++) if (sim.particleOf[v] >= 0 && !sim.pinned[sim.particleOf[v]]) verts.push(v);
    this.clothVerts = Uint32Array.from(verts);
    this.inverse = new Float64Array(verts.length * 12);
    this.boneMats = new Float64Array(names.length * 12);
    this.bodySkin =
      body && bodyIndex
        ? (() => {
            const ids = sim.bodyVertices;
            const pick = (src: ArrayLike<number>, k: number) => Float32Array.from({ length: ids.length * k }, (_, i) => src[ids[Math.floor(i / k)] * k + (i % k)]);
            return { index: Uint16Array.from(pick(bodyIndex!, 4)), weight: pick(body.skinWeight, 4), normals: pick(body.normals, 3) };
          })()
        : null;
    this.capsuleBones = Int32Array.from(capsules.map((c) => names.indexOf(c.from)));
    this.capsuleBind = Float32Array.from(capsules.flatMap((c) => [...c.a, ...c.b, c.ra, c.rb]));
    this.frame = {
      targets: new Float32Array(sim.count * 3),
      bodyNormals: this.bodySkin ? new Float32Array(sim.bodyVertices.length * 3) : undefined,
      capsules: capsules.length ? new Float32Array(capsules.length * 8) : undefined,
    };
  }

  /** Particles that move (not sewn to skin). */
  get moving(): number {
    return this.clothVerts.length;
  }

  /** Advances the cloth by dt (playing) or keeps it in step with a paused pose. */
  update(dt: number, playing: boolean): void {
    if (!this.sim.count) return;
    const t0 = performance.now();
    const changed = this.capture();
    if (playing && dt > 0) {
      this.sim.step(dt, this.frame);
      this.write();
    } else if (changed) {
      // Scrubbing or a new pose while paused: plain skinning until it plays again.
      this.restore();
      this.sim.restart();
    }
    this.ms = performance.now() - t0;
  }

  /** Puts the mesh back to its bind shape. */
  restore(): void {
    if (!this.live) return;
    const g = this.mesh.geometry;
    (g.attributes.position.array as Float32Array).set(this.bindPositions);
    g.attributes.position.needsUpdate = true;
    if (this.bindNormals && g.attributes.normal) {
      (g.attributes.normal.array as Float32Array).set(this.bindNormals);
      g.attributes.normal.needsUpdate = true;
    }
    this.live = false;
  }

  dispose(): void {
    this.restore();
  }

  private lastPose = new Float64Array(0);

  /** Skins the particle targets, body backstops and capsules for the current pose. Returns whether the pose moved. */
  private capture(): boolean {
    const mesh = this.mesh;
    const skel = mesh.skeleton;
    mesh.parent?.updateMatrixWorld(true);
    skel.update();
    // Per bone: world = meshWorld * bindMatrixInverse * boneMatrix * bindMatrix (3x4).
    const pre = new Matrix4().multiplyMatrices(mesh.matrixWorld, mesh.bindMatrixInverse);
    const tmp = new Matrix4();
    const B = this.boneMats;
    let changed = this.lastPose.length !== skel.bones.length * 12;
    if (changed) this.lastPose = new Float64Array(skel.bones.length * 12);
    for (let b = 0; b < skel.bones.length; b++) {
      tmp.fromArray(skel.boneMatrices!, b * 16).premultiply(pre).multiply(mesh.bindMatrix);
      const e = tmp.elements;
      const o = b * 12;
      B[o] = e[0]; B[o + 1] = e[4]; B[o + 2] = e[8]; B[o + 3] = e[12];
      B[o + 4] = e[1]; B[o + 5] = e[5]; B[o + 6] = e[9]; B[o + 7] = e[13];
      B[o + 8] = e[2]; B[o + 9] = e[6]; B[o + 10] = e[10]; B[o + 11] = e[14];
      for (let k = 0; k < 12; k++) {
        if (Math.abs(this.lastPose[o + k] - B[o + k]) > 1e-6) changed = true;
        this.lastPose[o + k] = B[o + k];
      }
    }
    const g = mesh.geometry;
    const si = g.attributes.skinIndex.array as ArrayLike<number>;
    const sw = g.attributes.skinWeight.array as ArrayLike<number>;
    const P = this.bindPositions;
    const M = new Float64Array(12);
    const blend = (index: ArrayLike<number>, weight: ArrayLike<number>, v: number) => {
      M.fill(0);
      for (let k = 0; k < 4; k++) {
        const w = weight[v * 4 + k];
        if (!w) continue;
        const o = index[v * 4 + k] * 12;
        for (let j = 0; j < 12; j++) M[j] += B[o + j] * w;
      }
    };
    const T = this.frame.targets;
    const sim = this.sim;
    for (let p = 0; p < sim.count; p++) {
      const v = sim.vertexOf[p];
      blend(si, sw, v);
      const x = P[v * 3], y = P[v * 3 + 1], z = P[v * 3 + 2];
      T[p * 3] = M[0] * x + M[1] * y + M[2] * z + M[3];
      T[p * 3 + 1] = M[4] * x + M[5] * y + M[6] * z + M[7];
      T[p * 3 + 2] = M[8] * x + M[9] * y + M[10] * z + M[11];
    }
    // Inverse skinning per moving render vertex, for writing back.
    const inv = this.inverse;
    for (let i = 0; i < this.clothVerts.length; i++) {
      blend(si, sw, this.clothVerts[i]);
      invert3x4(M, inv, i * 12);
    }
    const bs = this.bodySkin;
    if (bs && this.frame.bodyNormals) {
      for (let i = 0; i < bs.normals.length / 3; i++) {
        blend(bs.index, bs.weight, i);
        const nx = bs.normals[i * 3], ny = bs.normals[i * 3 + 1], nz = bs.normals[i * 3 + 2];
        const ax = M[0] * nx + M[1] * ny + M[2] * nz, ay = M[4] * nx + M[5] * ny + M[6] * nz, az = M[8] * nx + M[9] * ny + M[10] * nz;
        const l = Math.hypot(ax, ay, az) || 1;
        this.frame.bodyNormals[i * 3] = ax / l;
        this.frame.bodyNormals[i * 3 + 1] = ay / l;
        this.frame.bodyNormals[i * 3 + 2] = az / l;
      }
    }
    const caps = this.frame.capsules;
    if (caps) {
      const C = this.capsuleBind;
      for (let c = 0; c < this.capsuleBones.length; c++) {
        const o = Math.max(0, this.capsuleBones[c]) * 12;
        for (let e = 0; e < 2; e++) {
          const x = C[c * 8 + e * 3], y = C[c * 8 + e * 3 + 1], z = C[c * 8 + e * 3 + 2];
          caps[c * 8 + e * 3] = B[o] * x + B[o + 1] * y + B[o + 2] * z + B[o + 3];
          caps[c * 8 + e * 3 + 1] = B[o + 4] * x + B[o + 5] * y + B[o + 6] * z + B[o + 7];
          caps[c * 8 + e * 3 + 2] = B[o + 8] * x + B[o + 9] * y + B[o + 10] * z + B[o + 11];
        }
        caps[c * 8 + 6] = C[c * 8 + 6];
        caps[c * 8 + 7] = C[c * 8 + 7];
      }
    }
    return changed;
  }

  /** Writes the simulated cloth into the mesh, in bind space. */
  private write(): void {
    const g = this.mesh.geometry;
    const pos = g.attributes.position.array as Float32Array;
    const nor = g.attributes.normal ? (g.attributes.normal.array as Float32Array) : null;
    const X = this.sim.positions, Nn = this.sim.normals;
    const inv = this.inverse;
    for (let i = 0; i < this.clothVerts.length; i++) {
      const v = this.clothVerts[i];
      const p = this.sim.particleOf[v] * 3;
      const o = i * 12;
      const x = X[p], y = X[p + 1], z = X[p + 2];
      pos[v * 3] = inv[o] * x + inv[o + 1] * y + inv[o + 2] * z + inv[o + 3];
      pos[v * 3 + 1] = inv[o + 4] * x + inv[o + 5] * y + inv[o + 6] * z + inv[o + 7];
      pos[v * 3 + 2] = inv[o + 8] * x + inv[o + 9] * y + inv[o + 10] * z + inv[o + 11];
      if (nor) {
        // Keep the side the mesh's own normal faces (the sheet may be wound either way).
        const bx = this.bindNormals![v * 3], by = this.bindNormals![v * 3 + 1], bz = this.bindNormals![v * 3 + 2];
        let nx = inv[o] * Nn[p] + inv[o + 1] * Nn[p + 1] + inv[o + 2] * Nn[p + 2];
        let ny = inv[o + 4] * Nn[p] + inv[o + 5] * Nn[p + 1] + inv[o + 6] * Nn[p + 2];
        let nz = inv[o + 8] * Nn[p] + inv[o + 9] * Nn[p + 1] + inv[o + 10] * Nn[p + 2];
        const l = Math.hypot(nx, ny, nz) || 1;
        const s = nx * bx + ny * by + nz * bz < 0 ? -1 / l : 1 / l;
        nx *= s;
        ny *= s;
        nz *= s;
        nor[v * 3] = nx;
        nor[v * 3 + 1] = ny;
        nor[v * 3 + 2] = nz;
      }
    }
    g.attributes.position.needsUpdate = true;
    if (nor) g.attributes.normal.needsUpdate = true;
    this.live = true;
  }
}

/** Inverts an affine 3x4 matrix (row-major) into out[o..o+12]. */
function invert3x4(m: Float64Array, out: Float64Array, o: number): void {
  const a = m[0], b = m[1], c = m[2], d = m[4], e = m[5], f = m[6], g = m[8], h = m[9], i = m[10];
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  let det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) det = det < 0 ? -1e-12 : 1e-12;
  const r = 1 / det;
  const i00 = A * r, i01 = -(b * i - c * h) * r, i02 = (b * f - c * e) * r;
  const i10 = B * r, i11 = (a * i - c * g) * r, i12 = -(a * f - c * d) * r;
  const i20 = C * r, i21 = -(a * h - b * g) * r, i22 = (a * e - b * d) * r;
  const tx = m[3], ty = m[7], tz = m[11];
  out[o] = i00; out[o + 1] = i01; out[o + 2] = i02; out[o + 3] = -(i00 * tx + i01 * ty + i02 * tz);
  out[o + 4] = i10; out[o + 5] = i11; out[o + 6] = i12; out[o + 7] = -(i10 * tx + i11 * ty + i12 * tz);
  out[o + 8] = i20; out[o + 9] = i21; out[o + 10] = i22; out[o + 11] = -(i20 * tx + i21 * ty + i22 * tz);
}
