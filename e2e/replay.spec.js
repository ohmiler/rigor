import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

// Play a bit for real (keys and mouse), save the replay (F8), load it back
// and watch it: it has to play out to the end without drifting from what
// was recorded.
test('a run saves as a replay that plays back exactly', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`));

  await page.goto('/');
  await page.getByRole('button', { name: 'Play in a window' }).click();
  await expect(page.locator('#start')).toBeHidden();

  // Walk, strafe, fire, reload, swap: enough to be more than standing still.
  await page.mouse.move(700, 260);
  await page.keyboard.down('w');
  await page.mouse.down();
  await page.waitForTimeout(2500);
  await page.mouse.up();
  await page.keyboard.down('a');
  await page.keyboard.press('r');
  await page.waitForTimeout(2000);
  await page.keyboard.up('a');
  await page.keyboard.press('2');
  await page.mouse.move(560, 240);
  await page.mouse.down();
  await page.waitForTimeout(2000);
  await page.mouse.up();
  await page.keyboard.up('w');

  const download = page.waitForEvent('download');
  await page.keyboard.press('F8');
  const file = await (await download).path();
  const replay = JSON.parse(await readFile(file, 'utf8'));
  expect(replay.game).toBe('rigor');
  expect(replay.checks.length).toBeGreaterThan(0); // at least one fingerprint to compare
  expect(replay.cmds.some((c) => c[1] === 'reload')).toBe(true);

  await page.setInputFiles('#replay-file', file);
  await expect(page.locator('#replay')).toBeVisible();
  await page.keyboard.press('4');
  await expect(page.locator('#replay .info')).toContainText('over', { timeout: 60000 });
  await expect(page.locator('#replay .info')).not.toContainText('drifted');
  expect(errors).toEqual([]);
});
