# RigForge

**Turn static Meshy.ai models into rigged, animated characters for three.js, entirely in the browser.**

Drop in a GLB/FBX/OBJ from Meshy (or any humanoid mesh), or import straight from your Meshy.ai account with an API key, and RigForge will:

1. **Clean & orient** it: merges parts, fixes degenerate triangles, stands it upright facing +Z at real-world scale.
   **Remesh** it to 3k, 10k, 30k, 60k, 100k or 150k faces, as **clean quads** (edge loops that follow the shape, new UVs, textures baked across) or **triangles** (evenly sized, original UVs and textures kept). Quad meshes download as OBJ with the quads intact.
2. **Auto-rig** it: detects joints (T- or A-pose), including **15 finger bones per hand**, fits a VRM-compatible humanoid skeleton and computes skin weights with **geodesic voxel binding**, which is robust to the open, self-intersecting meshes AI generators produce.
3. **Animate** it: add 18 motion-capture presets (idle, walk, run, jump, wave, punch, kick, dance…) or retarget your own **Mixamo FBX, BVH or GLB** clips. Clips can loop, play in place, change speed or be mirrored.
4. **Refine** it: paint skin weights with a brush (add/subtract/smooth, mirrored), trim clips, and keyframe bones with a rotate gizmo, either to fix a retargeted clip or to pose a new one from scratch.
5. **Export** it: one optimized GLB (meshopt geometry/animation compression, WebP textures, keyframe reduction) plus copy-paste code for three.js or React Three Fiber. The file carries a **game controller setup** (which clip is idle/walk/run/jump/an action, with speeds measured from the clips) and any **spring bones** (hair, tails, capes).
6. **Test drive** it: play the exported file right in the editor with WASD, Shift to run, Space to jump and number keys for actions, on hilly ground with foot IK, using the same `@rigforge/three` runtime your game will.

Besides humanoids it rigs **animals** (auto-detected legs, spine, neck, head and tail, with procedural walk/trot/gallop gaits), **custom creatures** (click on the model to build any skeleton: dragons, spiders, snakes, tentacles) and **props**: a chest lid, a door, a wheel or a turret. Each separate part gets a bone and pivot, and generated motions (spin, swing, slide, bob) or keyframes animate them.

Projects save to a `.rigforge` file and autosave in the browser, so you can pick up where you left off.

Nothing is uploaded. Heavy compute runs in a Web Worker using Rust compiled to WebAssembly, with a TypeScript fallback.

## Quick start

```bash
pnpm install
pnpm dev          # editor at http://localhost:5173
```

Click **Try a sample** to run the whole pipeline on the built-in mannequin.

## Command line

Rig a whole folder of exports without opening the editor:

```bash
pnpm --filter @rigforge/cli build
node packages/cli/dist/cli.js rig exports/*.glb -o rigged/ --clips idle,walk,run,wave
node packages/cli/dist/cli.js rig dog.glb -t quadruped
```

Or pull models straight from your Meshy.ai account:

```bash
export MESHY_API_KEY=msy_...
node packages/cli/dist/cli.js meshy list
node packages/cli/dist/cli.js meshy rig <task-id> --clips all
```

See [`packages/cli`](packages/cli) for every option.

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

// Game-ready in one line: uses the controller setup saved in the file.
const controller = character.autoStateMachine();
controller.set('speed', velocity.length()); // blends Idle → Walk → Run
controller.trigger('jump');                 // and one trigger per action, e.g. 'punch'

// Or write your own state machine: phase-synced idle/walk/run blend + a jump.
const sm = character.stateMachine({
  initial: 'move',
  parameters: { speed: 0 },
  states: {
    move: { blend: { param: 'speed', clips: [[0, 'Idle'], [1.4, 'Walk'], [4, 'Run']] } },
    jump: { clip: 'Jump', loop: false },
  },
  transitions: [
    { from: 'move', to: 'jump', when: [{ trigger: 'jump' }] },
    { from: 'jump', to: 'move', exitTime: 0.9 },
  ],
});
sm.set('speed', velocity.length());
character.playLayer('attack', 'Punch', { mask: 'upperBody', loop: false }); // punch while walking
character.enableFootIK({ ground: [terrain] });                              // plant feet on slopes and steps

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
| [`@rigforge/three`](packages/three) | Small runtime: `loadCharacter`, playback and crossfades, state machines with 1D blends, masked/additive layers, root motion, foot IK, look-at, bone attachment. |
| [`@rigforge/r3f`](packages/r3f) | `<Character>`, `<Attach>`, `useCharacter()` for React Three Fiber. |
| [`@rigforge/cli`](packages/cli) | `rigforge rig *.glb`: batch auto-rigging and animation in Node, textures untouched. |
| [`@rigforge/presets`](packages/presets) | Humanoid motion presets retargeted from the CMU motion capture database. |
| [`crates/kernels`](crates/kernels) | Rust kernels (solid voxelization, geodesic bone distances) compiled to a dependency-free WASM module. |

## How the auto-rig works

- **Voxelization**: triangles are rasterized into a voxel grid, closed morphologically, and flood-filled from outside to get a solid volume even when the mesh has holes.
- **Joint detection** reads the front silhouette and cross-sections of that volume. It finds the crotch gap, traces each arm from the fingertips to the armpit, finds the neck as the narrowest section below the head, and finds the ankles where the foot's depth drops. Joints are placed on the volume's centerlines.
- **Fingers**: the hand is sliced across its length at millimeter resolution, and the slices with four separate runs of geometry are the fingers. Knuckles are where the runs merge into the palm, and the thumb is the geometry beyond the palm's edge. Fused "mitten" hands get finger bones placed from hand proportions.
- **Skin weights**: for every bone, a Dijkstra search through the solid voxels measures the distance *through the body* to each vertex, so the hand resting on a thigh doesn't get thigh weights. Weights fall off as 1/dᵏ, are smoothed over the surface, and are limited to 4 influences. The Rust kernel uses a radix heap over the distances' f32 bit patterns and a border-padded grid with no bounds checks, and the editor splits the bones across a pool of workers. The result is bit-identical to the single-threaded reference.
- **Quad remeshing** (Rust): a multi-resolution hierarchy of the surface, a smooth 4-way orientation field and a position lattice, optimized coarse to fine (after Instant Field-Aligned Meshes). Graph edges that snap to the same lattice point merge into one vertex, edges one step apart become quad edges, and faces are traced around each vertex. Vertices are then relaxed onto the original surface and take its smooth normals. Parts too small or thin for the lattice (eyes, lenses, straps) keep their triangles.
- **UVs and baking** (Rust): charts grow under a normal-cone limit, are projected flat, rotated to their tightest rectangle and skyline-packed. Every texel then finds the closest facing point on the original surface through a BVH and samples its material: base colour, metallic-roughness and emissive, merged into one material. Chart borders are dilated so mipmaps don't bleed.
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
pnpm tsx scripts/bench/profile.ts models/        # detect + weights timings per stage, WASM vs TypeScript
pnpm tsx scripts/bench/dump-mesh.ts a.glb a.mesh && \
  cargo run --release --manifest-path crates/kernels/Cargo.toml --example quadbench -- a.mesh 30000 out.obj   # quad remesh + atlas stats
pnpm tsx scripts/bench/dump-geodesic.ts a.glb a.bin && \
  cargo run --release --manifest-path crates/kernels/Cargo.toml --example bench -- a.bin   # native kernel, 1/2/4 threads
```

The compiled WASM module is committed, so JavaScript-only contributors don't need Rust.

## Roadmap

- **Done:** humanoid pipeline with finger bones, presets, retargeting, optimized export, three.js/R3F runtime; weight painting, keyframe editor, clip trimming, prop rigs, project files and autosave; state machines, layers, root motion and foot IK in the runtime.
- **Also done:** quadruped template with gaits, custom creature skeletons, CLI batch mode, Meshy API import, spring bones, exported controller setups and an in-editor test drive.
- **Later:** a pluggable AI text-to-motion provider.

## Credits & licenses

RigForge is MIT licensed. Preset motion data comes from the [CMU Graphics Lab Motion Capture Database](http://mocap.cs.cmu.edu), created with funding from NSF EIA-0196217, via Bruce Hahne's BVH conversion. It's free for research and commercial use, but the data itself may not be resold (see [`packages/presets/LICENSE`](packages/presets/LICENSE)).
