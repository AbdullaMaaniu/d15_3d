import { useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import { AnimationMixer, Box3, Vector3, type AnimationClip, type Object3D } from 'three';
import { autoMapBones, bakeClip, bakePropClip, bindSkeleton, buildSkinnedCharacter, decodeClip, quadrupedGaits } from '@rigforge/core';
import { PRESETS, rigInputs, useStore } from '../store';
import { computeWeights } from '../lib/rigClient';

const HUMAN_CLIPS: Array<[string, string]> = [['walk', 'Walk'], ['idle', 'Idle'], ['run', 'Run'], ['wave', 'Wave'], ['jump', 'Jump']];
const ANIMAL_CLIPS: Array<[string, string]> = [['walk', 'Walk'], ['trot', 'Trot'], ['gallop', 'Gallop'], ['idle', 'Idle']];

interface Preview {
  root: Object3D;
  clip: AnimationClip | null;
  size: Vector3;
  center: Vector3;
  ms: number;
}

function Stage({ preview }: { preview: Preview }) {
  const mixer = useMemo(() => new AnimationMixer(preview.root), [preview]);
  useEffect(() => {
    if (preview.clip) mixer.clipAction(preview.clip).play();
    return () => {
      mixer.stopAllAction();
      mixer.uncacheRoot(preview.root);
    };
  }, [mixer, preview]);
  useFrame((_, dt) => mixer.update(Math.min(dt, 0.1)));
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls) as unknown as { target: Vector3; update(): void } | null;
  useEffect(() => {
    const { size, center } = preview;
    const fit = Math.max(size.y, size.x * 0.8, size.z);
    camera.position.set(center.x + fit * 0.9, center.y + fit * 0.15, center.z + fit * 2.1);
    camera.lookAt(center);
    if (controls) {
      controls.target.copy(center);
      controls.update();
    }
    // Only re-frame when the model changes size, not on every rebuild.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camera, controls, Math.round(preview.size.y * 100)]);
  return <primitive object={preview.root} />;
}

/** A small live view of the character rigged with the current joints, playing a clip. */
export function RigPreview() {
  const open = useStore((s) => s.rigPreview);
  const set = useStore((s) => s.set);
  const joints = useStore((s) => s.joints);
  const normalized = useStore((s) => s.normalized);
  const rigType = useStore((s) => s.rigType);
  const fingers = useStore((s) => s.fingers);
  const extraBones = useStore((s) => s.extraBones);
  const settings = useStore((s) => s.weightSettings);
  const [clipId, setClipId] = useState('walk');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [status, setStatus] = useState<'idle' | 'working' | 'error'>('idle');
  const generation = useRef(0);
  const animal = rigType === 'quadruped';
  const clips = animal ? ANIMAL_CLIPS : HUMAN_CLIPS;

  useEffect(() => {
    if (!clips.some(([id]) => id === clipId)) setClipId('walk');
  }, [clips, clipId]);

  // Re-rig (at low voxel resolution) shortly after the joints stop moving.
  useEffect(() => {
    if (!open || !joints || !normalized) return;
    const gen = ++generation.current;
    setStatus('working');
    const timer = setTimeout(async () => {
      try {
        const t0 = performance.now();
        const { positions, index, defs, rigJoints, kind, quad } = rigInputs();
        const w = await computeWeights(positions, index, rigJoints, kind, { ...settings, resolution: Math.min(settings.resolution, 96) }, () => {});
        if (gen !== generation.current) return;
        const built = buildSkinnedCharacter(normalized.geometry, normalized.materials, defs, rigJoints, w.skinIndex, w.skinWeight, 'Preview');
        let clip: AnimationClip | null = null;
        if (quad) {
          const gait = quadrupedGaits(rigJoints).find((g) => g.id === clipId);
          if (gait) clip = bakePropClip(built, gait.keys, gait.name);
        } else {
          const preset = PRESETS.find((p) => p.id === clipId);
          if (preset) clip = bakeClip(bindSkeleton(built.root, autoMapBones(built.root).map), decodeClip(preset), { inPlace: true, name: preset.name });
        }
        built.root.traverse((o) => (o.frustumCulled = false));
        const box = new Box3().setFromBufferAttribute(normalized.geometry.attributes.position as never);
        setPreview({ root: built.root, clip, size: box.getSize(new Vector3()), center: box.getCenter(new Vector3()), ms: performance.now() - t0 });
        setStatus('idle');
      } catch (e) {
        if (gen === generation.current) setStatus('error');
        console.warn('[rigforge] rig preview failed', e);
      }
    }, 350);
    return () => clearTimeout(timer);
  }, [open, joints, normalized, fingers, extraBones, settings, clipId]);

  if (!open) {
    return (
      <button className="pill rig-preview-open" onClick={() => set('rigPreview', true)}>
        ▶ Live preview
      </button>
    );
  }
  return (
    <aside className="rig-preview" aria-label="Rig preview">
      <header>
        <strong>Live preview</strong>
        <select className="text" value={clipId} onChange={(e) => setClipId(e.target.value)} aria-label="Preview clip">
          {clips.map(([id, label]) => (
            <option key={id} value={id}>{label}</option>
          ))}
        </select>
        <button className="btn small ghost" aria-label="Close preview" onClick={() => set('rigPreview', false)}>✕</button>
      </header>
      <div className="rig-preview-view">
        {preview && (
          <Canvas dpr={[1, 1.5]} camera={{ fov: 32, near: 0.01, far: 100 }}>
            <color attach="background" args={['#1b1e25']} />
            <hemisphereLight args={['#ffffff', '#3a3f4b', 1.2]} />
            <directionalLight position={[2, 4, 3]} intensity={1.8} />
            <OrbitControls makeDefault enablePan={false} enableDamping />
            <Stage preview={preview} />
          </Canvas>
        )}
        <span className="rig-preview-status" data-testid="rig-preview-status">
          {status === 'working' ? 'Updating…' : status === 'error' ? 'Preview failed' : preview ? `Rigged in ${Math.round(preview.ms)} ms · drag to orbit` : ''}
        </span>
      </div>
    </aside>
  );
}
