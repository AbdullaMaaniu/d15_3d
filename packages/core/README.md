# @rigforge/core

Framework-agnostic building blocks behind RigForge. Works in browsers, Web Workers and Node.

```ts
import {
  mergeSceneMeshes, guessOrientation, computeNormalization, applyNormalization,
  detectHumanoid, computeSkinWeights, buildSkinnedCharacter, humanoidDefs,
  autoMapBones, bindSkeleton, bakeClip, decodeClip, exportCharacter, createWasmKernels,
} from '@rigforge/core';

const { geometry, materials } = mergeSceneMeshes(gltf.scene);
const { rotation } = guessOrientation(geometry);
const rigSpace = applyNormalization(geometry, computeNormalization(geometry, { rotation, targetHeight: 1.8 }));

const positions = rigSpace.attributes.position.array as Float32Array;
const index = new Uint32Array(rigSpace.index!.array);
const kernels = await createWasmKernels(await (await fetch(wasmUrl)).arrayBuffer()); // optional, faster
const joints = detectHumanoid(positions, index, { kernels });          // edit joints.joints if needed
const defs = humanoidDefs(true);                                         // with finger bones
const { skinIndex, skinWeight } = computeSkinWeights(positions, index, defs, joints, { kernels });
const character = buildSkinnedCharacter(rigSpace, materials, defs, joints, skinIndex, skinWeight);

const binding = bindSkeleton(character.root, autoMapBones(character.root).map);
const walk = bakeClip(binding, decodeClip(presets.clips.find((c) => c.id === 'walk')));
const { glb } = await exportCharacter(character.root, [walk], { preset: 'web' });
```

The WASM kernels ship at `@rigforge/core/wasm/rigforge_kernels.wasm`; without them the TypeScript kernels are used.
