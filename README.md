# RigForge

**Turn static Meshy.ai models into rigged, animated characters for three.js, entirely in the browser.**

Drop in a GLB/FBX/OBJ from Meshy (or any humanoid mesh), and RigForge will:

1. **Clean & orient** it: merges parts, fixes degenerate triangles, stands it upright facing +Z at real-world scale.
2. **Auto-rig** it: detects joints (T- or A-pose), including **15 finger bones per hand**, fits a VRM-compatible humanoid skeleton and computes skin weights with **geodesic voxel binding**, which is robust to the open, self-intersecting meshes AI generators produce.
3. **Animate** it: add 18 motion-capture presets (idle, walk, run, jump, wave, punch, kick, dance…) or retarget your own **Mixamo FBX, BVH or GLB** clips. Clips can loop, play in place, change speed or be mirrored.
4. **Export** it: one optimized GLB (meshopt geometry/animation compression, WebP textures, keyframe reduction) plus copy-paste code for three.js or React Three Fiber.

Nothing is uploaded. Heavy compute runs in a Web Worker using Rust compiled to WebAssembly, with a TypeScript fallback.

## Quick start

```bash
pnpm install
pnpm dev          # editor at http://localhost:5173
```

Click **Try a sample** to run the whole pipeline on the built-in mannequin.

## Using exported characters

```ts
import { loadCharacter } from '@rigforge/three';

const character = await loadCharacter('/models/hero.glb');
scene.add(character.object);
character.play('Idle');
character.play('Run', { fade: 0.25 });         // crossfade
character.attach('rightHand', sword);           // canonical bone names
character.lookAt(camera);                       // procedural head tracking
character.on('finished', ({ name }) => character.play('Idle'));

renderer.setAnimationLoop(() => {
  character.update(clock.getDelta());
  renderer.render(scene, camera);
});
```

React Three Fiber:

```tsx
import { Character, Attach } from '@rigforge/r3f';

<Character src="/models/hero.glb" action={moving ? 'Run' : 'Idle'} fade={0.2} lookAt={[0, 1.6, 3]}>
  <Attach bone="rightHand"><Sword /></Attach>
</Character>
```

Exported files are standard glTF 2.0, so plain `GLTFLoader` + `AnimationMixer` works too (the editor generates that snippet as well).

## Packages

| Package | What it is |
|---|---|
| [`apps/editor`](apps/editor) | The RigForge web app (Vite + React + React Three Fiber). |
| [`@rigforge/core`](packages/core) | Mesh prep, joint detection, skin weights, retargeting, clip tools and GLB export. Framework-agnostic, runs in browsers, workers and Node. |
| [`@rigforge/three`](packages/three) | Tiny runtime (~3 KB gzipped): `loadCharacter`, `Character.play/crossFadeTo/attach/lookAt/on/clone`. |
| [`@rigforge/r3f`](packages/r3f) | `<Character>`, `<Attach>`, `useCharacter()` for React Three Fiber. |
| [`@rigforge/presets`](packages/presets) | Humanoid motion presets retargeted from the CMU motion capture database. |
| [`crates/kernels`](crates/kernels) | Rust kernels (solid voxelization, geodesic bone distances) compiled to a dependency-free WASM module. |

## How the auto-rig works

- **Voxelization**: triangles are rasterized into a voxel grid, closed morphologically, and flood-filled from outside to get a solid volume even when the mesh has holes.
- **Joint detection** reads the front silhouette and cross-sections of that volume. It finds the crotch gap, traces each arm from the fingertips to the armpit, finds the neck as the narrowest section below the head, and finds the ankles where the foot's depth drops. Joints are placed on the volume's centerlines.
- **Fingers**: the hand is sliced across its length at millimeter resolution, and the slices with four separate runs of geometry are the fingers. Knuckles are where the runs merge into the palm, and the thumb is the geometry beyond the palm's edge. Fused "mitten" hands get finger bones placed from hand proportions.
- **Skin weights**: for every bone, a Dijkstra search through the solid voxels measures the distance *through the body* to each vertex, so the hand resting on a thigh doesn't get thigh weights. Weights fall off as 1/dᵏ, are smoothed over the surface, and are limited to 4 influences.
- **Retargeting** converts every clip to a skeleton-independent "normalized T-pose" space (like VRM), so A-pose meshes, T-pose Mixamo clips and CMU BVH data all line up.

## Development

```bash
pnpm test            # unit tests (vitest): detection accuracy, weights, retarget round-trips, export
pnpm typecheck
pnpm e2e             # Playwright: full import → rig → animate → export flow
pnpm build           # packages (tsup) + editor (vite)
pnpm build:wasm      # rebuild crates/kernels → packages/core/wasm (needs rustup target wasm32-unknown-unknown)
pnpm build:presets   # rebuild presets from CMU BVH files (downloads to packages/presets/.cache)
pnpm corpus          # rig every corpus/*.glb and write corpus/report.md
```

The compiled WASM module is committed, so JavaScript-only contributors don't need Rust.

## Roadmap

- **Now (MVP):** humanoid pipeline, finger bones, presets, retargeting, optimized export, three.js/R3F runtime.
- **Next:** weight painting, keyframe/timeline editor, clip trimming, prop and mechanical rigs, project save/load, animation state machine and foot IK in the runtime.
- **Later:** quadruped and custom skeleton templates, procedural secondary motion, Meshy API import, CLI batch mode, and a pluggable AI text-to-motion provider.

## Credits & licenses

RigForge is MIT licensed. Preset motion data comes from the [CMU Graphics Lab Motion Capture Database](http://mocap.cs.cmu.edu), created with funding from NSF EIA-0196217, via Bruce Hahne's BVH conversion. It's free for research and commercial use, but the data itself may not be resold (see [`packages/presets/LICENSE`](packages/presets/LICENSE)).
