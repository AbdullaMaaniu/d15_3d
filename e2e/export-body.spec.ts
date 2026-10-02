import { expect, test } from '@playwright/test';

const store = (page: import('@playwright/test').Page, expr: string) =>
  page.evaluate((e) => new Function('s', `return ${e}`)((window as any).rigforge.getState()), expr);
const drive = (page: import('@playwright/test').Page, expr: string) =>
  page.evaluate((e) => new Function('d', `return ${e}`)((window as any).rigforgeDrive), expr);

test('export: the body is written under the clothes and keeps up with the character in the runtime', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Try a sample' }).first().click();
  await page.getByRole('button', { name: /Continue to orientation/ }).click();
  await page.getByRole('button', { name: /find the joints/ }).click();
  await expect(page.getByText(/Detected/)).toBeVisible();
  await page.getByRole('button', { name: 'Build rig' }).click();
  await expect(page.getByRole('heading', { name: 'Rig ready' })).toBeVisible();
  await page.getByRole('button', { name: /Add animations/ }).click();
  await page.getByRole('button', { name: /Idle, Walk, Run, Jump/ }).click();
  await page.getByRole('button', { name: /^Export →/ }).click();
  await expect(page.getByText(/the body under the clothes/)).toBeVisible();

  const build = async () => {
    await page.getByRole('button', { name: 'Build GLB' }).click();
    await expect(page.getByRole('button', { name: /Download/ })).toBeVisible({ timeout: 60_000 });
    return (await store(page, 's.exportResult.after.geometry')) as number;
  };
  const withBody = await build();
  // Leaving the body out drops its geometry.
  await page.getByLabel('Body under the clothes').uncheck();
  expect(await store(page, 's.exportResult')).toBeNull();
  const without = await build();
  expect(withBody).toBeGreaterThan(without * 1.5);
  await page.getByLabel('Body under the clothes').check();

  // The exported file loads in the runtime with both meshes on one skeleton.
  await page.getByRole('button', { name: '▶ Test drive' }).click();
  await expect(page.getByTestId('drive-state')).toContainText('move', { timeout: 30_000 });
  const meshes = await drive(page, `(() => { const out = []; d.character.object.traverse((o) => { if (o.isSkinnedMesh) out.push(o.name); }); return out.sort(); })()`);
  expect(meshes).toEqual(['BodyMesh', 'CharacterMesh']);
  // Walking with root motion and foot IK, the body's hips stay with the character's.
  const hipsGap = `(() => { const o = d.character.object; o.updateMatrixWorld(true); const V = o.position.constructor; return o.getObjectByName('Body_hips').getWorldPosition(new V()).distanceTo(o.getObjectByName('hips').getWorldPosition(new V())); })()`;
  const still = (await drive(page, hipsGap)) as number;
  await page.keyboard.down('KeyW');
  await expect.poll(async () => ((await drive(page, 'd.position')) as number[])[2], { timeout: 30_000 }).toBeGreaterThan(0.2);
  const gap = (await drive(page, hipsGap)) as number;
  await page.keyboard.up('KeyW');
  // (The body's hips sit a little higher or lower than the character's, by its proportions.)
  expect(still).toBeLessThan(0.15);
  expect(Math.abs(gap - still)).toBeLessThan(0.05);
  expect(errors).toEqual([]);
});
