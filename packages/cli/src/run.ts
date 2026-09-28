import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, extname, join } from 'node:path';
import { Logger, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import {
  EXPORT_PRESETS,
  createWasmKernels,
  optimizeDocument,
  rigDocument,
  tsKernels,
  type Kernels,
  type PresetPack,
  type RigDocumentReport,
} from '@rigforge/core';

export interface RigJob {
  input: string;
  output: string;
  type: 'humanoid' | 'quadruped';
  height?: number;
  fingers: boolean;
  clips: string[] | 'all';
  preset: 'web' | 'mobile' | 'lossless';
  resolution?: number;
}

export interface JobResult extends RigDocumentReport {
  input: string;
  output: string;
  bytesIn: number;
  bytesOut: number;
  seconds: number;
  warnings: string[];
}

let kernelsPromise: Promise<Kernels> | null = null;
export function loadKernels(): Promise<Kernels> {
  kernelsPromise ??= (async () => {
    try {
      const require = createRequire(import.meta.url);
      const path = require.resolve('@rigforge/core/wasm/rigforge_kernels.wasm');
      return await createWasmKernels(await readFile(path));
    } catch {
      return tsKernels;
    }
  })();
  return kernelsPromise;
}

let presetsPromise: Promise<PresetPack> | null = null;
export function loadPresets(): Promise<PresetPack> {
  presetsPromise ??= (async () => {
    const require = createRequire(import.meta.url);
    return JSON.parse(await readFile(require.resolve('@rigforge/presets/clips.json'), 'utf8')) as PresetPack;
  })();
  return presetsPromise;
}

export async function createNodeIO(): Promise<NodeIO> {
  await MeshoptDecoder.ready;
  await MeshoptEncoder.ready;
  return new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });
}

/** Where a job writes: into a directory (keeping the name) or to an explicit .glb path. */
export async function outputPath(input: string, out: string | undefined, many: boolean): Promise<string> {
  const name = `${basename(input, extname(input))}.rigged.glb`;
  if (!out) return join(dirname(input), name);
  const isDir = many || out.endsWith('/') || (await stat(out).then((s) => s.isDirectory()).catch(() => false));
  return isDir ? join(out, name) : out;
}

export async function runJob(job: RigJob, log: (msg: string) => void = () => {}): Promise<JobResult> {
  const t0 = performance.now();
  const io = await createNodeIO();
  const bytesIn = (await stat(job.input)).size;
  const doc = await io.read(job.input);
  doc.setLogger(new Logger(Logger.Verbosity.WARN));
  const report = await rigDocument(doc, {
    type: job.type,
    height: job.height,
    fingers: job.fingers,
    clips: job.clips,
    presets: job.type === 'humanoid' ? await loadPresets() : null,
    resolution: job.resolution,
    kernels: await loadKernels(),
    onProgress: (s) => log(`  ${s}…`),
  });
  const preset = EXPORT_PRESETS[job.preset];
  const warnings = await optimizeDocument(doc, { meshopt: preset.meshopt, resample: preset.resample, webp: false });
  if (preset.webp) warnings.push('WebP/texture resizing runs in the browser editor; the CLI keeps original textures.');
  await mkdir(dirname(job.output), { recursive: true });
  const glb = await io.writeBinary(doc);
  await writeFile(job.output, glb);
  return { ...report, input: job.input, output: job.output, bytesIn, bytesOut: glb.byteLength, seconds: (performance.now() - t0) / 1000, warnings };
}
