import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

const store = (page: import('@playwright/test').Page, expr: string) =>
  page.evaluate((e) => new Function('s', `return ${e}`)((window as any).rigforge.getState()), expr);

/** Reads the JSON chunk of a GLB. */
function glbJson(buf: Buffer): any {
  const len = buf.readUInt32LE(12);
  return JSON.parse(buf.subarray(20, 20 + len).toString('utf8'));
}

test('accessory hair chain gets spring physics and ships in the GLB', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.getByRole('button', { name: 'Try a sample' }).first().click();
  await page.getByRole('button', { name: /Continue to orientation/ }).click();
  await page.getByRole('button', { name: /find the joints/ }).click();
  await expect(page.getByText(/Detected/)).toBeVisible();

  // A ponytail: three joints hanging behind the head.
  await page.getByRole('button', { name: '+ Add chain' }).click();
  await page.getByLabel('Attach to bone').selectOption('head');
  await page.evaluate(() => {
    const s = (window as any).rigforge.getState();
    const h = s.joints.joints.head;
    for (const [dy, dz] of [[0.08, -0.1], [-0.02, -0.14], [-0.12, -0.16]]) (window as any).rigforge.getState().addAccessoryJoint([h[0], h[1] + dy, h[2] + dz]);
  });
  await expect(page.getByText('3 joints · on head')).toBeVisible();
  await page.getByRole('button', { name: 'Done adding' }).click();

  await page.getByRole('button', { name: 'Build rig' }).click();
  await expect(page.getByRole('heading', { name: 'Rig ready' })).toBeVisible();
  expect(await store(page, 's.springs.chains.map((c) => c.bones.join(","))')).toEqual(['strandA1,strandA2,strandA3']);
  expect(await store(page, 's.springs.colliders.length')).toBeGreaterThan(3);

  // The tip lags behind the head while the walk plays (it isn't rigidly attached).
  const offsets = await page.evaluate(async () => {
    const s = (window as any).rigforge.getState();
    const root = s.character.root;
    const out: number[] = [];
    for (let i = 0; i < 12; i++) {
      await new Promise((r) => setTimeout(r, 80));
      const head = root.getObjectByName('head');
      const tip = root.getObjectByName('strandA3');
      head.updateWorldMatrix(true, false);
      tip.updateWorldMatrix(true, false);
      const hp = head.matrixWorld.elements, tp = tip.matrixWorld.elements;
      out.push(Math.hypot(tp[12] - hp[12], tp[13] - hp[13], tp[14] - hp[14]));
    }
    return out;
  });
  expect(Math.max(...offsets) - Math.min(...offsets)).toBeGreaterThan(0.002);

  await page.getByRole('button', { name: /Add animations/ }).click();
  await page.getByRole('button', { name: /Idle, Walk, Run, Jump/ }).click();
  await page.getByRole('button', { name: /^Export →/ }).click();
  await page.getByRole('button', { name: 'Build GLB' }).click();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /Download .*\.glb/ }).click()]);
  const path = info.outputPath('hero.glb');
  await dl.saveAs(path);
  const json = glbJson(readFileSync(path));
  const withSprings = json.nodes.find((n: any) => n.extras?.rigforge?.springs);
  expect(withSprings.extras.rigforge.springs.chains[0].bones).toEqual(['strandA1', 'strandA2', 'strandA3']);
  expect(errors).toEqual([]);
});
