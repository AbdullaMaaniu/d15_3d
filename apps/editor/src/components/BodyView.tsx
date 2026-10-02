import { useEffect, useState } from 'react';
import type { SkinnedMesh } from 'three';
import { useStore } from '../store';
import { bodySkinColor, buildBodyMesh, loadReferenceBody } from '../lib/body';

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
    let cancelled = false;
    const t = setTimeout(async () => {
      const ref = await loadReferenceBody();
      if (cancelled) return;
      const skin = bodySkinColor();
      try {
        const t0 = performance.now();
        const next = buildBodyMesh(built, joints, shape, skin, ref);
        useStore.setState({ bodyInfo: { triangles: next.geometry.index!.count / 3, ms: performance.now() - t0 } });
        setMesh((prev) => {
          prev?.geometry.dispose();
          return next;
        });
      } catch (e) {
        console.warn('[rigforge] body generation failed', e);
      }
    }, 60);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [character, joints, shape, rigType, partsVersion]);

  useEffect(() => () => mesh?.geometry.dispose(), [mesh]);
  return mesh ? <primitive object={mesh} /> : null;
}
