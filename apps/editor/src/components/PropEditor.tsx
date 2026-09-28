import { useEffect, useMemo, useRef } from 'react';
import { useThree, type ThreeEvent } from '@react-three/fiber';
import { Line } from '@react-three/drei';
import { Color, Float32BufferAttribute, MeshStandardMaterial, Plane, Raycaster, Vector2, Vector3 } from 'three';
import { useStore } from '../store';

/** Distinct color per bone (index 0 = root, neutral). */
export function propBoneColor(i: number): Color {
  if (i === 0) return new Color('#9aa3b2');
  return new Color().setHSL((i * 0.61803398875 + 0.05) % 1, 0.75, 0.55);
}

/**
 * Prop setup: parts are tinted with the color of the bone they belong to.
 * Click a part to give it to the selected bone; drag a pivot to move that bone's hinge.
 */
export function PropEditor() {
  const normalized = useStore((s) => s.normalized);
  const split = useStore((s) => s.propSplit);
  const rig = useStore((s) => s.propRig);
  const selected = useStore((s) => s.selectedBone);
  const assignPart = useStore((s) => s.assignPart);
  const updatePropBone = useStore((s) => s.updatePropBone);
  const set = useStore((s) => s.set);
  const { camera, gl, controls } = useThree();
  const drag = useRef<{ name: string; plane: Plane } | null>(null);

  const geometry = useMemo(() => normalized?.geometry.clone() ?? null, [normalized]);
  const material = useMemo(() => new MeshStandardMaterial({ vertexColors: true, roughness: 0.7 }), []);

  // Tint by bone assignment.
  useEffect(() => {
    if (!geometry || !split || !rig) return;
    const names = rig.bones.map((b) => b.name);
    const colors = new Float32Array(split.vertexPart.length * 3);
    const partColor = new Map<number, Color>();
    for (const part of split.parts) {
      const bone = rig.partBone[part.id] ?? 'root';
      const c = propBoneColor(Math.max(0, names.indexOf(bone)));
      if (bone === selected && bone !== 'root') c.lerp(new Color('#ffffff'), 0.25);
      partColor.set(part.id, c);
    }
    split.vertexPart.forEach((p, v) => {
      const c = partColor.get(p) ?? new Color('#9aa3b2');
      colors.set([c.r, c.g, c.b], v * 3);
    });
    geometry.setAttribute('color', new Float32BufferAttribute(colors, 3));
  }, [geometry, split, rig, selected]);

  useEffect(() => {
    const el = gl.domElement;
    const ray = new Raycaster();
    const ndc = new Vector2();
    const hit = new Vector3();
    const move = (e: PointerEvent) => {
      const d = drag.current;
      if (!d) return;
      const rect = el.getBoundingClientRect();
      ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
      ray.setFromCamera(ndc, camera);
      if (ray.ray.intersectPlane(d.plane, hit)) updatePropBone(d.name, { pivot: [hit.x, hit.y, hit.z] });
    };
    const up = () => {
      if (!drag.current) return;
      drag.current = null;
      if (controls) (controls as any).enabled = true;
    };
    el.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      el.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  }, [gl, camera, controls, updatePropBone]);

  if (!geometry || !split || !rig) return null;
  const height = useStore.getState().height;
  const r = 0.02 * Math.max(0.5, height);

  const onPick = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    const face = e.face;
    if (!face) return;
    assignPart(split.vertexPart[face.a]);
  };

  return (
    <group>
      <mesh geometry={geometry} material={material} onClick={onPick} castShadow />
      {rig.bones.map((b, i) => {
        const parent = b.parent ? rig.bones.find((x) => x.name === b.parent) : undefined;
        const on = b.name === selected;
        return (
          <group key={b.name}>
            {parent && <Line points={[parent.pivot, b.pivot]} color={`#${propBoneColor(i).getHexString()}`} lineWidth={2} depthTest={false} renderOrder={10} />}
            <mesh
              position={b.pivot}
              renderOrder={11}
              onPointerDown={(e) => {
                e.stopPropagation();
                set('selectedBone', b.name);
                const normal = camera.getWorldDirection(new Vector3()).negate();
                drag.current = { name: b.name, plane: new Plane().setFromNormalAndCoplanarPoint(normal, new Vector3(...b.pivot)) };
                if (controls) (controls as any).enabled = false;
              }}
            >
              <sphereGeometry args={[on ? r * 1.3 : r, 16, 12]} />
              <meshBasicMaterial color={on ? '#ffffff' : `#${propBoneColor(i).getHexString()}`} depthTest={false} transparent opacity={0.95} toneMapped={false} />
            </mesh>
          </group>
        );
      })}
    </group>
  );
}
