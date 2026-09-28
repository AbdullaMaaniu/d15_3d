import { useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import { GizmoHelper, GizmoViewport, Grid, OrbitControls } from '@react-three/drei';
import { PMREMGenerator, type Mesh } from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { computeNormalization } from '@rigforge/core';
import { useStore } from '../store';
import { JointEditor } from './JointEditor';
import { CharacterView } from './CharacterView';

function RoomEnv() {
  const { gl, scene } = useThree();
  useEffect(() => {
    const pmrem = new PMREMGenerator(gl);
    const tex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = tex;
    scene.environmentIntensity = 0.6;
    return () => {
      scene.environment = null;
      tex.dispose();
      pmrem.dispose();
    };
  }, [gl, scene]);
  return null;
}

/** The imported model, previewed with the current orientation and scale. */
function SourceView() {
  const prepared = useStore((s) => s.prepared);
  const rotation = useStore((s) => s.rotation);
  const height = useStore((s) => s.height);
  const ref = useRef<Mesh>(null);
  const matrix = useMemo(
    () => (prepared ? computeNormalization(prepared.geometry, { rotation, targetHeight: height }).matrix : null),
    [prepared, rotation, height],
  );
  useEffect(() => {
    if (ref.current && matrix) {
      ref.current.matrix.copy(matrix);
      ref.current.matrixWorldNeedsUpdate = true;
    }
  }, [matrix]);
  if (!prepared) return null;
  return <mesh ref={ref} geometry={prepared.geometry} material={prepared.materials} matrixAutoUpdate={false} castShadow />;
}

/** Normalized mesh shown see-through while placing joints. */
function NormalizedView() {
  const normalized = useStore((s) => s.normalized);
  const materials = useMemo(
    () =>
      normalized?.materials.map((m) => {
        const c = m.clone();
        c.transparent = true;
        c.opacity = 0.38;
        c.depthWrite = false;
        return c;
      }),
    [normalized],
  );
  if (!normalized || !materials) return null;
  return <mesh geometry={normalized.geometry} material={materials} renderOrder={0} />;
}

/** Arrow on the floor pointing to +Z, the direction the character must face. */
function FrontIndicator({ height }: { height: number }) {
  const s = height / 1.8;
  return (
    <group position={[0, 0.002, 0.45 * s]} rotation={[-Math.PI / 2, 0, 0]} scale={s}>
      <mesh position={[0, 0.08, 0]}>
        <planeGeometry args={[0.05, 0.2]} />
        <meshBasicMaterial color="#f97316" />
      </mesh>
      <mesh position={[0, 0.22, 0]} rotation={[0, 0, 0]}>
        <circleGeometry args={[0.08, 3, Math.PI / 2]} />
        <meshBasicMaterial color="#f97316" />
      </mesh>
    </group>
  );
}

function CameraTarget() {
  const height = useStore((s) => s.height);
  const step = useStore((s) => s.step);
  const controls = useThree((s) => s.controls) as unknown as { target: import('three').Vector3; update(): void } | null;
  const camera = useThree((s) => s.camera);
  useEffect(() => {
    if (!controls) return;
    controls.target.set(0, height * 0.52, 0);
    camera.position.set(0, height * 0.62, height * 2.1);
    controls.update();
  }, [controls, camera, height, step]);
  return null;
}

function useIsSmall(): boolean {
  const query = '(max-width: 860px)';
  const [small, setSmall] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setSmall(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return small;
}

export function Viewport() {
  const small = useIsSmall();
  const step = useStore((s) => s.step);
  const character = useStore((s) => s.character);
  const height = useStore((s) => s.height);
  const hasModel = useStore((s) => !!s.prepared);

  return (
    <Canvas shadows dpr={[1, 2]} camera={{ position: [0, 1.1, 3.8], fov: 38, near: 0.01, far: 200 }} gl={{ preserveDrawingBuffer: true }}>
      <color attach="background" args={['#15171c']} />
      <RoomEnv />
      <hemisphereLight args={['#ffffff', '#40444f', 0.8]} />
      <directionalLight position={[2.5, 5, 3]} intensity={1.6} castShadow shadow-mapSize={[2048, 2048]} shadow-camera-left={-3} shadow-camera-right={3} shadow-camera-top={3} shadow-camera-bottom={-3} />
      <Grid infiniteGrid cellSize={0.1} sectionSize={1} cellColor="#2a2e37" sectionColor="#3b4150" fadeDistance={30} fadeStrength={1.5} />
      <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow position={[0, -0.001, 0]}>
        <circleGeometry args={[3, 48]} />
        <shadowMaterial opacity={0.35} />
      </mesh>
      <OrbitControls makeDefault enableDamping dampingFactor={0.12} />
      <CameraTarget />

      {(step === 'import' || step === 'orient') && hasModel && <SourceView />}
      {step === 'orient' && <FrontIndicator height={height} />}
      {step === 'rig' && !character && (
        <>
          <NormalizedView />
          <JointEditor />
        </>
      )}
      {character && step !== 'import' && step !== 'orient' && <CharacterView />}

      {!small && (
        <GizmoHelper alignment="bottom-right" margin={[64, 64]}>
          <GizmoViewport axisColors={['#ef4444', '#22c55e', '#3b82f6']} labelColor="#fff" />
        </GizmoHelper>
      )}
    </Canvas>
  );
}
