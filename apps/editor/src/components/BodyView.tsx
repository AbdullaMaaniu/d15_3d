import { useEffect, useState } from 'react';
import type { SkinnedMesh } from 'three';
import { partsSummary, useStore } from '../store';
import { buildBodyMesh } from '../lib/body';

const DEFAULT_SKIN = '#d9a07a';

/** The generated body inside the character, regenerated shortly after the shape changes. */
export function BodyView() {
  const character = useStore((s) => s.character);
  const joints = useStore((s) => s.joints);
  const shape = useStore((s) => s.bodyShape);
  const rigType = useStore((s) => s.rigType);
  const partsVersion = useStore((s) => s.partsVersion);
  const [mesh, setMesh] = useState<SkinnedMesh | null>(null);

  useEffect(() => {
    const built = character?.built;
    if (!built || !joints || rigType !== 'humanoid') {
      setMesh(null);
      return;
    }
    const t = setTimeout(() => {
      // Skin colour from the Parts step, when it has a Skin part.
      const parts = useStore.getState().parts;
      const skinIndex = parts?.defs.findIndex((d) => d.name.toLowerCase() === 'skin') ?? -1;
      const skin = (skinIndex >= 0 && partsSummary()?.baseColors[skinIndex]) || DEFAULT_SKIN;
      try {
        const t0 = performance.now();
        const next = buildBodyMesh(built, joints, shape, skin);
        useStore.setState({ bodyInfo: { triangles: next.geometry.index!.count / 3, ms: performance.now() - t0 } });
        setMesh((prev) => {
          prev?.geometry.dispose();
          return next;
        });
      } catch (e) {
        console.warn('[rigforge] body generation failed', e);
      }
    }, 60);
    return () => clearTimeout(t);
  }, [character, joints, shape, rigType, partsVersion]);

  useEffect(() => () => mesh?.geometry.dispose(), [mesh]);
  return mesh ? <primitive object={mesh} /> : null;
}
