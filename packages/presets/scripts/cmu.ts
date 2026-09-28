import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Group, type AnimationClip } from 'three';
import { BVHLoader } from 'three/examples/jsm/loaders/BVHLoader.js';
import { autoMapBones, bindSkeleton, type SkeletonBinding } from '@rigforge/core';

const here = dirname(fileURLToPath(import.meta.url));
export const CACHE = join(here, '..', '.cache');
const MIRROR = 'https://raw.githubusercontent.com/una-dinosauria/cmu-mocap/master/data';

/** Downloads (once) and parses a CMU BVH take, e.g. "143_32". */
export function loadCmu(take: string): { binding: SkeletonBinding; clip: AnimationClip; duration: number } {
  const [subject] = take.split('_');
  const file = join(CACHE, `${take}.bvh`);
  if (!existsSync(file)) {
    mkdirSync(CACHE, { recursive: true });
    const url = `${MIRROR}/${subject.padStart(3, '0')}/${take}.bvh`;
    execFileSync('curl', ['-sSfL', '--retry', '3', '-o', file, url]);
  }
  const text = readFileSync(file, 'utf8');
  const { skeleton, clip } = new BVHLoader().parse(text);
  const root = new Group();
  root.add(skeleton.bones[0]);
  const { map, missing } = autoMapBones(root);
  if (missing.length) throw new Error(`${take}: unmapped bones ${missing.join(', ')}`);
  const binding = bindSkeleton(root, map);
  return { binding, clip, duration: clip.duration };
}
