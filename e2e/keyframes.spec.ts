import { expect, test } from '@playwright/test';

test('pose a new clip with keyframes', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.getByRole('button', { name: 'Try a sample' }).first().click();
  await page.getByRole('button', { name: /Continue to orientation/ }).click();
  await page.getByRole('button', { name: /find the joints/ }).click();
  await expect(page.getByText(/Detected/)).toBeVisible();
  await page.getByRole('button', { name: 'Build rig' }).click();
  await expect(page.getByRole('heading', { name: 'Rig ready' })).toBeVisible();
  await page.getByRole('button', { name: /Add animations/ }).click();
  await page.getByRole('button', { name: '+ Keyframe clip' }).click();
  await expect(page.getByText(/Keyframing “New Clip”/)).toBeVisible();

  // Raise the left arm at t=1s: rotate the bone as the gizmo would, then press K.
  await page.getByLabel('Bone', { exact: true }).selectOption('leftUpperArm');
  const raise = async (t: number, angle: number) => {
    await page.evaluate(([t, angle]) => {
      const store = (window as any).rigforge;
      store.setState({ time: t, seek: t });
      return new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => {
        const s = store.getState();
        const bone = s.character.root.getObjectByName('leftUpperArm');
        bone.rotateZ(angle);
        r();
      })));
    }, [t, angle] as const);
    await page.keyboard.press('k');
  };
  await raise(1, 1.2);
  await raise(2, -1.0); // relative to the held 1s pose
  await expect(page.locator('.timeline .key')).toHaveCount(2);
  await expect(page.getByText('2 keys')).toBeVisible();

  // The baked clip lifts the hand higher at the 1s key than at the 2s key.
  const handY = (t: number) =>
    page.evaluate(async (t) => {
      const store = (window as any).rigforge;
      store.setState({ time: t, seek: t });
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const hand = store.getState().character.root.getObjectByName('leftHand');
      hand.updateWorldMatrix(true, false);
      return hand.matrixWorld.elements[13];
    }, t);
  const y1 = await handY(1);
  const y2 = await handY(2);
  const yMid = await handY(1.5);
  expect(y1 - y2).toBeGreaterThan(0.25);
  expect(yMid).toBeLessThan(y1);
  expect(yMid).toBeGreaterThan(y2);
  if (process.env.SHOTS_DIR) await page.screenshot({ path: `${process.env.SHOTS_DIR}/keys.png` });

  // Jump back to the 1s key and delete it via the toolbar.
  await page.getByTitle('Previous key').click();
  await page.getByRole('button', { name: '✕◆' }).click();
  await expect(page.locator('.timeline .key')).toHaveCount(1);
  expect(errors).toEqual([]);
});
