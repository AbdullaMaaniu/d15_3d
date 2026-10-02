import { expect, test } from '@playwright/test';

const shots = process.env.SHOTS_DIR;

const drive = (page: import('@playwright/test').Page, expr: string) =>
  page.evaluate((e) => new Function('d', `return ${e}`)((window as any).rigforgeDrive), expr);

test('test drive: walk, run and jump the exported character on bumpy ground', async ({ page }) => {
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

  await page.getByRole('button', { name: '▶ Test drive' }).click();
  await expect(page.getByTestId('drive-state')).toContainText('move', { timeout: 30_000 });
  expect(await drive(page, 'd.character.controllerSetup.locomotion.map((l) => l[1])')).toEqual(['Idle', 'Walk', 'Run']);

  // Walk forward: the character moves along +Z (it faces +Z and the camera starts behind it).
  // Polled rather than timed: on a slow runner the first frames come late.
  await page.keyboard.down('KeyW');
  await expect.poll(() => drive(page, 'd.speed'), { timeout: 10_000 }).toBeGreaterThan(0.8);
  await expect.poll(async () => ((await drive(page, 'd.position')) as number[])[2], { timeout: 10_000 }).toBeGreaterThan(0.2);
  const walking = (await drive(page, 'd.speed')) as number;

  // Shift runs faster.
  await page.keyboard.down('Shift');
  await expect.poll(() => drive(page, 'd.speed'), { timeout: 10_000 }).toBeGreaterThan(walking + 0.8);
  if (shots) await page.screenshot({ path: `${shots}/drive-run.png` });
  await page.keyboard.up('Shift');
  await page.keyboard.up('KeyW');

  // Jump is a one-shot that returns to locomotion.
  await page.keyboard.press('Space');
  await expect.poll(() => drive(page, 'd.state')).toBe('jump');
  await expect.poll(() => drive(page, 'd.state'), { timeout: 20_000 }).toBe('move');

  // S turns the character around (camera-relative input) and it walks back toward -Z.
  await page.keyboard.down('KeyS');
  await expect.poll(async () => Math.abs((await drive(page, 'd.character.object.rotation.y')) as number), { timeout: 15_000 }).toBeGreaterThan(2.8);
  const zBack = ((await drive(page, 'd.position')) as number[])[2];
  await expect.poll(async () => ((await drive(page, 'd.position')) as number[])[2], { timeout: 15_000 }).toBeLessThan(zBack - 0.3);
  await page.keyboard.up('KeyS');

  // Foot IK keeps the feet on the hills: stand on a slope and compare foot heights with the ground.
  await drive(page, 'd.teleport(9, 3)');
  await page.waitForTimeout(1500);
  const gap = (await page.evaluate(() => {
    const d = (window as any).rigforgeDrive;
    const out: number[] = [];
    for (const name of ['leftFoot', 'rightFoot']) {
      const b = d.character.bone(name);
      b.updateWorldMatrix(true, false);
      const e = b.matrixWorld.elements;
      out.push(e[13] - d.ground(e[12], e[14]));
    }
    return out;
  })) as number[];
  for (const g of gap) expect(Math.abs(g)).toBeLessThan(0.16);
  if (shots) await page.screenshot({ path: `${shots}/drive-slope.png` });

  // Changing the controller marks the drive stale; rebuild picks it up.
  await page.getByLabel('Speed of Run').fill('5');
  await page.getByRole('button', { name: 'Settings changed · Rebuild' }).click();
  await expect.poll(() => drive(page, 'd.character.controllerSetup.locomotion[2][0]'), { timeout: 30_000 }).toBe(5);

  await page.keyboard.press('Escape');
  await expect(page.getByTestId('drive-state')).toHaveCount(0);
  await expect(page.locator('.timeline')).toBeVisible();
  expect(errors).toEqual([]);
});
