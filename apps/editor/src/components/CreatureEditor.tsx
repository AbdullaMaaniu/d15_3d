import { useMemo } from 'react';
import type { ThreeEvent } from '@react-three/fiber';
import { DoubleSide, Mesh, MeshBasicMaterial, Raycaster } from 'three';
import { useStore } from '../store';
import { JointEditor } from './JointEditor';

/**
 * Free-form skeleton building: clicking the mesh adds a child of the selected
 * joint *inside* the body, at the midpoint between where the click ray enters
 * and exits the surface.
 */
export function CreatureEditor() {
  const addCreatureJoint = useStore((s) => s.addCreatureJoint);
  return (
    <>
      <InteriorClickMesh onPlace={addCreatureJoint} />
      <JointEditor />
    </>
  );
}

/** See-through mesh; clicking it reports the point inside the body under the cursor. */
export function InteriorClickMesh({ onPlace }: { onPlace: (p: [number, number, number]) => void }) {
  const normalized = useStore((s) => s.normalized);
  const materials = useMemo(
    () =>
      normalized?.materials.map((m) => {
        const c = m.clone();
        c.transparent = true;
        c.opacity = 0.45;
        c.depthWrite = false;
        return c;
      }),
    [normalized],
  );
  // Double-sided proxy so the ray can find the far side of the surface.
  const proxy = useMemo(() => (normalized ? new Mesh(normalized.geometry, new MeshBasicMaterial({ side: DoubleSide })) : null), [normalized]);
  if (!normalized || !materials || !proxy) return null;

  const onClick = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    const dir = e.ray.direction.clone().normalize();
    const entry = e.point.clone();
    const ray = new Raycaster(entry.clone().addScaledVector(dir, 1e-4), dir);
    proxy.updateMatrixWorld(true);
    const exit = ray.intersectObject(proxy, false)[0]?.point;
    const inside = exit ? entry.clone().add(exit).multiplyScalar(0.5) : entry.clone().addScaledVector(dir, 0.02);
    onPlace([inside.x, inside.y, inside.z]);
  };

  return <mesh geometry={normalized.geometry} material={materials} onClick={onClick} />;
}

