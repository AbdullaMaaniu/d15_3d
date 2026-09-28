import { expect, test } from '@playwright/test';
import { Document, NodeIO } from '@gltf-transform/core';
import { createMannequin } from '../packages/core/src/mesh/mannequin';

async function mannequinGlb(): Promise<Buffer> {
  const { geometry } = createMannequin({ pose: 'A', detail: 8 });
  const doc = new Document();
  const buffer = doc.createBuffer();
  const prim = doc.createPrimitive()
    .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(new Float32Array(geometry.attributes.position.array)).setBuffer(buffer))
    .setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint32Array(geometry.index!.array)).setBuffer(buffer))
    .setMaterial(doc.createMaterial('m').setBaseColorFactor([0.8, 0.6, 0.5, 1]));
  doc.createScene().addChild(doc.createNode('Knight').setMesh(doc.createMesh().addPrimitive(prim)));
  return Buffer.from(await new NodeIO().writeBinary(doc));
}

test('import a model from Meshy.ai (mocked API)', async ({ page }) => {
  const glb = await mannequinGlb();
  const task = { id: 'tsk_1', status: 'SUCCEEDED', prompt: 'a brave knight', created_at: 1_790_000_000_000, thumbnail_url: 'https://assets.meshy.ai/tsk_1.png', model_urls: { glb: 'https://assets.meshy.ai/tsk_1.glb' } };
  let auth = '';
  await page.route('https://api.meshy.ai/**', (route) => {
    auth = route.request().headers()['authorization'] ?? '';
    const url = route.request().url();
    const body = url.includes('/v2/text-to-3d') ? [task] : [];
    return route.fulfill({ json: body, headers: { 'access-control-allow-origin': '*' } });
  });
  await page.route('https://assets.meshy.ai/tsk_1.glb', (route) => route.fulfill({ body: glb, contentType: 'model/gltf-binary', headers: { 'access-control-allow-origin': '*' } }));
  await page.route('https://assets.meshy.ai/tsk_1.png', (route) => route.fulfill({ status: 404 }));

  await page.goto('/');
  await page.getByRole('button', { name: 'Import from Meshy.ai…' }).first().click();
  await page.getByLabel('Meshy API key').first().fill('msy_test');
  await page.getByRole('button', { name: 'Show my models' }).first().click();
  await page.getByTitle('a brave knight').first().click();
  await expect(page.locator('.stats').getByText('Triangles')).toBeVisible();
  await expect(page.getByText('a-brave-knight.glb')).toBeVisible();
  expect(auth).toBe('Bearer msy_test');
});
