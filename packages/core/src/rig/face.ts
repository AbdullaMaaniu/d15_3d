import { Float32BufferAttribute, type BufferGeometry, type Mesh, type SkinnedMesh } from 'three';
import type { BoneDef, JointMap } from '../skeleton';

/**
 * Face rig for humanoids: a jaw and two eye bones (VRM humanoid names) and a set
 * of VRM expression presets as morph targets.
 *
 * Everything is found from the head's side profile in rig space (Y up, facing
 * +Z): the nose is the profile's most forward point, the chin is where the
 * profile steps back to the neck, and the mouth and eyes are placed between
 * them by facial proportions. The expressions are displacement fields around
 * those landmarks, so they work on any sculpted head without blendshapes of its own.
 */

type V3 = [number, number, number];

export const FACE_BONES = ['jaw', 'leftEye', 'rightEye'] as const;

/** VRM 1.0 expression presets RigForge generates, in export order. */
export const EXPRESSIONS = [
  'happy', 'angry', 'sad', 'relaxed', 'surprised',
  'aa', 'ih', 'ou', 'ee', 'oh',
  'blink', 'blinkLeft', 'blinkRight',
] as const;
export type ExpressionName = (typeof EXPRESSIONS)[number];

export interface FaceLandmarks {
  /** Jaw hinge (in front of the ears), on the midline. */
  jaw: V3;
  /** Front of the chin, and the underside where the chin meets the neck. */
  chin: V3;
  chinBottom: V3;
  /** Where the lips meet, on the midline. */
  mouth: V3;
  /** Half the mouth's width. */
  mouthHalfWidth: number;
  /** Where the lips meet across the mouth, left to right (empty when the lips aren't modelled apart). */
  lipSeam: V3[];
  noseTip: V3;
  /** Eyeball centres. */
  leftEye: V3;
  rightEye: V3;
  eyeRadius: number;
  /** Height of the brows. */
  browY: number;
  centerX: number;
  /** Chin to crown. */
  headHeight: number;
  /** Separate eyeball meshes were found (so the eye bones move real geometry). */
  eyeMeshes: boolean;
  /** The profile showed a nose and chin; false means a featureless head placed by proportions. */
  features: boolean;
}

/** Jaw and eye bones, parented to the head. */
export function faceDefs(): BoneDef[] {
  return [
    { name: 'jaw', parent: 'head', primaryChild: null, side: null, isFinger: false },
    { name: 'leftEye', parent: 'head', primaryChild: null, side: 'left', isFinger: false },
    { name: 'rightEye', parent: 'head', primaryChild: null, side: 'right', isFinger: false },
  ];
}

/** Joint positions and tails for the face bones. */
export function faceJoints(f: FaceLandmarks): JointMap {
  const fwd = (p: V3): V3 => [p[0], p[1], p[2] + f.eyeRadius];
  return {
    joints: { jaw: f.jaw, leftEye: f.leftEye, rightEye: f.rightEye },
    tails: { jaw: f.chin, leftEye: fwd(f.leftEye), rightEye: fwd(f.rightEye) },
  };
}

/**
 * Finds the face on a humanoid head. Returns null when there is no head to
 * speak of (the skeleton has no head joint or the head region is empty).
 */
export function detectFace(positions: ArrayLike<number>, index: ArrayLike<number> | null, map: JointMap, centerX?: number): FaceLandmarks | null {
  const head = map.joints.head;
  const crown = map.tails.head;
  const neck = map.joints.neck;
  if (!head || !crown) return null;
  const x0 = centerX ?? head[0];
  const crownY = crown[1];
  // Rough head length from the head joint (at the skull base) to the crown.
  const top = crownY - head[1];
  if (top <= 0) return null;
  const L = top / 0.8;
  const R = 0.75 * L;
  const yLo = neck ? Math.max(neck[1], head[1] - 0.6 * L) : head[1] - 0.6 * L;

  // Head vertices: above the neck, within reach of the head's axis.
  const cand: number[] = [];
  for (let i = 0; i < positions.length; i += 3) {
    const y = positions[i + 1];
    if (y < yLo || y > crownY + 0.01) continue;
    const dx = positions[i] - x0, dz = positions[i + 2] - head[2];
    if (dx * dx + dz * dz < R * R) cand.push(i / 3);
  }
  if (cand.length < 50) return null;

  // Side profile on the midline: the most forward and the rearmost point per height.
  const res = L / 120;
  const nb = Math.ceil((crownY - yLo) / res) + 1;
  const front = new Float32Array(nb).fill(-Infinity);
  const back = new Float32Array(nb).fill(Infinity);
  const strip = 0.035 * L;
  for (const v of cand) {
    const x = positions[v * 3], y = positions[v * 3 + 1], z = positions[v * 3 + 2];
    if (Math.abs(x - x0) > strip) continue;
    const b = Math.min(nb - 1, Math.max(0, Math.round((y - yLo) / res)));
    // Each side only from its own half, so a sparse bin can't read the face as the back.
    if (z > head[2] && z > front[b]) front[b] = z;
    if (z < head[2] && z < back[b]) back[b] = z;
  }
  fillGaps(front);
  fillGaps(back);
  const bin = (y: number) => Math.min(nb - 1, Math.max(0, Math.round((y - yLo) / res)));
  const yOf = (b: number) => yLo + b * res;
  const frontAt = (y: number) => front[bin(y)];

  // Nose tip: the most forward point of the face.
  let nb0 = bin(head[1] - 0.15 * L), nb1 = bin(crownY - 0.25 * L);
  let noseB = nb0;
  for (let b = nb0; b <= nb1; b++) if (front[b] > front[noseB]) noseB = b;
  // The middle of the tip, when it's flat for a few bins.
  let t0 = noseB, t1 = noseB;
  while (t0 > nb0 && front[t0 - 1] > front[noseB] - 0.004 * L) t0--;
  while (t1 < nb1 && front[t1 + 1] > front[noseB] - 0.004 * L) t1++;
  noseB = Math.round((t0 + t1) / 2);
  const noseY = yOf(noseB), noseZ = front[noseB];

  // Chin: scanning down from below the nose, where the profile steps back to the neck.
  const lipZ = frontAt(noseY - 0.15 * L);
  let chinY = NaN;
  // (It has to stay back for a few bins: a sparse mesh leaves odd bins.)
  const back3 = (b: number) => [b, b - 1, b - 2].every((k) => k < 0 || front[k] < lipZ - 0.18 * L);
  for (let b = bin(noseY - 0.15 * L); b >= 0; b--) {
    if (back3(b)) {
      chinY = yOf(b + 1);
      break;
    }
  }
  // A nose stands out from the face just above and below it; an egg-shaped head has none.
  const bump = noseZ - Math.max(frontAt(noseY + 0.11 * L), frontAt(noseY - 0.11 * L));
  const features = Number.isFinite(chinY) && bump > 0.03 * L && noseY - chinY > 0.18 * L && noseY - chinY < 0.6 * L;
  if (!features) chinY = Math.max(yLo, crownY - L);
  if (!features) {
    // No readable profile: place the face on proportions of the head length.
    nb0 = bin(chinY + 0.36 * L);
    nb1 = nb0;
    noseB = nb0;
  }
  const nY = features ? noseY : chinY + 0.36 * L;
  const nZ = features ? noseZ : frontAt(nY);
  const headHeight = crownY - chinY;
  const noseChin = nY - chinY;
  const mouthY = nY - 0.4 * noseChin;
  const eyeY = nY + 0.5 * noseChin;
  const mouthZ = frontAt(mouthY);
  const chinZ = Math.max(...range(bin(chinY), bin(chinY + 0.3 * noseChin)).map((b) => front[b]));
  const midZ = (z: number, y: number) => (z + back[bin(y)]) / 2;

  // Skull centre at eye height (the face, not the nose, sets its depth).
  const eyeFront = frontAt(eyeY + 0.03 * L);
  const skullMidZ = midZ(eyeFront, eyeY);
  const s = headHeight / 0.23;
  const eyeHalf = 0.031 * s;
  const eyeRadius = 0.0115 * s;

  // Eyeballs: separate meshes near the expected spots, else the surface there minus a radius.
  const comps = index ? smallComponents(positions, index, cand, 0.06 * s) : [];
  let eyeMeshes = false;
  const eyes: V3[] = [];
  for (const side of [1, -1]) {
    const guess: V3 = [x0 + side * eyeHalf, eyeY, 0];
    let surf = -Infinity;
    for (const v of cand) {
      const x = positions[v * 3], y = positions[v * 3 + 1], z = positions[v * 3 + 2];
      if (Math.abs(x - guess[0]) < 0.006 * s && Math.abs(y - eyeY) < 0.006 * s && z > surf) surf = z;
    }
    if (!Number.isFinite(surf)) surf = eyeFront;
    guess[2] = surf - eyeRadius;
    const near = comps.find((c) => Math.hypot(c.center[0] - guess[0], c.center[1] - guess[1], c.center[2] - guess[2]) < 0.02 * s && c.size < 0.045 * s);
    if (near) {
      eyes.push(near.center);
      eyeMeshes = true;
    } else eyes.push(guess);
  }
  if (eyeMeshes && eyes.length === 2) {
    // Keep them level and mirrored.
    const y = (eyes[0][1] + eyes[1][1]) / 2, z = (eyes[0][2] + eyes[1][2]) / 2, hx = (Math.abs(eyes[0][0] - x0) + Math.abs(eyes[1][0] - x0)) / 2;
    eyes[0] = [x0 + hx, y, z];
    eyes[1] = [x0 - hx, y, z];
  }

  // The lips' seam: the crease between the upper and lower lip, traced across the mouth.
  const lipSeam = features && index ? traceLipSeam(positions, index, x0, mouthY, mouthZ, s) : [];
  const mouthHalfWidth = lipSeam.length ? Math.min(0.03 * s, Math.max(0.016 * s, lipSeam[lipSeam.length - 1][0] - x0)) : 0.024 * s;
  const seamMid = lipSeam.length ? seamAt(lipSeam, x0) : null;

  // Jaw hinge: just below eye height, a little in front of the skull's middle.
  const jawY = nY + 0.2 * (eyeY - nY);
  const jawZ = skullMidZ + 0.02 * s;
  return {
    jaw: [x0, jawY, jawZ],
    chin: [x0, chinY + 0.25 * noseChin, chinZ],
    chinBottom: [x0, chinY, chinZ - 0.02 * s],
    mouth: seamMid ? [x0, seamMid[0], seamMid[1]] : [x0, mouthY, mouthZ],
    mouthHalfWidth,
    lipSeam,
    noseTip: [x0, nY, nZ],
    leftEye: eyes[0],
    rightEye: eyes[1],
    eyeRadius,
    browY: eyeY + 0.022 * s,
    centerX: x0,
    headHeight,
    eyeMeshes,
    features,
  };
}

/**
 * Traces where the lips meet: renders the front of the mouth into a depth map,
 * then follows its deepest horizontal crease outward from the middle until it
 * fades at the corners. Left and right are averaged so the corners match.
 */
function traceLipSeam(positions: ArrayLike<number>, index: ArrayLike<number>, x0: number, mouthY: number, mouthZ: number, s: number): V3[] {
  const res = 0.0003 * s;
  const hw = 0.035 * s, hh = 0.014 * s;
  const W = Math.ceil((2 * hw) / res), H = Math.ceil((2 * hh) / res);
  const depth = new Float32Array(W * H).fill(-Infinity);
  const minZ = mouthZ - 0.035 * s;
  const inWin = (v: number) => Math.abs(positions[v * 3] - x0) < hw + 0.005 && Math.abs(positions[v * 3 + 1] - mouthY) < hh + 0.005 && positions[v * 3 + 2] > minZ;
  for (let t = 0; t < index.length; t += 3) {
    const a = index[t], b = index[t + 1], c = index[t + 2];
    if (!inWin(a) && !inWin(b) && !inWin(c)) continue;
    const P = [a, b, c].map((v) => [positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]]);
    const edge = Math.max(...[[0, 1], [1, 2], [2, 0]].map(([i, j]) => Math.hypot(P[i][0] - P[j][0], P[i][1] - P[j][1])));
    const n = Math.min(60, Math.max(1, Math.ceil(edge / (res * 0.7))));
    for (let i = 0; i <= n; i++) {
      for (let j = 0; i + j <= n; j++) {
        const u = i / n, v = j / n, w = 1 - u - v;
        const x = P[0][0] * w + P[1][0] * u + P[2][0] * v;
        const y = P[0][1] * w + P[1][1] * u + P[2][1] * v;
        const z = P[0][2] * w + P[1][2] * u + P[2][2] * v;
        const px = Math.floor((x - x0 + hw) / res), py = Math.floor((y - mouthY + hh) / res);
        if (px < 0 || py < 0 || px >= W || py >= H) continue;
        if (z > depth[py * W + px]) depth[py * W + px] = z;
      }
    }
  }
  const at = (px: number, py: number) => depth[py * W + px];
  // The crease in one column near row `near`: the lowest point with higher lips above and below it.
  const crease = (px: number, near: number, reach: number): number | null => {
    let best = -1, bestDepth = 0;
    const span = Math.round((0.004 * s) / res);
    for (let py = Math.max(span, near - reach); py <= Math.min(H - 1 - span, near + reach); py++) {
      const z = at(px, py);
      if (!Number.isFinite(z)) continue;
      let up = -Infinity, down = -Infinity;
      for (let k = 1; k <= span; k++) {
        up = Math.max(up, at(px, py + k));
        down = Math.max(down, at(px, py - k));
      }
      const d = Math.min(up, down) - z;
      if (d > bestDepth) { bestDepth = d; best = py; }
    }
    return best >= 0 && bestDepth > 0.0003 * s ? best : null;
  };
  const mid = Math.floor(W / 2);
  const start = crease(mid, Math.floor(H / 2), Math.round((0.008 * s) / res));
  if (start === null) return [];
  const step = Math.max(1, Math.round((0.002 * s) / res));
  const sides: number[][] = [[], []];
  for (const [k, dir] of [[0, 1], [1, -1]] as const) {
    let prev = start;
    for (let px = mid + dir * step; px >= 0 && px < W; px += dir * step) {
      const c = crease(px, prev, Math.round((0.0015 * s) / res));
      if (c === null) break;
      sides[k].push(c);
      prev = c;
    }
  }
  const reach = Math.min(sides[0].length, sides[1].length);
  if (reach < 3) return [];
  const yOf = (py: number) => mouthY - hh + (py + 0.5) * res;
  const point = (i: number): [number, number] => {
    if (i === 0) return [yOf(start), at(mid, start)];
    const a = sides[0][i - 1], b = sides[1][i - 1];
    const pxA = mid + i * step, pxB = mid - i * step;
    return [(yOf(a) + yOf(b)) / 2, (at(pxA, a) + at(pxB, b)) / 2];
  };
  const seam: V3[] = [];
  const dx = step * res;
  for (let i = reach; i >= 1; i--) seam.push([x0 - i * dx, ...point(i)]);
  for (let i = 0; i <= reach; i++) seam.push([x0 + i * dx, ...point(i)]);
  return seam;
}

/** The lip seam's height and depth at x (clamped to its ends). */
export function seamAt(seam: V3[], x: number): [number, number] {
  if (x <= seam[0][0]) return [seam[0][1], seam[0][2]];
  for (let i = 1; i < seam.length; i++) {
    if (x <= seam[i][0]) {
      const t = (x - seam[i - 1][0]) / (seam[i][0] - seam[i - 1][0]);
      return [seam[i - 1][1] + t * (seam[i][1] - seam[i - 1][1]), seam[i - 1][2] + t * (seam[i][2] - seam[i - 1][2])];
    }
  }
  const e = seam[seam.length - 1];
  return [e[1], e[2]];
}

function range(a: number, b: number): number[] {
  const out: number[] = [];
  for (let i = a; i <= b; i++) out.push(i);
  return out;
}

/** Fills empty profile bins from their neighbours. */
function fillGaps(a: Float32Array): void {
  let last = NaN;
  for (let i = 0; i < a.length; i++) {
    if (Number.isFinite(a[i])) last = a[i];
    else if (Number.isFinite(last)) a[i] = last;
  }
  last = NaN;
  for (let i = a.length - 1; i >= 0; i--) {
    if (Number.isFinite(a[i])) last = a[i];
    else if (Number.isFinite(last)) a[i] = last;
  }
}

/** Connected pieces of the mesh made only of head vertices and smaller than `maxSize`. */
function smallComponents(positions: ArrayLike<number>, index: ArrayLike<number>, verts: number[], maxSize: number) {
  const inHead = new Map<number, number>();
  verts.forEach((v, i) => inHead.set(v, i));
  const parent = new Int32Array(verts.length).map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]];
    return i;
  };
  const outside = new Uint8Array(verts.length);
  for (let t = 0; t < index.length; t += 3) {
    const a = inHead.get(index[t]), b = inHead.get(index[t + 1]), c = inHead.get(index[t + 2]);
    const ids = [a, b, c].filter((x): x is number => x !== undefined);
    if (ids.length < 3) {
      for (const i of ids) outside[i] = 1;
      continue;
    }
    parent[find(ids[0])] = find(ids[1]);
    parent[find(ids[1])] = find(ids[2]);
  }
  const groups = new Map<number, { lo: V3; hi: V3; sum: V3; n: number; open: boolean }>();
  verts.forEach((v, i) => {
    const r = find(i);
    let g = groups.get(r);
    if (!g) groups.set(r, (g = { lo: [Infinity, Infinity, Infinity], hi: [-Infinity, -Infinity, -Infinity], sum: [0, 0, 0], n: 0, open: false }));
    for (let k = 0; k < 3; k++) {
      const p = positions[v * 3 + k];
      g.lo[k] = Math.min(g.lo[k], p);
      g.hi[k] = Math.max(g.hi[k], p);
      g.sum[k] += p;
    }
    g.n++;
    if (outside[i]) g.open = true;
  });
  const out: Array<{ center: V3; size: number }> = [];
  for (const g of groups.values()) {
    if (g.open || g.n < 8) continue;
    const size = Math.max(g.hi[0] - g.lo[0], g.hi[1] - g.lo[1], g.hi[2] - g.lo[2]);
    if (size > maxSize) continue;
    // Bounding-box centre: a sphere's centre even when only its front is modelled densely.
    out.push({ center: [(g.lo[0] + g.hi[0]) / 2, (g.lo[1] + g.hi[1]) / 2, (g.lo[2] + g.hi[2]) / 2], size });
  }
  return out;
}

const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/** How much of each vertex the jaw carries (0..1), from the face landmarks. */
export function jawMask(positions: ArrayLike<number>, f: FaceLandmarks): Float32Array {
  const n = positions.length / 3;
  const out = new Float32Array(n);
  const s = f.headHeight / 0.23;
  const [, py, pz] = f.jaw;
  // Cheek plane: through the hinge and the mouth's corner (where the lips' seam ends).
  const corner = f.lipSeam?.length ? f.lipSeam[f.lipSeam.length - 1] : ([f.centerX, f.mouth[1], f.mouth[2] - 0.012 * s] as V3);
  const my = corner[1] - py, mz = corner[2] - pz;
  const mLen = Math.hypot(my, mz);
  // Underside: from the chin's underside back to the angle of the jaw.
  const gonion: V3 = [f.centerX, f.mouth[1] - 0.35 * (f.mouth[1] - f.chinBottom[1]), pz - 0.012 * s];
  const uy = gonion[1] - f.chinBottom[1], uz = gonion[2] - f.chinBottom[2];
  const uLen = Math.hypot(uy, uz);
  // Back edge: from the hinge down to the angle.
  const ry = gonion[1] - py, rz = gonion[2] - pz;
  const rLen = Math.hypot(ry, rz);
  const halfWidth = 0.075 * s;
  for (let v = 0; v < n; v++) {
    const x = positions[v * 3], y = positions[v * 3 + 1], z = positions[v * 3 + 2];
    const ax = Math.abs(x - f.centerX);
    if (ax > halfWidth || y > py + 0.01 * s || y < f.chinBottom[1] - 0.04 * s) continue;
    // Signed distance below the cheek plane (positive = jaw side).
    let below = ((y - py) * mz - (z - pz) * my) / mLen * -Math.sign(mz || 1);
    // On the lips themselves: below the seam where they meet (or the mouth's midline height).
    const [sy, sz] = f.lipSeam?.length ? seamAt(f.lipSeam, x) : [f.mouth[1], f.mouth[2]];
    const onLips = (1 - smooth(f.mouthHalfWidth * 0.85, f.mouthHalfWidth * 1.3, ax)) * smooth(sz - 0.03 * s, sz - 0.015 * s, z);
    below += (sy - y - below) * onLips;
    // The lips part sharply at the seam; over the cheeks the change is gradual.
    // Toward the corners the lips stay joined, so the mouth opens lens-shaped.
    const mw = 0.005 * s + 0.01 * s * smooth(f.mouthHalfWidth * 0.45, f.mouthHalfWidth * 1.1, ax) + 0.006 * s * (1 - onLips) * smooth(f.mouthHalfWidth, f.mouthHalfWidth * 2.2, ax);
    const wMouth = smooth(-mw, mw, below);
    // Above the underside line (positive = jaw side, the neck is below it).
    const above = ((z - f.chinBottom[2]) * uy - (y - f.chinBottom[1]) * uz) / uLen * Math.sign(uy || 1) * -1;
    const wUnder = smooth(-0.035 * s, 0.015 * s, -above);
    // In front of the back edge (positive = jaw side).
    const ahead = ((z - pz) * ry - (y - py) * rz) / rLen * Math.sign(ry || 1) * -1;
    const wBack = smooth(-0.012 * s, 0.012 * s, -ahead);
    const w = wMouth * wUnder * wBack * (1 - smooth(halfWidth * 0.8, halfWidth, ax));
    if (w > 1e-3) out[v] = w;
  }
  return out;
}

/** For each expression's deltas: how much each vertex lies inside the opened mouth (shaded dark). */
const CAVITY = new WeakMap<Float32Array, Float32Array>();

/** Which bone slot of a vertex holds a bone, or -1. */
function slotOf(skinIndex: ArrayLike<number>, skinWeight: ArrayLike<number>, v: number, bone: number): number {
  for (let k = 0; k < 4; k++) if (skinIndex[v * 4 + k] === bone && skinWeight[v * 4 + k] > 0) return k;
  return -1;
}

/** Adds weight for a bone to a vertex, evicting its smallest influence if all four slots are taken. */
function addInfluence(skinIndex: Uint16Array, skinWeight: Float32Array, v: number, bone: number, w: number): void {
  let k = slotOf(skinIndex, skinWeight, v, bone);
  if (k < 0) {
    k = 0;
    for (let j = 1; j < 4; j++) if (skinWeight[v * 4 + j] < skinWeight[v * 4 + k]) k = j;
    skinIndex[v * 4 + k] = bone;
    skinWeight[v * 4 + k] = 0;
  }
  skinWeight[v * 4 + k] += w;
  let sum = 0;
  for (let j = 0; j < 4; j++) sum += skinWeight[v * 4 + j];
  if (sum > 0) for (let j = 0; j < 4; j++) skinWeight[v * 4 + j] /= sum;
}

/**
 * Gives the jaw the lower face and the eye bones their eyeballs, taking the
 * weight from the head (and the neck under the chin). Edits the arrays in place.
 */
export function applyFaceWeights(
  positions: ArrayLike<number>,
  index: ArrayLike<number> | null,
  skinIndex: Uint16Array,
  skinWeight: Float32Array,
  boneNames: readonly string[],
  f: FaceLandmarks,
): void {
  const id = (n: string) => boneNames.indexOf(n);
  const headI = id('head'), neckI = id('neck'), jawI = id('jaw');
  if (headI < 0 || jawI < 0) return;
  const mask = jawMask(positions, f);
  const n = positions.length / 3;
  for (let v = 0; v < n; v++) {
    if (!mask[v]) continue;
    let moved = 0;
    for (let k = 0; k < 4; k++) {
      const b = skinIndex[v * 4 + k];
      if (b !== headI && b !== neckI) continue;
      // Both shares move by the same amount, so the jaw follows the smooth mask
      // rather than the noisier head/neck split of the voxel weights.
      const take = skinWeight[v * 4 + k] * mask[v];
      skinWeight[v * 4 + k] -= take;
      moved += take;
    }
    if (moved > 0) addInfluence(skinIndex, skinWeight, v, jawI, moved);
  }
  if (!f.eyeMeshes || !index) return;
  // Separate eyeballs follow their eye bone rigidly.
  const r2 = (1.6 * f.eyeRadius) ** 2;
  for (const [name, c] of [['leftEye', f.leftEye], ['rightEye', f.rightEye]] as const) {
    const bi = id(name);
    if (bi < 0) continue;
    const ball = eyeballVertices(positions, index, c, r2);
    for (const v of ball) {
      for (let k = 0; k < 4; k++) skinWeight[v * 4 + k] = 0;
      skinIndex[v * 4] = bi;
      skinWeight[v * 4] = 1;
    }
  }
}

/** Vertices of mesh pieces lying entirely within the eye's sphere. */
function eyeballVertices(positions: ArrayLike<number>, index: ArrayLike<number>, c: V3, r2: number): number[] {
  const inside = (v: number) => (positions[v * 3] - c[0]) ** 2 + (positions[v * 3 + 1] - c[1]) ** 2 + (positions[v * 3 + 2] - c[2]) ** 2 < r2;
  const near = new Set<number>();
  const n = positions.length / 3;
  for (let v = 0; v < n; v++) if (inside(v)) near.add(v);
  // Drop any piece that crosses the sphere's edge (eyelids, the face around the socket).
  const verts = [...near];
  const local = new Map(verts.map((v, i) => [v, i]));
  const parent = new Int32Array(verts.length).map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]];
    return i;
  };
  const leaks = new Set<number>();
  for (let t = 0; t < index.length; t += 3) {
    const ids = [local.get(index[t]), local.get(index[t + 1]), local.get(index[t + 2])];
    const ins = ids.filter((x): x is number => x !== undefined);
    if (ins.length === 3) {
      parent[find(ins[0])] = find(ins[1]);
      parent[find(ins[1])] = find(ins[2]);
    } else for (const i of ins) leaks.add(i);
  }
  const leakRoots = new Set([...leaks].map(find));
  return verts.filter((_, i) => !leakRoots.has(find(i)));
}

/**
 * Builds the expression morph targets (position deltas per vertex, in rig
 * space). `faceWeight` is how much of each vertex follows the head and jaw;
 * hair on its own bones and the body stay put.
 */
export function faceExpressions(
  positions: ArrayLike<number>,
  skinIndex: ArrayLike<number>,
  skinWeight: ArrayLike<number>,
  boneNames: readonly string[],
  f: FaceLandmarks,
): Record<ExpressionName, Float32Array> {
  const n = positions.length / 3;
  const s = f.headHeight / 0.23;
  const headI = boneNames.indexOf('head'), jawI = boneNames.indexOf('jaw');
  const eyeI = [boneNames.indexOf('leftEye'), boneNames.indexOf('rightEye')];
  const face = new Float32Array(n);
  const jaw = new Float32Array(n);
  const eyeball = new Uint8Array(n);
  for (let v = 0; v < n; v++) {
    for (let k = 0; k < 4; k++) {
      const b = skinIndex[v * 4 + k], w = skinWeight[v * 4 + k];
      if (b === headI || b === jawI) face[v] += w;
      if (b === jawI) jaw[v] += w;
      if ((b === eyeI[0] || b === eyeI[1]) && w > 0.5) eyeball[v] = 1;
    }
  }
  // Only the front of the face deforms.
  const frontZ = f.jaw[2];
  for (let v = 0; v < n; v++) face[v] *= smooth(frontZ - 0.01 * s, frontZ + 0.02 * s, positions[v * 3 + 2]);

  const P = f.jaw;
  const out = {} as Record<ExpressionName, Float32Array>;
  let cav: Float32Array | null = null;
  const make = (field: (x: number, y: number, z: number, v: number, d: V3) => void) => {
    const d = new Float32Array(n * 3);
    cav = null;
    const tmp: V3 = [0, 0, 0];
    for (let v = 0; v < n; v++) {
      if (face[v] < 1e-3 && !jaw[v]) continue;
      tmp[0] = tmp[1] = tmp[2] = 0;
      field(positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2], v, tmp);
      d[v * 3] = tmp[0];
      d[v * 3 + 1] = tmp[1];
      d[v * 3 + 2] = tmp[2];
    }
    if (cav) CAVITY.set(d, cav);
    return d;
  };
  // Opens the jaw by `deg` about the hinge (what the jaw bone would do, baked).
  // Lips modelled shut stretch across the opening; that skin is pulled back into
  // the mouth so it reads as the inside of the mouth rather than a membrane.
  const openJaw = (deg: number, y: number, z: number, v: number, d: V3, x = f.centerX) => {
    if (!jaw[v]) return;
    const j = jaw[v];
    const [sy] = f.lipSeam?.length ? seamAt(f.lipSeam, x) : [f.mouth[1]];
    // An ellipse around the seam, so the dark opening is lens-shaped like a mouth.
    const r = ((x - f.centerX) / (f.mouthHalfWidth * 0.95)) ** 2 + ((y - sy) / (0.012 * s)) ** 2;
    const inMouth = 1 - smooth(0.35, 1, r);
    const c = 4 * j * (1 - j) * inMouth * Math.min(1, deg / 12);
    d[2] -= c * 0.02 * s;
    if (c > 0.01) (cav ??= new Float32Array(n))[v] = c;
    const a = (deg * Math.PI) / 180;
    const dy = y - P[1], dz = z - P[2];
    // Rotating about +X by +a turns the chin down (z toward -y).
    const ny = dy * Math.cos(a) - dz * Math.sin(a);
    const nz = dy * Math.sin(a) + dz * Math.cos(a);
    d[1] += (ny - dy) * jaw[v];
    d[2] += (nz - dz) * jaw[v];
  };
  const gauss = (x: number, y: number, z: number, c: V3, r: number) => Math.exp(-((x - c[0]) ** 2 + (y - c[1]) ** 2 + (z - c[2]) ** 2) / (r * r));
  const x0 = f.centerX;
  const seamEnd = f.lipSeam?.length ? f.lipSeam[f.lipSeam.length - 1] : null;
  const corner = (side: number): V3 => (seamEnd ? [x0 + side * (seamEnd[0] - x0), seamEnd[1], seamEnd[2]] : [x0 + side * f.mouthHalfWidth, f.mouth[1] + 0.002 * s, f.mouth[2] - 0.012 * s]);
  const corners = [corner(1), corner(-1)];
  // Mouth corners: pulled by (dx outward, dy, dz).
  const corners3 = (x: number, y: number, z: number, v: number, d: V3, out_: number, up: number, back: number, r = 0.016) => {
    corners.forEach((c, i) => {
      const g = gauss(x, y, z, c, r * s) * face[v];
      const side = i === 0 ? 1 : -1;
      d[0] += side * out_ * s * g;
      d[1] += up * s * g;
      d[2] -= back * s * g;
    });
  };
  // Lips pushed forward and gathered toward the middle.
  const pucker = (x: number, y: number, z: number, v: number, d: V3, amount: number) => {
    const g = gauss(x, y, z, [x0, f.mouth[1], f.mouth[2] - 0.005 * s], 0.026 * s) * face[v];
    d[0] -= (x - x0) * amount * g;
    d[2] += 0.012 * s * amount * g;
  };
  const brow = (x: number, y: number, z: number, v: number, d: V3, innerUp: number, outerUp: number, inward: number) => {
    for (const [i, side] of [[0, 1], [1, -1]] as const) {
      const eye = i === 0 ? f.leftEye : f.rightEye;
      const inner: V3 = [x0 + side * 0.012 * s, f.browY, eye[2] + f.eyeRadius];
      const outer: V3 = [eye[0] + side * 0.012 * s, f.browY + 0.002 * s, eye[2] + f.eyeRadius * 0.6];
      const gi = gauss(x, y, z, inner, 0.014 * s) * face[v];
      const go = gauss(x, y, z, outer, 0.016 * s) * face[v];
      d[1] += (innerUp * gi + outerUp * go) * s;
      d[0] -= side * inward * s * gi;
    }
  };
  // Eyelids closing over the eye: the upper lid comes down to just below the eye's middle.
  const lids = (x: number, y: number, z: number, v: number, d: V3, amount: number, which: number[]) => {
    if (eyeball[v]) return;
    for (const i of which) {
      const e = i === 0 ? f.leftEye : f.rightEye;
      const rx = 1.5 * f.eyeRadius, ry = 1.05 * f.eyeRadius;
      const ex = (x - e[0]) / rx, ey = (y - e[1]) / ry;
      const r2 = ex * ex + ey * ey;
      if (r2 >= 1 || z < e[2]) continue;
      const k = (1 - smooth(0.45, 1, Math.sqrt(r2))) * face[v];
      const close = e[1] - 0.25 * f.eyeRadius;
      if (y > close) {
        d[1] -= (y - close) * amount * k;
        d[2] += 0.15 * f.eyeRadius * amount * k * smooth(close, e[1] + ry, y);
      } else d[1] += (close - y) * 0.3 * amount * k;
    }
  };
  const both = [0, 1];

  out.aa = make((x, y, z, v, d) => openJaw(15, y, z, v, d, x));
  out.oh = make((x, y, z, v, d) => { openJaw(10, y, z, v, d, x); pucker(x, y, z, v, d, 0.3); });
  out.ou = make((x, y, z, v, d) => { openJaw(4, y, z, v, d, x); pucker(x, y, z, v, d, 0.5); });
  out.ih = make((x, y, z, v, d) => { openJaw(7, y, z, v, d, x); corners3(x, y, z, v, d, 0.004, 0.0015, 0.001); });
  out.ee = make((x, y, z, v, d) => { openJaw(4, y, z, v, d, x); corners3(x, y, z, v, d, 0.008, 0.001, 0.003); });
  out.happy = make((x, y, z, v, d) => {
    openJaw(2, y, z, v, d, x);
    corners3(x, y, z, v, d, 0.006, 0.009, 0.004, 0.02);
    // Cheeks lift, and the lower lids with them.
    for (const [i, side] of [[0, 1], [1, -1]] as const) {
      const c = corners[i];
      const cheek: V3 = [c[0] + side * 0.012 * s, c[1] + 0.028 * s, c[2]];
      d[1] += 0.004 * s * gauss(x, y, z, cheek, 0.02 * s) * face[v];
    }
    for (const e of [f.leftEye, f.rightEye]) {
      const lower: V3 = [e[0], e[1] - 0.9 * f.eyeRadius, e[2] + f.eyeRadius];
      if (!eyeball[v]) d[1] += 0.0025 * s * gauss(x, y, z, lower, 0.008 * s) * face[v];
    }
  });
  out.angry = make((x, y, z, v, d) => { brow(x, y, z, v, d, -0.006, 0.0015, 0.003); corners3(x, y, z, v, d, 0.001, -0.004, 0); lids(x, y, z, v, d, 0.15, both); });
  out.sad = make((x, y, z, v, d) => { brow(x, y, z, v, d, 0.006, -0.001, 0.001); corners3(x, y, z, v, d, -0.001, -0.006, -0.001); lids(x, y, z, v, d, 0.2, both); });
  out.relaxed = make((x, y, z, v, d) => { corners3(x, y, z, v, d, 0.002, 0.003, 0.001); lids(x, y, z, v, d, 0.45, both); });
  out.surprised = make((x, y, z, v, d) => { openJaw(9, y, z, v, d, x); brow(x, y, z, v, d, 0.008, 0.007, 0); pucker(x, y, z, v, d, 0.12); });
  out.blink = make((x, y, z, v, d) => lids(x, y, z, v, d, 1, both));
  out.blinkLeft = make((x, y, z, v, d) => lids(x, y, z, v, d, 1, [0]));
  out.blinkRight = make((x, y, z, v, d) => lids(x, y, z, v, d, 1, [1]));
  return out;
}

/**
 * Puts the expressions on a skinned mesh as named morph targets (VRM preset
 * names), which glTF export writes out with the mesh.
 */
export function attachExpressions(mesh: Mesh, f: FaceLandmarks): ExpressionName[] {
  const g = mesh.geometry;
  const fields = faceExpressions(
    g.attributes.position.array as ArrayLike<number>,
    g.attributes.skinIndex.array as ArrayLike<number>,
    g.attributes.skinWeight.array as ArrayLike<number>,
    (mesh as SkinnedMesh).skeleton.bones.map((b) => b.name),
    f,
  );
  // The opened lips follow the mesh's triangles, which zigzag; relax them along the surface.
  const neighbours = adjacency(g);
  for (const name of EXPRESSIONS) {
    const cavity = CAVITY.get(fields[name]);
    if (cavity) relaxMouth(fields[name], cavity, neighbours);
  }
  g.morphAttributes.position = EXPRESSIONS.map((name) => {
    const a = new Float32BufferAttribute(fields[name], 3);
    a.name = name;
    return a;
  });
  // Normals follow the shape, so a stretched or folded face shades smoothly.
  const base = normalsOf(g, null);
  if (g.attributes.normal && !(globalThis as any).RF_NO_MORPH_NORMALS) {
    g.morphAttributes.normal = EXPRESSIONS.map((name) => {
      const n = normalsOf(g, fields[name]);
      const out = new Float32Array(n.length);
      const delta = fields[name];
      // Inside the open mouth the normals turn away from the light: no interior is modelled, so it reads as shadow.
      const cavity = CAVITY.get(delta);
      if (cavity) {
        for (let v = 0; v < cavity.length; v++) {
          const c = Math.min(1, cavity[v] * 2.5);
          if (!c) continue;
          const nx = n[v * 3] * (1 - c), ny = n[v * 3 + 1] * (1 - c), nz = n[v * 3 + 2] * (1 - c) - c;
          const l = Math.hypot(nx, ny, nz) || 1;
          n[v * 3] = nx / l;
          n[v * 3 + 1] = ny / l;
          n[v * 3 + 2] = nz / l;
        }
      }
      for (let v = 0; v < n.length / 3; v++) {
        // Only where the face moved (keeps the targets sparse).
        if (!delta[v * 3] && !delta[v * 3 + 1] && !delta[v * 3 + 2] && !moved(v)) continue;
        for (let k = 0; k < 3; k++) out[v * 3 + k] = n[v * 3 + k] - base[v * 3 + k];
      }
      return new Float32BufferAttribute(out, 3);
      function moved(v: number) {
        return Math.abs(n[v * 3] - base[v * 3]) + Math.abs(n[v * 3 + 1] - base[v * 3 + 1]) + Math.abs(n[v * 3 + 2] - base[v * 3 + 2]) > 1e-4;
      }
    });
  }
  g.morphTargetsRelative = true;
  mesh.updateMorphTargets();
  return [...EXPRESSIONS];
}

/** Smooth vertex normals of the geometry, optionally with position deltas added. */
function normalsOf(g: BufferGeometry, delta: Float32Array | null): Float32Array {
  const p = g.attributes.position.array as ArrayLike<number>;
  const idx = g.index?.array as ArrayLike<number> | undefined;
  const n = p.length / 3;
  const pos = new Float32Array(n * 3);
  for (let i = 0; i < n * 3; i++) pos[i] = p[i] + (delta ? delta[i] : 0);
  // Shared positions (UV seams) share a normal, as in the merged mesh.
  const out = new Float32Array(n * 3);
  const tris = idx ? idx.length / 3 : n / 3;
  for (let t = 0; t < tris; t++) {
    const a = idx ? idx[t * 3] : t * 3, b = idx ? idx[t * 3 + 1] : t * 3 + 1, c = idx ? idx[t * 3 + 2] : t * 3 + 2;
    const ux = pos[b * 3] - pos[a * 3], uy = pos[b * 3 + 1] - pos[a * 3 + 1], uz = pos[b * 3 + 2] - pos[a * 3 + 2];
    const vx = pos[c * 3] - pos[a * 3], vy = pos[c * 3 + 1] - pos[a * 3 + 1], vz = pos[c * 3 + 2] - pos[a * 3 + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const v of [a, b, c]) {
      out[v * 3] += nx;
      out[v * 3 + 1] += ny;
      out[v * 3 + 2] += nz;
    }
  }
  for (let v = 0; v < n; v++) {
    const l = Math.hypot(out[v * 3], out[v * 3 + 1], out[v * 3 + 2]) || 1;
    out[v * 3] /= l;
    out[v * 3 + 1] /= l;
    out[v * 3 + 2] /= l;
  }
  return out;
}

/** Vertex neighbours over the triangles, with vertices at the same position merged (UV seams). */
function adjacency(g: BufferGeometry): Int32Array[] {
  const p = g.attributes.position.array as ArrayLike<number>;
  const n = p.length / 3;
  const key = new Map<string, number>();
  const rep = new Int32Array(n);
  for (let v = 0; v < n; v++) {
    const k = `${p[v * 3].toFixed(5)},${p[v * 3 + 1].toFixed(5)},${p[v * 3 + 2].toFixed(5)}`;
    const r = key.get(k);
    if (r === undefined) { key.set(k, v); rep[v] = v; } else rep[v] = r;
  }
  const sets = new Map<number, Set<number>>();
  const idx = g.index?.array as ArrayLike<number> | undefined;
  const tris = idx ? idx.length / 3 : n / 3;
  for (let t = 0; t < tris; t++) {
    const vs = [0, 1, 2].map((k) => rep[idx ? idx[t * 3 + k] : t * 3 + k]);
    for (const a of vs) for (const b of vs) if (a !== b) {
      let set = sets.get(a);
      if (!set) sets.set(a, (set = new Set()));
      set.add(b);
    }
  }
  const out: Int32Array[] = new Array(n);
  const empty = new Int32Array(0);
  for (let v = 0; v < n; v++) {
    const set = sets.get(rep[v]);
    out[v] = set ? Int32Array.from(set) : empty;
  }
  return out;
}

/** Averages the deltas (and the cavity) of the opened mouth's vertices with their neighbours'. */
function relaxMouth(delta: Float32Array, cavity: Float32Array, nb: Int32Array[]): void {
  const n = cavity.length;
  // The region: the mouth and a ring around it.
  const region: number[] = [];
  const inRegion = new Uint8Array(n);
  for (let v = 0; v < n; v++) if (cavity[v] > 0) { inRegion[v] = 1; region.push(v); }
  for (let ring = 0; ring < 2; ring++) {
    for (const v of [...region]) for (const u of nb[v]) if (!inRegion[u]) { inRegion[u] = 1; region.push(u); }
  }
  const tmp = new Float32Array(n * 3), tc = new Float32Array(n);
  for (let pass = 0; pass < 6; pass++) {
    for (const v of region) {
      let x = delta[v * 3], y = delta[v * 3 + 1], z = delta[v * 3 + 2], c = cavity[v], k = 1;
      for (const u of nb[v]) { x += delta[u * 3]; y += delta[u * 3 + 1]; z += delta[u * 3 + 2]; c += cavity[u]; k++; }
      tmp[v * 3] = x / k; tmp[v * 3 + 1] = y / k; tmp[v * 3 + 2] = z / k; tc[v] = c / k;
    }
    for (const v of region) {
      delta[v * 3] = tmp[v * 3]; delta[v * 3 + 1] = tmp[v * 3 + 1]; delta[v * 3 + 2] = tmp[v * 3 + 2]; cavity[v] = tc[v];
    }
  }
}
