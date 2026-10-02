import { useEffect, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import { partsSummary, useStore } from '../store';
import { buildBodyMesh, dressBody, loadReferenceBody, syncBodyPose, type BodyRig } from '../lib/body';

const DEFAULT_SKIN = '#d9a07a';

/** The body, following the character's pose, regenerated shortly after the shape changes. */
export function BodyView() {
  const character = useStore((s) => s.character);
  const joints = useStore((s) => s.joints);
  const shape = useStore((s) => s.bodyShape);
  const rigType = useStore((s) => s.rigType);
  const partsVersion = useStore((s) => s.partsVersion);
  const [rig, setRig] = useState<BodyRig | null>(null);

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
      // Skin colour from the Parts step, when it has a Skin part.
      const parts = useStore.getState().parts;
      const skinIndex = parts?.defs.findIndex((d) => d.name.toLowerCase() === 'skin') ?? -1;
      const skin = (skinIndex >= 0 && partsSummary()?.baseColors[skinIndex]) || DEFAULT_SKIN;
      try {
        const t0 = performance.now();
        const next = buildBodyMesh(built, joints, shape, skin, ref);
        const g = next.mesh.geometry;
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
  // The character's clothes follow the body while it's shown.
  useEffect(() => {
    const built = character?.built;
    if (!rig || !built) return;
    syncBodyPose(rig, built);
    return dressBody(rig, built);
  }, [rig, character]);
  // After the character's animation has posed its bones this frame.
  useFrame(() => {
    const built = character?.built;
    if (rig && built) syncBodyPose(rig, built);
  });
  return rig ? <primitive object={rig.root} /> : null;
}
