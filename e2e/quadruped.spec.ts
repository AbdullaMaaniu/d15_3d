import { expect, test } from '@playwright/test';

test('rig and animate an animal (sample dog)', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const shots = process.env.SHOTS_DIR;
  await page.goto('/');
  await page.getByRole('button', { name: 'Sample animal' }).first().click();
  await page.getByRole('button', { name: /Continue to orientation/ }).click();
  if (shots) await page.screenshot({ path: `${shots}/dog-orient.png` });
  await page.getByRole('button', { name: /find the joints/ }).click();
  await expect(page.getByText('Detected (quadruped)')).toBeVisible();
  await expect(page.getByText('All joints found')).toBeVisible();
  if (shots) await page.screenshot({ path: `${shots}/dog-joints.png` });
  await page.getByRole('button', { name: 'Build rig' }).click();
  await expect(page.getByRole('heading', { name: 'Rig ready' })).toBeVisible();
  await page.waitForTimeout(800);
  if (shots) await page.screenshot({ path: `${shots}/dog-walk.png` });

  await page.getByRole('button', { name: /Add animations/ }).click();
  await page.getByRole('button', { name: /Idle, Walk, Trot, Gallop/ }).click();
  await expect(page.locator('.clip')).toHaveCount(4);
  await page.getByRole('button', { name: 'Play Gallop' }).click();
  await page.evaluate(async () => {
    (window as any).rigforge.setState({ playing: false, seek: 0.2, time: 0.2 });
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  });
  if (shots) await page.screenshot({ path: `${shots}/dog-gallop.png` });

  await page.getByRole('button', { name: /^Export →/ }).click();
  await page.getByRole('button', { name: 'Build GLB' }).click();
  await expect(page.getByRole('button', { name: /Download .*\.glb/ })).toBeVisible();
  expect(errors).toEqual([]);
});
