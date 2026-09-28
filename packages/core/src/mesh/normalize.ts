import { Box3, BufferGeometry, Matrix4, Quaternion, Vector3 } from 'three';

export interface NormalizeOptions {
  /** Rotation applied before scaling (e.g. from auto-orient or the user's axis buttons). */
  rotation?: Quaternion;
  /** Target height in meters. Default 1.8. */
  targetHeight?: number;
  /** Scale so the height ('height', default) or the largest dimension ('max') matches targetHeight. */
  fit?: 'height' | 'max';
}

export interface Normalization {
  matrix: Matrix4;
  rotation: Quaternion;
  scale: number;
  /** Height of the model in source units after rotation. */
  sourceHeight: number;
}

/**
 * Computes the transform that brings a model into RigForge rig space:
 * rotated upright, scaled to `targetHeight`, feet on y = 0 and centered on X/Z.
 */
export function computeNormalization(geometry: BufferGeometry, options: NormalizeOptions = {}): Normalization {
  const rotation = options.rotation?.clone() ?? new Quaternion();
  const targetHeight = options.targetHeight ?? 1.8;
  const rotated = geometry.clone();
  rotated.applyQuaternion(rotation);
  rotated.computeBoundingBox();
  const bb = rotated.boundingBox!;
  rotated.dispose();
  const sourceHeight = bb.max.y - bb.min.y;
  const measured = options.fit === 'max' ? Math.max(sourceHeight, bb.max.x - bb.min.x, bb.max.z - bb.min.z) : sourceHeight;
  const scale = measured > 0 ? targetHeight / measured : 1;
  const center = new Vector3((bb.min.x + bb.max.x) / 2, bb.min.y, (bb.min.z + bb.max.z) / 2);
  const matrix = new Matrix4()
    .makeScale(scale, scale, scale)
    .multiply(new Matrix4().makeTranslation(-center.x, -center.y, -center.z))
    .multiply(new Matrix4().makeRotationFromQuaternion(rotation));
  return { matrix, rotation, scale, sourceHeight };
}

export function applyNormalization(geometry: BufferGeometry, n: Normalization): BufferGeometry {
  const g = geometry.clone();
  g.applyMatrix4(n.matrix);
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

const AXES = [new Vector3(1, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 0, 1)];

/**
 * Guesses a rotation that makes a humanoid stand upright (Y up) and face +Z.
 *
 * Heuristics: the up axis is the longest extent unless Y is already close to it;
 * the arm span (widest horizontal extent) should lie along X; and the feet stick
 * out toward the front, so the lowest slice of the mesh is biased toward +Z.
 */
export function guessOrientation(geometry: BufferGeometry): { rotation: Quaternion; confidence: number; notes: string[] } {
  const notes: string[] = [];
  const pos = geometry.attributes.position.array as ArrayLike<number>;
  const bb = new Box3().setFromBufferAttribute(geometry.attributes.position as any);
  const size = bb.getSize(new Vector3()).toArray();
  const rotation = new Quaternion();

  // 1. Up axis.
  const maxExtent = Math.max(...size);
  if (size[1] < 0.8 * maxExtent) {
    const upIdx = size.indexOf(maxExtent);
    rotation.setFromUnitVectors(AXES[upIdx], AXES[1]);
    notes.push(`Model looked like it was lying along ${'XYZ'[upIdx]}; stood it up.`);
  }

  // Work on rotated positions from here.
  const n = pos.length / 3;
  const v = new Vector3();
  const pts = new Float32Array(pos.length);
  for (let i = 0; i < n; i++) {
    v.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]).applyQuaternion(rotation);
    pts[i * 3] = v.x;
    pts[i * 3 + 1] = v.y;
    pts[i * 3 + 2] = v.z;
  }
  const rb = new Box3();
  for (let i = 0; i < n; i++) rb.expandByPoint(v.set(pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2]));
  const height = rb.max.y - rb.min.y;

  // 2. Arms along X: compare horizontal extents in the upper body.
  let ux0 = Infinity, ux1 = -Infinity, uz0 = Infinity, uz1 = -Infinity;
  for (let i = 0; i < n; i++) {
    if (pts[i * 3 + 1] < rb.min.y + height * 0.5) continue;
    ux0 = Math.min(ux0, pts[i * 3]); ux1 = Math.max(ux1, pts[i * 3]);
    uz0 = Math.min(uz0, pts[i * 3 + 2]); uz1 = Math.max(uz1, pts[i * 3 + 2]);
  }
  let yaw = 0;
  if (uz1 - uz0 > (ux1 - ux0) * 1.15) {
    yaw = Math.PI / 2;
    notes.push('Arm span lay along Z; turned the model 90°.');
  }
  const cos = Math.cos(yaw), sin = Math.sin(yaw);

  // 3. Facing: toes point forward. Compare how far the foot slice reaches in +Z vs -Z
  //    relative to the ankle-level centroid.
  const footTop = rb.min.y + height * 0.06;
  const ankleTop = rb.min.y + height * 0.12;
  let fz0 = Infinity, fz1 = -Infinity, az = 0, ac = 0;
  for (let i = 0; i < n; i++) {
    const x = pts[i * 3], y = pts[i * 3 + 1], z = pts[i * 3 + 2];
    const zr = -x * sin + z * cos; // z after yaw about Y
    if (y <= footTop) {
      fz0 = Math.min(fz0, zr);
      fz1 = Math.max(fz1, zr);
    } else if (y <= ankleTop) {
      az += zr;
      ac++;
    }
  }
  let confidence = 0.5;
  if (ac > 0 && Number.isFinite(fz0)) {
    const ankleZ = az / ac;
    const front = fz1 - ankleZ;
    const back = ankleZ - fz0;
    if (back > front * 1.2) {
      yaw += Math.PI;
      notes.push('Feet pointed toward -Z; turned the model around to face +Z.');
    }
    confidence = Math.min(1, Math.abs(front - back) / (Math.max(front, back) || 1) + 0.3);
  } else {
    notes.push('Could not find the feet to determine facing; please check the orientation.');
    confidence = 0.2;
  }
  if (yaw !== 0) rotation.premultiply(new Quaternion().setFromAxisAngle(AXES[1], yaw));
  return { rotation, confidence, notes };
}
