/**
 * Builds assets/reference-body.bin from a sculpted human base mesh (GLB, one
 * mesh, A- or T-pose, facing +Z): scales it to 1.80 m with the feet at 0,
 * simplifies it, finds its joints and computes its skin weights with RigForge's
 * own rigger.
 *
 *   pnpm --filter @rigforge/core build:reference <model.glb> [triangles]
 */
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { NodeIO } from '@gltf-transform/core';
import { MeshoptSimplifier } from 'meshoptimizer';
import { detectHumanoid, symmetrizeJoints } from '../src/rig/landmarks';
import { computeSkinWeights } from '../src/rig/weights';
import { humanoidDefs } from '../src/skeleton';
import { createWasmKernels, tsKernels, type Kernels } from '../src/kernels';
import { encodeReferenceBody, FIT_SLOTS } from '../src/body/reference';
import { removeSeams } from './seams';

const [input, trisArg] = process.argv.slice(2);
if (!input) throw new Error('usage: build-reference-body <model.glb> [triangles]');
const targetTris = Number(trisArg ?? 40000);
const HEIGHT = 1.8;

const doc = await new NodeIO().read(input);
const prim = doc.getRoot().listMeshes()[0].listPrimitives()[0];
const src = prim.getAttribute('POSITION')!.getArray() as Float32Array;
const srcIndex = Uint32Array.from(prim.getIndices()!.getArray()!);

// Feet at 0, centred on x, 1.80 m tall.
const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
for (let i = 0; i < src.length; i++) {
  lo[i % 3] = Math.min(lo[i % 3], src[i]);
  hi[i % 3] = Math.max(hi[i % 3], src[i]);
}
const s = HEIGHT / (hi[1] - lo[1]);
const cx = (lo[0] + hi[0]) / 2;
const scaled = new Float32Array(src.length);
for (let i = 0; i < src.length; i += 3) {
  scaled[i] = (src[i] - cx) * s;
  scaled[i + 1] = (src[i + 1] - lo[1]) * s;
  scaled[i + 2] = src[i + 2] * s;
}

// Remove the bodysuit seams the generator sculpted in, keeping the anatomy around them.
console.log('seams:', removeSeams(scaled, srcIndex));

await MeshoptSimplifier.ready;
const [simple] = MeshoptSimplifier.simplify(srcIndex, scaled, 3, targetTris * 3, 0.02, []);
// Keep only the vertices still used.
const remap = new Int32Array(scaled.length / 3).fill(-1);
const pos: number[] = [];
const index = new Uint32Array(simple.length);
simple.forEach((v, i) => {
  if (remap[v] < 0) {
    remap[v] = pos.length / 3;
    pos.push(scaled[v * 3], scaled[v * 3 + 1], scaled[v * 3 + 2]);
  }
  index[i] = remap[v];
});
const positions = Float32Array.from(pos);
console.log(`${positions.length / 3} vertices, ${index.length / 3} triangles`);

let kernels: Kernels = tsKernels;
try {
  const require = createRequire(import.meta.url);
  kernels = await createWasmKernels(await readFile(require.resolve('@rigforge/core/wasm/rigforge_kernels.wasm')));
} catch {
  console.log('WASM kernels unavailable, using TypeScript');
}

// Same settings as the editor uses, so the reference is rigged the way a character would be.
const found = detectHumanoid(positions, index, { fingers: false, kernels });
console.log(`pose ${found.pose}, confidence ${found.confidence.toFixed(2)}`, found.notes.join('; '));
const joints = symmetrizeJoints({ joints: found.joints, tails: found.tails }, 'left', 0);
const defs = humanoidDefs(false);
const w = computeSkinWeights(positions, index, defs, joints, { kernels, resolution: 256 });
console.log(`weights: ${w.fallbackVertices} fallback vertices`);
// Soft weights for fitting: no hard shoulder seam, then smoothed far along the surface.
const fit = smoothWeights(computeSkinWeights(positions, index, defs, joints, { kernels, resolution: 256, splitShoulders: false, maxInfluences: 16 }), defs.length, Number(process.env.FIT_SMOOTH ?? 200));

const out = encodeReferenceBody({ positions, index, skinIndex: w.skinIndex, skinWeight: w.skinWeight, fitIndex: fit.skinIndex, fitWeight: fit.skinWeight, bones: defs.map((d) => d.name), joints });
const dest = new URL('../assets/reference-body.bin', import.meta.url);
await writeFile(dest, out);
console.log(`wrote ${dest.pathname} (${(out.byteLength / 1024).toFixed(0)} KB)`);

/** Uniform Laplacian smoothing of the weights over the mesh, keeping the FIT_SLOTS largest. */
function smoothWeights(w: { skinIndex: Uint16Array; skinWeight: Float32Array }, B: number, iterations: number) {
  const V = positions.length / 3;
  const nb: Set<number>[] = Array.from({ length: V }, () => new Set());
  for (let t = 0; t < index.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const a = index[t + e], b = index[t + ((e + 1) % 3)];
      nb[a].add(b);
      nb[b].add(a);
    }
  }
  const lists = nb.map((s) => [...s]);
  let d = new Float32Array(V * B), next = new Float32Array(V * B);
  const m = w.skinIndex.length / V;
  for (let v = 0; v < V; v++) for (let k = 0; k < m; k++) d[v * B + w.skinIndex[v * m + k]] += w.skinWeight[v * m + k];
  for (let it = 0; it < iterations; it++) {
    for (let v = 0; v < V; v++) {
      const l = lists[v];
      for (let b = 0; b < B; b++) {
        let s = 0;
        for (const n of l) s += d[n * B + b];
        next[v * B + b] = 0.5 * d[v * B + b] + (0.5 * s) / (l.length || 1);
      }
    }
    [d, next] = [next, d];
  }
  const n = FIT_SLOTS;
  const skinIndex = new Uint16Array(V * n), skinWeight = new Float32Array(V * n);
  let dropped = 0;
  for (let v = 0; v < V; v++) {
    const order = [...Array(B).keys()].sort((a, b) => d[v * B + b] - d[v * B + a]);
    const top = order.slice(0, n);
    dropped = Math.max(dropped, d[v * B + order[n]]);
    const sum = top.reduce((s, b) => s + d[v * B + b], 0) || 1;
    top.forEach((b, i) => {
      skinIndex[v * n + i] = b;
      skinWeight[v * n + i] = d[v * B + b] / sum;
    });
  }
  console.log(`fit weights: largest weight left out ${dropped.toFixed(3)}`);
  return { skinIndex, skinWeight };
}
