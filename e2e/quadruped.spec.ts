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

  // Test drive: gaits blend by speed; no foot IK toggle for four legs.
  await page.getByRole('button', { name: '▶ Test drive' }).click();
  await expect(page.getByTestId('drive-state')).toContainText('move', { timeout: 30_000 });
  await expect(page.getByText('Foot IK')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).rigforgeDrive.character.controllerSetup.locomotion.map((l: [number, string]) => l[1]))).toEqual(['Idle', 'Walk', 'Trot', 'Gallop']);
  await page.keyboard.down('KeyW');
  await page.keyboard.down('Shift');
  await expect.poll(() => page.evaluate(() => (window as any).rigforgeDrive.position[2]), { timeout: 15_000 }).toBeGreaterThan(0.5);
  if (shots) await page.screenshot({ path: `${shots}/dog-drive.png` });
  await page.keyboard.up('Shift');
  await page.keyboard.up('KeyW');
  expect(errors).toEqual([]);
});
