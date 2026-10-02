import { AnimationClip, BoxGeometry, BufferGeometry, Float32BufferAttribute, Uint32BufferAttribute, CapsuleGeometry, CylinderGeometry, SphereGeometry, Group, LoadingManager, Mesh, MeshStandardMaterial, type Object3D } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { MTLLoader } from 'three/examples/jsm/loaders/MTLLoader.js';
import { BVHLoader } from 'three/examples/jsm/loaders/BVHLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { createClothedSample, createMannequin, createQuadrupedMannequin } from '@rigforge/core';
import { loadReferenceBody } from './body';

export interface LoadedFile {
  name: string;
  scene: Object3D;
  animations: AnimationClip[];
}

const MODEL_EXT = /\.(glb|gltf|fbx|obj|bvh)$/i;

/**
 * Loads a model from dropped files. Companion files (textures, .bin, .mtl) are
 * resolved by file name through a LoadingManager URL modifier.
 */
export async function loadFiles(files: File[]): Promise<LoadedFile> {
  const main = files.find((f) => MODEL_EXT.test(f.name));
  if (!main) throw new Error('Drop a .glb, .gltf, .fbx, .obj or .bvh file (plus any textures it uses).');
  const urls = new Map<string, string>();
  for (const f of files) urls.set(f.name.toLowerCase(), URL.createObjectURL(f));
  const manager = new LoadingManager();
  manager.setURLModifier((url) => {
    const base = decodeURIComponent(url.split(/[\\/]/).pop() ?? url).toLowerCase();
    return urls.get(base) ?? url;
  });
  const mainUrl = urls.get(main.name.toLowerCase())!;
  const ext = main.name.split('.').pop()!.toLowerCase();
  try {
    if (ext === 'glb' || ext === 'gltf') {
      const gltf = await new GLTFLoader(manager).setMeshoptDecoder(MeshoptDecoder).loadAsync(mainUrl);
      return { name: main.name, scene: gltf.scene, animations: gltf.animations };
    }
    if (ext === 'fbx') {
      const group = await new FBXLoader(manager).loadAsync(mainUrl);
      return { name: main.name, scene: group, animations: group.animations };
    }
    if (ext === 'obj') {
      const loader = new OBJLoader(manager);
      const mtl = files.find((f) => /\.mtl$/i.test(f.name));
      if (mtl) {
        const materials = await new MTLLoader(manager).loadAsync(urls.get(mtl.name.toLowerCase())!);
        materials.preload();
        loader.setMaterials(materials);
      }
      const group = await loader.loadAsync(mainUrl);
      return { name: main.name, scene: group, animations: [] };
    }
    if (ext === 'bvh') {
      const text = await main.text();
      const { skeleton, clip } = new BVHLoader().parse(text);
      const root = new Group();
      root.add(skeleton.bones[0]);
      clip.name = main.name.replace(/\.bvh$/i, '');
      return { name: main.name, scene: root, animations: [clip] };
    }
  } finally {
    // Keep blob URLs alive until textures have decoded.
    setTimeout(() => urls.forEach((u) => URL.revokeObjectURL(u)), 30_000);
  }
  throw new Error(`Unsupported file: ${main.name}`);
}

/** Built-in sample so the tool can be tried without a Meshy export. */
export function loadSample(pose: 'T' | 'A' = 'A'): LoadedFile {
  const { geometry } = createMannequin({ pose, fingers: true, detail: 16 });
  geometry.computeVertexNormals();
  const mesh = new Mesh(geometry, new MeshStandardMaterial({ color: 0xc9b8a6, roughness: 0.7 }));
  mesh.name = 'Mannequin';
  const root = new Group();
  root.add(mesh);
  return { name: `mannequin-${pose.toLowerCase()}-pose.glb`, scene: root, animations: [] };
}

/** Sample clothed character: one mesh with the clothes baked in, like a Meshy export. */
export async function loadClothedSample(): Promise<LoadedFile> {
  const ref = await loadReferenceBody();
  if (!ref) throw new Error('The clothed sample could not be loaded.');
  const s = createClothedSample(ref);
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(s.positions, 3));
  g.setAttribute('normal', new Float32BufferAttribute(s.normals, 3));
  g.setAttribute('color', new Float32BufferAttribute(s.colors, 3));
  g.setIndex(new Uint32BufferAttribute(s.index, 1));
  const mesh = new Mesh(g, new MeshStandardMaterial({ vertexColors: true, roughness: 0.8 }));
  mesh.name = 'ClothedSample';
  const root = new Group();
  root.add(mesh);
  return { name: 'clothed-sample.glb', scene: root, animations: [] };
}

export function hasSkeleton(scene: Object3D): boolean {
  let found = false;
  scene.traverse((o) => {
    if ((o as any).isSkinnedMesh) found = true;
  });
  return found;
}

/** Sample prop: a treasure chest with a separate lid and lock (made of distinct parts). */
export function loadSampleProp(): LoadedFile {
  const wood = new MeshStandardMaterial({ color: 0x8b5a2b, roughness: 0.8 });
  const metal = new MeshStandardMaterial({ color: 0xd4a017, roughness: 0.35, metalness: 0.8 });
  const root = new Group();
  const add = (g: import('three').BufferGeometry, m: MeshStandardMaterial, name: string) => {
    const mesh = new Mesh(g, m);
    mesh.name = name;
    root.add(mesh);
  };
  add(new BoxGeometry(1, 0.55, 0.6).translate(0, 0.275, 0), wood, 'Body');
  add(new BoxGeometry(1.04, 0.16, 0.64).translate(0, 0.64, 0), wood, 'Lid');
  add(new CylinderGeometry(0.03, 0.03, 1.06, 12).rotateZ(Math.PI / 2).translate(0, 0.575, -0.31), metal, 'Hinge');
  add(new BoxGeometry(0.12, 0.14, 0.04).translate(0, 0.49, 0.32), metal, 'Lock');
  return { name: 'treasure-chest.glb', scene: root, animations: [] };
}

/** Sample animal: a procedural dog. */
export function loadSampleAnimal(): LoadedFile {
  const { geometry } = createQuadrupedMannequin({ detail: 14 });
  geometry.computeVertexNormals();
  const mesh = new Mesh(geometry, new MeshStandardMaterial({ color: 0xb08050, roughness: 0.75 }));
  mesh.name = 'Dog';
  const root = new Group();
  root.add(mesh);
  return { name: 'sample-dog.glb', scene: root, animations: [] };
}

/** Sample creature: a snake lying along Z (no preset skeleton fits it). */
export function loadSampleCreature(): LoadedFile {
  const skin = new MeshStandardMaterial({ color: 0x5f8f3e, roughness: 0.6 });
  const root = new Group();
  const body = new Mesh(new CapsuleGeometry(0.035, 1.1, 8, 20, 24).rotateX(Math.PI / 2).translate(0, 0.04, -0.1), skin);
  const head = new Mesh(new SphereGeometry(0.055, 20, 14).scale(1, 0.7, 1.4).translate(0, 0.05, 0.52), skin);
  body.name = 'Body';
  head.name = 'Head';
  root.add(body, head);
  return { name: 'sample-snake.glb', scene: root, animations: [] };
}
