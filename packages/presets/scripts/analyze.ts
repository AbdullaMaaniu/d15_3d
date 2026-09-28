// Prints a coarse motion timeline of CMU takes to help choose clip ranges:
//   pnpm --filter @rigforge/presets exec tsx scripts/analyze.ts 143_32 143_01
import { Quaternion } from 'three';
import { extractNormalizedClip } from '@rigforge/core';
import { loadCmu } from './cmu';

for (const take of process.argv.slice(2)) {
  const { binding, clip, duration } = loadCmu(take);
  const n = extractNormalizedClip(binding, clip, { fps: 30, start: 0.1 });
  const B = n.bones.length;
  const lines: string[] = [];
  const qa = new Quaternion(), qb = new Quaternion();
  for (let s = 0; s + 15 < n.frames; s += 15) {
    const f = s, g = s + 15;
    const dx = n.hips[g * 3] - n.hips[f * 3], dz = n.hips[g * 3 + 2] - n.hips[f * 3 + 2];
    let ang = 0;
    for (let i = 0; i < B; i++) {
      qa.fromArray(n.rotations, (f * B + i) * 4);
      qb.fromArray(n.rotations, (g * B + i) * 4);
      ang += qa.angleTo(qb);
    }
    const hq = qa.fromArray(n.rotations, (f * B + n.bones.indexOf('hips')) * 4);
    const yaw = Math.round((Math.atan2(2 * (hq.w * hq.y + hq.x * hq.z), 1 - 2 * (hq.y * hq.y + hq.x * hq.x)) * 180) / Math.PI);
    lines.push(`${(0.1 + s / 30).toFixed(1).padStart(5)}s  speed ${(Math.hypot(dx, dz) * 2).toFixed(2)}  y ${n.hips[f * 3 + 1].toFixed(2).padStart(5)}  act ${ang.toFixed(1).padStart(5)}  yaw ${String(yaw).padStart(4)}`);
  }
  console.log(`== ${take} (${duration.toFixed(1)}s, hips height ${binding.hipsHeight.toFixed(2)})`);
  console.log(lines.join('\n'));
}
