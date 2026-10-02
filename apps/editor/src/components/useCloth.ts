import { useEffect, useRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import { useStore } from '../store';
import { ClothController } from '../lib/cloth';
import type { BodyRig } from '../lib/body';
import { buildBodyMesh, loadReferenceBody } from '../lib/body';

/**
 * The cloth simulation for the current character, rebuilt when its parts,
 * fabrics, body shape or rig change. Runs in the Body and Animate steps, on
 * humanoids with parts, and stops (restoring the mesh) while weights or keys
 * are being edited.
 */
export function useCloth() {
  const character = useStore((s) => s.character);
  const joints = useStore((s) => s.joints);
  const parts = useStore((s) => s.parts);
  const partsVersion = useStore((s) => s.partsVersion);
  const fabrics = useStore((s) => s.cloth.fabrics);
  const enabled = useStore((s) => s.cloth.enabled);
  const shape = useStore((s) => s.bodyShape);
  const step = useStore((s) => s.step);
  const rigType = useStore((s) => s.rigType);
  const editing = useStore((s) => s.paint.active || s.keyEdit.clipId !== null);
  const built = character?.built ?? null;
  const active = enabled && !!parts && !!built && !!joints && rigType === 'humanoid' && (step === 'body' || step === 'animate') && !editing;
  const ref = useRef<ClothController | null>(null);
  // The body to collide with (never shown, so never uploaded), kept across rebuilds that don't change it.
  const bodyRig = useRef<{ key: unknown[]; rig: BodyRig } | null>(null);
  // The body view rebinds the mesh to the body's skeleton while it's shown (and back after): set up again for it.
  const [skeleton, setSkeleton] = useState(built?.mesh.skeleton);
  useFrame(() => {
    if (built && built.mesh.skeleton !== skeleton) setSkeleton(built.mesh.skeleton);
  });

  useEffect(() => {
    if (!active || !built || !joints || !parts) {
      useStore.setState({ clothInfo: null });
      return;
    }
    let cancelled = false;
    let controller: ClothController | null = null;
    const t = setTimeout(async () => {
      const reference = await loadReferenceBody();
      if (cancelled) return;
      try {
        const key = [built, joints, shape, reference];
        if (!bodyRig.current || bodyRig.current.key.some((k, i) => k !== key[i])) bodyRig.current = { key, rig: buildBodyMesh(built, joints, shape, '#000', reference) };
        const rig = bodyRig.current.rig;
        const next = await ClothController.create(built, parts, fabrics, rig, joints);
        if (cancelled) return;
        controller = next;
        ref.current = controller;
        useStore.setState({ clothInfo: { particles: controller.sim.cageCount, ms: 0 } });
      } catch (e) {
        console.warn('[rigforge] cloth setup failed', e);
      }
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(t);
      controller?.dispose();
      if (ref.current === controller) ref.current = null;
    };
  }, [active, built, joints, parts, partsVersion, fabrics, shape, skeleton]);

  return ref;
}
