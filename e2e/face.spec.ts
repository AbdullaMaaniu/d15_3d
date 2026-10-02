import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

const store = (page: import('@playwright/test').Page, expr: string) =>
  page.evaluate((e) => new Function('s', `return ${e}`)((window as any).rigforge.getState()), expr);

/** Reads the JSON chunk of a GLB. */
function glbJson(buf: Buffer): any {
  const len = buf.readUInt32LE(12);
  return JSON.parse(buf.subarray(20, 20 + len).toString('utf8'));
}

test('face rig: jaw, eye bones and expressions preview, save and ship in the GLB', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.getByRole('button', { name: 'Try a sample' }).first().click();
  await page.getByRole('button', { name: /Continue to orientation/ }).click();
  await page.getByRole('button', { name: /find the joints/ }).click();
  await expect(page.getByText(/Detected/)).toBeVisible();
  await expect(page.getByLabel(/Face rig/)).toBeChecked();
  await page.getByRole('button', { name: 'Build rig' }).click();
  await expect(page.getByRole('heading', { name: 'Rig ready' })).toBeVisible();

  const bones = await store(page, 's.character.built.skeleton.bones.map((b) => b.name)');
  for (const b of ['jaw', 'leftEye', 'rightEye']) expect(bones).toContain(b);
  // The sample's head is an egg: the face is placed by proportion and says so.
  await expect(page.getByText(/placed by proportion/)).toBeVisible();

  // Sliders drive the morph targets.
  await page.getByLabel('Expression Aa').fill('0.6');
  expect(await store(page, 's.character.built.mesh.morphTargetInfluences[s.character.built.mesh.morphTargetDictionary.aa]')).toBeCloseTo(0.6, 3);

  await page.getByRole('button', { name: /Add animations/ }).click();
  await page.getByRole('button', { name: /Idle, Walk, Run, Jump/ }).click();
  await page.getByRole('button', { name: /^Export →/ }).click();
  await page.getByRole('button', { name: 'Build GLB' }).click();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /Download .*\.glb/ }).click()]);
  const path = info.outputPath('face.glb');
  await dl.saveAs(path);
  const json = glbJson(readFileSync(path));
  const names = json.nodes.map((n: any) => n.name);
  for (const b of ['jaw', 'leftEye', 'rightEye']) expect(names).toContain(b);
  const mesh = json.meshes.find((m: any) => m.extras?.targetNames);
  expect(mesh.extras.targetNames).toEqual(['happy', 'angry', 'sad', 'relaxed', 'surprised', 'aa', 'ih', 'ou', 'ee', 'oh', 'blink', 'blinkLeft', 'blinkRight']);
  // Exported neutral, whatever the preview showed.
  expect((mesh.weights ?? []).every((w: number) => w === 0)).toBe(true);
  // Targets only touch the face, so they're stored sparse.
  const target = mesh.primitives[0].targets[0];
  expect(json.accessors[target.POSITION].sparse).toBeDefined();
  // The editor preview is still on.
  expect(await store(page, 's.character.built.mesh.morphTargetInfluences[s.character.built.mesh.morphTargetDictionary.aa]')).toBeCloseTo(0.6, 3);

  // The exported file drives expressions and blinks through @rigforge/three.
  await page.getByRole('button', { name: /Test drive/ }).click();
  await page.waitForFunction(() => (window as any).rigforgeDrive?.character);
  const drive = await page.evaluate(() => {
    const c = (window as any).rigforgeDrive.character;
    const ok = c.setExpression('happy', 1);
    return { expressions: c.expressions, ok, happy: c.getExpression('happy'), eye: !!c.bone('leftEye') };
  });
  expect(drive.expressions).toContain('blink');
  expect(drive.ok).toBe(true);
  expect(drive.happy).toBe(1);
  expect(drive.eye).toBe(true);
  expect(errors).toEqual([]);
});

test('face rig survives saving and reopening a project', async ({ page }, info) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Try a sample' }).first().click();
  await page.getByRole('button', { name: /Continue to orientation/ }).click();
  await page.getByRole('button', { name: /find the joints/ }).click();
  await expect(page.getByText(/Detected/)).toBeVisible();
  await page.getByRole('button', { name: 'Build rig' }).click();
  await expect(page.getByRole('heading', { name: 'Rig ready' })).toBeVisible();
  const jaw = await store(page, 's.face.jaw');
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Save' }).click()]);
  const path = info.outputPath('face.rigforge');
  await download.saveAs(path);
  await page.evaluate(() => indexedDB.deleteDatabase('rigforge'));
  await page.reload();
  await page.locator('input[accept*=".rigforge"]').setInputFiles(path);
  await expect(page.getByRole('heading', { name: 'Rig ready' })).toBeVisible();
  expect(await store(page, 's.face.jaw')).toEqual(jaw);
  expect(await store(page, 'Object.keys(s.character.built.mesh.morphTargetDictionary).length')).toBe(13);
  expect(await store(page, 's.character.built.skeleton.bones.some((b) => b.name === "jaw")')).toBe(true);
});
