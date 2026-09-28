// Profiles auto-rigging on GLBs: pnpm tsx scripts/bench/profile.ts <dir-or-files...>
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { BufferAttribute, BufferGeometry, Matrix4, Vector3 } from 'three';
import { applyNormalization, computeNormalization, computeSkinWeights, createWasmKernels, detectHumanoid, guessOrientation, humanoidDefs, tsKernels } from '../../packages/core/src/index';

const root = join(import.meta.dirname, '../..');
const args = process.argv.slice(2);
const files = args.flatMap((a) => (statSync(a).isDirectory() ? readdirSync(a).filter((f) => /\.glb$/i.test(f)).map((f) => join(a, f)) : [a]));
const wasm = await createWasmKernels(readFileSync(join(root, 'packages/core/wasm/rigforge_kernels.wasm')));
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);

async function load(path: string): Promise<BufferGeometry> {
  const doc = await io.read(path);
  const positions: number[] = [], indices: number[] = [];
  const v = new Vector3();
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const m = new Matrix4().fromArray(node.getWorldMatrix());
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute('POSITION');
      if (!pos) continue;
      const base = positions.length / 3, el: number[] = [];
      for (let i = 0; i < pos.getCount(); i++) { pos.getElement(i, el); v.set(el[0], el[1], el[2]).applyMatrix4(m); positions.push(v.x, v.y, v.z); }
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

const kernelSel = process.env.KERNELS ?? 'wasm,ts';
for (const f of files) {
  const g = await load(f);
  const { rotation } = guessOrientation(g);
  const n = applyNormalization(g, computeNormalization(g, { rotation, targetHeight: 1.8 }));
  const positions = n.attributes.position.array as Float32Array;
  const index = new Uint32Array(n.index!.array);
  for (const kernels of [wasm, tsKernels].filter((k) => kernelSel.includes(k.name))) {
    let t = performance.now();
    const det = detectHumanoid(positions, index, { kernels });
    const tDetect = performance.now() - t;
    t = performance.now();
    const w = computeSkinWeights(positions, index, humanoidDefs(true), det, { kernels });
    const tW = performance.now() - t;
    const tm = Object.entries(w.timings).map(([k, v]) => `${k} ${v.toFixed(0)}`).join(', ');
    console.log(`${f.split('/').pop()} [${kernels.name}] tris ${index.length / 3} · detect ${tDetect.toFixed(0)} ms · weights ${tW.toFixed(0)} ms (${tm})`);
  }
}
