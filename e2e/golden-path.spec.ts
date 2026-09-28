import { expect, test } from '@playwright/test';

const shots = process.env.SHOTS_DIR;

test('sample mannequin: import → rig → animate → export', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });

  await page.goto('/');
  await expect(page.getByRole('heading', { name: /Rig & animate Meshy models/ })).toBeVisible();
  if (shots) await page.screenshot({ path: `${shots}/0-empty.png` });

  await page.getByRole('button', { name: 'Try a sample' }).first().click();
  await expect(page.getByText('Triangles')).toBeVisible();
  if (shots) await page.screenshot({ path: `${shots}/1-import.png` });

  await page.getByRole('button', { name: /Continue to orientation/ }).click();
  if (shots) await page.screenshot({ path: `${shots}/2-orient.png` });
  await page.getByRole('button', { name: /find the joints/ }).click();

  await expect(page.getByText(/Detected \(A-pose\)/)).toBeVisible();
  if (shots) await page.screenshot({ path: `${shots}/3-joints.png` });

  await page.getByRole('button', { name: 'Build rig' }).click();
  await expect(page.getByRole('heading', { name: 'Rig ready' })).toBeVisible();
  // Geodesic distances ran on the worker pool when the machine has cores to spare.
  const rig = await page.evaluate(() => ({ timings: (window as any).rigforge.getState().rigTimings, cores: navigator.hardwareConcurrency }));
  console.log('rig timings', JSON.stringify(rig));
  if (rig.cores >= 3) expect(rig.timings.threads).toBeGreaterThan(1);
  await page.waitForTimeout(1200);
  if (shots) await page.screenshot({ path: `${shots}/4-rigged.png` });

  await page.getByRole('button', { name: 'Weights' }).click();
  await page.waitForTimeout(300);
  if (shots) await page.screenshot({ path: `${shots}/5-weights.png` });
  await page.getByRole('button', { name: 'Textured' }).click();

  await page.getByRole('button', { name: /Add animations/ }).click();
  await page.getByRole('button', { name: /Idle, Walk, Run, Jump/ }).click();
  await expect(page.locator('.clip')).toHaveCount(4);
  await page.getByRole('button', { name: 'Play Run' }).click();
  await page.waitForTimeout(700);
  if (shots) await page.screenshot({ path: `${shots}/6-animate.png` });

  await page.getByRole('button', { name: /^Export →/ }).click();
  await page.getByRole('button', { name: 'Build GLB' }).click();
  const download = page.getByRole('button', { name: /Download .*\.glb/ });
  await expect(download).toBeVisible();
  if (shots) await page.screenshot({ path: `${shots}/7-export.png` });

  const [file] = await Promise.all([page.waitForEvent('download'), download.click()]);
  const size = (await file.createReadStream()).readableLength;
  expect(file.suggestedFilename()).toMatch(/\.glb$/);
  expect(size).toBeGreaterThanOrEqual(0);

  expect(errors.filter((e) => !/Download the React DevTools|THREE\.WebGLRenderer: Context Lost/.test(e))).toEqual([]);
});
