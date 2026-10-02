import { expect, test } from '@playwright/test';

const store = (page: import('@playwright/test').Page, expr: string) =>
  page.evaluate((e) => new Function('s', `return ${e}`)((window as any).rigforge.getState()), expr);

test('body step: the clothes are cut from a clothed character, saved with the project', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Clothed sample' }).first().click();
  await page.getByRole('button', { name: /Continue to orientation/ }).click();
  await page.getByRole('button', { name: /find the joints/ }).click();
  await expect(page.getByText(/Detected/)).toBeVisible();
  await page.getByRole('button', { name: 'Build rig' }).click();
  await expect(page.getByRole('heading', { name: 'Rig ready' })).toBeVisible();

  await page.locator('.steps button', { hasText: 'Body' }).click();
  const list = page.getByRole('list', { name: 'Garments' });
  await expect(list).toBeVisible({ timeout: 30000 });
  // Found automatically: the T-shirt, trousers, trainers and hair, plus the character's own head.
  await expect.poll(() => store(page, 's.garmentInfo.pieces.map((p) => p.name).join()')).toBe('Hair,Top,Bottoms,Shoes,Head');
  expect(await store(page, 's.garmentInfo.auto')).toBe(true);
  await expect(page.getByText(/hidden under the clothes/)).toBeVisible();
  expect(await store(page, 's.garmentInfo.hiddenBody')).toBeGreaterThan(10000);
  // The cut clothes replace the character's mesh.
  expect(await store(page, 's.character.built.mesh.visible')).toBe(false);

  // The body can take the head too.
  await page.getByText("Keep the character's own head").click();
  await expect.poll(() => store(page, 's.garmentInfo.pieces.map((p) => p.name).join()')).toBe('Hair,Top,Bottoms,Shoes');

  // Off: the mesh as imported.
  await page.getByText('Cut the clothes from the body').click();
  await expect(list).toBeHidden();
  await expect.poll(() => store(page, 's.character.built.mesh.visible')).toBe(true);
  await page.getByText('Cut the clothes from the body').click();
  await expect(list).toBeVisible();

  // Fixing them in Parts starts from the same regions.
  await page.getByRole('button', { name: 'Fix them in Parts' }).click();
  await expect(page.getByRole('heading', { name: 'Parts', level: 2 })).toBeVisible();
  expect(await store(page, 's.parts.defs.map((d) => d.name).join()')).toBe('Hair,Skin,Top,Bottoms,Shoes');
  await page.locator('.steps button', { hasText: 'Body' }).click();
  await expect.poll(() => store(page, 's.garmentInfo && s.garmentInfo.auto')).toBe(false);

  // Settings are saved with the project.
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Save' }).click()]);
  const path = info.outputPath('garments.rigforge');
  await download.saveAs(path);
  await page.evaluate(() => indexedDB.deleteDatabase('rigforge'));
  await page.reload();
  await page.locator('input[accept*=".rigforge"]').setInputFiles(path);
  await expect.poll(() => store(page, '!!s.character'), { timeout: 30000 }).toBe(true);
  expect(await store(page, 's.garments.keepHead')).toBe(false);
  expect(errors).toEqual([]);
});
