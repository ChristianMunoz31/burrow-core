// Visual baselines for the main screens, light and dark (the theme follows prefers-color-scheme).
// Seeded demo data at a fixed instant; the server clock is shifted by e2e/support/fixedClock.mjs and
// the browser clock by page.clock.install. Linux only: baselines come from the pinned container.
import { test, expect, useBurrow } from '../support/fixtures.js';
import { FIXED_NOW, settleAndShoot } from '../support/visual.js';
import { nav } from '../pages/nav.js';

useBurrow({ seed: true, ollama: 'fake', fixedNow: FIXED_NOW, preseed: { trialEnded: true } });

const SCREENS = [
  { name: 'home', url: '/', heading: 'Overview' },
  { name: 'budget', url: '/budget', heading: 'Budget' },
  { name: 'todos', url: '/todos', heading: 'Todos' },
  { name: 'journal', url: '/journal', heading: 'Journal' },
  { name: 'calendar', url: '/calendar', heading: 'Calendar' },
  { name: 'settings', url: '/settings', heading: 'Settings' },
  { name: 'settings-ai', url: '/settings#ai', heading: 'Settings', section: '#ai' },
];

for (const theme of ['light', 'dark']) {
  test.describe(theme, () => {
    test.use({ colorScheme: theme });

    for (const screen of SCREENS) {
      test(`${screen.name}`, async ({ page }) => {
        await page.clock.install({ time: new Date(FIXED_NOW) });
        const heading = page.getByRole('heading', { level: 2, name: screen.heading, exact: true }).first();
        await page.goto(screen.url);
        await expect(heading).toBeVisible();
        if (screen.section) await expect(page.getByText('Ollama is running', { exact: true })).toBeVisible();
        if (screen.ready) await expect(screen.ready(page)).toBeVisible();
        await settleAndShoot(page, `${screen.name}-${theme}.png`, {
          target: screen.section ? page.locator(screen.section) : page,
          fullPage: Boolean(screen.fullPage),
        });
      });
    }

    // The open menu over /journal (Journal active) in its default state, fresh storage: Home, Budget and
    // Productivity collapsed, Health expanded, the divider and Calendar. Shot over a page, so it
    // never depends on Home cards.
    test('drawer-open', async ({ page }) => {
      await page.clock.install({ time: new Date(FIXED_NOW) });
      await page.goto('/journal');
      await expect(page.getByRole('heading', { level: 2, name: 'Journal', exact: true }).first()).toBeVisible();
      const n = nav(page);
      const list = await n.openDrawer();
      await expect(n.sectionHeader('Budget')).toHaveAttribute('aria-expanded', 'false');
      await expect(n.sectionHeader('Productivity')).toHaveAttribute('aria-expanded', 'false');
      await expect(n.sectionHeader('Health')).toHaveAttribute('aria-expanded', 'true');
      await expect(n.drawerSection('Health').getByRole('link', { name: 'Journal', exact: true })).toHaveAttribute(
        'aria-current',
        'page',
      );
      await expect(list.getByRole('link', { name: 'Calendar', exact: true })).toBeVisible();
      await settleAndShoot(page, `drawer-open-${theme}.png`);
    });

    // The same menu with all three sections expanded (every row, Journal active).
    test('drawer-open-all', async ({ page }) => {
      await page.clock.install({ time: new Date(FIXED_NOW) });
      await page.goto('/journal');
      await expect(page.getByRole('heading', { level: 2, name: 'Journal', exact: true }).first()).toBeVisible();
      const n = nav(page);
      const list = await n.openDrawer();
      await n.openAllSections();
      // Park the pointer over the dimmed page (no header keeps a hover fill from the clicks) and focus on
      // the active row, as when the menu opens.
      await page.mouse.move(1000, 400);
      await n.drawerSection('Health').getByRole('link', { name: 'Journal', exact: true }).focus();
      await expect(list.getByRole('link', { name: 'Calendar', exact: true })).toBeVisible();
      await settleAndShoot(page, `drawer-open-all-${theme}.png`);
    });
  });
}
