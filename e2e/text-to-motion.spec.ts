import { expect, test, type Page } from '@playwright/test';

/** Lets the viewport finish crossfading into the new clip (pausing mid-fade would freeze the blend). */
const settle = (page: Page) => page.waitForTimeout(600);

async function rigSample(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Try a sample' }).first().click();
  await page.getByRole('button', { name: /Continue to orientation/ }).click();
  await page.getByRole('button', { name: /find the joints/ }).click();
  await expect(page.getByText(/Detected/)).toBeVisible();
  await page.getByRole('button', { name: 'Build rig' }).click();
  await expect(page.getByRole('heading', { name: 'Rig ready' })).toBeVisible();
  await page.getByRole('button', { name: /Add animations/ }).click();
}

/** World height of a bone at time t of the active clip. */
const boneY = (page: Page, bone: string, t: number) =>
  page.evaluate(async ([bone, t]) => {
    const store = (window as any).rigforge;
    store.setState({ playing: false, time: t, seek: t });
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const node = store.getState().character.root.getObjectByName(bone);
    node.updateWorldMatrix(true, false);
    return node.matrixWorld.elements[13] as number;
  }, [bone, t] as const);

test('generate a clip from a text prompt with the built-in provider', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await rigSample(page);

  const prompt = page.getByLabel('Motion prompt');
  await prompt.fill('photosynthesise');
  await page.getByRole('button', { name: 'Generate' }).click();
  await expect(page.getByRole('alert')).toContainText('No motion recognised');

  await prompt.fill('Walk for 3 seconds, then wave with the left hand');
  await page.getByRole('button', { name: 'Generate' }).click();
  await expect(page.getByTestId('motion-plan')).toContainText('Walk 3 s → Wave (One Hand) left');
  await expect(page.locator('.clip')).toHaveCount(1);
  await expect(page.locator('.clip div.src')).toContainText('Text · “Walk for 3 seconds');
  await settle(page);

  // During the wave the left hand is raised above the head; while walking it hangs.
  const head = await boneY(page, 'head', 4.4);
  expect(await boneY(page, 'leftHand', 4.4)).toBeGreaterThan(head);
  expect(await boneY(page, 'leftHand', 1)).toBeLessThan(head - 0.3);
  expect(await boneY(page, 'rightHand', 4.4)).toBeLessThan(head - 0.3);
  expect(errors).toEqual([]);
});

test('generate a clip with Claude', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const requests: any[] = [];
  await page.route('https://api.anthropic.com/**', async (route) => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST' } });
    requests.push(route.request().postDataJSON());
    const plan = {
      name: 'Salute And Bow', loop: false,
      steps: [{ clip: 'salute', side: 'left' }, { keys: [{ t: 0.5, pose: [{ control: 'spineBend', degrees: 45 }] }, { t: 1.2, pose: [{ control: 'spineBend', degrees: 0 }] }] }],
    };
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
      body: JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'end_turn', stop_sequence: null, content: [{ type: 'text', text: JSON.stringify(plan) }], usage: { input_tokens: 1, output_tokens: 1 } }),
    });
  });
  await rigSample(page);
  await page.getByRole('button', { name: 'Claude', exact: true }).click();
  await page.getByLabel('Claude API key').fill('sk-ant-test');
  await page.getByLabel('Motion prompt').fill('salute with the left hand and then bow a little');
  await page.getByRole('button', { name: 'Generate' }).click();
  await expect(page.getByTestId('motion-plan')).toContainText('Salute left → Custom pose (2 keys)');
  expect(requests).toHaveLength(1);
  expect(requests[0].messages[0].content).toBe('salute with the left hand and then bow a little');
  await expect(page.locator('.clip input.name')).toHaveValue('Salute And Bow');
  expect(errors).toEqual([]);
});

/**
 * Review renders (SHOTS_DIR=dir): frames of generated clips from the front, the side
 * and three-quarters, to check the motion by eye.
 */
test('render generated clips for review', async ({ page }) => {
  test.skip(!process.env.SHOTS_DIR, 'set SHOTS_DIR to render review frames');
  test.setTimeout(600_000);
  await rigSample(page);
  const canvas = page.locator('canvas').first();
  const box = (await canvas.boundingBox())!;
  const orbit = async (dx: number) => {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(600);
  };
  const prompts = (process.env.PROMPTS ?? 'Walk for 3 seconds, then wave with the left hand|wave while walking|squat, then cheer|kneel|clap then nod|cross arms|think|hands on hips|salute|point|facepalm|fist pump|raise hand|look around|shake head').split('|');
  for (const [i, p] of prompts.entries()) {
    await page.getByLabel('Motion prompt').fill(p);
    await page.getByRole('button', { name: 'Generate' }).click();
    await expect(page.locator('.clip')).toHaveCount(i + 1);
    // Keep the character in frame: review poses in place (root travel is checked in the unit tests).
    await page.evaluate(() => {
      const s = (window as any).rigforge.getState();
      s.updateClip(s.activeClip, { inPlace: true });
    });
    await settle(page);
    const dur = await page.evaluate(() => {
      const s = (window as any).rigforge.getState();
      const c = s.clips.find((x: any) => x.id === s.activeClip);
      return (c.normalized.frames - 1) / c.normalized.fps;
    });
    const slug = p.replace(/[^a-z]+/gi, '-').toLowerCase().slice(0, 30);
    const views: Array<[string, number]> = [['front', 0], ['side', 300], ['threeq', -150]];
    for (const [view, dx] of views) {
      if (dx) await orbit(dx);
      for (let k = 0; k < 6; k++) {
        const t = (dur * k) / 5;
        await page.evaluate(async (t) => {
          const store = (window as any).rigforge;
          store.setState({ playing: false, time: t, seek: t });
          await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        }, t);
        await canvas.screenshot({ path: `${process.env.SHOTS_DIR}/${String(i).padStart(2, '0')}-${slug}-${view}-${k}.png` });
      }
    }
    await orbit(-150); // back to the front
  }
});
