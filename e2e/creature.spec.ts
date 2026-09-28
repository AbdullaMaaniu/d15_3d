import { expect, test } from '@playwright/test';

const store = (page: import('@playwright/test').Page, expr: string) =>
  page.evaluate((e) => new Function('s', `return ${e}`)((window as any).rigforge.getState()), expr);

test('build a custom skeleton for a snake and make it slither', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const shots = process.env.SHOTS_DIR;
  await page.goto('/');
  await page.getByRole('button', { name: 'Sample creature' }).first().click();
  await page.getByRole('button', { name: /Continue to orientation/ }).click();
  await page.getByRole('button', { name: /build the skeleton/ }).click();
  await expect(page.getByText('Joints (1)')).toBeVisible();

  // Click along the snake's body from tail to head to lay down a chain.
  const box = (await page.locator('.stage canvas').boundingBox())!;
  const clickAt = async (fx: number) => {
    await page.mouse.click(box.x + box.width * fx, box.y + box.height * 0.5);
  };
  const before = await store(page, 's.creatureBones.length');
  // Lay the spine chain down deterministically, then add one joint with a real click.
  await page.evaluate(() => {
    const s = (window as any).rigforge.getState();
    const g = s.normalized.geometry;
    g.computeBoundingBox();
    const { min, max } = g.boundingBox;
    const y = (min.y + max.y) / 2;
    for (let i = 0; i < 5; i++) (window as any).rigforge.getState().addCreatureJoint([0, y, min.z + ((i + 0.5) / 5) * (max.z - min.z)]);
  });
  await clickAt(0.5); // a real click also adds a joint inside the body
  const after = await store(page, 's.creatureBones.length');
  expect(after).toBe(before + 6);
  const last = await store(page, 's.joints.joints[s.selectedBone]');
  expect(Math.abs(last[0])).toBeLessThan(0.05); // placed inside the body, not on its surface
  if (shots) await page.screenshot({ path: `${shots}/snake-joints.png` });

  await page.getByRole('button', { name: 'Build rig' }).click();
  await expect(page.getByRole('heading', { name: 'Rig ready' })).toBeVisible();
  await page.getByRole('button', { name: /Add animations/ }).click();
  await page.getByLabel('Motion bone').selectOption('bone1');
  await page.getByRole('button', { name: 'Wave', exact: true }).click();
  await page.getByRole('button', { name: '+ Add motion' }).click();
  await expect(page.locator('.clip')).toHaveCount(1);
  await page.waitForTimeout(600);
  if (shots) await page.screenshot({ path: `${shots}/snake-wave.png` });
  expect(errors).toEqual([]);
});
