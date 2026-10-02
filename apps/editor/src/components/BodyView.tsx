import { useEffect, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import { Uint32BufferAttribute, type Material, type SkinnedMesh } from 'three';
import { coveredBodyTriangles, type GarmentSeparation, type HeadCut, type RiggedCharacter } from '@rigforge/core';
import { garmentRegions, useStore } from '../store';
import { bodySkinColor, buildBodyMesh, dressBody, dressMesh, loadReferenceBody, restOnBody, syncBodyPose, type BodyRig } from '../lib/body';
import { buildGarmentMeshes, separateCharacter } from '../lib/garments';

/**
 * The body, following the character's pose, regenerated shortly after the
 * shape changes, and the clothes cut from the character's mesh around it.
 */
export function BodyView() {
  const character = useStore((s) => s.character);
  const joints = useStore((s) => s.joints);
  const shape = useStore((s) => s.bodyShape);
  const rigType = useStore((s) => s.rigType);
  const partsVersion = useStore((s) => s.partsVersion);
  const garments = useStore((s) => s.garments);
  const shading = useStore((s) => s.shading);
  const [rig, setRig] = useState<BodyRig | null>(null);
  const [cut, setCut] = useState<{ sep: GarmentSeparation; meshes: SkinnedMesh[] } | null>(null);

  // The clothes, cut from the character's mesh.
  useEffect(() => {
    const built = character?.built;
    if (!built || rigType !== 'humanoid' || !garments.separate) {
      setCut(null);
      useStore.setState({ garmentInfo: null });
      return;
    }
    const t = setTimeout(() => {
      const found = garmentRegions();
      if (!found) return;
      try {
        const t0 = performance.now();
        const sep = separateCharacter(built, joints, found.regions, { keepHead: garments.keepHead });
        const notes = [...sep.notes];
        if (!sep.pieces.length) notes.push('No clothes found: the whole mesh looks like skin, so it is shown as imported.');
        // Nothing to cut: keep the mesh as it is.
        const meshes = sep.pieces.length ? buildGarmentMeshes(built, sep) : [];
        setCut(sep.pieces.length ? { sep, meshes } : null);
        useStore.setState({
          garmentInfo: {
            pieces: sep.pieces.map((p) => ({ name: p.name, kind: p.kind, triangles: p.index.length / 3, openings: p.openings.length })),
            auto: found.auto,
            notes,
            ms: performance.now() - t0,
            hiddenBody: 0,
          },
        });
      } catch (e) {
        console.warn('[rigforge] garment separation failed', e);
        setCut(null);
      }
    }, 30);
    return () => clearTimeout(t);
  }, [character, joints, rigType, partsVersion, garments.separate, garments.keepHead]);

  useEffect(() => () => cut?.meshes.forEach((m) => m.geometry.dispose()), [cut]);

  // The body.
  useEffect(() => {
    const built = character?.built;
    if (!built || !joints || rigType !== 'humanoid') {
      setRig(null);
      return;
    }
    let cancelled = false;
    const t = setTimeout(async () => {
      const ref = await loadReferenceBody();
      if (cancelled) return;
      const skin = bodySkinColor();
      try {
        const t0 = performance.now();
        const next = buildBodyMesh(built, joints, shape, skin, ref);
        const g = next.mesh.geometry;
        g.userData.rfFullIndex = (g.index!.array as Uint32Array).slice();
        g.computeBoundingBox();
        const height = g.boundingBox!.max.y - g.boundingBox!.min.y;
        useStore.setState({ bodyInfo: { triangles: g.index!.count / 3, ms: performance.now() - t0, height, heightScale: shape.height ?? 1 } });
        syncBodyPose(next, built);
        setRig(next);
      } catch (e) {
        console.warn('[rigforge] body generation failed', e);
      }
    }, 60);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [character, joints, shape, rigType, partsVersion]);

  useEffect(() => () => rig?.mesh.geometry.dispose(), [rig]);

  // Leave out the body where the clothes cover it (both at rest on the body's skeleton, in rig space).
  useEffect(() => {
    if (!rig) return;
    const g = rig.mesh.geometry;
    const full = g.userData.rfFullIndex as Uint32Array;
    let index = full;
    let hidden = 0;
    if (cut && garments.hideCovered) {
      const covered = coveredBodyTriangles(
        { positions: g.attributes.position.array as Float32Array, normals: g.attributes.normal.array as Float32Array, index: full },
        // The clothes as they sit on the body's skeleton at rest.
        cut.sep.pieces.map((p) => ({ ...p, positions: restOnBody(rig.moves, p.positions, p.skinIndex, p.skinWeight) })),
        { headCut: headCutOnBody(rig, character!.built!, cut.sep.headCut) },
      );
      const kept: number[] = [];
      for (let t = 0; t < covered.length; t++) {
        if (covered[t]) hidden++;
        else kept.push(full[t * 3], full[t * 3 + 1], full[t * 3 + 2]);
      }
      index = Uint32Array.from(kept);
    }
    g.setIndex(new Uint32BufferAttribute(index, 1));
    const info = useStore.getState().garmentInfo;
    if (info) useStore.setState({ garmentInfo: { ...info, hiddenBody: hidden } });
  }, [rig, cut, garments.hideCovered, character]);

  // The cut clothes replace the character's mesh, beside it under the character's root; see-through like it in x-ray.
  useEffect(() => {
    const built = character?.built;
    if (!built || !cut) return;
    built.mesh.visible = false;
    built.root.add(...cut.meshes);
    return () => {
      built.root.remove(...cut.meshes);
      built.mesh.visible = true;
    };
  }, [character, cut]);
  useEffect(() => {
    if (!cut) return;
    for (const m of cut.meshes) {
      for (const mat of m.material as Material[]) {
        mat.transparent = shading === 'xray';
        mat.opacity = shading === 'xray' ? 0.35 : 1;
        mat.depthWrite = shading !== 'xray';
        mat.needsUpdate = true;
      }
    }
  }, [cut, shading]);
  // The character's clothes follow the body while it's shown: its own mesh and the cut garments.
  useEffect(() => {
    const built = character?.built;
    if (!rig || !built) return;
    syncBodyPose(rig, built);
    const undo = [dressBody(rig, built), ...(cut?.meshes.map((m) => dressMesh(rig, m)) ?? [])];
    return () => undo.forEach((u) => u());
  }, [rig, character, cut]);

  // After the character's animation has posed its bones this frame.
  useFrame(() => {
    const built = character?.built;
    if (rig && built) syncBodyPose(rig, built);
  });
  return (
    <>
      {rig && <primitive object={rig.root} />}
    </>
  );
}

/** The kept head's cut moved onto the body's skeleton: its plane with the neck, its reach with the head. */
function headCutOnBody(rig: BodyRig, built: RiggedCharacter, cut: HeadCut | null): HeadCut | null {
  if (!cut) return null;
  const names = built.skeleton.bones.map((b) => b.name);
  const move = (bone: string, p: [number, number, number]): [number, number, number] => {
    const i = names.indexOf(bone);
    if (i < 0) return p;
    const [x, y, z] = restOnBody(rig.moves, p, [i, 0, 0, 0], [1, 0, 0, 0]);
    return [x, y, z];
  };
  return { ...cut, point: move('neck', cut.point), center: move('head', cut.center) };
}
