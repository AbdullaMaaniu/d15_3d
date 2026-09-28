import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { unzipSync, strFromU8 } from 'three/examples/jsm/libs/fflate.module.js';

const shots = process.env.SHOTS_DIR;
const state = (page: import('@playwright/test').Page, expr: string) =>
  page.evaluate((e) => new Function('s', `return ${e}`)((window as any).rigforge.getState()), expr);

test('remesh to quads and triangles, download OBJ, then rig the result', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.getByRole('button', { name: 'Try a sample' }).first().click();
  await expect(page.getByText('Triangles').first()).toBeVisible();
  const before = (await state(page, 's.report.triangles')) as number;

  // Quads: new topology, UV atlas and a baked texture.
  await page.getByRole('button', { name: '3k', exact: true }).click();
  await page.getByRole('button', { name: '1K', exact: true }).click();
  await page.getByRole('button', { name: 'Remesh to 3k quads' }).click();
  const result = page.getByTestId('remesh-result');
  await expect(result).toContainText('faces', { timeout: 60_000 });
  const q = (await state(page, 's.remeshInfo')) as { faces: number; quads: number; charts: number; textureSize: number };
  expect(Math.abs(q.faces / 3000 - 1)).toBeLessThan(0.15);
  expect(q.quads / q.faces).toBeGreaterThan(0.8);
  expect(q.charts).toBeGreaterThan(5);
  expect(await state(page, 's.prepared.geometry.userData.faceSizes.length')).toBe(q.faces);
  // One untextured material: nothing to bake, the material carries over as is.
  expect(q.textureSize).toBeNull();
  await expect(page.getByLabel('Wireframe')).toBeChecked();
  if (shots) await page.screenshot({ path: `${shots}/remesh-quads.png` });

  // The OBJ keeps quads as quads.
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download OBJ' }).click()]);
  const zipPath = info.outputPath('remesh.zip');
  await dl.saveAs(zipPath);
  const files = unzipSync(new Uint8Array(readFileSync(zipPath)));
  const objName = Object.keys(files).find((n) => n.endsWith('.obj'))!;
  expect(Object.keys(files).some((n) => n.endsWith('.mtl'))).toBe(true);
  const faces = strFromU8(files[objName]).split('\n').filter((l) => l.startsWith('f '));
  expect(faces.length).toBe(q.faces);
  expect(faces.filter((l) => l.split(' ').length === 5).length).toBe(q.quads);

  // Triangles: from the original, keeping its UVs.
  await page.getByRole('button', { name: 'Triangles', exact: true }).click();
  await page.getByRole('button', { name: '3k', exact: true }).click();
  await page.getByRole('button', { name: 'Remesh to 3k triangles' }).click();
  await expect(result).toContainText('triangles', { timeout: 60_000 });
  const tris = (await state(page, 's.report.triangles')) as number;
  expect(Math.abs(tris - Math.min(3000, before))).toBeLessThan(200);

  await page.getByRole('button', { name: 'Revert to original' }).click();
  expect(await state(page, 's.report.triangles')).toBe(before);

  // A quad remesh rigs and exports like any other mesh.
  await page.getByRole('button', { name: 'Quads', exact: true }).click();
  await page.getByRole('button', { name: '10k', exact: true }).click();
  await page.getByRole('button', { name: 'Remesh to 10k quads' }).click();
  await expect(result).toContainText('faces', { timeout: 60_000 });
  await page.getByRole('button', { name: /Continue to orientation/ }).click();
  await page.getByRole('button', { name: /find the joints/ }).click();
  await expect(page.getByText(/Detected/)).toBeVisible();
  await page.getByRole('button', { name: 'Build rig' }).click();
  await expect(page.getByRole('heading', { name: 'Rig ready' })).toBeVisible();
  await page.getByRole('button', { name: /Add animations/ }).click();
  await page.getByRole('button', { name: /Idle, Walk, Run, Jump/ }).click();
  await page.getByRole('button', { name: /^Export →/ }).click();
  await page.getByRole('button', { name: 'Build GLB' }).click();
  await expect(page.getByRole('button', { name: /Download .*\.glb/ })).toBeVisible();
  if (shots) await page.screenshot({ path: `${shots}/remesh-rigged.png` });
  expect(errors).toEqual([]);
});

test('quad remesh bakes two materials into one textured material', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.getByRole('button', { name: 'Sample prop' }).first().click();
  await expect(page.getByText('Triangles').first()).toBeVisible();
  await page.getByRole('button', { name: '3k', exact: true }).click();
  await page.getByRole('button', { name: '1K', exact: true }).click();
  await page.getByRole('button', { name: 'Remesh to 3k quads' }).click();
  await expect(page.getByTestId('remesh-result')).toContainText('1K texture', { timeout: 60_000 });
  const baked = await page.evaluate(() => {
    const m = (window as any).rigforge.getState().prepared.materials;
    const img = m[0].map.image as HTMLCanvasElement;
    const px = img.getContext('2d')!.getImageData(0, 0, img.width, img.height).data;
    // Count wood-brown and gold texels.
    let wood = 0, gold = 0;
    for (let i = 0; i < px.length; i += 4) {
      const [r, g, b] = [px[i], px[i + 1], px[i + 2]];
      if (r > 120 && g > 100 && b < 60 && r - g < 60) gold++;
      else if (r > 90 && r > g + 20 && g > b) wood++;
    }
    return { materials: m.length, wood, gold, mr: !!m[0].roughnessMap && m[0].roughnessMap === m[0].metalnessMap, size: img.width };
  });
  expect(baked.materials).toBe(1);
  expect(baked.size).toBe(1024);
  expect(baked.mr).toBe(true);
  expect(baked.wood).toBeGreaterThan(20_000);
  expect(baked.gold).toBeGreaterThan(2_000);
  expect(errors).toEqual([]);
});
