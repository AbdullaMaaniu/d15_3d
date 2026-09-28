import { expect, test } from '@playwright/test';

const shots = process.env.SHOTS_DIR;

test('live rig preview follows the joints and can be closed', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.getByRole('button', { name: 'Try a sample' }).first().click();
  await page.getByRole('button', { name: /Continue to orientation/ }).click();
  await page.getByRole('button', { name: /find the joints/ }).click();
  await expect(page.getByText(/Detected/)).toBeVisible();

  const status = page.getByTestId('rig-preview-status');
  await expect(status).toContainText('Rigged in', { timeout: 30_000 });
  await expect(page.locator('.rig-preview canvas')).toBeVisible();
  if (shots) {
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${shots}/rig-preview.png` });
  }

  // Moving a joint re-rigs the preview.
  const first = await status.textContent();
  await page.evaluate(() => {
    const s = (window as any).rigforge.getState();
    const [x, y, z] = s.joints.joints.leftUpperArm;
    s.moveJoint('leftUpperArm', [x - 0.03, y - 0.03, z]);
  });
  await expect(status).toContainText('Updating');
  await expect(status).toContainText('Rigged in', { timeout: 30_000 });

  // Another clip.
  await page.getByLabel('Preview clip').selectOption('wave');
  await expect(status).toContainText('Rigged in', { timeout: 30_000 });
  expect(first).toBeTruthy();

  await page.getByRole('button', { name: 'Close preview' }).click();
  await expect(page.locator('.rig-preview')).toHaveCount(0);
  await page.getByRole('button', { name: '▶ Live preview' }).click();
  await expect(status).toContainText('Rigged in', { timeout: 30_000 });

  // The panel is only for placing joints: gone once the rig is built.
  await page.getByRole('button', { name: 'Build rig' }).click();
  await expect(page.getByRole('heading', { name: 'Rig ready' })).toBeVisible();
  await expect(page.locator('.rig-preview')).toHaveCount(0);
  expect(errors).toEqual([]);
});
