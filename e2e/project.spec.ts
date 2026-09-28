import { expect, test } from '@playwright/test';

const store = (page: import('@playwright/test').Page, expr: string) =>
  page.evaluate((e) => new Function('s', `return ${e}`)((window as any).rigforge.getState()), expr);

test('save, reopen and autosave-restore a project', async ({ page }, info) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Try a sample' }).first().click();
  await page.getByRole('button', { name: /Continue to orientation/ }).click();
  await page.getByRole('button', { name: /find the joints/ }).click();
  await expect(page.getByText(/Detected/)).toBeVisible();
  await page.getByRole('button', { name: 'Build rig' }).click();
  await expect(page.getByRole('heading', { name: 'Rig ready' })).toBeVisible();
  await page.getByRole('button', { name: /Add animations/ }).click();
  await page.getByRole('button', { name: /Idle, Walk, Run, Jump/ }).click();
  await page.getByLabel('Trim start').nth(1).fill('0.2');
  await page.getByLabel('Trim start').nth(1).blur();
  const weightSum = await store(page, 'Array.from(s.character.built.mesh.geometry.attributes.skinWeight.array).slice(0, 4000).reduce((a, b) => a + b, 0)');

  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Save' }).click()]);
  expect(download.suggestedFilename()).toMatch(/\.rigforge$/);
  const path = info.outputPath('saved.rigforge');
  await download.saveAs(path);

  // Fresh page: open the file.
  await page.evaluate(() => indexedDB.deleteDatabase('rigforge'));
  await page.reload();
  await page.locator('input[accept*=".rigforge"]').setInputFiles(path);
  await expect(page.locator('.clip')).toHaveCount(4);
  expect(await store(page, 's.step')).toBe('animate');
  expect(await store(page, 's.clips[1].trim[0]')).toBeCloseTo(0.2, 2);
  const restoredSum = await store(page, 'Array.from(s.character.built.mesh.geometry.attributes.skinWeight.array).slice(0, 4000).reduce((a, b) => a + b, 0)');
  expect(restoredSum).toBeCloseTo(weightSum, 3);

  // Autosave kicks in after edits; a reload offers to restore it.
  await page.getByRole('button', { name: 'Remove Jump' }).click();
  await page.waitForTimeout(4000);
  await page.reload();
  await page.getByRole('button', { name: 'Restore' }).click();
  await expect(page.locator('.clip')).toHaveCount(3);
});
