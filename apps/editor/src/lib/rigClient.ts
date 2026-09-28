import * as Comlink from 'comlink';
import type { DetectResult, JointMap, MeshArrays, QuadRemeshInput, QuadRemeshOutput, QuadrupedDetectResult, SkinWeights } from '@rigforge/core';
import type { RigWorkerApi, SkeletonKind } from '../workers/rig.worker';
export type { SkeletonKind } from '../workers/rig.worker';

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

export async function detectQuadrupedJoints(positions: Float32Array, index: Uint32Array): Promise<QuadrupedDetectResult> {
  return api().detectQuadruped(positions, index);
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
  skeleton: SkeletonKind,
  settings: WeightSettings,
  onProgress: (stage: string, fraction: number) => void,
): Promise<SkinWeights> {
  // One weights job at a time: jobs share the worker pool's sessions.
  const run = weightsQueue.then(() => api().weights(positions, index, joints, skeleton, settings, Comlink.proxy(onProgress)));
  weightsQueue = run.catch(() => undefined);
  return run;
}

let weightsQueue: Promise<unknown> = Promise.resolve();

/** Seam-preserving triangle simplification (or subdivision) in the rig worker. */
export async function remeshTriangles(mesh: MeshArrays, target: number): Promise<MeshArrays> {
  return api().remeshTriangles(mesh, target);
}

/** Quad remesh + UV atlas + texture bake in the rig worker (inputs are copied). */
export async function remeshQuads(input: QuadRemeshInput): Promise<QuadRemeshOutput> {
  return api().remeshQuads(input);
}
