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

  // No tags on the rig: a colour key in the corner of the view, by side, selects joints.
  await expect(page.locator('.joint-tag')).toHaveCount(0);
  const key = page.locator('.joint-key');
  await expect(key.locator('.col', { hasText: 'Right' }).getByRole('button', { name: 'Elbow' })).toBeVisible();
  await expect(key.locator('.col', { hasText: 'Center' }).getByRole('button', { name: 'Pelvis' })).toBeVisible();
  await key.locator('.col', { hasText: 'Right' }).getByRole('button', { name: 'Wrist' }).click();
  expect(await page.evaluate(() => (window as any).rigforge.getState().selectedBone)).toBe('rightHand');
  // Same joint type, same colour on both sides.
  const colors = await key.locator('button', { hasText: 'Knee' }).evaluateAll((els) => els.map((e) => getComputedStyle(e.querySelector('i')!).backgroundColor));
  expect(colors.length).toBe(2);
  expect(colors[0]).toBe(colors[1]);

  // Hovering a marker on the rig lights up its entry in the key (real pointer: sweep until one is hit).
  const canvas = (await page.locator('.stage canvas').first().boundingBox())!;
  let hovered: string | null = null;
  for (let y = 0.3; y < 0.9 && !hovered; y += 0.01) {
    for (const x of [0.47, 0.5, 0.53]) {
      await page.mouse.move(canvas.x + canvas.width * x, canvas.y + canvas.height * y);
      hovered = await page.evaluate(() => (window as any).rigforge.getState().hoverJoint);
      if (hovered && !hovered.endsWith(':tail')) break;
      hovered = null;
    }
  }
  expect(hovered).toBeTruthy();
  await expect(key.locator('button.hover')).toHaveCount(1);
  if (shots) await page.screenshot({ path: `${shots}/joint-hover.png` });
  await page.mouse.move(canvas.x + 5, canvas.y + canvas.height - 5);
  await expect(key.locator('button.hover')).toHaveCount(0);
  // And the other way round: hovering an entry highlights its marker.
  await key.locator('.col', { hasText: 'Left' }).getByRole('button', { name: 'Knee' }).hover();
  expect(await page.evaluate(() => (window as any).rigforge.getState().hoverJoint)).toBe('leftLowerLeg');

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
