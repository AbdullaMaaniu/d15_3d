import { expect, test, type Page } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { clothedCharacterGlb } from './fixtures/clothed';

const shots = process.env.SHOTS_DIR;

const store = (page: Page, expr: string) =>
  page.evaluate((e) => new Function('s', `return ${e}`)((window as any).rigforge.getState()), expr);

/** Steps the walk and the cloth by fixed frames (the dev hook), so renders are repeatable. */
const advance = (page: Page, frames: number) =>
  page.evaluate((n) => (window as any).rigforgeAdvance(1 / 60, n), frames);

test('cloth: garments simulate during the walk, per fabric, and are saved', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  const glb = info.outputPath('dancer.glb');
  writeFileSync(glb, await clothedCharacterGlb());

  await page.goto('/');
  await page.locator('input[type=file]').first().setInputFiles(glb);
  await expect(page.locator('.stats').getByText('Triangles')).toBeVisible();
  await page.getByRole('button', { name: /Continue to orientation/ }).click();
  await page.getByRole('button', { name: /find the joints/ }).click();
  await expect(page.getByText(/Detected/)).toBeVisible();
  await page.getByRole('button', { name: 'Build rig' }).click();
  await expect(page.getByRole('heading', { name: 'Rig ready' })).toBeVisible({ timeout: 120000 });

  // Parts by colour, named after the garments.
  await page.evaluate(() => {
    const s = (window as any).rigforge.getState();
    s.detectParts('colour', 3);
    const st = (window as any).rigforge.getState();
    const mats = st.character.built.mesh.material as any[];
    const colour = (name: string) => {
      const m = mats.find((x) => x.userData?.rigforge?.region?.name === name);
      const hex = m.userData.rigforge.region.baseColor as string;
      return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    };
    const names = st.parts.defs.map((d: any) => d.name);
    const cols = names.map(colour);
    const shirt = cols.reduce((b: number, c: number[], i: number) => (c[2] - c[0] > cols[b][2] - cols[b][0] ? i : b), 0);
    const rest = [0, 1, 2].filter((i) => i !== shirt);
    const skin = cols[rest[0]][1] > cols[rest[1]][1] ? rest[0] : rest[1];
    const skirt = rest.find((i) => i !== skin)!;
    st.renamePart(shirt, 'Shirt');
    st.renamePart(skin, 'Skin');
    st.renamePart(skirt, 'Skirt');
  });
  expect((await store(page, 's.parts.defs.map((d) => d.name)')).sort()).toEqual(['Shirt', 'Skin', 'Skirt']);

  // Body step: the cloth section guesses fabrics from the part names.
  await page.locator('.steps button', { hasText: 'Body' }).click();
  await expect(page.getByLabel('Shirt fabric')).toHaveValue('cotton');
  await expect(page.getByLabel('Skirt fabric')).toHaveValue('cotton');
  await expect(page.getByLabel('Skin fabric')).toHaveValue('none');
  await expect.poll(() => store(page, 's.clothInfo && s.clothInfo.particles'), { timeout: 30000 }).toBeGreaterThan(1000);
  // With the body shown, the clothes move onto its skeleton and the cloth follows them there.
  await expect.poll(() => page.evaluate(() => (window as any).rigforgeAdvance?.cloth()?.dressed), { timeout: 60000 }).toBe(true);
  await page.evaluate(() => {
    const s = (window as any).rigforge.getState();
    s.set('shading', 'textured');
    s.setTestClip('walk');
    s.set('playing', false);
  });
  await page.waitForTimeout(500);
  const dressedStats = await page.evaluate(() => {
    (window as any).rigforgeAdvance.rewind();
    return (window as any).rigforgeAdvance(1 / 60, 90);
  });
  expect(dressedStats.maxOffset).toBeLessThan(0.4);
  if (shots) await renderReview(page, shots, 'body');

  // Walk in the Animate step with solid clothes; the hem lags and swings.
  await page.getByRole('button', { name: 'Add animations →' }).click();
  await page.evaluate(() => {
    const s = (window as any).rigforge.getState();
    s.set('shading', 'textured');
    s.setTestClip('walk');
    s.set('playing', false);
  });
  await page.waitForTimeout(500);
  const firstStats = await page.evaluate(() => {
    (window as any).rigforgeAdvance.rewind();
    return (window as any).rigforgeAdvance(1 / 60, 90);
  });
  expect(firstStats.particles).toBeGreaterThan(1000);
  expect(firstStats.maxOffset).toBeGreaterThan(0.01);
  expect(firstStats.maxOffset).toBeLessThan(0.4);
  // No explosion: every vertex is finite and near the body.
  const box = await page.evaluate(() => {
    const g = (window as any).rigforge.getState().character.built.mesh.geometry;
    const a = g.attributes.position.array as Float32Array;
    let ok = true, lo = Infinity, hi = -Infinity;
    for (let i = 0; i < a.length; i++) {
      if (!Number.isFinite(a[i])) ok = false;
      if (i % 3 === 1) (lo = Math.min(lo, a[i])), (hi = Math.max(hi, a[i]));
    }
    return { ok, lo, hi };
  });
  expect(box.ok).toBe(true);
  expect(box.lo).toBeGreaterThan(-0.3);
  expect(box.hi).toBeLessThan(2.2);

  if (shots) await renderReview(page, shots, 'animate');

  // Turning it off puts the mesh back exactly.
  await page.locator('.steps button', { hasText: 'Body' }).click();
  await page.getByLabel('Simulate cloth').uncheck();
  await page.getByLabel('Skirt fabric').isDisabled();
  await expect.poll(() => store(page, 's.clothInfo')).toBe(null);

  // Saved with the project.
  await page.getByLabel('Simulate cloth').check();
  await page.getByLabel('Skirt fabric').selectOption('denim');
  expect(await store(page, 's.cloth.fabrics.Skirt')).toBe('denim');
  await page.getByRole('button', { name: 'Add animations →' }).click();
  await page.getByRole('button', { name: /Idle, Walk, Run, Jump/ }).click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Save' }).click()]);
  const path = info.outputPath('cloth.rigforge');
  await download.saveAs(path);
  await page.evaluate(() => indexedDB.deleteDatabase('rigforge'));
  await page.reload();
  await page.locator('input[accept*=".rigforge"]').setInputFiles(path);
  await expect.poll(() => store(page, 's.clips.length'), { timeout: 60000 }).toBe(4);
  expect(await store(page, 's.cloth')).toEqual({ enabled: true, fabrics: { Skirt: 'denim' } });
  expect(errors).toEqual([]);
});

/** Front, side and 3/4 renders through the walk, per fabric, for checking by eye. */
async function renderReview(page: Page, dir: string, step: string) {
  const canvas = page.locator('.stage canvas').first();
  await page.evaluate(() => (window as any).rigforge.getState().set('showSkeleton', false));
  const views: Array<[string, number]> = [['front', 0], ['side', Math.PI / 2], ['34', Math.PI / 4]];
  const fabrics = (process.env.FABRICS ?? 'cotton').split(',');
  for (const fabric of fabrics) {
    // 'off' renders plain skinning, to compare.
    await page.evaluate((f) => (window as any).rigforge.getState().setCloth(f === 'off' ? { enabled: false } : { enabled: true, fabrics: { Skirt: f } }), fabric);
    await page.waitForTimeout(800);
    await expect.poll(() => page.evaluate(() => !!(window as any).rigforgeAdvance?.cloth()), { timeout: 30000 }).toBe(fabric !== 'off');
    for (const [name, angle] of views) {
      await page.evaluate((a) => {
        (window as any).rigforge.getState().character.root.rotation.y = a;
        (window as any).rigforgeAdvance.rewind();
      }, angle);
      await advance(page, 60);
      for (let k = 0; k < 4; k++) {
        await advance(page, 9);
        await page.waitForTimeout(60);
        await canvas.screenshot({ path: `${dir}/${step}-${fabric}-${name}-${k}.png` });
      }
    }
    await page.evaluate(() => ((window as any).rigforge.getState().character.root.rotation.y = 0));
  }
  await page.evaluate(() => (window as any).rigforge.getState().setCloth({ enabled: true, fabrics: {} }));
  await expect.poll(() => page.evaluate(() => !!(window as any).rigforgeAdvance?.cloth()), { timeout: 30000 }).toBe(true);
}
