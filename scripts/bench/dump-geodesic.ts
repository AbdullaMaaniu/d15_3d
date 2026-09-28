// Dumps a model's geodesic kernel inputs (and the WASM result) for the native Rust bench:
//   pnpm tsx scripts/bench/dump-geodesic.ts model.glb out.bin
//   cargo run --release --manifest-path crates/kernels/Cargo.toml --example bench -- out.bin
import { readFileSync, writeFileSync } from 'node:fs';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { BufferAttribute, BufferGeometry, Matrix4, Vector3 } from 'three';
import { applyNormalization, computeNormalization, computeSkinWeights, createWasmKernels, detectHumanoid, guessOrientation, humanoidDefs } from '../../packages/core/src/index';
const wasm = await createWasmKernels(readFileSync('packages/core/wasm/rigforge_kernels.wasm'));
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
const det = detectHumanoid(P, I, { kernels: wasm });
computeSkinWeights(P, I, humanoidDefs(true), det, { kernels: { ...wasm, boneDistances: (inp: any) => {
  const { grid, boneCount, segments, points, maxDistance } = inp;
  const head = new Float32Array([grid.nx, grid.ny, grid.nz, grid.origin[0], grid.origin[1], grid.origin[2], grid.dx, boneCount, segments.length / 7, points.length / 3, maxDistance]);
  const res = wasm.boneDistances(inp);
  writeFileSync(out, Buffer.concat([Buffer.from(head.buffer), Buffer.from(grid.data), Buffer.from(segments.buffer), Buffer.from(points.buffer), Buffer.from(res.buffer)]));
  return res;
} } as any });
console.log('dumped', out);
