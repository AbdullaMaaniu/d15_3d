import { expect, test } from '@playwright/test';

const store = (page: import('@playwright/test').Page, expr: string) =>
  page.evaluate((e) => new Function('s', `return ${e}`)((window as any).rigforge.getState()), expr);

test('rig and animate a prop (treasure chest)', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const shots = process.env.SHOTS_DIR;
  await page.goto('/');
  await page.getByRole('button', { name: 'Sample prop' }).first().click();
  await expect(page.getByText('Prop / object')).toBeVisible();
  await page.getByRole('button', { name: /Continue to orientation/ }).click();
  await page.getByRole('button', { name: /set up parts/ }).click();
  await expect(page.getByText(/Found 4 separate parts/)).toBeVisible();

  await page.getByRole('button', { name: '+ Bone' }).click();
  await page.getByLabel('Name').fill('lid');
  await page.getByLabel('Name').blur();
  // Click the lid in the viewport (upper middle of the chest).
  const box = (await page.locator('.stage canvas').boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height * 0.33);
  if (shots) await page.screenshot({ path: `${shots}/prop-click.png` });
  expect(Object.values(await store(page, 's.propRig.partBone'))).toContain('lid');
  // Hinge along the back top edge.
  await page.getByLabel('Pivot y').fill('0.62');
  await page.getByLabel('Pivot z').fill('-0.36');
  if (shots) await page.screenshot({ path: `${shots}/prop-parts.png` });

  await page.getByRole('button', { name: 'Build rig →' }).click();
  await page.waitForTimeout(500);
  if (shots) await page.screenshot({ path: `${shots}/prop-built.png` });
  await page.getByLabel('Amount').fill('-100');
  await page.getByRole('button', { name: '+ Add motion' }).click();
  await expect(page.locator('.clip')).toHaveCount(1);
  // Jump to the end of the opening instead of waiting (frame rate varies under load).
  await page.evaluate(async () => {
    (window as any).rigforge.setState({ playing: false, seek: 1.49, time: 1.49 });
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  });
  if (shots) await page.screenshot({ path: `${shots}/prop-open.png` });
  const angle = await store(page, '2 * Math.acos(Math.min(1, Math.abs(s.character.built.bones.lid.quaternion.w)))');
  expect(angle).toBeGreaterThan(1.5); // ~100°

  await page.getByRole('button', { name: /^Export →/ }).click();
  await page.getByRole('button', { name: 'Build GLB' }).click();
  await expect(page.getByRole('button', { name: /Download .*\.glb/ })).toBeVisible();
  expect(errors).toEqual([]);
});
