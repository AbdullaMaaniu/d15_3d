import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { TransformControls } from '@react-three/drei';
import { Vector3, type Mesh, type Object3D } from 'three';
import { humanoidDefs } from '@rigforge/core';
import { useStore } from '../store';

/**
 * Keyframe posing: clickable handles on every bone, and a rotate (or, for the
 * hips, move) gizmo on the selected one. Releasing the gizmo sets a key when
 * auto-key is on.
 */
export function KeyEditor({ root }: { root: Object3D }) {
  const keyEdit = useStore((s) => s.keyEdit);
  const binding = useStore((s) => s.binding);
  const fingers = useStore((s) => s.fingers);
  const setKeyEdit = useStore((s) => s.setKeyEdit);
  const keyCurrentPose = useStore((s) => s.keyCurrentPose);

  const bones = useMemo(() => {
    if (!binding) return [] as Array<{ name: string; node: Object3D; finger: boolean }>;
    return humanoidDefs(fingers)
      .map((d) => ({ name: d.name, node: binding.map[d.name] ? root.getObjectByName(binding.map[d.name]) : undefined, finger: d.isFinger }))
      .filter((b): b is { name: string; node: Object3D; finger: boolean } => !!b.node);
  }, [binding, fingers, root]);

  const handles = useRef<Array<Mesh | null>>([]);
  const tmp = useMemo(() => new Vector3(), []);
  useFrame(() => {
    bones.forEach((b, i) => {
      const h = handles.current[i];
      if (h) h.position.copy(b.node.getWorldPosition(tmp));
    });
  });

  const selected = bones.find((b) => b.name === keyEdit.bone);
  const mode = keyEdit.bone === 'hips' ? keyEdit.mode : 'rotate';
  return (
    <>
      {bones.map((b, i) => {
        const on = b.name === keyEdit.bone;
        return (
          <mesh
            key={b.name}
            ref={(m) => (handles.current[i] = m)}
            renderOrder={25}
            onClick={(e) => {
              e.stopPropagation();
              setKeyEdit({ bone: b.name });
            }}
          >
            <sphereGeometry args={[b.finger ? 0.005 : on ? 0.016 : 0.011, 12, 8]} />
            <meshBasicMaterial color={on ? '#ffffff' : b.name.startsWith('left') ? '#38bdf8' : b.name.startsWith('right') ? '#fb923c' : '#facc15'} depthTest={false} transparent opacity={0.9} toneMapped={false} />
          </mesh>
        );
      })}
      {selected && (
        <TransformControls
          key={`${selected.name}:${mode}`}
          object={selected.node}
          mode={mode}
          space={mode === 'rotate' ? 'local' : 'world'}
          size={0.55}
          onMouseUp={() => {
            if (useStore.getState().keyEdit.autoKey) keyCurrentPose();
          }}
        />
      )}
    </>
  );
}
