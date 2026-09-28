import * as Comlink from 'comlink';
import { createWasmKernels, tsKernels, type GeodesicInput, type GeodesicSession, type Kernels } from '@rigforge/core';
import wasmUrl from '@rigforge/core/wasm/rigforge_kernels.wasm?url';

// One of a pool: holds a geodesic session for the current model and computes bones on request.
let kernels: Promise<Kernels> | null = null;
let session: GeodesicSession | null = null;

function load(): Promise<Kernels> {
  kernels ??= fetch(wasmUrl)
    .then((r) => r.arrayBuffer())
    .then((b) => createWasmKernels(b))
    .catch(() => tsKernels);
  return kernels;
}

const api = {
  /** Loads the kernels ahead of time so the first rig doesn't wait for them. */
  async warm(): Promise<void> {
    await load();
  },
  async start(input: GeodesicInput): Promise<void> {
    await load();
    session?.free();
    session = (await load()).geodesicSession(input);
  },
  bone(b: number): Float32Array {
    if (!session) throw new Error('No geodesic session');
    const col = session.bone(b);
    return Comlink.transfer(col, [col.buffer]);
  },
  end(): void {
    session?.free();
    session = null;
  },
};

export type GeodesicWorkerApi = typeof api;
Comlink.expose(api);
