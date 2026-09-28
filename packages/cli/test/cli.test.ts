import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { Document, NodeIO } from '@gltf-transform/core';
import { createMannequin, createQuadrupedMannequin } from '../../core/src/index';
import { main } from '../src/main';

async function writeModel(dir: string, name: string, geometry: import('three').BufferGeometry) {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const prim = doc.createPrimitive()
    .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(new Float32Array(geometry.attributes.position.array)).setBuffer(buffer))
    .setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint32Array(geometry.index!.array)).setBuffer(buffer))
    .setMaterial(doc.createMaterial('m'));
  doc.createScene().addChild(doc.createNode('Model').setMesh(doc.createMesh().addPrimitive(prim)));
  const path = join(dir, name);
  await new NodeIO().write(path, doc);
  return path;
}

describe('rigforge CLI', () => {
  it('batch-rigs models into a directory and writes a report', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rigforge-'));
    const a = await writeModel(dir, 'hero.glb', createMannequin({ pose: 'T', detail: 8 }).geometry);
    const b = await writeModel(dir, 'villain.glb', createMannequin({ pose: 'A', detail: 8 }).geometry);
    const out = join(dir, 'out');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const code = await main(['rig', a, b, '-o', out, '--clips', 'idle,wave', '--resolution', '96', '--report', join(dir, 'report.json')]);
    log.mockRestore();
    expect(code).toBe(0);
    expect(existsSync(join(out, 'hero.rigged.glb'))).toBe(true);
    expect(existsSync(join(out, 'villain.rigged.glb'))).toBe(true);
    const report = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8'));
    expect(report.map((r: any) => r.clips)).toEqual([['Idle', 'Wave'], ['Idle', 'Wave']]);
    const doc = await new NodeIO().read(join(out, 'hero.rigged.glb')).catch(() => null);
    // Output is meshopt-compressed (web preset): a plain NodeIO can't decode it, which is expected.
    expect(doc).toBeNull();
  });

  it('rigs a quadruped and rejects unknown clips', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rigforge-'));
    const dog = await writeModel(dir, 'dog.glb', createQuadrupedMannequin({ detail: 8 }).geometry);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await main(['rig', dog, '-t', 'quadruped', '-p', 'lossless', '--resolution', '96'])).toBe(0);
    const doc = await new NodeIO().read(join(dir, 'dog.rigged.glb'));
    expect(doc.getRoot().listAnimations().map((a) => a.getName())).toEqual(['Idle', 'Walk', 'Trot', 'Gallop']);
    expect(await main(['rig', dog, '--clips', 'moonwalk'])).toBe(2);
    expect(err.mock.calls.flat().join(' ')).toContain('Unknown clip');
    log.mockRestore();
    err.mockRestore();
  });
});
