import { expect, test } from '@playwright/test';

const store = (page: import('@playwright/test').Page, expr: string) =>
  page.evaluate((e) => new Function('s', `return ${e}`)((window as any).rigforge.getState()), expr);

test('weight painting and clip trimming', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.getByRole('button', { name: 'Try a sample' }).first().click();
  await page.getByRole('button', { name: /Continue to orientation/ }).click();
  await page.getByRole('button', { name: /find the joints/ }).click();
  await expect(page.getByText(/Detected/)).toBeVisible();
  await page.getByRole('button', { name: 'Build rig' }).click();
  await expect(page.getByRole('heading', { name: 'Rig ready' })).toBeVisible();

  // Paint the chest onto the spine bone.
  await page.getByRole('button', { name: 'Start painting' }).click();
  await page.locator('select').nth(1).selectOption('leftUpperArm');
  const box = (await page.locator('.stage canvas').boundingBox())!;
  const cx = box.x + box.width / 2, cy = box.y + box.height * 0.42;
  await page.mouse.move(cx - 30, cy);
  await page.mouse.down();
  for (let i = 0; i <= 6; i++) await page.mouse.move(cx - 30 + i * 10, cy, { steps: 2 });
  await page.mouse.up();
  const version = await store(page, 's.weightsVersion');
  expect(version).toBeGreaterThan(0);
  expect(await store(page, 's.paintUndo')).toBe(1);
  if (process.env.SHOTS_DIR) await page.screenshot({ path: `${process.env.SHOTS_DIR}/paint.png` });
  await page.getByRole('button', { name: 'Undo' }).click();
  expect(await store(page, 's.paintUndo')).toBe(0);
  await page.getByRole('button', { name: 'Done' }).click();

  // Trim a clip.
  await page.getByRole('button', { name: /Add animations/ }).click();
  await page.getByRole('button', { name: '+ Add' }).first().click();
  const full = await store(page, 's.clips[0].baked.duration');
  await page.getByLabel('Trim start').fill('0.5');
  await page.getByLabel('Trim start').blur();
  const trimmed = await store(page, 's.clips[0].baked.duration');
  expect(trimmed).toBeLessThan(full - 0.3);
  expect(errors).toEqual([]);
});
