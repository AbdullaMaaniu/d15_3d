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
