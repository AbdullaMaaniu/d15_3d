import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { createNodeIO, loadPresets, outputPath, runJob, type JobResult, type RigJob } from './run';

const HELP = `rigforge: auto-rig and animate GLB models (e.g. Meshy.ai exports) for three.js

Usage
  rigforge rig <input.glb...> [options]     Rig one or more models
  rigforge clips [--type humanoid|quadruped] List available animation clips
  rigforge info <input.glb>                  Show what's in a file

Options (rig)
  -o, --out <path>         Output file, or directory for several inputs
                           (default: <input>.rigged.glb next to the input)
  -t, --type <type>        humanoid (default) or quadruped
      --height <m>         Height to scale to (default 1.8 humanoid / 0.8 quadruped)
      --clips <ids>        Comma-separated clip ids, or "all" (see: rigforge clips)
      --no-fingers         Skip finger bones
  -p, --preset <name>      web (default), mobile or lossless
      --resolution <n>     Skinning voxel resolution (default 192)
      --report <file.json> Write a JSON report of every job
  -h, --help               Show this help
`;

const GAITS = [
  ['idle', 'Standing, looking around'],
  ['walk', 'Four-beat walk'],
  ['trot', 'Diagonal-pair trot'],
  ['gallop', 'Rotary gallop'],
  ['sit', 'Sit down and stay'],
  ['tailWag', 'Happy tail'],
];

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === '-h' || command === '--help' || command === 'help') {
    process.stdout.write(HELP);
    return 0;
  }
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      out: { type: 'string', short: 'o' },
      type: { type: 'string', short: 't', default: 'humanoid' },
      height: { type: 'string' },
      clips: { type: 'string' },
      'no-fingers': { type: 'boolean', default: false },
      preset: { type: 'string', short: 'p', default: 'web' },
      resolution: { type: 'string' },
      report: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  const type = values.type === 'quadruped' ? 'quadruped' : values.type === 'humanoid' ? 'humanoid' : null;
  if (!type) return fail(`Unknown --type "${values.type}" (use humanoid or quadruped).`);

  if (command === 'clips') {
    if (type === 'quadruped') for (const [id, d] of GAITS) console.log(`${id.padEnd(14)} ${d}`);
    else for (const c of (await loadPresets()).clips) console.log(`${c.id.padEnd(14)} ${c.description ?? ''}${c.loop ? ' (loop)' : ''}`);
    return 0;
  }

  if (command === 'info') {
    if (!positionals.length) return fail('info needs a file.');
    const io = await createNodeIO();
    for (const file of positionals) {
      const doc = await io.read(file);
      const root = doc.getRoot();
      let tris = 0, verts = 0;
      for (const m of root.listMeshes()) for (const p of m.listPrimitives()) {
        verts += p.getAttribute('POSITION')?.getCount() ?? 0;
        tris += (p.getIndices()?.getCount() ?? p.getAttribute('POSITION')?.getCount() ?? 0) / 3;
      }
      console.log(`${file}
  meshes ${root.listMeshes().length}, vertices ${verts.toLocaleString()}, triangles ${Math.round(tris).toLocaleString()}
  materials ${root.listMaterials().length}, textures ${root.listTextures().length}
  skins ${root.listSkins().length}, animations ${root.listAnimations().map((a) => a.getName()).join(', ') || 'none'}`);
    }
    return 0;
  }

  if (command !== 'rig') return fail(`Unknown command "${command}". Try: rigforge --help`);
  if (!positionals.length) return fail('rig needs at least one input .glb/.gltf file.');
  const preset = values.preset as RigJob['preset'];
  if (!['web', 'mobile', 'lossless'].includes(preset)) return fail(`Unknown --preset "${preset}".`);
  const clips = !values.clips ? undefined : values.clips === 'all' ? 'all' : values.clips.split(',').map((s) => s.trim()).filter(Boolean);
  if (clips && clips !== 'all') {
    const known = type === 'quadruped' ? GAITS.map((g) => g[0]) : (await loadPresets()).clips.map((c) => c.id);
    const unknown = clips.filter((c) => !known.includes(c));
    if (unknown.length) return fail(`Unknown clip(s): ${unknown.join(', ')}. See: rigforge clips${type === 'quadruped' ? ' --type quadruped' : ''}`);
  }

  const results: JobResult[] = [];
  let failed = 0;
  for (const input of positionals) {
    const output = await outputPath(input, values.out, positionals.length > 1);
    console.log(`▸ ${input}`);
    try {
      const r = await runJob(
        {
          input,
          output,
          type,
          height: values.height ? parseFloat(values.height) : undefined,
          fingers: !values['no-fingers'],
          clips: clips ?? (type === 'quadruped' ? ['idle', 'walk', 'trot', 'gallop'] : ['idle', 'walk', 'run', 'jump']),
          preset,
          resolution: values.resolution ? parseInt(values.resolution, 10) : undefined,
        },
        (m) => process.stderr.isTTY && process.stderr.write(`${m}\r`),
      );
      results.push(r);
      console.log(`  ✓ ${r.output}  ${kb(r.bytesIn)} → ${kb(r.bytesOut)}, ${r.bones} bones, clips: ${r.clips.join(', ') || 'none'} (${r.seconds.toFixed(1)} s)`);
      for (const n of r.notes) console.log(`    ! ${n}`);
      for (const w of r.warnings) console.log(`    · ${w}`);
    } catch (e) {
      failed++;
      console.error(`  ✗ ${(e as Error).message}`);
    }
  }
  if (values.report) await writeFile(values.report, JSON.stringify(results, null, 2));
  if (positionals.length > 1) console.log(`\n${results.length} rigged, ${failed} failed.`);
  return failed ? 1 : 0;
}

function kb(n: number) {
  return n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(2)} MB` : `${Math.round(n / 1024)} KB`;
}

function fail(msg: string): number {
  console.error(`rigforge: ${msg}`);
  return 2;
}
