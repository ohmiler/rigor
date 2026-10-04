import { test, expect } from '@playwright/test';

// Collect anything that goes wrong on the page.
function watchErrors(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`));
  page.on('requestfailed', (r) => errors.push(`request failed: ${r.url()}`));
  page.on('response', (r) => r.status() >= 400 && errors.push(`${r.status()}: ${r.url()}`));
  return errors;
}

const metresToGo = async (page) => Number((await page.locator('#objective').textContent()).match(/(\d+) m/)?.[1]);

test('the game loads, starts from the start screen, and the player can walk', async ({ page }, info) => {
  // Software WebGL can run the game at a handful of steps a second: a reload
  // that takes 2.5 s in the game can take most of a minute here.
  test.setTimeout(180000);
  const errors = watchErrors(page);
  // No Director: its mobs only slow the frames further, and could grab the
  // player mid-check.
  await page.goto('/?nodirector');
  await expect(page.locator('#start')).toBeVisible();
  // Dev tools stay hidden on the published build.
  await expect(page.locator('.lil-gui')).toHaveCount(0);
  await expect(page.locator('#lab-link')).toBeHidden();

  await page.getByRole('button', { name: 'Play in a window' }).click();
  await expect(page.locator('#start')).toBeHidden();
  await page.waitForTimeout(500);
  const before = await metresToGo(page);
  // Hold W until the distance drops: software WebGL runs at a few frames a
  // second, so how long that takes varies.
  await page.keyboard.down('w');
  await expect.poll(() => metresToGo(page), { timeout: 30000 }).toBeLessThan(before);
  await page.keyboard.up('w');

  // Fire, reload and swap guns: nothing should throw.
  await page.mouse.move(640, 250);
  // Fire until a round is gone (a full magazine won't reload).
  const mag = async () => Number(await page.locator('#ammo .mag').textContent());
  const full = await mag();
  await page.mouse.down();
  await expect.poll(mag, { timeout: 30000 }).toBeLessThan(full);
  await page.mouse.up();
  await page.keyboard.press('r');
  // No swapping mid-reload (by design): see it start, then wait for it to finish.
  await expect(page.locator('#ammo .state')).toContainText('RELOADING', { timeout: 10000 });
  await expect(page.locator('#ammo .state')).not.toContainText('RELOADING', { timeout: 60000 });
  await page.keyboard.press('2');
  await expect(page.locator('#ammo .weapon')).toContainText('PISTOL', { timeout: 30000 });
  await page.keyboard.press('3');
  await expect(page.locator('#ammo .weapon')).toContainText('KNIFE', { timeout: 30000 });

  await info.attach('game', { body: await page.screenshot(), contentType: 'image/png' });
  expect(errors).toEqual([]);
});

test('?dev shows the tuning tools', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto('/?dev');
  await expect(page.locator('.lil-gui').first()).toBeVisible();
  await expect(page.locator('#stats')).toBeVisible();
  expect(errors).toEqual([]);
});

test('the lab loads and its move checks run', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto('/lab.html');
  await expect(page.locator('canvas')).toBeVisible();
  await page.locator('.lil-controller', { hasText: 'Check all moves' }).locator('button').click();
  await expect(page.locator('#check')).toBeVisible();
  expect(errors).toEqual([]);
});
