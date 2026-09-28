import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { MeshStandardMaterial } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { createMannequin } from '../src/mesh/mannequin';
import { detectHumanoid } from '../src/rig/landmarks';
import { computeSkinWeights } from '../src/rig/weights';
import { buildSkinnedCharacter } from '../src/rig/build';
import { humanoidDefs } from '../src/skeleton';
import { autoMapBones } from '../src/anim/bonemap';
import { bakeClip, bindSkeleton } from '../src/anim/retarget';
import { decodeClip, type PresetPack } from '../src/anim/codec';
import { createWasmKernels } from '../src/kernels';
import { exportCharacter } from '../src/export/export';
import { generateSnippet } from '../src/export/snippets';

beforeAll(() => {
  // GLTFExporter uses FileReader for binary output; Node lacks it.
  (globalThis as any).FileReader ??= class {
    result: ArrayBuffer | null = null;
    onloadend: (() => void) | null = null;
    readAsArrayBuffer(blob: Blob) {
      blob.arrayBuffer().then((b) => { this.result = b; this.onloadend?.(); });
    }
    readAsDataURL(blob: Blob) {
      blob.arrayBuffer().then((b) => { (this as any).result = `data:${blob.type};base64,${Buffer.from(b).toString('base64')}`; this.onloadend?.(); });
    }
  };
});

describe('export', () => {
  it('writes a compressed GLB that three.js can load back', async () => {
    const kernels = await createWasmKernels(readFileSync(fileURLToPath(new URL('../wasm/rigforge_kernels.wasm', import.meta.url))));
    const pack = JSON.parse(readFileSync(fileURLToPath(new URL('../../presets/clips.json', import.meta.url)), 'utf8')) as PresetPack;
    const { geometry } = createMannequin({ pose: 'A', detail: 8 });
    const positions = geometry.attributes.position.array as Float32Array;
    const index = new Uint32Array(geometry.index!.array);
    const detected = detectHumanoid(positions, index, { kernels });
    const defs = humanoidDefs(true);
    const w = computeSkinWeights(positions, index, defs, detected, { kernels, resolution: 96 });
    const c = buildSkinnedCharacter(geometry, new MeshStandardMaterial({ color: 0x8899aa }), defs, detected, w.skinIndex, w.skinWeight);
    const binding = bindSkeleton(c.root, autoMapBones(c.root).map);
    const clips = ['idle', 'walk', 'wave'].map((id) => bakeClip(binding, decodeClip(pack.clips.find((x) => x.id === id)!)));

    const lossless = await exportCharacter(c.root, clips, { preset: 'lossless' });
    const web = await exportCharacter(c.root, clips, { preset: 'web' });
    expect(web.glb.byteLength).toBeLessThan(lossless.glb.byteLength);

    const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
    const buf = web.glb.buffer.slice(web.glb.byteOffset, web.glb.byteOffset + web.glb.byteLength);
    const gltf = await new Promise<any>((resolve, reject) => loader.parse(buf as ArrayBuffer, '', resolve, reject));
    expect(gltf.animations.map((a: any) => a.name).sort()).toEqual(['Idle', 'Walk', 'Wave']);
    let skinned = 0;
    gltf.scene.traverse((o: any) => { if (o.isSkinnedMesh) skinned++; });
    expect(skinned).toBe(1);
    expect(gltf.scene.getObjectByName('leftIndexDistal')).toBeTruthy();
    const walk = gltf.animations.find((a: any) => a.name === 'Walk');
    expect(walk.duration).toBeGreaterThan(0.8);
  });

  it('generates snippets naming the exported clips', () => {
    const s = generateSnippet('three', { url: 'hero.glb', clipNames: ['Idle', 'Walk'] });
    expect(s).toContain("character.play('Idle')");
    expect(generateSnippet('r3f', { url: 'hero.glb', clipNames: ['Idle', 'Run'] })).toContain('<Character');
    const sm = generateSnippet('state-machine', {
      url: 'hero.glb',
      clipNames: ['Idle', 'Walk', 'Run', 'Jump', 'Punch'],
      controller: { locomotion: [[0, 'Idle'], [1.3, 'Walk'], [3.8, 'Run']], jump: 'Jump', actions: { punch: 'Punch' } },
    });
    expect(sm).toContain('character.autoStateMachine()');
    expect(sm).toContain('Walk @ 1.3 m/s');
    expect(sm).toContain("sm.trigger('punch')");
  });
});
