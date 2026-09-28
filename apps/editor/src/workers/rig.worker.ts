import * as Comlink from 'comlink';
import {
  computeSkinWeights,
  createWasmKernels,
  detectHumanoid,
  humanoidDefs,
  tsKernels,
  detectQuadruped,
  QUADRUPED_DEFS,
  type BoneDef,
  type QuadrupedDetectResult,
  type DetectResult,
  type JointMap,
  type Kernels,
} from '@rigforge/core';
import wasmUrl from '@rigforge/core/wasm/rigforge_kernels.wasm?url';

export type SkeletonKind = 'humanoid' | 'humanoid-nofingers' | 'quadruped' | BoneDef[];

function defsFor(kind: SkeletonKind): readonly BoneDef[] {
  if (Array.isArray(kind)) return kind;
  return kind === 'quadruped' ? QUADRUPED_DEFS : humanoidDefs(kind === 'humanoid');
}

let kernelsPromise: Promise<Kernels> | null = null;

function kernels(): Promise<Kernels> {
  kernelsPromise ??= fetch(wasmUrl)
    .then((r) => r.arrayBuffer())
    .then((bytes) => createWasmKernels(bytes))
    .catch((e) => {
      console.warn('[rigforge] WASM kernels unavailable, using TypeScript fallback', e);
      return tsKernels;
    });
  return kernelsPromise;
}

const api = {
  async kernelName(): Promise<string> {
    return (await kernels()).name;
  },

  async detect(positions: Float32Array, index: Uint32Array, fingers: boolean): Promise<DetectResult> {
    return detectHumanoid(positions, index, { fingers, kernels: await kernels() });
  },

  async detectQuadruped(positions: Float32Array, index: Uint32Array): Promise<QuadrupedDetectResult> {
    return detectQuadruped(positions, index, { kernels: await kernels() });
  },

  async weights(
    positions: Float32Array,
    index: Uint32Array,
    joints: JointMap,
    skeleton: SkeletonKind,
    options: { resolution: number; falloff: number; smoothIterations: number },
    onProgress: (stage: string, fraction: number) => void,
  ) {
    const result = computeSkinWeights(positions, index, defsFor(skeleton), joints, {
      ...options,
      kernels: await kernels(),
      onProgress,
    });
    return Comlink.transfer(result, [result.skinIndex.buffer, result.skinWeight.buffer]);
  },
};

export type RigWorkerApi = typeof api;
Comlink.expose(api);
