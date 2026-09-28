import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Document } from '@gltf-transform/core';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { AnimationMixer, Box3, Vector3 } from 'three';
import { createMannequin, createQuadrupedMannequin } from '../src/mesh/mannequin';
import { rigDocument } from '../src/export/document';
import { optimizeDocument, createIO } from '../src/export/export';
import { createWasmKernels } from '../src/kernels';
import type { PresetPack } from '../src/anim/codec';

const presets = JSON.parse(readFileSync(fileURLToPath(new URL('../../presets/clips.json', import.meta.url)), 'utf8')) as PresetPack;
const kernelsP = createWasmKernels(readFileSync(fileURLToPath(new URL('../wasm/rigforge_kernels.wasm', import.meta.url))));
// 1x1 PNG, to check textures pass through untouched.
const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));

/** A Meshy-like input: centimeters, Z-up via a parent node, with a textured material. */
function makeDoc(geometry: import('three').BufferGeometry): Document {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const pos = geometry.attributes.position.array as Float32Array;
  const cm = new Float32Array(pos.length);
  // Model space: Z-up (swap y/z), centimeters.
  for (let i = 0; i < pos.length; i += 3) {
    cm[i] = pos[i] * 100;
    cm[i + 1] = -pos[i + 2] * 100;
    cm[i + 2] = pos[i + 1] * 100;
  }
  const prim = doc.createPrimitive()
    .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(cm).setBuffer(buffer))
    .setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint32Array(geometry.index!.array)).setBuffer(buffer))
    .setMaterial(doc.createMaterial('Skin').setBaseColorTexture(doc.createTexture('albedo').setImage(PNG).setMimeType('image/png')));
  const mesh = doc.createMesh('Body').addPrimitive(prim);
  // Parent converts Z-up centimeters to Y-up meters, like many exporters do.
  const child = doc.createNode('Body').setMesh(mesh);
  const parent = doc.createNode('Root').setScale([0.01, 0.01, 0.01]).setRotation([-Math.SQRT1_2, 0, 0, Math.SQRT1_2]).addChild(child);
  doc.createScene('Scene').addChild(parent);
  return doc;
}

async function loadBack(doc: Document) {
  const io = await createIO();
  const glb = await io.writeBinary(doc);
  const { MeshoptDecoder } = await import('three/examples/jsm/libs/meshopt_decoder.module.js');
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  // Textures need a DOM image decoder in three; strip them for the Node load check.
  const copy = await io.readBinary(glb);
  for (const t of copy.getRoot().listTextures()) t.dispose();
  const bare = await io.writeBinary(copy);
  const gltf = await new Promise<any>((resolve, reject) => loader.parse(bare.buffer.slice(bare.byteOffset, bare.byteOffset + bare.byteLength) as ArrayBuffer, '', resolve, reject));
  return { gltf, glb };
}

describe('rigDocument (CLI path)', () => {
  it('rigs a humanoid in place, keeping textures', async () => {
    const kernels = await kernelsP;
    const { geometry } = createMannequin({ pose: 'A', detail: 8 });
    const doc = makeDoc(geometry);
    const report = await rigDocument(doc, { kernels, presets, clips: ['idle', 'walk'], resolution: 96 });
    expect(report.notes).toEqual([]);
    expect(report.clips).toEqual(['Idle', 'Walk']);
    expect(doc.getRoot().listTextures().length).toBe(1);
    expect(Buffer.from(doc.getRoot().listTextures()[0].getImage()!).equals(Buffer.from(PNG))).toBe(true);
    await optimizeDocument(doc, { meshopt: true });

    const { gltf } = await loadBack(doc);
    let mesh: any;
    gltf.scene.traverse((o: any) => { if (o.isSkinnedMesh) mesh = o; });
    expect(mesh).toBeTruthy();
    // Upright, 1.8 m tall, feet on the ground.
    const box = new Box3().setFromObject(mesh);
    expect(box.max.y - box.min.y).toBeCloseTo(1.8, 1);
    expect(box.min.y).toBeCloseTo(0, 1);
    // The walk animates the legs.
    const mixer = new AnimationMixer(gltf.scene);
    mixer.clipAction(gltf.animations.find((a: any) => a.name === 'Walk')).play();
    const foot = gltf.scene.getObjectByName('leftFoot');
    const zs: number[] = [];
    for (let t = 0; t < 1; t += 0.1) {
      mixer.setTime(t);
      gltf.scene.updateMatrixWorld(true);
      zs.push(foot.getWorldPosition(new Vector3()).z);
    }
    expect(Math.max(...zs) - Math.min(...zs)).toBeGreaterThan(0.2);
  });

  it('rigs a quadruped with gaits', async () => {
    const kernels = await kernelsP;
    const { geometry } = createQuadrupedMannequin({ detail: 8 });
    const doc = makeDoc(geometry);
    const report = await rigDocument(doc, { type: 'quadruped', kernels, clips: 'all', resolution: 96 });
    expect(report.bones).toBe(25);
    expect(report.clips).toEqual(['Idle', 'Walk', 'Trot', 'Gallop', 'Sit', 'Tail Wag']);
    const { gltf } = await loadBack(doc);
    expect(gltf.animations.length).toBe(6);
    expect(gltf.scene.getObjectByName('tail3')).toBeTruthy();
  });
});

