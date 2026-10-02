import { useEffect, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import { partsSummary, useStore } from '../store';
import { buildBodyMesh, loadReferenceBody, syncBodyPose, type BodyRig } from '../lib/body';

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
        useStore.setState({ bodyInfo: { triangles: next.mesh.geometry.index!.count / 3, ms: performance.now() - t0 } });
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
  // After the character's animation has posed its bones this frame.
  useFrame(() => {
    const built = character?.built;
    if (rig && built) syncBodyPose(rig, built);
  });
  return rig ? <primitive object={rig.root} /> : null;
}
