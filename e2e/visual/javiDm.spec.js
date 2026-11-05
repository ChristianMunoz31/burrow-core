// Visual baselines for the Javi bar and its message window (docs/design/javi-dm-2026-10.md 7.4,
// docs/design/minimal-shell-2026-10.md 4 and 8.3). Its own file and server, so the calendar write these tests make never
// reaches the main screens baselines. Seeded through the UI and the data routes with the fake Ollama (never the state
// route: `javi.inbox` is route owned); model text is masked.
//   javi-bar-collapsed-badge: Bookmarks, after an insight on Calendar and a calendar event written through the API
//     while Bookmarks is on screen (count 1: Bookmarks itself is marked seen first, so its current-page notice does
//     not add to it): the collapsed bar with its badge.
//   javi-bar-open: Journal (a Calendar row counts on every other page), the window expanded
//     with a fake insight, the Report link, the AI helper tag and one strip row.
//   javi-bar-open-forced: javi-bar-open in light with forced colours.
//   javi-bar-narrow-light: javi-bar-collapsed-badge at phone width (390 x 844), the compact bar.
import { test, expect, useBurrow } from '../support/fixtures.js';
import { FIXED_NOW, javiModelText, settleAndShoot } from '../support/visual.js';
import { PLAIN_REPLY } from '../../scripts/lib/fakeOllamaServer.js';
import { javi, seedCalendarChange, waitForActivePage } from '../pages/javi.js';

useBurrow({ seed: true, ollama: 'fake', fixedNow: FIXED_NOW });

const heading = (page, name) => page.getByRole('heading', { level: 2, name, exact: true }).first();

async function collapsedBadge(page) {
  await seedCalendarChange(page);
  await expect(javi(page).bar).toHaveAccessibleName('Javi, AI helper, 1 new for you');
  await expect(javi(page).badge).toHaveText('1');
}

async function openOnJournal(page) {
  await seedCalendarChange(page);
  const j = javi(page);
  const active = waitForActivePage(page, 'journal');
  await page.goto('/journal');
  await active;
  await expect(heading(page, 'Journal')).toBeVisible();
  await j.open();
  await expect(j.message(PLAIN_REPLY)).toBeVisible();
  await expect(j.panel.getByRole('link', { name: 'Report this Javi reply by email' })).toBeVisible();
  await expect(j.panel.getByText('AI helper', { exact: true })).toBeVisible();
  await expect(j.stripRows()).toHaveText(['Calendar changed since your last insight']);
}

const shoot = async (page, name) => {
  // No hover state from the last click.
  await page.mouse.move(0, 0);
  await settleAndShoot(page, name, { mask: [javiModelText(page)] });
};

for (const theme of ['light', 'dark']) {
  test.describe(theme, () => {
    test.use({ colorScheme: theme });

    test('javi-bar-collapsed-badge', async ({ page }) => {
      await page.clock.install({ time: new Date(FIXED_NOW) });
      await collapsedBadge(page);
      await shoot(page, `javi-bar-collapsed-badge-${theme}.png`);
    });

    test('javi-bar-open', async ({ page }) => {
      await page.clock.install({ time: new Date(FIXED_NOW) });
      await openOnJournal(page);
      await shoot(page, `javi-bar-open-${theme}.png`);
    });
  });
}

test.describe('forced colours', () => {
  test.use({ colorScheme: 'light', forcedColors: 'active' });

  test('javi-bar-open-forced', async ({ page }) => {
    await page.clock.install({ time: new Date(FIXED_NOW) });
    await openOnJournal(page);
    await shoot(page, 'javi-bar-open-forced.png');
  });
});

test.describe('narrow', () => {
  test.use({ colorScheme: 'light', viewport: { width: 390, height: 844 } });

  test('javi-bar-narrow', async ({ page }) => {
    await page.clock.install({ time: new Date(FIXED_NOW) });
    await collapsedBadge(page);
    await shoot(page, 'javi-bar-narrow-light.png');
  });
});
