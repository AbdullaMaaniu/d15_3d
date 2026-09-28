import * as Comlink from 'comlink';
import {
  computeSkinWeights,
  computeSkinWeightsAsync,
  distancesFromSessions,
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
import type { GeodesicWorkerApi } from './geodesic.worker';

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

// Geodesic distances are independent per bone, so a pool of workers shares them.
// Nested workers aren't available everywhere; without them the rig worker does it alone.
let pool: Array<Comlink.Remote<GeodesicWorkerApi>> | null = null;
function geodesicPool(): Array<Comlink.Remote<GeodesicWorkerApi>> {
  if (pool) return pool;
  pool = [];
  const cores = (self.navigator as Navigator | undefined)?.hardwareConcurrency ?? 1;
  const size = Math.min(8, Math.max(0, cores - 1));
  if (size < 2 || typeof Worker === 'undefined') return pool;
  try {
    for (let i = 0; i < size; i++) {
      pool.push(Comlink.wrap<GeodesicWorkerApi>(new Worker(new URL('./geodesic.worker.ts', import.meta.url), { type: 'module' })));
    }
  } catch (e) {
    console.warn('[rigforge] geodesic worker pool unavailable', e);
    pool = [];
  }
  return pool;
}

/** Starts the pool and loads its kernels in the background (called while the user reviews joints). */
function warmPool(): void {
  for (const w of geodesicPool()) void w.warm();
}

const api = {
  async kernelName(): Promise<string> {
    warmPool();
    return (await kernels()).name;
  },

  async detect(positions: Float32Array, index: Uint32Array, fingers: boolean): Promise<DetectResult> {
    warmPool();
    return detectHumanoid(positions, index, { fingers, kernels: await kernels() });
  },

  async detectQuadruped(positions: Float32Array, index: Uint32Array): Promise<QuadrupedDetectResult> {
    warmPool();
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
    const k = await kernels();
    const workers = geodesicPool();
    let result;
    if (workers.length > 1) {
      try {
        result = await computeSkinWeightsAsync(positions, index, defsFor(skeleton), joints, async (input, onBone) => {
          await Promise.all(workers.map((w) => w.start(input)));
          try {
            return await distancesFromSessions(input, workers.map((w) => (b: number) => w.bone(b)), onBone);
          } finally {
            for (const w of workers) void w.end();
          }
        }, { ...options, kernels: k, onProgress });
        result.timings.threads = workers.length;
      } catch (e) {
        console.warn('[rigforge] parallel geodesics failed, running single-threaded', e);
        pool = [];
      }
    }
    result ??= computeSkinWeights(positions, index, defsFor(skeleton), joints, { ...options, kernels: k, onProgress });
    return Comlink.transfer(result, [result.skinIndex.buffer, result.skinWeight.buffer]);
  },
};

export type RigWorkerApi = typeof api;
Comlink.expose(api);
