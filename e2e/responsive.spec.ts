import { expect, test } from '@playwright/test';

test.use({ viewport: { width: 390, height: 844 } });

test('phone layout has no horizontal overflow', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Try a sample' }).first().click();
  await page.getByRole('button', { name: /Continue to orientation/ }).click();
  await page.getByRole('button', { name: /find the joints/ }).click();
  await expect(page.getByText(/Detected/)).toBeVisible();
  if (process.env.SHOTS_DIR) await page.screenshot({ path: `${process.env.SHOTS_DIR}/m-joints.png`, fullPage: true });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
