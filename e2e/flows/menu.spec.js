// The one menu (docs/design/nav-sections-2026-10.md, updated by #108): Home and Calendar, then the Financials,
// Health and Productivity sections as dropdowns (the current page's section open by default, each toggle
// remembered on this device), with no divider; arrow keys walk the visible rows and headers;
// Alt+1 / Alt+2 and the palette's Switch to are gone; /weather lands on Home; Home through the
// wordmark and Settings through the gear; and nothing asks for the old `workspace` row.
import { test, expect, useBurrow } from '../support/fixtures.js';
import { nav, topBar } from '../pages/nav.js';

useBurrow({ seed: true, ollama: 'fake' });

const heading = (page, name) => page.getByRole('heading', { level: 2, name, exact: true }).first();

const SECTIONS = ['Financials', 'Health', 'Productivity'];
// Every section expanded.
const MENU = [
  'Home',
  'Calendar',
  '#Financials',
  'Budget',
  'Subscriptions',
  '#Health',
  'Journal',
  'Habits',
  'Sleep & activity',
  '#Productivity',
  'Todos',
  'Notes',
  'Focus',
  'Countdowns',
  'Bookmarks',
  'Folders',
];

/** Every request the page makes for the old `workspace` app_state row, from the moment this is called. */
function watchWorkspaceRequests(page) {
  const urls = [];
  page.on('request', (r) => {
    if (r.url().includes('/api/state/workspace')) urls.push(`${r.method()} ${r.url()}`);
  });
  return urls;
}

/** The rows of the open menu in order: link names and '#Section' for section headers (the menu has no divider). */
async function rows(list) {
  return list.locator('a, h3, hr').evaluateAll((els) =>
    els.map((el) => {
      if (el.tagName === 'HR') return '---';
      if (el.tagName === 'H3') return `#${el.textContent.trim()}`;
      return el.textContent.trim();
    }),
  );
}

/** { Financials: bool, Health: bool, Productivity: bool } from the headers' aria-expanded. */
async function expanded(n) {
  const out = {};
  for (const name of SECTIONS) out[name] = (await n.sectionHeader(name).getAttribute('aria-expanded')) === 'true';
  return out;
}

test('the menu opens with only the current section expanded; expanded, it lists every page and no Settings', async ({ page }) => {
  const workspaceRequests = watchWorkspaceRequests(page);
  await page.goto('/journal');
  await expect(heading(page, 'Journal')).toBeVisible();
  const n = nav(page);
  const list = await n.openDrawer();
  // Default: the section of the current page is open, the others are one header row each.
  expect(await expanded(n)).toEqual({ Financials: false, Health: true, Productivity: false });
  expect(await rows(list)).toEqual([
    'Home',
    'Calendar',
    '#Financials',
    '#Health',
    'Journal',
    'Habits',
    'Sleep & activity',
    '#Productivity',
  ]);
  await expect(n.drawerSection('Health').getByRole('link', { name: 'Journal', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
  // Each header controls its section's list.
  for (const name of SECTIONS) {
    const controls = await n.sectionHeader(name).getAttribute('aria-controls');
    await expect(n.drawerSection(name).locator(`[id="${controls}"]`)).toHaveCount(1);
  }

  await n.openAllSections();
  expect(await rows(list)).toEqual(MENU);
  await expect(list.getByRole('separator')).toHaveCount(0);
  await expect(page.getByRole('dialog').getByRole('group')).toHaveCount(3);
  await expect(n.drawerSection('Financials').getByRole('link')).toHaveText(['Budget', 'Subscriptions']);
  await expect(n.drawerSection('Productivity').getByRole('link')).toHaveText([
    'Todos',
    'Notes',
    'Focus',
    'Countdowns',
    'Bookmarks',
    'Folders',
  ]);
  await expect(n.drawerSection('Health').getByRole('link')).toHaveText(['Journal', 'Habits', 'Sleep & activity']);
  // The only buttons are the three section headers (no workspace switch), and there is no Settings row.
  await expect(page.getByRole('dialog').getByRole('button')).toHaveText(SECTIONS);
  await expect(list.getByRole('link', { name: 'Settings', exact: true })).toHaveCount(0);
  await expect(list.getByRole('link', { name: 'Weather', exact: true })).toHaveCount(0);

  // Sleep & activity opens the /health page under its new name.
  await n.drawerSection('Health').getByRole('link', { name: 'Sleep & activity', exact: true }).click();
  await expect(page).toHaveURL(/\/health$/);
  await expect(heading(page, 'Sleep & activity')).toBeVisible();
  await expect(page).toHaveTitle(/^Sleep & activity/);
  expect(workspaceRequests).toEqual([]);
});

test('a header toggles its section, and the choice survives a reload', async ({ page }) => {
  await page.goto('/');
  await expect(heading(page, 'Overview')).toBeVisible();
  const n = nav(page);
  const list = await n.openDrawer();
  // Home is in no section: everything starts collapsed.
  expect(await expanded(n)).toEqual({ Financials: false, Health: false, Productivity: false });
  await expect(list.getByRole('link')).toHaveText(['Home', 'Calendar']);

  await n.sectionHeader('Productivity').click();
  await expect(n.sectionHeader('Productivity')).toHaveAttribute('aria-expanded', 'true');
  await expect(n.drawerSection('Productivity').getByRole('link')).toHaveCount(6);
  await n.sectionHeader('Financials').click();
  await n.sectionHeader('Financials').click();
  await expect(n.sectionHeader('Financials')).toHaveAttribute('aria-expanded', 'false');
  await expect(n.drawerSection('Financials').getByRole('link')).toHaveCount(0);

  await page.reload();
  await expect(heading(page, 'Overview')).toBeVisible();
  await n.openDrawer();
  expect(await expanded(n)).toEqual({ Financials: false, Health: false, Productivity: true });

  // Going to a page opens its section next time and keeps the other choices.
  await n.closeDrawer();
  await page.goto('/habits');
  await expect(heading(page, 'Habits')).toBeVisible();
  await n.openDrawer();
  expect(await expanded(n)).toEqual({ Financials: false, Health: true, Productivity: true });
  await expect(n.drawerSection('Health').getByRole('link', { name: 'Habits', exact: true })).toBeFocused();
});

test('the menu fits the smallest desktop window (960 x 640) without scrolling, with every section open', async ({ page }) => {
  await page.setViewportSize({ width: 960, height: 640 });
  await page.goto('/budget');
  await expect(heading(page, 'Budget')).toBeVisible();
  const n = nav(page);
  const list = await n.openDrawer();
  await n.openAllSections();
  await expect(list.getByRole('link', { name: 'Calendar', exact: true })).toBeInViewport();
  const overflow = await list.evaluate((el) => el.scrollHeight - el.clientHeight);
  expect(overflow).toBeLessThanOrEqual(0);
});

test('arrow keys walk the visible rows and headers, skip collapsed rows, and Enter / Space toggle', async ({ page }) => {
  await page.goto('/settings');
  await expect(heading(page, 'Settings')).toBeVisible();
  const n = nav(page);
  const list = await n.openDrawer();
  // Not on a menu page, so focus starts on Home and every section is collapsed.
  const home = list.getByRole('link', { name: 'Home', exact: true });
  await expect(home).toBeFocused();
  const calendar = list.getByRole('link', { name: 'Calendar', exact: true });
  for (const target of [calendar, n.sectionHeader('Financials'), n.sectionHeader('Health'), n.sectionHeader('Productivity')]) {
    await page.keyboard.press('ArrowDown');
    await expect(target).toBeFocused();
  }
  await page.keyboard.press('ArrowDown');
  await expect(home).toBeFocused();

  // Enter opens Financials, Space opens Health; the arrows now reach their rows.
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(n.sectionHeader('Financials')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(n.sectionHeader('Financials')).toHaveAttribute('aria-expanded', 'true');
  await n.sectionHeader('Health').focus();
  await page.keyboard.press('Space');
  await expect(n.sectionHeader('Health')).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Home');
  const stops = ['Home', 'Calendar', '#Financials', 'Budget', 'Subscriptions', '#Health', 'Journal', 'Habits', 'Sleep & activity', '#Productivity'];
  for (const name of stops.slice(1)) {
    await page.keyboard.press('ArrowDown');
    const target = name.startsWith('#') ? n.sectionHeader(name.slice(1)) : list.getByRole('link', { name, exact: true });
    await expect(target).toBeFocused();
  }
  await page.keyboard.press('End');
  await expect(n.sectionHeader('Productivity')).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(list.getByRole('link', { name: 'Sleep & activity', exact: true })).toBeFocused();
  await n.closeDrawer();
});


test('Alt+1 and Alt+2 do nothing, with or without the menu open', async ({ page }) => {
  await page.goto('/settings');
  await expect(heading(page, 'Settings')).toBeVisible();
  await page.locator('main').focus();
  for (const key of ['Alt+1', 'Alt+2']) {
    await page.keyboard.press(key);
    await expect(page).toHaveURL(/\/settings$/);
  }
  await nav(page).openDrawer();
  for (const key of ['Alt+1', 'Alt+2']) {
    await page.keyboard.press(key);
    await expect(page).toHaveURL(/\/settings$/);
  }
  await expect(page.locator('[data-nav-drawer]')).toBeVisible();
});

test('the palette has no Switch to command and finds Sleep & activity by "health"', async ({ page }) => {
  await page.goto('/settings');
  await expect(heading(page, 'Settings')).toBeVisible();
  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await expect(palette).toBeVisible();
  const search = palette.getByLabel('Search');
  for (const q of ['Switch to', 'workspace']) {
    await search.fill(q);
    // Only the Ask Javi row may echo the query.
    await expect(palette.getByRole('option', { name: /^Switch to/ })).toHaveCount(0);
  }
  await search.fill('health');
  await palette.getByRole('option', { name: /Go to Sleep & activity/ }).click();
  await expect(page).toHaveURL(/\/health$/);
  await expect(heading(page, 'Sleep & activity')).toBeVisible();
});

test('/weather lands on Home, where the Javi card carries the weather', async ({ page }) => {
  await page.goto('/weather');
  await expect(page).toHaveURL(/\/$/);
  await expect(heading(page, 'Overview')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Javi' })).toBeVisible();
});

test('Home opens from the wordmark and the Home row, Settings from the gear, with no workspace request', async ({ page }) => {
  const workspaceRequests = watchWorkspaceRequests(page);
  const n = nav(page);
  await page.goto('/budget');
  await expect(heading(page, 'Budget')).toBeVisible();
  await n.openSettings();
  await expect(topBar(page).getByRole('link', { name: 'Settings', exact: true })).toHaveAttribute('aria-current', 'page');
  await n.goHome();
  await expect(topBar(page).getByRole('link', { name: 'Burrow, go to Home' })).toHaveAttribute('aria-current', 'page');

  await page.goto('/journal');
  await expect(heading(page, 'Journal')).toBeVisible();
  const list = await n.openDrawer();
  await list.getByRole('link', { name: 'Home', exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(heading(page, 'Overview')).toBeVisible();
  await page.waitForLoadState('networkidle');
  expect(workspaceRequests).toEqual([]);
});
