// Dumps a model's merged, normalized triangle mesh for the native remesh bench:
//   pnpm tsx scripts/bench/dump-mesh.ts model.glb out.bin
import { writeFileSync } from 'node:fs';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { BufferAttribute, BufferGeometry, Matrix4, Vector3 } from 'three';
import { applyNormalization, computeNormalization, guessOrientation } from '../../packages/core/src/index';
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const [path, out] = process.argv.slice(2);
const doc = await io.read(path);
const positions: number[] = [], indices: number[] = [];
const v = new Vector3();
for (const node of doc.getRoot().listNodes()) {
  const mesh = node.getMesh(); if (!mesh) continue;
  const m = new Matrix4().fromArray(node.getWorldMatrix());
  for (const prim of mesh.listPrimitives()) {
    const pos = prim.getAttribute('POSITION')!; const base = positions.length / 3, el: number[] = [];
    for (let i = 0; i < pos.getCount(); i++) { pos.getElement(i, el); v.set(el[0], el[1], el[2]).applyMatrix4(m); positions.push(v.x, v.y, v.z); }
    const idx = prim.getIndices()!; for (let i = 0; i < idx.getCount(); i++) indices.push(base + idx.getScalar(i));
  }
}
const g = new BufferGeometry(); g.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3)); g.setIndex(new BufferAttribute(new Uint32Array(indices), 1));
const n = applyNormalization(g, computeNormalization(g, { rotation: guessOrientation(g).rotation, targetHeight: 1.8 }));
const P = n.attributes.position.array as Float32Array, I = new Uint32Array(n.index!.array);
const head = new Uint32Array([P.length / 3, I.length]);
writeFileSync(out, Buffer.concat([Buffer.from(head.buffer), Buffer.from(P.buffer, P.byteOffset, P.byteLength), Buffer.from(I.buffer)]));
console.log('dumped', out);
