import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { AnimationMixer, BufferGeometry, Float32BufferAttribute, Matrix4, MeshStandardMaterial, SkinnedMesh, Uint16BufferAttribute, Uint32BufferAttribute, Vector3 } from 'three';
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
import { decodeReferenceBody, fitReferenceBody } from '../src/body/reference';

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

  it('writes the body beside the clothes, skinned to the same skeleton', async () => {
    const kernels = await createWasmKernels(readFileSync(fileURLToPath(new URL('../wasm/rigforge_kernels.wasm', import.meta.url))));
    const pack = JSON.parse(readFileSync(fileURLToPath(new URL('../../presets/clips.json', import.meta.url)), 'utf8')) as PresetPack;
    const { geometry } = createMannequin({ pose: 'A', detail: 8 });
    const positions = geometry.attributes.position.array as Float32Array;
    const index = new Uint32Array(geometry.index!.array);
    const detected = detectHumanoid(positions, index, { kernels });
    const defs = humanoidDefs(true);
    const w = computeSkinWeights(positions, index, defs, detected, { kernels, resolution: 96 });
    const c = buildSkinnedCharacter(geometry, new MeshStandardMaterial(), defs, detected, w.skinIndex, w.skinWeight);

    const ref = decodeReferenceBody(readFileSync(new URL('../assets/reference-body.bin', import.meta.url)));
    const fitted = fitReferenceBody(ref, detected, {}, 0.9);
    const names = c.skeleton.bones.map((b) => b.name);
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(fitted.positions, 3));
    g.setAttribute('normal', new Float32BufferAttribute(fitted.normals, 3));
    g.setAttribute('skinIndex', new Uint16BufferAttribute(Uint16Array.from(fitted.skinIndex, (i) => Math.max(0, names.indexOf(fitted.bones[i]))), 4));
    g.setAttribute('skinWeight', new Float32BufferAttribute(fitted.skinWeight, 4));
    g.setIndex(new Uint32BufferAttribute(fitted.index, 1));
    const body = new SkinnedMesh(g, new MeshStandardMaterial());
    body.name = 'Body';
    body.bind(c.skeleton, new Matrix4());

    const binding = bindSkeleton(c.root, autoMapBones(c.root).map);
    const walk = bakeClip(binding, decodeClip(pack.clips.find((x) => x.id === 'walk')!));
    const web = await exportCharacter(c.root, [walk], { preset: 'web', layers: [body] });
    const out = await exportCharacter(c.root, [walk], { preset: 'lossless', layers: [body] });
    // The layer is put back where it was.
    expect(body.parent).toBeNull();
    expect(c.root.getObjectByName('Body')).toBeUndefined();

    const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
    const parse = (glb: Uint8Array) =>
      new Promise<any>((resolve, reject) => loader.parse(glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength) as ArrayBuffer, '', resolve, reject));
    const skinnedNames = (scene: any) => {
      const n: string[] = [];
      scene.traverse((o: any) => { if (o.isSkinnedMesh) n.push(o.name); });
      return n.sort();
    };
    expect(skinnedNames((await parse(web.glb)).scene)).toEqual(['Body', 'CharacterMesh']);

    // Uncompressed, so vertices can be matched one to one.
    const gltf = await parse(out.glb);
    const meshes: SkinnedMesh[] = [];
    gltf.scene.traverse((o: any) => { if (o.isSkinnedMesh) meshes.push(o); });
    expect(meshes.map((m) => m.name).sort()).toEqual(['Body', 'CharacterMesh']);
    const loaded = meshes.find((m) => m.name === 'Body')!;
    expect(loaded.geometry.index!.count).toBe(fitted.index.length);
    // Both meshes drive the same bones.
    const clothes = meshes.find((m) => m.name !== 'Body')!;
    expect(loaded.skeleton.bones.every((b) => clothes.skeleton.bones.includes(b))).toBe(true);

    // Mid-stride, the re-imported body deforms like the one in the editor.
    const mixer = new AnimationMixer(gltf.scene);
    mixer.clipAction(gltf.animations[0]).play();
    mixer.setTime(walk.duration * 0.3);
    gltf.scene.updateMatrixWorld(true);
    const src = new AnimationMixer(c.root);
    src.clipAction(walk).play();
    src.setTime(walk.duration * 0.3);
    c.root.add(body);
    c.root.updateMatrixWorld(true);
    // Compare the skinned vertex at the same rest position as each probe.
    const a = new Vector3(), b = new Vector3();
    const probes = [0, 1000, 5000, 9000, 15000].filter((v) => v < fitted.positions.length / 3);
    const lp = loaded.geometry.getAttribute('position');
    for (const v of probes) {
      let best = 0, bestD = Infinity;
      for (let i = 0; i < lp.count; i++) {
        const d = (lp.getX(i) - fitted.positions[v * 3]) ** 2 + (lp.getY(i) - fitted.positions[v * 3 + 1]) ** 2 + (lp.getZ(i) - fitted.positions[v * 3 + 2]) ** 2;
        if (d < bestD) { bestD = d; best = i; }
      }
      body.getVertexPosition(v, a).applyMatrix4(body.matrixWorld);
      loaded.getVertexPosition(best, b).applyMatrix4(loaded.matrixWorld);
      expect(a.distanceTo(b)).toBeLessThan(0.01);
    }
    // And it actually moved off its rest pose.
    const moved = Math.max(...probes.map((v) => body.getVertexPosition(v, a).distanceTo(b.fromArray(fitted.positions, v * 3))));
    expect(moved).toBeGreaterThan(0.02);
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
