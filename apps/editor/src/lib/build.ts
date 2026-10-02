import { coveredBodyTriangles, exportCharacter, type ExportResult, type Follower } from '@rigforge/core';
import type { ControllerSetup } from '@rigforge/three';
import { Uint32BufferAttribute, type Object3D, type SkinnedMesh } from 'three';
import { suggestController, useStore } from '../store';
import { exportBodyRig } from './body';
import { garmentsForExport } from './garments';

interface ExportParts {
  /** Meshes on the character's skeleton written beside (or instead of) its own: the separated garments. */
  layers: SkinnedMesh[];
  /** The generated body on its own skeleton, which follows the character's. */
  followers: Follower[];
  /** Left out of the file: the character's mesh, when the garments and body replace it. */
  omit: Object3D[];
}

/**
 * What goes into the GLB beside the rig. With the clothes separated (Body
 * step), the garments and the body replace the character's mesh, and the body
 * leaves out its triangles under the clothes; without the body, the mesh is
 * exported as it is, since the garments alone have holes where the skin was.
 */
async function exportParts(): Promise<ExportParts> {
  const out: ExportParts = { layers: [], followers: [], omit: [] };
  const rig = await exportBodyRig();
  if (!rig) return out;
  rig.root.name = 'Body';
  rig.mesh.name = 'BodyMesh';
  out.followers.push({ root: rig.root, links: rig.links.map(({ bone, source }) => ({ bone, source })), stride: rig.stride });
  const garments = garmentsForExport();
  if (!garments?.meshes.length) return out;
  out.layers.push(...garments.meshes);
  out.omit.push(useStore.getState().character!.built!.mesh);
  if (useStore.getState().garments.hideCovered) {
    const g = rig.mesh.geometry;
    const full = g.index!.array as Uint32Array;
    const covered = coveredBodyTriangles(
      { positions: g.attributes.position.array as Float32Array, normals: g.attributes.normal.array as Float32Array, index: full },
      garments.separation.pieces,
      { headCut: garments.separation.headCut },
    );
    const kept: number[] = [];
    for (let t = 0; t < covered.length; t++) if (!covered[t]) kept.push(full[t * 3], full[t * 3 + 1], full[t * 3 + 2]);
    g.setIndex(new Uint32BufferAttribute(Uint32Array.from(kept), 1));
  }
  return out;
}

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
  try {
    set('playing', false);
    set('shading', 'textured');
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    character.root.traverse((o: any) => {
      if (o.isSkinnedMesh) o.skeleton.pose();
    });
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
    onProgress?.('Fitting the body');
    const { layers, followers, omit } = await exportParts();
    try {
      const res = await exportCharacter(character.root, baked, { preset: exportPreset, onProgress, layers, followers, omit });
      set('exportResult', res);
      return res;
    } finally {
      for (const l of layers) l.geometry.dispose();
      for (const f of followers) f.root.traverse((o) => (o as SkinnedMesh).isSkinnedMesh && (o as SkinnedMesh).geometry.dispose());
    }
  } finally {
    set('playing', wasPlaying);
  }
}
