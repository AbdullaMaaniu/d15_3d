import { expect, test } from '@playwright/test';

const store = (page: import('@playwright/test').Page, expr: string) =>
  page.evaluate((e) => new Function('s', `return ${e}`)((window as any).rigforge.getState()), expr);
/** Names of the skinned meshes in a GLB's JSON chunk. */
function glbMeshes(glb: number[]): string[] {
  const bytes = Uint8Array.from(glb);
  const len = new DataView(bytes.buffer).getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + len)));
  return json.nodes.filter((n: any) => n.mesh !== undefined && n.skin !== undefined).map((n: any) => n.name).sort();
}
const drive = (page: import('@playwright/test').Page, expr: string) =>
  page.evaluate((e) => new Function('d', `return ${e}`)((window as any).rigforgeDrive), expr);

test('export: the body is written under the clothes and keeps up with the character in the runtime', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Clothed sample' }).first().click();
  await page.getByRole('button', { name: /Continue to orientation/ }).click();
  await page.getByRole('button', { name: /find the joints/ }).click();
  await expect(page.getByText(/Detected/)).toBeVisible();
  await page.getByRole('button', { name: 'Build rig' }).click();
  await expect(page.getByRole('heading', { name: 'Rig ready' })).toBeVisible();
  await page.getByRole('button', { name: /Add animations/ }).click();
  await page.getByRole('button', { name: /Idle, Walk, Run, Jump/ }).click();
  await page.getByRole('button', { name: /^Export →/ }).click();
  await expect(page.getByText(/clothes as separate meshes, the body under them/)).toBeVisible();

  const build = async () => {
    await page.getByRole('button', { name: 'Build GLB' }).click();
    await expect(page.getByRole('button', { name: /Download/ })).toBeVisible({ timeout: 90_000 });
    return glbMeshes((await page.evaluate(() => Array.from((window as any).rigforge.getState().exportResult.glb as Uint8Array))) as number[]);
  };
  // The garments cut in the Body step replace the clothed mesh, with the body under them.
  expect(await build()).toEqual(['BodyMesh', 'Bottoms', 'Hair', 'Head', 'Shoes', 'Top']);
  // Without the body, the character's mesh goes out as it is.
  await page.getByLabel('Body under the clothes').uncheck();
  expect(await store(page, 's.exportResult')).toBeNull();
  expect(await build()).toEqual(['CharacterMesh']);
  await page.getByLabel('Body under the clothes').check();

  // The exported file loads in the runtime with both meshes on one skeleton.
  await page.getByRole('button', { name: '▶ Test drive' }).click();
  await expect(page.getByTestId('drive-state')).toContainText('move', { timeout: 30_000 });
  const meshes = await drive(page, `(() => { const out = []; d.character.object.traverse((o) => { if (o.isSkinnedMesh) out.push(o.name); }); return out.sort(); })()`);
  expect(meshes).toEqual(['BodyMesh', 'Bottoms', 'Hair', 'Head', 'Shoes', 'Top']);
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
