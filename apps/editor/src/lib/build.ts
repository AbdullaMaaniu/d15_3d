import { exportCharacter, type ExportResult } from '@rigforge/core';
import type { ControllerSetup } from '@rigforge/three';
import { suggestController, useStore } from '../store';

/** The controller roles to export: the user's edits if still valid, else the suggestion. */
export function exportController(): ControllerSetup {
  const s = useStore.getState();
  const names = new Set(s.clips.map((c) => c.name));
  const c = s.controller;
  if (c && c.locomotion.every(([, n]) => names.has(n)) && (!c.jump || names.has(c.jump)) && Object.values(c.actions ?? {}).every((n) => names.has(n))) return c;
  return suggestController();
}

/** Builds the GLB from the current rig and clips (bind pose, textured, every clip at its speed). */
export async function buildGlb(onProgress?: (stage: string) => void): Promise<ExportResult> {
  const { character, clips, exportPreset, springs, set } = useStore.getState();
  if (!character) throw new Error('Build the rig first.');
  const wasPlaying = useStore.getState().playing;
  let restore = () => {};
  try {
    set('playing', false);
    set('shading', 'textured');
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    // Bind pose, neutral face: expression previews aren't part of the file.
    const influences: Array<[number[], number[]]> = [];
    character.root.traverse((o: any) => {
      if (o.isSkinnedMesh) o.skeleton.pose();
      if (o.morphTargetInfluences) {
        influences.push([o.morphTargetInfluences, [...o.morphTargetInfluences]]);
        o.morphTargetInfluences.fill(0);
      }
    });
    restore = () => influences.forEach(([live, saved]) => saved.forEach((v, i) => (live[i] = v)));
    character.root.updateMatrixWorld(true);
    // Spring bones and controller roles ride along as node extras; @rigforge/three reads them on load.
    character.root.userData.rigforge = {
      ...(character.root.userData.rigforge ?? {}),
      springs: springs.chains.length ? springs : undefined,
      controller: exportController(),
    };
    const baked = clips.map((c) => {
      const clip = c.baked.clone();
      clip.name = c.name;
      if (c.speed !== 1) for (const t of clip.tracks) t.scale(1 / c.speed);
      clip.resetDuration();
      clip.userData = { rigforge: { loop: c.loop, inPlace: c.inPlace } };
      return clip;
    });
    const res = await exportCharacter(character.root, baked, { preset: exportPreset, onProgress });
    set('exportResult', res);
    return res;
  } finally {
    restore();
    set('playing', wasPlaying);
  }
}
