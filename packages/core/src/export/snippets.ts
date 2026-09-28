export interface SnippetInput {
  /** File name or URL of the exported GLB. */
  url: string;
  clipNames: string[];
  /** Name of the clip to start with (defaults to an idle-like clip or the first). */
  initial?: string;
}

export type SnippetKind = 'three' | 'r3f' | 'vanilla' | 'state-machine';

function pickInitial(input: SnippetInput): string {
  return input.initial ?? input.clipNames.find((n) => /idle/i.test(n)) ?? input.clipNames[0] ?? 'Idle';
}

function other(input: SnippetInput, initial: string): string {
  return input.clipNames.find((n) => n !== initial && /walk|run|wave/i.test(n)) ?? input.clipNames.find((n) => n !== initial) ?? initial;
}

/** Generates ready-to-paste integration code for the exported character. */
export function generateSnippet(kind: SnippetKind, input: SnippetInput): string {
  const initial = pickInitial(input);
  const next = other(input, initial);
  const clips = input.clipNames.map((n) => `'${n}'`).join(' | ') || "'Idle'";
  if (kind === 'three') {
    return `import * as THREE from 'three';
import { loadCharacter } from '@rigforge/three';

// Clips in this file: ${clips}
const character = await loadCharacter('${input.url}');
scene.add(character.object);
character.play('${initial}');

// Crossfade to another action, e.g. on key press:
window.addEventListener('keydown', (e) => {
  if (e.key === ' ') character.play('${next}', { fade: 0.25 });
});

// Attach a prop to the right hand:
// character.attach('rightHand', swordMesh);

const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  character.update(clock.getDelta());
  renderer.render(scene, camera);
});
`;
  }
  if (kind === 'state-machine') {
    const has = (re: RegExp) => input.clipNames.find((n) => re.test(n));
    const idle = has(/idle/i) ?? initial;
    const walk = has(/^walk$/i) ?? has(/walk/i);
    const run = has(/run/i) ?? has(/gallop/i) ?? has(/trot/i);
    const jump = has(/jump/i);
    const blend = [[0, idle], ...(walk ? [[1.4, walk]] : []), ...(run ? [[4, run]] : [])]
      .map(([t, n]) => `[${t}, '${n}']`)
      .join(', ');
    return `import * as THREE from 'three';
import { loadCharacter } from '@rigforge/three';

const character = await loadCharacter('${input.url}');
scene.add(character.object);

// Idle/walk/run blend by speed${jump ? ', plus a jump' : ''}. Clips: ${clips}
const sm = character.stateMachine({
  initial: 'move',
  parameters: { speed: 0 },
  states: {
    move: { blend: { param: 'speed', clips: [${blend}] } },${jump ? `
    jump: { clip: '${jump}', loop: false },` : ''}
  },
  transitions: [${jump ? `
    { from: 'move', to: 'jump', when: [{ trigger: 'jump' }] },
    { from: 'jump', to: 'move', exitTime: 0.9 },
  ` : ''}],
});

// Keep feet on uneven terrain and drive it from your controller:
character.enableFootIK({ ground: [terrain] });
const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  sm.set('speed', player.velocity.length()); // meters per second
  if (input.jumpPressed) sm.trigger('jump');
  character.update(clock.getDelta());
  renderer.render(scene, camera);
});
`;
  }
  if (kind === 'r3f') {
    return `import { Canvas } from '@react-three/fiber';
import { Character } from '@rigforge/r3f';
import { useState } from 'react';

// Clips in this file: ${clips}
export function Scene() {
  const [action, setAction] = useState('${initial}');
  return (
    <Canvas camera={{ position: [0, 1.4, 3] }}>
      <ambientLight intensity={0.6} />
      <directionalLight position={[2, 4, 3]} />
      <Character
        src="${input.url}"
        action={action}
        fade={0.25}
        onClick={() => setAction(action === '${initial}' ? '${next}' : '${initial}')}
      />
    </Canvas>
  );
}
`;
  }
  return `import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

// Plain three.js, no RigForge runtime. Clips in this file: ${clips}
const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
const gltf = await loader.loadAsync('${input.url}');
scene.add(gltf.scene);

const mixer = new THREE.AnimationMixer(gltf.scene);
const actions = Object.fromEntries(gltf.animations.map((clip) => [clip.name, mixer.clipAction(clip)]));
let current = actions['${initial}'];
current.play();

function play(name, fade = 0.25) {
  const next = actions[name];
  if (!next || next === current) return;
  next.reset().play();
  current.crossFadeTo(next, fade, false);
  current = next;
}

const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  mixer.update(clock.getDelta());
  renderer.render(scene, camera);
});
`;
}
