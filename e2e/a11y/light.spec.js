// axe (WCAG 2.0/2.1 A and AA) on every route and Settings > AI, light theme.
import { test, expect, useBurrow } from '../support/fixtures.js';
import { registerThemeTests, scan, describe } from '../support/axe.js';
import { PLAIN_REPLY } from '../../scripts/lib/fakeOllamaServer.js';
import { javi, seedCalendarChange, waitForActivePage } from '../pages/javi.js';
import { nav } from '../pages/nav.js';

useBurrow({ seed: true, ollama: 'fake' });
registerThemeTests(test, 'light');

test('calculator dialog after a result and an error has no serious or critical violations (light)', async ({ page }, testInfo) => {
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  await page.goto('/');
  await page.locator('main').focus();
  await page.keyboard.press('Control+k');
  await page.getByRole('combobox', { name: 'Search' }).fill('calc');
  await page.getByRole('option', { name: /Calculator/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Calculator' });
  const input = dialog.getByRole('textbox', { name: 'Calculation' });
  await input.fill('1 / 3');
  await input.press('Enter');
  await expect(dialog.getByText('Result: 0.3333333333')).toBeAttached();
  let violations = await scan(page, testInfo, { name: 'calculator-result', theme: 'light', include: '[role="dialog"]' });
  expect(describe(violations), 'axe violations on the calculator result (light)').toEqual([]);
  await input.fill('5 / 0');
  await input.press('Enter');
  await expect(input).toHaveAttribute('aria-invalid', 'true');
  violations = await scan(page, testInfo, { name: 'calculator-error', theme: 'light', include: '[role="dialog"]' });
  expect(describe(violations), 'axe violations on the calculator error (light)').toEqual([]);
});

test('open Javi DM with an insight and a New for you row has no serious or critical violations (light)', async ({ page }, testInfo) => {
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  // An unread row the way a user gets one (insight on Calendar, a calendar write while Bookmarks is on screen),
  // opened on Journal (every unread row except the current page's shows).
  await seedCalendarChange(page);
  const j = javi(page);
  const active = waitForActivePage(page, 'journal');
  await page.goto('/journal');
  await active;
  await expect(page.getByRole('heading', { level: 2, name: 'Journal', exact: true }).first()).toBeVisible();
  await j.open();
  await expect(j.message(PLAIN_REPLY)).toBeVisible();
  await expect(j.stripRows()).toHaveText(['Calendar changed since your last insight']);
  // The whole page: the expanded Javi window (the bar is hidden while it is open).
  const violations = await scan(page, testInfo, { name: 'javi-dm-open', theme: 'light' });
  expect(describe(violations), 'axe violations on the open Javi DM (light)').toEqual([]);
});

test('open navigation menu has no serious or critical violations (light)', async ({ page }, testInfo) => {
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  await page.goto('/journal');
  await expect(page.getByRole('heading', { level: 2, name: 'Journal', exact: true }).first()).toBeVisible();
  const n = nav(page);
  const list = await n.openDrawer();
  await expect(page.getByRole('dialog').getByRole('group')).toHaveCount(3);
  for (const name of ['Financials', 'Health', 'Productivity']) await expect(n.drawerSection(name)).toBeVisible();
  // Every section expanded, so the scan covers every row as well as the header buttons.
  await n.openAllSections();
  await expect(list.getByRole('link').first()).toHaveText('Home');
  await page.waitForLoadState('networkidle');
  // The whole page: Home, Calendar and the three sections under their h3 dropdown headers (Journal active)
  // over the dimmed page.
  const violations = await scan(page, testInfo, { name: 'drawer-open', theme: 'light' });
  expect(describe(violations), 'axe violations on the open navigation menu (light)').toEqual([]);
});
