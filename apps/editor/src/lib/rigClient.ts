import * as Comlink from 'comlink';
import type { DetectResult, JointMap, SkinWeights } from '@rigforge/core';
import type { RigWorkerApi } from '../workers/rig.worker';

let worker: Comlink.Remote<RigWorkerApi> | null = null;

function api(): Comlink.Remote<RigWorkerApi> {
  if (!worker) {
    const w = new Worker(new URL('../workers/rig.worker.ts', import.meta.url), { type: 'module' });
    worker = Comlink.wrap<RigWorkerApi>(w);
  }
  return worker;
}

export async function kernelName(): Promise<string> {
  return api().kernelName();
}

export async function detectJoints(positions: Float32Array, index: Uint32Array, fingers: boolean): Promise<DetectResult> {
  return api().detect(positions, index, fingers);
}

export interface WeightSettings {
  resolution: number;
  falloff: number;
  smoothIterations: number;
}

export async function computeWeights(
  positions: Float32Array,
  index: Uint32Array,
  joints: JointMap,
  fingers: boolean,
  settings: WeightSettings,
  onProgress: (stage: string, fraction: number) => void,
): Promise<SkinWeights> {
  return api().weights(positions, index, joints, fingers, settings, Comlink.proxy(onProgress));
}
