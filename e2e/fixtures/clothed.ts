import { readFileSync } from 'node:fs';
import { Document, NodeIO } from '@gltf-transform/core';
import { decodeReferenceBody } from '../../packages/core/src/body/reference';

/**
 * A clothed test character: the reference body (skin) in a loose T-shirt and an
 * A-line skirt to mid-calf, each its own material so the Parts step can split
 * them by colour. The garments are separate shells around the body, like many
 * AI-generated characters.
 */
export function clothedCharacter(): { positions: Float32Array; parts: Array<{ name: string; color: [number, number, number]; index: Uint32Array }> } {
  const ref = decodeReferenceBody(readFileSync(new URL('../../packages/core/assets/reference-body.bin', import.meta.url)));
  const P = ref.positions, I = ref.index;
  const V = P.length / 3;
  const J = ref.joints.joints;

  // Smooth vertex normals.
  const N = new Float32Array(V * 3);
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const o of [a, b, c]) (N[o] += nx), (N[o + 1] += ny), (N[o + 2] += nz);
  }
  for (let o = 0; o < N.length; o += 3) {
    const l = Math.hypot(N[o], N[o + 1], N[o + 2]) || 1;
    N[o] /= l;
    N[o + 1] /= l;
    N[o + 2] /= l;
  }
  const dominant = new Array<string>(V);
  for (let v = 0; v < V; v++) {
    let k = 0;
    for (let j = 1; j < 4; j++) if (ref.skinWeight[v * 4 + j] > ref.skinWeight[v * 4 + k]) k = j;
    dominant[v] = ref.bones[ref.skinIndex[v * 4 + k]];
  }
  const smooth = (e0: number, e1: number, x: number) => {
    const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
  };

  const out: number[] = Array.from(P);
  const parts: Array<{ name: string; color: [number, number, number]; index: Uint32Array }> = [];
  parts.push({ name: 'Skin', color: [0.85, 0.62, 0.48], index: Uint32Array.from(I) });

  // T-shirt: the torso and upper arms, offset out, looser towards the hem.
  const hipsY = J.hips[1], chestY = J.chest[1];
  const hemY = hipsY + 0.02;
  const shirtBones = new Set(['spine', 'chest', 'upperChest', 'leftShoulder', 'rightShoulder', 'leftUpperArm', 'rightUpperArm', 'hips']);
  const inShirt = (v: number) => {
    if (!shirtBones.has(dominant[v])) return false;
    if (P[v * 3 + 1] < hemY) return false;
    // Short sleeves: stop partway down the upper arm.
    for (const side of ['left', 'right']) {
      if (dominant[v] !== `${side}UpperArm`) continue;
      const a = J[`${side}UpperArm`], b = J[`${side}LowerArm`];
      const t = ((P[v * 3] - a[0]) * (b[0] - a[0]) + (P[v * 3 + 1] - a[1]) * (b[1] - a[1]) + (P[v * 3 + 2] - a[2]) * (b[2] - a[2])) /
        ((b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2 + (b[2] - a[2]) ** 2);
      if (t > 0.55) return false;
    }
    return true;
  };
  const shirtMap = new Map<number, number>();
  const shirtStart = out.length / 3;
  const shirtIdx: number[] = [];
  for (let t = 0; t < I.length; t += 3) {
    if (![I[t], I[t + 1], I[t + 2]].every(inShirt)) continue;
    for (let k = 0; k < 3; k++) {
      const v = I[t + k];
      let o = shirtMap.get(v);
      if (o === undefined) {
        o = out.length / 3;
        shirtMap.set(v, o);
        const y = P[v * 3 + 1];
        const off = 0.012 + 0.03 * (1 - smooth(hemY, chestY, y));
        out.push(P[v * 3] + N[v * 3] * off, y + N[v * 3 + 1] * off, P[v * 3 + 2] + N[v * 3 + 2] * off);
      }
      shirtIdx.push(o);
    }
  }
  smoothShell(out, shirtIdx, shirtStart);
  parts.push({ name: 'Shirt', color: [0.22, 0.42, 0.7], index: Uint32Array.from(shirtIdx) });

  // Skirt: rings from the waist to mid-calf, outside the body and flaring out.
  const top = hipsY + 0.05, bottom = 0.36;
  const rows = Math.round((top - bottom) / 0.02) + 1, cols = 72;
  const cx = J.hips[0], cz = J.hips[2];
  const isLimb = (v: number) => /Arm|Hand|Thumb|Index|Middle|Ring|Little/.test(dominant[v]);
  let prev: Float32Array | null = null;
  const skirtStart = out.length / 3;
  for (let r = 0; r < rows; r++) {
    const y = top - ((top - bottom) * r) / (rows - 1);
    const reach = new Float32Array(cols);
    for (let v = 0; v < V; v++) {
      if (Math.abs(P[v * 3 + 1] - y) > 0.015 || isLimb(v)) continue;
      const dx = P[v * 3] - cx, dz = P[v * 3 + 2] - cz;
      const c = Math.floor(((Math.atan2(dz, dx) / (2 * Math.PI) + 1) % 1) * cols) % cols;
      reach[c] = Math.max(reach[c], Math.hypot(dx, dz));
    }
    // Fill gaps and smooth around the ring, then keep it outside the row above.
    const ring = new Float32Array(cols);
    for (let c = 0; c < cols; c++) {
      let m = 0;
      for (let k = -4; k <= 4; k++) m = Math.max(m, reach[(c + k + cols) % cols]);
      ring[c] = m;
    }
    for (let pass = 0; pass < 3; pass++) {
      const s = ring.slice();
      for (let c = 0; c < cols; c++) ring[c] = Math.max(ring[c], (s[(c + cols - 1) % cols] + 2 * s[c] + s[(c + 1) % cols]) / 4);
    }
    for (let c = 0; c < cols; c++) {
      ring[c] += r === 0 ? 0.008 : 0.015;
      if (prev) ring[c] = Math.max(ring[c], prev[c] + 0.0035);
      const a = ((c + 0.5) / cols) * 2 * Math.PI;
      out.push(cx + Math.cos(a) * ring[c], y, cz + Math.sin(a) * ring[c]);
    }
    prev = ring;
  }
  const skirtIdx: number[] = [];
  for (let r = 0; r < rows - 1; r++)
    for (let c = 0; c < cols; c++) {
      const a = skirtStart + r * cols + c, b = skirtStart + r * cols + ((c + 1) % cols);
      const d = a + cols, e = b + cols;
      // Outward-facing triangles.
      skirtIdx.push(a, b, d, b, e, d);
    }
  parts.push({ name: 'Skirt', color: [0.62, 0.2, 0.22], index: Uint32Array.from(skirtIdx) });
  return { positions: Float32Array.from(out), parts };
}

export async function clothedCharacterGlb(): Promise<Uint8Array> {
  const { positions, parts } = clothedCharacter();
  const doc = new Document();
  const buffer = doc.createBuffer();
  const pos = doc.createAccessor().setType('VEC3').setArray(positions).setBuffer(buffer);
  const mesh = doc.createMesh('Dancer');
  for (const part of parts) {
    const prim = doc
      .createPrimitive()
      .setAttribute('POSITION', pos)
      .setIndices(doc.createAccessor().setType('SCALAR').setArray(part.index).setBuffer(buffer))
      .setMaterial(doc.createMaterial(part.name).setBaseColorFactor([...part.color, 1]).setRoughnessFactor(0.85).setDoubleSided(true));
    mesh.addPrimitive(prim);
  }
  doc.createScene().addChild(doc.createNode('Dancer').setMesh(mesh));
  return new NodeIO().writeBinary(doc);
}

/**
 * Evens out an offset shell (Taubin smoothing, so it keeps its size): the
 * offset folds over itself in tight spots, and its cut edges are jagged.
 * Open edges are smoothed along themselves only.
 */
function smoothShell(pos: number[], index: number[], start: number) {
  const n = pos.length / 3 - start;
  const edges = new Map<number, number>();
  const key = (a: number, b: number) => Math.min(a, b) * 1e7 + Math.max(a, b);
  for (let t = 0; t < index.length; t += 3)
    for (let k = 0; k < 3; k++) {
      const e = key(index[t + k], index[t + ((k + 1) % 3)]);
      edges.set(e, (edges.get(e) ?? 0) + 1);
    }
  const nb: Array<Set<number>> = Array.from({ length: n }, () => new Set());
  const border = new Uint8Array(n);
  const borderNb: Array<Set<number>> = Array.from({ length: n }, () => new Set());
  for (const [e, c] of edges) {
    const a = Math.floor(e / 1e7) - start, b = (e % 1e7) - start;
    nb[a].add(b);
    nb[b].add(a);
    if (c === 1) {
      border[a] = border[b] = 1;
      borderNb[a].add(b);
      borderNb[b].add(a);
    }
  }
  const pass = (f: number) => {
    const next = pos.slice(start * 3);
    for (let v = 0; v < n; v++) {
      const ring = border[v] ? borderNb[v] : nb[v];
      if (!ring.size) continue;
      for (let k = 0; k < 3; k++) {
        let m = 0;
        for (const u of ring) m += pos[(start + u) * 3 + k];
        m /= ring.size;
        next[v * 3 + k] += (m - pos[(start + v) * 3 + k]) * f;
      }
    }
    for (let i = 0; i < next.length; i++) pos[start * 3 + i] = next[i];
  };
  for (let i = 0; i < 15; i++) {
    pass(0.5);
    pass(-0.53);
  }
}
