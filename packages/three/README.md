# @rigforge/three

A ~3 KB runtime for rigged, animated GLB characters in three.js. It works with any skinned glTF and is tuned for RigForge exports.

```ts
import { loadCharacter } from '@rigforge/three';

const hero = await loadCharacter('/hero.glb');     // meshopt decoder preconfigured
scene.add(hero.object);
hero.play('Idle');
hero.play('Run', { fade: 0.25, speed: 1.2 });
hero.bone('leftHand');                              // canonical (VRM) names, Mixamo/UE aliases
hero.attach('rightHand', sword);
hero.lookAt(camera, { maxAngle: 1 });
const off = hero.on('finished', ({ name }) => hero.play('Idle'));
const npc = hero.clone();                           // independent skeleton, shared data

// every frame
hero.update(delta);
```

## Recolouring parts

Characters split into parts in RigForge's Parts step (hair, skin, top, …) export one named material per part. Recolour them at runtime; the texture's folds, stripes and shading are kept, and dark parts can go light:

```ts
hero.regions;                        // ['Hair', 'Skin', 'Top', 'Bottoms', 'Shoes']
hero.setColor('Hair', '#e8c36a');    // case-insensitive; returns false if there's no such part
hero.setColor('Hair', null);         // back to the texture's colour
```

Each character gets its own materials on first use, so clones from the same file can wear different colours. Without the `Character` class, use `setRegionColor(object, 'Top', color)` and `listRegions(object)`. Other engines see ordinary named materials and can tint them with their own colour multiplier.

## State machines

```ts
const sm = hero.stateMachine({
  initial: 'move',
  parameters: { speed: 0 },
  states: {
    move: { blend: { param: 'speed', clips: [[0, 'Idle'], [1.4, 'Walk'], [4, 'Run']] } }, // phase-synced blend
    jump: { clip: 'Jump', loop: false },
  },
  transitions: [
    { from: 'move', to: 'jump', when: [{ trigger: 'jump' }] },
    { from: 'jump', to: 'move', exitTime: 0.9 },
  ],
});
sm.set('speed', velocity.length());
sm.trigger('jump');
```

## Layers, root motion and foot IK

```ts
hero.playLayer('attack', 'Punch', { mask: 'upperBody', loop: false }); // punch while walking
hero.playLayer('breathe', 'Idle', { additive: true, weight: 0.5 });
hero.rootMotion = true;                        // clips exported with root motion move hero.object
hero.enableFootIK({ ground: [terrainMesh] });  // feet follow uneven ground, hips drop to reach
```
