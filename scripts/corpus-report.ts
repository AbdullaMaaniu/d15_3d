// Auto-rigs every GLB in corpus/ and writes corpus/report.md.
//   pnpm corpus
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { BufferAttribute, BufferGeometry, Matrix4, Vector3 } from 'three';
import {
  analyzeMesh,
  applyNormalization,
  computeNormalization,
  computeSkinWeights,
  createWasmKernels,
  detectHumanoid,
  guessOrientation,
  humanoidDefs,
} from '../packages/core/src/index';

const root = join(import.meta.dirname, '..');
const dir = join(root, 'corpus');
const files = readdirSync(dir).filter((f) => /\.glb$/i.test(f));
if (!files.length) {
  console.log('No .glb files in corpus/. See corpus/README.md.');
  process.exit(0);
}

const kernels = await createWasmKernels(readFileSync(join(root, 'packages/core/wasm/rigforge_kernels.wasm')));
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);

/** Bakes every mesh primitive into one world-space triangle list. */
async function loadGeometry(path: string): Promise<BufferGeometry> {
  const doc = await io.read(path);
  const positions: number[] = [];
  const indices: number[] = [];
  const v = new Vector3();
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const m = new Matrix4().fromArray(node.getWorldMatrix());
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute('POSITION');
      if (!pos) continue;
      const base = positions.length / 3;
      const el: number[] = [];
      for (let i = 0; i < pos.getCount(); i++) {
        pos.getElement(i, el);
        v.set(el[0], el[1], el[2]).applyMatrix4(m);
        positions.push(v.x, v.y, v.z);
      }
      const idx = prim.getIndices();
      if (idx) for (let i = 0; i < idx.getCount(); i++) indices.push(base + idx.getScalar(i));
      else for (let i = 0; i < pos.getCount(); i++) indices.push(base + i);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  g.setIndex(new BufferAttribute(new Uint32Array(indices), 1));
  return g;
}

const rows: string[] = [
  '| Model | Tris | Pose | Confidence | Fingers (L/R) | Detect | Weights | Notes |',
  '|---|---:|---|---:|---|---:|---:|---|',
];
for (const f of files) {
  const g = await loadGeometry(join(dir, f));
  const report = analyzeMesh(g);
  const { rotation } = guessOrientation(g);
  const n = applyNormalization(g, computeNormalization(g, { rotation, targetHeight: 1.8 }));
  const positions = n.attributes.position.array as Float32Array;
  const index = new Uint32Array(n.index!.array);
  let t = performance.now();
  const det = detectHumanoid(positions, index, { kernels });
  const tDetect = performance.now() - t;
  t = performance.now();
  computeSkinWeights(positions, index, humanoidDefs(true), det, { kernels });
  const tWeights = performance.now() - t;
  const fingers = det.fingers ? `${det.fingers.left.method}/${det.fingers.right.method}` : '-';
  rows.push(
    `| ${f} | ${report.triangles.toLocaleString()} | ${det.pose} | ${Math.round(det.confidence * 100)}% | ${fingers} | ${Math.round(tDetect)} ms | ${Math.round(tWeights)} ms | ${det.notes.join(' ') || '-'} |`,
  );
  console.log(rows[rows.length - 1]);
}
writeFileSync(join(dir, 'report.md'), `# Corpus report\n\n${rows.join('\n')}\n`);
console.log('Wrote corpus/report.md');
