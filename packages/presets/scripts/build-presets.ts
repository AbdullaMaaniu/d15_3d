// Builds clips.json from the CMU motion capture database.
//   pnpm build:presets
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  alignHeading,
  encodeClip,
  extractNormalizedClip,
  findLoop,
  makeSeamlessLoop,
  sliceClip,
  symmetrizeArms,
  type PresetPack,
} from '@rigforge/core';
import { CLIPS } from './clips.config';
import { loadCmu } from './cmu';

const here = dirname(fileURLToPath(import.meta.url));
const FPS = 30;

const pack: PresetPack = {
  version: 1,
  license: 'CMU Graphics Lab Motion Capture Database terms: free for research and commercial use; the data itself may not be resold.',
  attribution: 'The data used in this project was obtained from mocap.cs.cmu.edu. The database was created with funding from NSF EIA-0196217. BVH conversion by Bruce Hahne.',
  clips: [],
};

for (const spec of CLIPS) {
  const { binding, clip } = loadCmu(spec.take);
  const [s0, s1] = spec.window;
  let n = extractNormalizedClip(binding, clip, { fps: FPS, start: s0, end: s1, name: spec.name });
  let info = '';
  if (spec.loop) {
    const [p0, p1] = spec.loop.period.map((p) => Math.round(p * FPS));
    const best = findLoop(n, p0, p1);
    n = sliceClip(n, best.start, best.end + 1);
    n = alignHeading(n, spec.heading);
    n = makeSeamlessLoop(n);
    if (spec.arms) n = symmetrizeArms(n, spec.arms);
    info = `loop ${((best.end - best.start) / FPS).toFixed(2)}s err ${best.error.toFixed(3)}`;
  } else {
    n = alignHeading(n, spec.heading);
    n.loop = false;
    info = `once ${((n.frames - 1) / FPS).toFixed(2)}s`;
  }
  n.name = spec.name;
  pack.clips.push(encodeClip(n, { id: spec.id, category: spec.category, source: `CMU ${spec.take}`, description: spec.description }));
  console.log(`${spec.id.padEnd(14)} ${spec.take.padEnd(7)} ${info}`);
}

const out = join(here, '..', 'clips.json');
writeFileSync(out, JSON.stringify(pack));
console.log(`wrote ${out} (${(JSON.stringify(pack).length / 1024).toFixed(0)} KB, ${pack.clips.length} clips)`);
