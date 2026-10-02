import { expect, test } from '@playwright/test';

const store = (page: import('@playwright/test').Page, expr: string) =>
  page.evaluate((e) => new Function('s', `return ${e}`)((window as any).rigforge.getState()), expr);

test('body step: generated body inside the clothes, shape sliders, saved with the project', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Try a sample' }).first().click();
  await page.getByRole('button', { name: /Continue to orientation/ }).click();
  await page.getByRole('button', { name: /find the joints/ }).click();
  await expect(page.getByText(/Detected/)).toBeVisible();
  await page.getByRole('button', { name: 'Build rig' }).click();
  await expect(page.getByRole('heading', { name: 'Rig ready' })).toBeVisible();

  await page.locator('.steps button', { hasText: 'Body' }).click();
  await expect(page.getByRole('heading', { name: 'Body', level: 2 })).toBeVisible();
  const status = page.getByText(/generated in \d+ ms/);
  await expect(status).toBeVisible({ timeout: 30000 });
  // Clothes are see-through so the body shows.
  expect(await store(page, 's.shading')).toBe('xray');
  const tris = await store(page, 's.bodyInfo.triangles');
  expect(tris).toBeGreaterThan(5000);

  // Sliders reshape it.
  const before = await store(page, 's.bodyInfo.ms');
  await page.getByRole('slider', { name: 'Biceps' }).fill('1.4');
  await expect.poll(() => store(page, 's.bodyShape.biceps')).toBe(1.4);
  await expect(page.getByText('+40%')).toBeVisible();
  await expect.poll(() => store(page, 's.bodyInfo.ms !== ' + before)).toBe(true);
  await page.getByRole('button', { name: 'Reset Biceps' }).click();
  await expect.poll(() => store(page, 's.bodyShape.biceps === undefined')).toBe(true);
  await page.getByRole('slider', { name: 'Calves' }).fill('1.2');

  // Clothes toggle, walk preview.
  await page.getByRole('button', { name: 'Clothes: see-through' }).click();
  expect(await store(page, 's.shading')).toBe('textured');
  await page.getByRole('button', { name: '▶ Walk' }).click();
  expect(await store(page, 's.playing')).toBe(true);

  // Leaving the step puts the clothes back to normal.
  await page.getByRole('button', { name: 'Clothes: solid' }).click();
  await page.getByRole('button', { name: 'Add animations →' }).click();
  expect(await store(page, 's.shading')).toBe('textured');

  // The shape is saved with the project.
  await page.getByRole('button', { name: /Idle, Walk, Run, Jump/ }).click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Save' }).click()]);
  const path = info.outputPath('body.rigforge');
  await download.saveAs(path);
  await page.evaluate(() => indexedDB.deleteDatabase('rigforge'));
  await page.reload();
  await page.locator('input[accept*=".rigforge"]').setInputFiles(path);
  await expect.poll(() => store(page, 's.clips.length'), { timeout: 30000 }).toBe(4);
  expect(await store(page, 's.bodyShape.calves')).toBe(1.2);
  expect(errors).toEqual([]);
});
