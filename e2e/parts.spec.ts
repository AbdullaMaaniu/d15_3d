import { expect, test } from '@playwright/test';

const store = (page: import('@playwright/test').Page, expr: string) =>
  page.evaluate((e) => new Function('s', `return ${e}`)((window as any).rigforge.getState()), expr);

/** Material names and region tags in a GLB's JSON chunk. */
function glbMaterials(glb: number[]): Array<[string, string | undefined]> {
  const bytes = Uint8Array.from(glb);
  const view = new DataView(bytes.buffer);
  const len = view.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + len)));
  return (json.materials ?? []).map((m: any) => [m.name, m.extras?.rigforge?.region?.name]);
}

test('parts: paint, fill, undo, rename, preview colours, export and reopen', async ({ page }, info) => {
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

  // The optional step, reached from the rig or the step bar.
  await page.getByRole('button', { name: /split into recolourable parts/ }).click();
  await expect(page.getByRole('heading', { name: 'Parts', level: 2 })).toBeVisible();
  await page.getByRole('button', { name: /Start with one part/ }).click();
  const list = page.getByRole('listbox', { name: 'Parts' });
  await expect(list.getByRole('option')).toHaveCount(1);
  await expect(list.getByRole('option').first()).toContainText('100%');

  // A second part, painted on the chest with the brush (mirrored).
  await page.getByRole('button', { name: '+ Add' }).click();
  await expect(list.getByRole('option')).toHaveCount(2);
  await expect(list.getByRole('option').nth(1)).toHaveAttribute('aria-selected', 'true');
  const canvas = (await page.locator('.stage canvas').first().boundingBox())!;
  const cx = canvas.x + canvas.width / 2, cy = canvas.y + canvas.height * 0.42;
  await page.mouse.move(cx - 10, cy);
  await page.mouse.down();
  for (let i = 0; i <= 10; i++) await page.mouse.move(cx - 10 + i * 4, cy + i * 3);
  await page.mouse.up();
  const painted = await store(page, 's.parts.faces.filter((f) => f === 1).length');
  expect(painted).toBeGreaterThan(10);
  expect(await store(page, 'Array.isArray(s.character.built.mesh.material) && s.character.built.mesh.material.length')).toBe(2);

  // Undo / redo.
  await page.getByRole('button', { name: /Undo/ }).click();
  expect(await store(page, 's.parts.faces.filter((f) => f === 1).length')).toBe(0);
  await page.keyboard.press('Control+Shift+Z');
  expect(await store(page, 's.parts.faces.filter((f) => f === 1).length')).toBe(painted);

  // Rename, then the fill tool (F) spreads the part over the matching colour.
  await page.getByLabel('Part 2 name').fill('Shirt');
  await page.keyboard.press('Escape');
  await page.locator('.stage canvas').first().click({ position: { x: 5, y: 5 } }); // blur the input
  await page.keyboard.press('f');
  expect(await store(page, 's.partsTool.mode')).toBe('fill');
  await page.mouse.click(cx + 12, cy + 30);
  expect(await store(page, 's.parts.faces.filter((f) => f === 1).length')).toBeGreaterThan(painted);

  // Hovering the model names the part under the cursor in the list.
  await page.mouse.move(cx, cy);
  await expect(list.locator('.part-row.hover')).toHaveCount(1);

  // Preview colour switches to the colours view and recolours in the viewport.
  await page.getByLabel('Shirt preview colour').fill('#c0392b');
  expect(await store(page, 's.partsTool.view')).toBe('colours');
  expect(await store(page, 's.parts.tints[1]')).toBe('#c0392b');
  await page.waitForTimeout(500);

  // Walk preview plays, pause returns to the bind pose for editing.
  await page.getByRole('button', { name: '▶ Walk' }).click();
  expect(await store(page, 's.playing')).toBe(true);
  await page.getByRole('button', { name: '❚❚ Pause' }).click();
  expect(await store(page, 's.playing')).toBe(false);

  // Export: one named material per part, tagged for the runtime, plus the body's skin.
  await page.getByRole('button', { name: 'Add animations →' }).click();
  await page.getByRole('button', { name: /Idle, Walk, Run, Jump/ }).click();
  await page.getByRole('button', { name: /^Export →/ }).click();
  await page.getByRole('button', { name: 'Build GLB' }).click();
  await expect(page.getByRole('button', { name: /Download .*\.glb/ })).toBeVisible({ timeout: 60000 });
  const glb = await page.evaluate(() => Array.from((window as any).rigforge.getState().exportResult.glb as Uint8Array));
  expect(glbMaterials(glb)).toEqual([['Body', 'Body'], ['Shirt', 'Shirt'], ['Skin', undefined]]);

  // Save and reopen: the parts come back on the mesh.
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Save' }).click()]);
  const path = info.outputPath('parts.rigforge');
  await download.saveAs(path);
  await page.evaluate(() => indexedDB.deleteDatabase('rigforge'));
  await page.reload();
  await page.locator('input[accept*=".rigforge"]').setInputFiles(path);
  await expect.poll(() => store(page, 's.clips.length'), { timeout: 30000 }).toBe(4);
  expect(await store(page, 's.parts.defs.map((d) => d.name).join()')).toBe('Body,Shirt');
  expect(await store(page, 's.parts.tints[1]')).toBe('#c0392b');
  await expect.poll(() => store(page, 's.character.built.mesh.material.map((m) => m.name).join()')).toBe('Body,Shirt');

  // Clearing goes back to one material.
  await page.locator('.steps button', { hasText: 'Parts' }).click();
  await page.getByRole('button', { name: 'Clear parts' }).click();
  expect(await store(page, '[].concat(s.character.built.mesh.material).length')).toBe(1);
  expect(await store(page, 's.character.built.mesh.geometry.groups.length')).toBeLessThanOrEqual(1);
  expect(errors).toEqual([]);
});
