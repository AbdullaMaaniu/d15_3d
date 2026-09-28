import { useEffect, useMemo, useRef, useState } from 'react';
import { useThree, type ThreeEvent } from '@react-three/fiber';
import { Line } from '@react-three/drei';
import { Plane, Raycaster, Vector2, Vector3 } from 'three';
import { skeletonDefs, useStore } from '../store';

type V3 = [number, number, number];

const COLORS = { left: '#38bdf8', right: '#fb923c', center: '#facc15', selected: '#ffffff' };

function colorOf(name: string): string {
  if (name.startsWith('left')) return COLORS.left;
  if (name.startsWith('right')) return COLORS.right;
  return COLORS.center;
}

/**
 * Draggable joint markers (always drawn on top of the see-through mesh).
 * Dragging moves a joint in the plane facing the camera; with symmetry on,
 * the mirrored joint follows.
 */
export function JointEditor() {
  const joints = useStore((s) => s.joints);
  const fingers = useStore((s) => s.fingers);
  const showFingers = useStore((s) => s.showFingerMarkers);
  const selected = useStore((s) => s.selectedBone);
  const height = useStore((s) => s.height);
  const moveJoint = useStore((s) => s.moveJoint);
  const setStore = useStore((s) => s.set);
  const { camera, gl, controls } = useThree();
  const [hover, setHover] = useState<string | null>(null);
  const drag = useRef<{ name: string; tail: boolean; plane: Plane } | null>(null);

  const rigType = useStore((s) => s.rigType);
  const defs = useMemo(() => skeletonDefs(), [fingers, rigType]);

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
      if (ray.ray.intersectPlane(d.plane, hit)) moveJoint(d.name, [hit.x, hit.y, hit.z], d.tail);
    };
    const up = () => {
      if (!drag.current) return;
      drag.current = null;
      if (controls) (controls as any).enabled = true;
      el.style.cursor = '';
    };
    el.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      el.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  }, [gl, camera, controls, moveJoint]);

  if (!joints) return null;
  const r = 0.014 * (height / 1.8);

  const startDrag = (name: string, tail: boolean) => (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    const p = (tail ? joints.tails : joints.joints)[name];
    const normal = camera.getWorldDirection(new Vector3()).negate();
    drag.current = { name, tail, plane: new Plane().setFromNormalAndCoplanarPoint(normal, new Vector3(...p)) };
    if (controls) (controls as any).enabled = false;
    gl.domElement.style.cursor = 'grabbing';
    setStore('selectedBone', name);
  };

  const markers: Array<{ key: string; name: string; p: V3; tail: boolean; small: boolean }> = [];
  const lines: Array<{ key: string; a: V3; b: V3; color: string; small: boolean }> = [];
  for (const def of defs) {
    const p = joints.joints[def.name];
    if (!p) continue;
    // Finger joints are always drawn as lines; their markers are optional to reduce clutter.
    if (!def.isFinger || showFingers) markers.push({ key: def.name, name: def.name, p, tail: false, small: def.isFinger });
    const tail = joints.tails[def.name];
    if (def.parent && joints.joints[def.parent]) {
      const parent = joints.joints[def.parent];
      lines.push({ key: `${def.parent}-${def.name}`, a: parent, b: p, color: colorOf(def.name), small: def.isFinger });
    }
    if (tail) {
      lines.push({ key: `${def.name}-tail`, a: p, b: tail, color: colorOf(def.name), small: def.isFinger });
      if (!def.isFinger || showFingers) markers.push({ key: `${def.name}:tail`, name: def.name, p: tail, tail: true, small: true });
    }
  }

  return (
    <group>
      {lines.map((l) => (
        <Line key={l.key} points={[l.a, l.b]} color={l.color} lineWidth={l.small ? 1 : 2} depthTest={false} transparent opacity={0.9} renderOrder={10} />
      ))}
      {markers.map((m) => {
        const isSel = selected === m.name && !m.tail;
        const isHover = hover === m.key;
        return (
          <mesh
            key={m.key}
            position={m.p}
            renderOrder={11}
            onPointerDown={startDrag(m.name, m.tail)}
            onPointerOver={(e) => {
              e.stopPropagation();
              setHover(m.key);
              gl.domElement.style.cursor = 'grab';
            }}
            onPointerOut={() => {
              setHover(null);
              if (!drag.current) gl.domElement.style.cursor = '';
            }}
          >
            {m.tail ? <octahedronGeometry args={[r * 0.8]} /> : <sphereGeometry args={[m.small ? r * 0.6 : r, 16, 12]} />}
            <meshBasicMaterial color={isSel || isHover ? COLORS.selected : colorOf(m.name)} depthTest={false} transparent opacity={0.95} />
          </mesh>
        );
      })}
    </group>
  );
}
