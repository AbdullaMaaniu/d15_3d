import type { ReferenceBody } from './reference';

/**
 * A clothed test character like a Meshy export: the reference body wearing a
 * T-shirt, trousers, white trainers and short hair, all one surface with the colours
 * baked in (vertex colours). The clothes are the body's own surface pushed out
 * a little, with a step at every cuff and collar, so nothing underneath is
 * modelled: exactly what garment separation has to deal with.
 */
export interface ClothedSample {
  positions: Float32Array;
  normals: Float32Array;
  /** Linear RGB per vertex. */
  colors: Float32Array;
  index: Uint32Array;
  /** The reference body's skin weights carried over (4 per vertex, into the reference's `bones`): a ground-truth rig for tests. */
  skinIndex: Uint16Array;
  skinWeight: Float32Array;
}

type Zone = 'skin' | 'hair' | 'shirt' | 'trousers' | 'shoes';

const COLORS: Record<Zone, string> = {
  skin: '#c98d6b',
  hair: '#2b1d14',
  shirt: '#2f6290',
  trousers: '#3a3c48',
  shoes: '#e4e2dc',
};
/** How far each garment stands off the skin (m). */
const OFFSET: Record<Zone, number> = { skin: 0, hair: 0.012, shirt: 0.014, trousers: 0.016, shoes: 0.012 };

export function createClothedSample(ref: ReferenceBody): ClothedSample {
  const V = ref.positions.length / 3;
  const p = ref.positions;
  const j = ref.joints.joints;
  const normals = vertexNormals(p, ref.index);
  const zone: Zone[] = new Array(V);
  /** Distance (m) from each vertex to the nearest edge of its zone, so the edges can be snapped smooth. */
  const edge = new Float32Array(V);
  const along = (v: number, a: number[], b: number[]) => {
    const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const l2 = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
    return ((p[v * 3] - a[0]) * d[0] + (p[v * 3 + 1] - a[1]) * d[1] + (p[v * 3 + 2] - a[2]) * d[2]) / l2;
  };
  const dist = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const hem = j.hips[1] + 0.05;
  for (let v = 0; v < V; v++) {
    let bone = '', best = -1;
    for (let k = 0; k < 4; k++) if (ref.skinWeight[v * 4 + k] > best) { best = ref.skinWeight[v * 4 + k]; bone = ref.bones[ref.skinIndex[v * 4 + k]]; }
    const y = p[v * 3 + 1], z = p[v * 3 + 2];
    const side = p[v * 3] >= 0 ? 'left' : 'right';
    // The torso's sides by the elbows are weighted to the arms; they're still torso.
    if (/Arm$|Hand$/.test(bone) && Math.abs(p[v * 3]) < Math.abs(j[`${side}UpperArm`][0]) + 0.02) bone = 'chest';
    // Crew neck, lower at the front; trainers to just above the ankle.
    const collar = j.neck[1] + 0.015 - 0.045 * Math.min(1, Math.max(0, (z - j.neck[2]) / 0.08));
    const ankle = j[`${side}Foot`][1] + 0.07;
    let zn: Zone, d: number;
    if (bone === 'head' || (bone === 'neck' && y > collar)) {
      // Hairline: high on the forehead, lower towards the nape.
      const hairline = Math.max(j.head[1], 1.712 - 0.085 * Math.min(1, Math.max(0, -(z - j.head[2]) / 0.08)));
      zn = y > hairline ? 'hair' : 'skin';
      d = Math.abs(y - hairline);
      if (zn === 'skin' && y < collar + 0.06) d = Math.min(d, y - collar);
    } else if (/Hand$|LowerArm$/.test(bone)) {
      zn = 'skin';
      d = 1;
    } else if (/UpperArm$/.test(bone)) {
      // Short sleeves: the upper 45% of the upper arm.
      const a = along(v, j[`${side}UpperArm`], j[`${side}LowerArm`]);
      zn = a < 0.45 ? 'shirt' : 'skin';
      d = Math.abs(0.45 - a) * dist(j[`${side}UpperArm`], j[`${side}LowerArm`]);
      if (zn === 'shirt') d = Math.min(d, Math.abs(collar - y));
    } else if (y > collar) {
      zn = 'skin';
      d = y - collar;
    } else if (y > hem) {
      zn = 'shirt';
      d = Math.min(collar - y, y - hem);
    } else if (y > ankle) {
      zn = 'trousers';
      d = Math.min(hem - y, y - ankle);
    } else {
      zn = 'shoes';
      d = ankle - y;
    }
    zone[v] = zn;
    edge[v] = Math.max(0, d);
  }
  // Cut the triangles along the zone edges, so every edge is a crisp smooth
  // line, and join each garment's raised edge to the surface below with a wall.
  const rgb = Object.fromEntries(Object.entries(COLORS).map(([k, hex]) => [k, srgbHexToLinear(hex)])) as Record<Zone, number[]>;
  const out = { positions: [] as number[], colors: [] as number[], index: [] as number[], skinIndex: [] as number[], skinWeight: [] as number[] };
  const ids = new Map<string, number>();
  /** A vertex blended from source vertices, coloured as one zone and raised as another. */
  const vertex = (key: string, src: number[], w: number[], colour: Zone, raised: Zone, seed: number) => {
    const k = `${key}|${colour}|${raised}`;
    let id = ids.get(k);
    if (id !== undefined) return id;
    const pos = [0, 0, 0], n = [0, 0, 0];
    src.forEach((sv, i) => {
      for (let c = 0; c < 3; c++) {
        pos[c] += p[sv * 3 + c] * w[i];
        n[c] += normals[sv * 3 + c] * w[i];
      }
    });
    const l = Math.hypot(n[0], n[1], n[2]) || 1;
    // A little deterministic variation, like a baked texture.
    const shade = 1 + 0.06 * (hash(seed) - 0.5);
    for (let c = 0; c < 3; c++) {
      out.positions.push(pos[c] + (n[c] / l) * OFFSET[raised]);
      out.colors.push(rgb[colour][c] * shade);
    }
    const acc = new Map<number, number>();
    src.forEach((sv, i) => {
      for (let k = 0; k < 4; k++) acc.set(ref.skinIndex[sv * 4 + k], (acc.get(ref.skinIndex[sv * 4 + k]) ?? 0) + ref.skinWeight[sv * 4 + k] * w[i]);
    });
    const top = [...acc].sort((a, b) => b[1] - a[1]).slice(0, 4);
    const sum = top.reduce((x, e) => x + e[1], 0) || 1;
    for (let k = 0; k < 4; k++) {
      out.skinIndex.push(top[k]?.[0] ?? 0);
      out.skinWeight.push((top[k]?.[1] ?? 0) / sum);
    }
    id = ids.size;
    ids.set(k, id);
    return id;
  };
  const corner = (v: number, z: Zone = zone[v]) => vertex(`v${v}`, [v], [1], z, z, v);
  const crossing = (a: number, b: number, colour: Zone, raised: Zone) => {
    if (a > b) [a, b] = [b, a];
    const t = edge[a] / (edge[a] + edge[b] || 1);
    return vertex(`e${a}_${b}`, [a, b], [1 - t, t], colour, raised, a + b);
  };
  const tri = (a: number, b: number, c: number) => out.index.push(a, b, c);
  const polygon = (ids: number[]) => {
    for (let i = 1; i + 1 < ids.length; i++) tri(ids[0], ids[i], ids[i + 1]);
  };
  const I = ref.index;
  for (let t = 0; t < I.length; t += 3) {
    const c = [I[t], I[t + 1], I[t + 2]];
    const z = c.map((v) => zone[v]);
    if (z[0] === z[1] && z[1] === z[2]) {
      polygon(c.map((v) => corner(v)));
      continue;
    }
    if (z[0] !== z[1] && z[1] !== z[2] && z[0] !== z[2]) {
      // Three zones meet: a kite per corner (no walls; rare).
      const centre = (zc: Zone) => vertex(`c${t}`, c, [1 / 3, 1 / 3, 1 / 3], zc, zc, t);
      for (let i = 0; i < 3; i++) {
        const j = (i + 1) % 3, k = (i + 2) % 3;
        polygon([corner(c[i]), crossing(c[i], c[j], z[i], z[i]), centre(z[i]), crossing(c[k], c[i], z[i], z[i])]);
      }
      continue;
    }
    // One corner alone in its zone.
    const k = z[0] === z[1] ? 2 : z[1] === z[2] ? 0 : 1;
    const k1 = (k + 1) % 3, k2 = (k + 2) % 3;
    const A = z[k], B = z[k1];
    polygon([corner(c[k]), crossing(c[k], c[k1], A, A), crossing(c[k2], c[k], A, A)]);
    polygon([crossing(c[k], c[k1], B, B), corner(c[k1]), corner(c[k2]), crossing(c[k2], c[k], B, B)]);
    // The wall from the raised zone down to the other, in the raised zone's colour.
    const [hi, lo] = OFFSET[A] >= OFFSET[B] ? [A, B] : [B, A];
    if (OFFSET[hi] === OFFSET[lo]) continue;
    const top = [crossing(c[k], c[k1], hi, hi), crossing(c[k2], c[k], hi, hi)];
    const bottom = [crossing(c[k], c[k1], hi, lo), crossing(c[k2], c[k], hi, lo)];
    // Facing away from the raised side: the alone corner's side when it's the lower zone.
    if (hi === A) polygon([top[1], top[0], bottom[0], bottom[1]]);
    else polygon([top[0], top[1], bottom[1], bottom[0]]);
  }
  const positions = Float32Array.from(out.positions);
  const index = Uint32Array.from(out.index);
  // Soles stay on the ground.
  let minY = Infinity;
  for (let i = 1; i < positions.length; i += 3) minY = Math.min(minY, positions[i]);
  for (let i = 1; i < positions.length; i += 3) positions[i] -= minY;
  return {
    positions,
    normals: vertexNormals(positions, index),
    colors: Float32Array.from(out.colors),
    index,
    skinIndex: Uint16Array.from(out.skinIndex),
    skinWeight: Float32Array.from(out.skinWeight),
  };
}

function hash(i: number): number {
  let x = (i * 2654435761) >>> 0;
  x ^= x >>> 15;
  x = Math.imul(x, 2246822519) >>> 0;
  x ^= x >>> 13;
  return (x >>> 0) / 4294967296;
}

function srgbHexToLinear(hex: string): number[] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
}

function vertexNormals(p: ArrayLike<number>, index: ArrayLike<number>): Float32Array {
  const out = new Float32Array(p.length);
  for (let t = 0; t < index.length; t += 3) {
    const a = index[t], b = index[t + 1], c = index[t + 2];
    const ux = p[b * 3] - p[a * 3], uy = p[b * 3 + 1] - p[a * 3 + 1], uz = p[b * 3 + 2] - p[a * 3 + 2];
    const vx = p[c * 3] - p[a * 3], vy = p[c * 3 + 1] - p[a * 3 + 1], vz = p[c * 3 + 2] - p[a * 3 + 2];
    const n = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
    for (const v of [a, b, c]) for (let k = 0; k < 3; k++) out[v * 3 + k] += n[k];
  }
  for (let v = 0; v < out.length / 3; v++) {
    const l = Math.hypot(out[v * 3], out[v * 3 + 1], out[v * 3 + 2]) || 1;
    for (let k = 0; k < 3; k++) out[v * 3 + k] /= l;
  }
  return out;
}
