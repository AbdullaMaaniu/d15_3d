import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import {
  AnimationMixer,
  Color,
  Float32BufferAttribute,
  LoopOnce,
  LoopRepeat,
  MeshBasicMaterial,
  MeshStandardMaterial,
  SkeletonHelper,
  type AnimationAction,
  Matrix3,
  Quaternion,
  Vector3,
  type Material,
  type Mesh,
  type Object3D,
  type SkinnedMesh,
} from 'three';
import { useStore } from '../store';

/** Hue per bone so the dominant-influence view reads as distinct regions. */
function boneColor(i: number, out: Color): Color {
  return out.setHSL((i * 0.61803398875) % 1, 0.9, 0.45 + 0.1 * ((i % 3) - 1));
}

function skinnedMeshes(root: Object3D): SkinnedMesh[] {
  const out: SkinnedMesh[] = [];
  root.traverse((o) => {
    if ((o as SkinnedMesh).isSkinnedMesh) out.push(o as SkinnedMesh);
  });
  return out;
}

/**
 * Renders the rigged character, drives its AnimationMixer from the store and
 * applies the debug shading modes (clay, x-ray, skin-weight heatmap).
 */
export function CharacterView() {
  const character = useStore((s) => s.character)!;
  const shading = useStore((s) => s.shading);
  const showSkeleton = useStore((s) => s.showSkeleton);
  const selectedBone = useStore((s) => s.selectedBone);
  const playing = useStore((s) => s.playing);
  const clips = useStore((s) => s.clips);
  const activeClip = useStore((s) => s.activeClip);
  const testClip = useStore((s) => s.testClip);
  const seek = useStore((s) => s.seek);
  const setStore = useStore((s) => s.set);
  const paint = useStore((s) => s.paint);
  const weightsVersion = useStore((s) => s.weightsVersion);

  const meshes = useMemo(() => skinnedMeshes(character.root), [character]);
  const original = useMemo(() => new Map(meshes.map((m) => [m, m.material])), [meshes]);
  const mixer = useMemo(() => new AnimationMixer(character.root), [character]);
  const current = useRef<AnimationAction | null>(null);
  const lastTimeUpdate = useRef(0);

  // Pick the clip to show: the pose-test clip (rig step) or the active library clip.
  const entry = clips.find((c) => c.id === activeClip);
  const clip = testClip ?? entry?.baked ?? null;
  const loop = testClip ? true : entry?.loop ?? true;
  const speed = testClip ? 1 : entry?.speed ?? 1;

  useEffect(() => {
    if (!clip) {
      current.current?.fadeOut(0.2);
      current.current = null;
      // Return to bind pose once the fade finishes.
      const t = setTimeout(() => {
        if (!current.current) {
          mixer.stopAllAction();
          meshes.forEach((m) => m.skeleton.pose());
        }
      }, 250);
      return () => clearTimeout(t);
    }
    const action = mixer.clipAction(clip);
    action.setLoop(loop ? LoopRepeat : LoopOnce, Infinity);
    action.clampWhenFinished = !loop;
    action.setEffectiveTimeScale(speed);
    action.reset().setEffectiveWeight(1).play();
    const prev = current.current;
    if (prev && prev !== action) prev.crossFadeTo(action, 0.25, false);
    current.current = action;
    return undefined;
  }, [clip, loop, speed, mixer, meshes]);

  useEffect(() => {
    if (seek === null || seek === undefined || !current.current) return;
    current.current.time = seek;
    mixer.update(0);
    setStore('seek', null);
  }, [seek, mixer, setStore]);

  useEffect(() => () => {
    mixer.stopAllAction();
    mixer.uncacheRoot(character.root);
  }, [mixer, character]);

  useFrame((_, delta) => {
    if (playing) mixer.update(Math.min(delta, 0.1));
    const now = performance.now();
    if (current.current && now - lastTimeUpdate.current > 100) {
      lastTimeUpdate.current = now;
      useStore.setState({ time: current.current.time });
    }
  });

  // Shading modes.
  const clay = useMemo(() => new MeshStandardMaterial({ color: '#b9b2a9', roughness: 0.85, metalness: 0 }), []);
  const heat = useMemo(() => new MeshBasicMaterial({ vertexColors: true, toneMapped: false }), []);
  useEffect(() => {
    for (const mesh of meshes) {
      const base = original.get(mesh)!;
      if (shading !== 'weights' && mesh.geometry.userData.rfPainted) {
        mesh.geometry.deleteAttribute('color');
        mesh.geometry.userData.rfPainted = false;
      }
      if (shading === 'textured') mesh.material = base;
      else if (shading === 'clay') mesh.material = clay;
      else if (shading === 'xray') {
        const mats = (Array.isArray(base) ? base : [base]).map((m: Material) => {
          const c = m.clone();
          c.transparent = true;
          c.opacity = 0.35;
          c.depthWrite = false;
          return c;
        });
        mesh.material = Array.isArray(base) ? mats : mats[0];
      } else {
        paintWeights(mesh, selectedBone);
        mesh.material = heat;
      }
    }
  }, [shading, selectedBone, meshes, original, clay, heat, weightsVersion]);

  const helper = useMemo(() => {
    const h = new SkeletonHelper(character.root);
    (h.material as any).depthTest = false;
    (h.material as any).transparent = true;
    h.renderOrder = 20;
    return h;
  }, [character]);

  const brush = useBrush();

  return (
    <>
      <primitive object={character.root} {...(paint.active ? brush.handlers : {})} />
      {showSkeleton && <primitive object={helper} />}
      {paint.active && (
        <mesh ref={brush.cursor} visible={false} renderOrder={30}>
          <ringGeometry args={[paint.radius * 0.92, paint.radius, 48]} />
          <meshBasicMaterial color={paint.mode === 'subtract' ? '#60a5fa' : paint.mode === 'smooth' ? '#a3e635' : '#fb923c'} depthTest={false} transparent opacity={0.9} toneMapped={false} />
        </mesh>
      )}
    </>
  );
}

/** Pointer handling for the weight brush: drag to paint, Alt/right-click to pick the bone under the cursor. */
function useBrush() {
  const cursor = useRef<Mesh>(null);
  const controls = useThree((s) => s.controls) as unknown as { enabled: boolean } | null;
  const down = useRef(false);
  const last = useRef<Vector3 | null>(null);
  const place = (e: ThreeEvent<PointerEvent>) => {
    const c = cursor.current;
    if (!c || !e.face) return;
    const n = e.face.normal.clone().applyMatrix3(new Matrix3().getNormalMatrix(e.object.matrixWorld)).normalize();
    c.position.copy(e.point).addScaledVector(n, 0.002);
    c.quaternion.copy(new Quaternion().setFromUnitVectors(new Vector3(0, 0, 1), n));
    c.visible = true;
  };
  const dabAt = (p: Vector3) => {
    const { radius } = useStore.getState().paint;
    if (last.current && last.current.distanceTo(p) < radius * 0.25) return;
    last.current = p.clone();
    useStore.getState().dab([p.x, p.y, p.z]);
  };
  const end = () => {
    if (!down.current) return;
    down.current = false;
    last.current = null;
    if (controls) controls.enabled = true;
  };
  const handlers = {
    onPointerDown: (e: ThreeEvent<PointerEvent>) => {
      e.stopPropagation();
      if (e.altKey || e.button === 2) {
        useStore.getState().pickBoneAt([e.point.x, e.point.y, e.point.z]);
        return;
      }
      if (e.button !== 0) return;
      down.current = true;
      if (controls) controls.enabled = false;
      (e.target as Element | null)?.setPointerCapture?.(e.pointerId);
      useStore.getState().beginStroke();
      dabAt(e.point);
    },
    onPointerMove: (e: ThreeEvent<PointerEvent>) => {
      place(e);
      if (down.current) dabAt(e.point);
    },
    onPointerUp: end,
    onPointerLeave: () => {
      if (cursor.current) cursor.current.visible = false;
    },
    onContextMenu: (e: ThreeEvent<MouseEvent>) => e.nativeEvent.preventDefault(),
  };
  useEffect(() => {
    window.addEventListener('pointerup', end);
    return () => window.removeEventListener('pointerup', end);
  });
  return { cursor, handlers };
}

function paintWeights(mesh: SkinnedMesh, bone: string | null) {
  const g = mesh.geometry;
  const si = g.attributes.skinIndex;
  const sw = g.attributes.skinWeight;
  if (!si || !sw) return;
  const n = si.count;
  const colors = new Float32Array(n * 3);
  const bones = mesh.skeleton.bones;
  const target = bone ? bones.findIndex((b) => b.name === bone) : -1;
  const c = new Color();
  const cold = new Color('#1e3a8a');
  const hot = new Color('#fde047');
  const mid = new Color('#ef4444');
  for (let i = 0; i < n; i++) {
    if (target >= 0) {
      let w = 0;
      for (let k = 0; k < 4; k++) if (si.getComponent(i, k) === target) w += sw.getComponent(i, k);
      if (w < 0.5) c.copy(cold).lerp(mid, w * 2);
      else c.copy(mid).lerp(hot, (w - 0.5) * 2);
    } else {
      // Blend of per-bone colors by weight.
      c.setRGB(0, 0, 0);
      const tmp = new Color();
      for (let k = 0; k < 4; k++) {
        const w = sw.getComponent(i, k);
        if (w <= 0) continue;
        boneColor(si.getComponent(i, k), tmp);
        c.r += tmp.r * w;
        c.g += tmp.g * w;
        c.b += tmp.b * w;
      }
    }
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  if (g.attributes.color && !g.userData.rfPainted) return; // model has its own vertex colors; don't overwrite
  g.setAttribute('color', new Float32BufferAttribute(colors, 3));
  g.userData.rfPainted = true;
}
