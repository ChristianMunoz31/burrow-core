// The docked Javi bar and its message window (src/components/javi/). The bar is hidden (display: none) while the
// window is open, so `bar` only resolves while Javi is collapsed. The composer, `ask` and the confirm card are Pro
// only: pro/e2e/pages/javiPro.js.
import { expect } from '../support/fixtures.js';
import { PLAIN_REPLY } from '../../scripts/lib/fakeOllamaServer.js';
import { JAVI_PAGE_PATHS } from '../../server/javi/pages.js';

export function javi(page) {
  const bar = page.getByRole('button', { name: /^Javi, AI helper/ });
  const panel = page.getByRole('dialog', { name: 'Javi' });
  return {
    bar,
    panel,
    /** The visible unread count on the bar (aria-hidden; the bar name carries the number). */
    badge: bar.locator('span').filter({ hasText: /^(\d+|9\+)$/ }),
    /** "Collapse Javi" while the bar is shown (the default); "Close Javi" when the setting hides the bar. */
    closeButton: panel.getByRole('button', { name: 'Collapse Javi' }),
    /** The rows of the "New for you" strip, each a button. */
    stripRows: () => panel.getByRole('list', { name: 'New for you' }).getByRole('button'),
    async open() {
      await bar.click();
      await expect(panel).toBeVisible();
    },
    async close() {
      await panel.getByRole('button', { name: 'Collapse Javi' }).click();
      await expect(panel).toBeHidden();
      await expect(bar).toBeVisible();
    },
    /** A visible message in the panel (the screen-reader live region repeats the text, so skip it). */
    message(text) {
      return panel.locator('p:not(.sr-only)').filter({ hasText: text });
    },
    /** The friendly state when Ollama is not available. */
    needsOllama() {
      return panel.getByText('Javi needs Ollama');
    },
  };
}

/**
 * Resolves with the inbox read POST `{ ids: [] }` that the app sends once page `key` is on screen (the page-change
 * refresh; the body no longer names the page). Start it before the navigation, then await it so the bar reflects
 * that page's inbox answer.
 */
export function waitForActivePage(page, key) {
  return page.waitForResponse(
    (r) =>
      r.url().endsWith('/api/jarvis/inbox/read') &&
      r.ok() &&
      r.request().postDataJSON()?.ids?.length === 0 &&
      new URL(page.url()).pathname === JAVI_PAGE_PATHS[key],
  );
}

/**
 * Marks pages seen through the inbox read route, the same call opening Javi on each page sends, so a test can
 * isolate one count from the current-page notice (a seeded page with data counts until Javi is opened there).
 */
export async function markSeen(page, ...keys) {
  const res = await page.request.post('/api/jarvis/inbox/read', { data: { ids: keys.map((k) => `page:${k}`) } });
  expect(res.ok()).toBe(true);
}

/** Ids of the unread items the server lists (GET, no side effect). */
export async function inboxIds(page) {
  const res = await page.request.get('/api/jarvis/inbox');
  expect(res.ok()).toBe(true);
  return (await res.json()).data.items.map((i) => i.id);
}

const heading = (page, name) => page.getByRole('heading', { level: 2, name, exact: true }).first();

/**
 * Leaves "Calendar changed since your last insight" unread the way a user gets there: an insight on Calendar
 * (fake Ollama), then a calendar event written through the API while Bookmarks is the page on screen. Bookmarks (seeded
 * data) is marked seen first, so its own current-page notice does not add to the count. Ends on Bookmarks, reloaded so
 * the bar shows the new count (1).
 */
export async function seedCalendarChange(page, { summary = 'Synthetic planning call' } = {}) {
  const j = javi(page);
  await page.goto('/calendar');
  await expect(heading(page, 'Calendar')).toBeVisible();
  await j.open();
  await expect(j.message(PLAIN_REPLY)).toBeVisible();
  await j.close();

  await markSeen(page, 'bookmarks');
  let active = waitForActivePage(page, 'bookmarks');
  await page.goto('/bookmarks');
  await active;
  await expect(heading(page, 'Bookmarks')).toBeVisible();
  const start = new Date(Date.now() + 2 * 86_400_000).toISOString();
  const res = await page.request.post('/api/calendar/events', { data: { summary, start } });
  expect(res.ok()).toBe(true);

  active = waitForActivePage(page, 'bookmarks');
  await page.reload();
  await active;
  await expect(heading(page, 'Bookmarks')).toBeVisible();
}
