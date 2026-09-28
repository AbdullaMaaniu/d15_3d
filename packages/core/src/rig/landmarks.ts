import { EMPTY, SURFACE, type VoxelGrid } from '../voxel/grid';
import type { Kernels } from '../kernels';
import { tsKernels } from '../kernels';
import { mirrorBoneName, type JointMap } from '../skeleton';
import { detectFingers, type FingerDetection } from './fingers';

type V3 = [number, number, number];

export interface DetectOptions {
  /** Add full finger chains (default true). */
  fingers?: boolean;
  /** Voxels along the model height used for detection (default 160). */
  resolution?: number;
  kernels?: Kernels;
}

export interface DetectResult extends JointMap {
  /** Overall confidence 0..1 (heuristic). */
  confidence: number;
  notes: string[];
  pose: 'T' | 'A' | 'unknown';
  fingers: { left: FingerDetection; right: FingerDetection } | null;
  /** Intermediate measurements, useful for overlays and debugging. */
  measurements: { centerX: number; crotchY: number; shoulderY: number; neckY: number; height: number };
}

interface Silhouette {
  /** Occupancy of the front projection (x, y). */
  occ: Uint8Array;
  /** Front projection of surface voxels only: narrow gaps that closing filled stay open. */
  surf: Uint8Array;
  /** Sum and count of solid voxel z per (x, y) cell, for centroids. */
  zSum: Float32Array;
  zCount: Uint16Array;
}

/**
 * Detects humanoid joint positions from a mesh in rig space (Y up, facing +Z,
 * feet at y = 0). Works on the solid voxelization, so it tolerates open and
 * self-intersecting meshes. Assumes a T- or A-pose; the result is meant to be
 * reviewed in the marker UI.
 */
export function detectHumanoid(positions: Float32Array, index: Uint32Array | null, options: DetectOptions = {}): DetectResult {
  const kernels = options.kernels ?? tsKernels;
  const notes: string[] = [];
  let minY = Infinity, maxY = -Infinity;
  for (let i = 1; i < positions.length; i += 3) {
    if (positions[i] < minY) minY = positions[i];
    if (positions[i] > maxY) maxY = positions[i];
  }
  const H = maxY - minY;
  const dx = H / (options.resolution ?? 160);
  const g = kernels.voxelize({ positions, index, dx, pad: 2 });
  const sil = frontSilhouette(g);
  const wx = (xi: number) => g.origin[0] + (xi + 0.5) * dx;
  const wy = (yi: number) => g.origin[1] + (yi + 0.5) * dx;
  const xiOf = (x: number) => Math.floor((x - g.origin[0]) / dx);
  const yiOf = (y: number) => Math.floor((y - g.origin[1]) / dx);
  const occ = (xi: number, yi: number) => xi >= 0 && yi >= 0 && xi < g.nx && yi < g.ny && sil.occ[xi + g.nx * yi] === 1;
  const zAt = (xi: number, yi: number) => {
    const k = xi + g.nx * yi;
    return sil.zCount[k] ? sil.zSum[k] / sil.zCount[k] : 0;
  };
  const runsInRow = (yi: number, x0 = 0, x1 = g.nx - 1): Array<[number, number]> => {
    const runs: Array<[number, number]> = [];
    let start = -1;
    for (let xi = x0; xi <= x1 + 1; xi++) {
      const on = xi <= x1 && occ(xi, yi);
      if (on && start < 0) start = xi;
      if (!on && start >= 0) {
        runs.push([start, xi - 1]);
        start = -1;
      }
    }
    return runs;
  };
  const runsInColumn = (xi: number, y0: number, y1: number): Array<[number, number]> => {
    const runs: Array<[number, number]> = [];
    let start = -1;
    for (let yi = y0; yi <= y1 + 1; yi++) {
      const on = yi <= y1 && occ(xi, yi);
      if (on && start < 0) start = yi;
      if (!on && start >= 0) {
        runs.push([start, yi - 1]);
        start = -1;
      }
    }
    return runs;
  };

  const groundYi = yiOf(minY);
  const topYi = yiOf(maxY);

  // --- Body center line -----------------------------------------------------------
  let x0i = xiOf(0);
  {
    const legRow = yiOf(minY + 0.25 * H);
    const runs = runsInRow(legRow).filter((r) => Math.abs(wx((r[0] + r[1]) / 2)) < 0.3 * H);
    if (runs.length >= 2) {
      runs.sort((a, b) => b[1] - b[0] - (a[1] - a[0]));
      const [r1, r2] = runs.slice(0, 2).sort((a, b) => a[0] - b[0]);
      x0i = Math.round((r1[1] + r2[0]) / 2);
    } else {
      const torsoRow = yiOf(minY + 0.6 * H);
      const r = runsInRow(torsoRow).find((q) => q[0] <= x0i && q[1] >= x0i);
      if (r) x0i = Math.round((r[0] + r[1]) / 2);
    }
  }
  const x0 = wx(x0i);

  // --- Crotch ---------------------------------------------------------------------
  // Scan down the center line from the pelvis for the first gap between the legs.
  // (Scanning down rather than up tolerates knees or baggy trousers that touch lower down.)
  let crotchYi = -1;
  const surfOcc = (xi: number, yi: number) => xi >= 0 && yi >= 0 && xi < g.nx && yi < g.ny && sil.surf[xi + g.nx * yi] === 1;
  const centerOcc = (yi: number) => surfOcc(x0i, yi) || (surfOcc(x0i - 1, yi) && surfOcc(x0i + 1, yi));
  const lowEmpty = !centerOcc(yiOf(minY + 0.1 * H)) || !centerOcc(yiOf(minY + 0.2 * H));
  for (let yi = yiOf(minY + 0.62 * H); yi > yiOf(minY + 0.2 * H); yi--) {
    if (!centerOcc(yi) && !centerOcc(yi - 1)) {
      crotchYi = yi + 1;
      break;
    }
  }
  if (crotchYi >= 0 && wy(crotchYi) - minY < 0.36 * H) {
    notes.push('The legs touch for most of their length; hip joints were estimated from proportions.');
    crotchYi = -1;
  }
  let crotchY: number;
  if (crotchYi < 0) {
    crotchY = minY + 0.46 * H;
    crotchYi = yiOf(crotchY);
    if (!lowEmpty) notes.push('Legs appear joined (robe, dress or closed stance); leg joints were estimated from proportions.');
  } else {
    crotchY = wy(crotchYi);
  }
  const hipY = crotchY + 0.1 * (crotchY - minY);

  // --- Legs -----------------------------------------------------------------------
  const joints: Record<string, V3> = {};
  const tails: Record<string, V3> = {};

  const legRowStats = (side: 1 | -1, yi: number) => {
    let sx = 0, sz = 0, c = 0, zmin = Infinity, zmax = -Infinity;
    for (let z = 0; z < g.nz; z++)
      for (let xi = 0; xi < g.nx; xi++) {
        if ((xi - x0i) * side <= 0) continue;
        if (Math.abs(wx(xi) - x0) > 0.3 * H) continue;
        if (g.data[xi + g.nx * (yi + g.ny * z)] === EMPTY) continue;
        const zz = g.origin[2] + (z + 0.5) * dx;
        sx += wx(xi);
        sz += zz;
        c++;
        if (zz < zmin) zmin = zz;
        if (zz > zmax) zmax = zz;
      }
    return c ? { x: sx / c, z: sz / c, zmin, zmax, count: c } : null;
  };

  for (const side of [1, -1] as const) {
    const name = side === 1 ? 'left' : 'right';
    const rows: Array<ReturnType<typeof legRowStats>> = [];
    for (let yi = groundYi; yi <= crotchYi; yi++) rows[yi] = legRowStats(side, yi);
    const statAt = (y: number) => {
      const yi = Math.min(crotchYi - 1, Math.max(groundYi, yiOf(y)));
      for (let d = 0; d < 6; d++) {
        const r = rows[yi - d] ?? rows[yi + d];
        if (r) return r;
      }
      return { x: x0 + side * 0.09 * H, z: 0, zmin: 0, zmax: 0, count: 0 };
    };
    // Ankle: first row where the foot's depth drops well below the sole's depth.
    let footDepth = 0;
    for (let yi = groundYi; yi <= yiOf(minY + 0.04 * H); yi++) {
      const r = rows[yi];
      if (r) footDepth = Math.max(footDepth, r.zmax - r.zmin);
    }
    let ankleY = minY + 0.05 * H;
    for (let yi = yiOf(minY + 0.03 * H); yi <= yiOf(minY + 0.15 * H); yi++) {
      const r = rows[yi];
      if (r && r.zmax - r.zmin < 0.55 * footDepth) {
        ankleY = wy(yi);
        break;
      }
    }
    const ankle = statAt(ankleY + dx);
    const hip = statAt(crotchY - 3 * dx);
    const kneeY = (hipY + ankleY) / 2;
    const knee = statAt(kneeY);
    joints[`${name}UpperLeg`] = [hip.x, hipY, hip.z];
    joints[`${name}LowerLeg`] = [knee.x, kneeY, knee.z];
    joints[`${name}Foot`] = [ankle.x, ankleY, ankle.z];

    // Toes: the most forward foot voxel below the ankle.
    let toeTipZ = -Infinity;
    for (let yi = groundYi; yi < yiOf(ankleY); yi++) {
      const r = rows[yi];
      if (r && r.zmax > toeTipZ) toeTipZ = r.zmax;
    }
    if (!Number.isFinite(toeTipZ)) toeTipZ = ankle.z + 0.12 * H;
    const toeZ = ankle.z + 0.72 * (toeTipZ - ankle.z);
    const toeY = minY + Math.max(0.3 * (ankleY - minY), dx);
    joints[`${name}Toes`] = [ankle.x, toeY, toeZ];
    tails[`${name}Toes`] = [ankle.x, toeY, toeTipZ];
  }

  // --- Arms -----------------------------------------------------------------------
  const armMinYi = yiOf(minY + 0.25 * H);
  let armThickness = 0.05 * H;
  const armResult: Record<'left' | 'right', { tip: V3; wrist: V3; poseAngle: number } | null> = { left: null, right: null };
  for (const side of [1, -1] as const) {
    const name = side === 1 ? 'left' : 'right';
    // Tip column: the most lateral occupied column above the knees.
    let tipXi = -1;
    if (side === 1) {
      for (let xi = g.nx - 1; xi > x0i && tipXi < 0; xi--) for (let yi = armMinYi; yi <= topYi; yi++) if (occ(xi, yi)) { tipXi = xi; break; }
    } else {
      for (let xi = 0; xi < x0i && tipXi < 0; xi++) for (let yi = armMinYi; yi <= topYi; yi++) if (occ(xi, yi)) { tipXi = xi; break; }
    }
    if (tipXi < 0) continue;
    const tipRuns = runsInColumn(tipXi, armMinYi, topYi);
    let prevYc = tipRuns.length ? (tipRuns[0][0] + tipRuns[0][1]) / 2 : yiOf(minY + 0.8 * H);

    // March inward, tracking the arm's run in each column.
    const path: Array<{ xi: number; y0: number; y1: number; yc: number; len: number }> = [];
    for (let xi = tipXi; xi !== x0i; xi -= side) {
      const runs = runsInColumn(xi, armMinYi, topYi);
      if (!runs.length) break;
      let best = runs[0], bestD = Infinity;
      for (const r of runs) {
        const d = prevYc < r[0] ? r[0] - prevYc : prevYc > r[1] ? prevYc - r[1] : 0;
        if (d < bestD) { bestD = d; best = r; }
      }
      if (bestD > 0.08 * H / dx) break;
      const yc = (best[0] + best[1]) / 2;
      path.push({ xi, y0: best[0], y1: best[1], yc, len: best[1] - best[0] + 1 });
      prevYc = yc;
    }
    if (path.length < 8) continue;
    const lens = path.slice(Math.floor(path.length * 0.25), Math.floor(path.length * 0.5)).map((p) => p.len).sort((a, b) => a - b);
    const baseline = lens[Math.floor(lens.length / 2)] || 4;
    armThickness = baseline * dx;
    let armpit = path.length - 1;
    for (let k = Math.floor(path.length * 0.45); k < path.length; k++) {
      if (path[k].len > 2.2 * baseline) {
        armpit = Math.max(0, k - 1);
        break;
      }
    }
    // 3D centerline from the tip to the armpit.
    const centerline: V3[] = [];
    for (let k = 0; k <= armpit; k++) {
      const p = path[k];
      let sz = 0, c = 0;
      for (let yi = p.y0; yi <= p.y1; yi++) {
        const k2 = p.xi + g.nx * yi;
        if (sil.zCount[k2]) { sz += sil.zSum[k2]; c += sil.zCount[k2]; }
      }
      centerline.push([wx(p.xi), wy(p.yc), c ? sz / c : 0]);
    }
    const tip = centerline[0];
    const pit = centerline[centerline.length - 1];
    // The shoulder joint sits where the arm meets the torso.
    const upperArm = pit;
    const line = centerline.slice().reverse();
    const total = polylineLength(line);
    const elbow = pointAlong(line, total * 0.42);
    const wrist = pointAlong(line, total * 0.755);
    joints[`${name}UpperArm`] = upperArm;
    joints[`${name}LowerArm`] = elbow;
    joints[`${name}Hand`] = wrist;
    tails[`${name}Hand`] = tip;
    const angle = (Math.atan2(upperArm[1] - tip[1], Math.abs(tip[0] - upperArm[0])) * 180) / Math.PI;
    armResult[name] = { tip, wrist, poseAngle: angle };
  }
  if (!armResult.left || !armResult.right) {
    notes.push('Could not trace both arms; arm joints were estimated. Check the markers.');
    for (const side of [1, -1] as const) {
      const name = side === 1 ? 'left' : 'right';
      if (armResult[name]) continue;
      const y = minY + 0.8 * H;
      joints[`${name}UpperArm`] = [x0 + side * 0.1 * H, y, 0];
      joints[`${name}LowerArm`] = [x0 + side * 0.28 * H, y, 0];
      joints[`${name}Hand`] = [x0 + side * 0.43 * H, y, 0];
      tails[`${name}Hand`] = [x0 + side * 0.52 * H, y, 0];
    }
  }
  const angles = [armResult.left?.poseAngle, armResult.right?.poseAngle].filter((a): a is number => a !== undefined);
  const meanAngle = angles.length ? angles.reduce((a, b) => a + b, 0) / angles.length : 0;
  const pose: DetectResult['pose'] = !angles.length ? 'unknown' : meanAngle < 20 ? 'T' : meanAngle < 65 ? 'A' : 'unknown';
  if (pose === 'unknown') notes.push('Arms are neither in a T- nor an A-pose; auto-rigging works best with arms away from the body.');

  // --- Neck and head --------------------------------------------------------------
  const shoulderY = (joints.leftUpperArm[1] + joints.rightUpperArm[1]) / 2;
  const centralWidth = (yi: number) => {
    const r = runsInRow(yi).find((q) => q[0] <= x0i && q[1] >= x0i);
    return r ? r[1] - r[0] + 1 : 0;
  };
  const neckSearch0 = yiOf(shoulderY + 0.02 * H);
  const neckSearch1 = yiOf(shoulderY + 0.6 * (maxY - shoulderY));
  let neckMinYi = neckSearch0, neckMinW = Infinity;
  for (let yi = neckSearch0; yi <= neckSearch1; yi++) {
    const w = centralWidth(yi);
    if (w > 0 && w < neckMinW) { neckMinW = w; neckMinYi = yi; }
  }
  const neckMinY = wy(neckMinYi);
  const rowCenterZ = (y: number, halfWidth: number) => {
    const yi = yiOf(y);
    let sz = 0, c = 0;
    for (let xi = xiOf(x0 - halfWidth); xi <= xiOf(x0 + halfWidth); xi++) {
      const k = xi + g.nx * yi;
      if (xi >= 0 && xi < g.nx && sil.zCount[k]) { sz += sil.zSum[k]; c += sil.zCount[k]; }
    }
    return c ? sz / c : 0;
  };
  const neckY = shoulderY + 0.5 * (neckMinY - shoulderY);
  const headY = Math.min(neckMinY + 0.025 * H, maxY - 0.05 * H);
  const shoulderHalf = Math.abs(joints.leftUpperArm[0] - joints.rightUpperArm[0]) / 2;
  joints.neck = [x0, neckY, rowCenterZ(neckY, 0.3 * shoulderHalf)];
  joints.head = [x0, headY, rowCenterZ(headY, 0.3 * shoulderHalf)];
  tails.head = [x0, maxY, joints.head[2]];

  // --- Spine ----------------------------------------------------------------------
  const torsoHalf = 0.6 * shoulderHalf;
  const hipsY = hipY + 0.01 * H;
  joints.hips = [x0, hipsY, rowCenterZ(hipsY, torsoHalf)];
  for (const [bone, f] of [['spine', 0.2], ['chest', 0.47], ['upperChest', 0.72]] as const) {
    const y = hipsY + f * (neckY - hipsY);
    joints[bone] = [x0, y, rowCenterZ(y, torsoHalf)];
  }
  for (const side of [1, -1] as const) {
    const name = side === 1 ? 'left' : 'right';
    const ua = joints[`${name}UpperArm`];
    const y = Math.max(ua[1], joints.upperChest[1] + 0.01 * H);
    joints[`${name}Shoulder`] = [x0 + 0.3 * (ua[0] - x0), Math.min(y, neckY), ua[2]];
  }

  // --- Fingers --------------------------------------------------------------------
  let fingers: DetectResult['fingers'] = null;
  if (options.fingers !== false) {
    const left = detectFingers(positions, index, {
      side: 'left', wrist: joints.leftHand, tip: tails.leftHand, height: H,
    });
    const right = detectFingers(positions, index, {
      side: 'right', wrist: joints.rightHand, tip: tails.rightHand, height: H,
    });
    Object.assign(joints, left.joints, right.joints);
    Object.assign(tails, left.tails, right.tails);
    delete tails.leftHand;
    delete tails.rightHand;
    fingers = { left: left.detection, right: right.detection };
    for (const [n, f] of [['left', left.detection], ['right', right.detection]] as const) {
      if (f.method === 'template') notes.push(`Could not see separate fingers on the ${n} hand; finger bones were placed from hand proportions.`);
    }
    // On a symmetric body the hands should agree. A hand whose knuckles make it point
    // away from its forearm would be twisted at the wrist by every animation, so when
    // one hand is clearly off and the other isn't, mirror the good one.
    const armsSymmetric = ['UpperArm', 'LowerArm', 'Hand'].every((b) => {
      const l = joints[`left${b}`], r = joints[`right${b}`];
      return Math.hypot(l[0] - x0 + (r[0] - x0), l[1] - r[1], l[2] - r[2]) < 0.02 * H;
    });
    const deviation = (side: 'left' | 'right') => {
      const fore = normalize(sub(joints[`${side}Hand`], joints[`${side}LowerArm`]));
      const hand = normalize(sub(joints[`${side}MiddleProximal`], joints[`${side}Hand`]));
      return (Math.acos(Math.max(-1, Math.min(1, fore[0] * hand[0] + fore[1] * hand[1] + fore[2] * hand[2]))) * 180) / Math.PI;
    };
    if (armsSymmetric && joints.leftMiddleProximal && joints.rightMiddleProximal) {
      const dl = deviation('left'), dr = deviation('right');
      if (Math.max(dl, dr) > 15 && Math.abs(dl - dr) > 10) {
        const good = dl < dr ? 'left' : 'right';
        const bad = good === 'left' ? 'right' : 'left';
        const gw = joints[`${good}Hand`], bw = joints[`${bad}Hand`];
        for (const src of [joints, tails]) {
          for (const name of Object.keys(src)) {
            if (!name.startsWith(good) || !/(Thumb|Index|Middle|Ring|Little)/.test(name)) continue;
            const p = src[name];
            src[`${bad}${name.slice(good.length)}`] = [bw[0] - (p[0] - gw[0]), bw[1] + (p[1] - gw[1]), bw[2] + (p[2] - gw[2])];
          }
        }
        fingers[bad] = { ...fingers[good] };
        notes.push(`The ${bad} hand's fingers were unclear, so they mirror the ${good} hand's.`);
      }
    }
  }

  let confidence = 1;
  confidence -= notes.length * 0.15;
  if (pose === 'unknown') confidence -= 0.2;
  return {
    joints,
    tails,
    confidence: Math.max(0.05, Math.min(1, confidence)),
    notes,
    pose,
    fingers,
    measurements: { centerX: x0, crotchY, shoulderY, neckY: neckMinY, height: H },
  };
}

function frontSilhouette(g: VoxelGrid): Silhouette {
  const occ = new Uint8Array(g.nx * g.ny);
  const surf = new Uint8Array(g.nx * g.ny);
  const zSum = new Float32Array(g.nx * g.ny);
  const zCount = new Uint16Array(g.nx * g.ny);
  for (let z = 0; z < g.nz; z++) {
    const wz = g.origin[2] + (z + 0.5) * g.dx;
    for (let y = 0; y < g.ny; y++)
      for (let x = 0; x < g.nx; x++) {
        if (g.data[x + g.nx * (y + g.ny * z)] === EMPTY) continue;
        const k = x + g.nx * y;
        occ[k] = 1;
        if (g.data[x + g.nx * (y + g.ny * z)] === SURFACE) surf[k] = 1;
        zSum[k] += wz;
        zCount[k]++;
      }
  }
  return { occ, surf, zSum, zCount };
}

/** Mirrors joints from one side to the other across the x = centerX plane. */
export function symmetrizeJoints(map: JointMap, from: 'left' | 'right', centerX = 0): JointMap {
  const joints = { ...map.joints };
  const tails = { ...map.tails };
  for (const src of [joints, tails]) {
    for (const name of Object.keys(src)) {
      if (!name.startsWith(from)) continue;
      const p = src[name];
      src[mirrorBoneName(name)] = [2 * centerX - p[0], p[1], p[2]];
    }
  }
  for (const name of ['hips', 'spine', 'chest', 'upperChest', 'neck', 'head']) {
    if (joints[name]) joints[name] = [centerX, joints[name][1], joints[name][2]];
  }
  if (tails.head) tails.head = [centerX, tails.head[1], tails.head[2]];
  return { joints, tails };
}

// --- small vector helpers --------------------------------------------------------
export function sub(a: V3, b: V3): V3 { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
export function add(a: V3, b: V3): V3 { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
export function scale(a: V3, s: number): V3 { return [a[0] * s, a[1] * s, a[2] * s]; }
export function length(a: V3): number { return Math.hypot(a[0], a[1], a[2]); }
export function normalize(a: V3): V3 { const l = length(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }
export function polylineLength(pts: V3[]): number {
  let l = 0;
  for (let i = 1; i < pts.length; i++) l += length(sub(pts[i], pts[i - 1]));
  return l;
}
export function pointAlong(pts: V3[], distance: number): V3 {
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const seg = length(sub(pts[i], pts[i - 1]));
    if (acc + seg >= distance && seg > 0) {
      const t = (distance - acc) / seg;
      return add(pts[i - 1], scale(sub(pts[i], pts[i - 1]), t));
    }
    acc += seg;
  }
  return pts[pts.length - 1];
}
