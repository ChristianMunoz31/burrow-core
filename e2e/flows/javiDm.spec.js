// Javi's "new for you" inbox and the DM keyboard rules (docs/design/javi-dm-2026-10.md 1.6, 2.4 to 2.7, R20, and the
// 2026-10-10 update: a page with data counts until Javi is opened there, and an own edit counts again), on
// the docked Javi bar (docs/design/minimal-shell-2026-10.md 4), against the fake Ollama. Tests run in order on one server: each one leaves
// nothing unread that a later one counts on its page.
import { test, expect, useBurrow } from '../support/fixtures.js';
import { PLAIN_REPLY } from '../../scripts/lib/fakeOllamaServer.js';
import { inboxIds, javi, markSeen, seedCalendarChange, waitForActivePage } from '../pages/javi.js';
import { todos } from '../pages/todos.js';

useBurrow({ seed: true, ollama: 'fake' });

const heading = (page, name) => page.getByRole('heading', { level: 2, name, exact: true }).first();

/** The number in the bar name ("..., 3 new for you"), 0 without one. Read it while the bar is shown. */
async function barCount(bar) {
  const name = (await bar.getAttribute('aria-label')) ?? '';
  return Number(/, (\d+) new for you$/.exec(name)?.[1] ?? 0);
}

test('a change made on another page shows count 1, the strip lists exactly that row, and the row opens Javi there', async ({ page }) => {
  await seedCalendarChange(page);
  const j = javi(page);

  // Bookmarks is on screen: the calendar write is counted once, on the bar and in its name.
  await expect(j.bar).toHaveAccessibleName('Javi, AI helper, 1 new for you');
  await expect(j.badge).toHaveText('1');
  expect(await inboxIds(page)).toEqual(['page:calendar']);
  const counted = await barCount(j.bar);

  // count === rows: the strip renders every counted row as a button, and nothing else. The bar gives way to the window.
  await j.open();
  await expect(j.bar).toBeHidden();
  await expect(j.stripRows()).toHaveText(['Calendar changed since your last insight']);
  expect(await j.stripRows().count()).toBe(counted);

  // The row navigates, Javi opens on Calendar and focus lands inside the window, never on the body.
  await j.stripRows().first().click();
  await expect(page).toHaveURL(/\/calendar$/);
  await expect(heading(page, 'Calendar')).toBeVisible();
  await expect(j.panel).toBeVisible();
  await expect(j.panel.getByText('About Calendar', { exact: true })).toBeVisible();
  await expect(j.panel.locator(':focus')).toHaveCount(1);

  // Open on its own page: the item is read, so nothing is counted or listed any more.
  await expect.poll(() => inboxIds(page)).toEqual([]);
  await expect(j.panel.getByRole('list', { name: 'New for you' })).toHaveCount(0);
  await j.close();
  await expect(j.bar).toHaveAccessibleName('Javi, AI helper');
  await expect(j.badge).toHaveCount(0);
});

test('a Calendar row counts on every other page', async ({ page }) => {
  await seedCalendarChange(page);
  const j = javi(page);
  // Bookmarks counts it.
  await expect(j.bar).toHaveAccessibleName('Javi, AI helper, 1 new for you');

  // Budget counts it too, plus its own notice (seeded transactions, never opened in Javi); the strip lists only the
  // Calendar row, since the current page's notice is the insight itself.
  const active = waitForActivePage(page, 'budget');
  await page.goto('/budget');
  await active;
  await expect(j.bar).toHaveAccessibleName('Javi, AI helper, 2 new for you');
  await j.open();
  await expect(j.stripRows()).toHaveText(['Calendar changed since your last insight']);

  // Opening the row reads it, so later tests start with nothing unread.
  await j.stripRows().first().click();
  await expect(page).toHaveURL(/\/calendar$/);
  await expect(j.panel.getByText('About Calendar', { exact: true })).toBeVisible();
  await expect.poll(() => inboxIds(page)).toEqual([]);
  await j.close();
});

test('a page with data counts until Javi is opened there, and adding a todo there counts it again', async ({ page }) => {
  const j = javi(page);
  let active = waitForActivePage(page, 'todos');
  await page.goto('/todos');
  await active;
  await expect(heading(page, 'Todos')).toBeVisible();
  // Seeded todos, never opened in Javi: the current-page notice, on the bar only (the strip lists other pages).
  await expect(j.bar).toHaveAccessibleName('Javi, AI helper, 1 new for you');
  await expect(j.badge).toHaveText('1');
  await j.open();
  await expect(j.message(PLAIN_REPLY)).toBeVisible();
  await expect(j.panel.getByRole('list', { name: 'New for you' })).toHaveCount(0);
  await j.close();
  await expect(j.bar).toHaveAccessibleName('Javi, AI helper');

  // The user's own edit on the page counts (owner decision 2026-10-10, reverses R1).
  await todos(page).add('Synthetic own edit todo');
  await expect(todos(page).item('Synthetic own edit todo')).toBeVisible();
  await expect(j.bar).toHaveAccessibleName('Javi, AI helper, 1 new for you');
  expect(await inboxIds(page)).toEqual(['page:todos']);

  // Opening Javi again reads it (a fresh insight for the changed page), and the count clears.
  await j.open();
  await expect(j.message(PLAIN_REPLY).first()).toBeVisible();
  await expect.poll(() => inboxIds(page)).toEqual([]);
  await j.close();
  await expect(j.bar).toHaveAccessibleName('Javi, AI helper');

  // A write made while another page is on screen is listed there as a row.
  await markSeen(page, 'journal');
  active = waitForActivePage(page, 'journal');
  await page.goto('/journal');
  await active;
  await expect(heading(page, 'Journal')).toBeVisible();
  await expect(j.bar).toHaveAccessibleName('Javi, AI helper');
  const res = await page.request.post('/api/todos', { data: { title: 'Synthetic todo from elsewhere' } });
  expect(res.ok()).toBe(true);
  active = waitForActivePage(page, 'journal');
  await page.reload();
  await active;
  await expect(j.bar).toHaveAccessibleName('Javi, AI helper, 1 new for you');
  await j.open();
  await expect(j.stripRows()).toHaveText(['Todos changed since your last insight']);
  await j.close();
});

test('the bar expands on a click and collapses back with the chevron, focus returning to the bar', async ({ page }) => {
  const j = javi(page);
  await page.goto('/calendar');
  await expect(heading(page, 'Calendar')).toBeVisible();

  await expect(j.bar).toHaveAttribute('aria-expanded', 'false');
  await expect(j.bar).toContainText('Javi');
  await expect(j.bar).toContainText('AI helper');
  await j.bar.click();
  await expect(j.panel).toBeVisible();
  await expect(j.bar).toBeHidden();
  await expect(j.panel.locator(':focus')).toHaveCount(1);

  await j.closeButton.click();
  await expect(j.panel).toBeHidden();
  await expect(j.bar).toBeVisible();
  await expect(j.bar).toBeFocused();
  await expect(j.bar).toHaveAttribute('aria-expanded', 'false');
});

test('Alt+J opens Javi and moves focus into it, Escape collapses it, and Alt+J is ignored in a text field', async ({ page }) => {
  const j = javi(page);
  await page.goto('/calendar');
  // Shell listeners mount with the app: wait for the page before any shortcut.
  await expect(heading(page, 'Calendar')).toBeVisible();

  await page.keyboard.press('Alt+KeyJ');
  await expect(j.panel).toBeVisible();
  await expect(j.panel.locator(':focus')).toHaveCount(1);

  // Open with focus outside the window (the bar is hidden while it is open): Alt+J moves focus in and it stays open.
  await page.getByRole('button', { name: 'Navigation menu' }).focus();
  await page.keyboard.press('Alt+KeyJ');
  await expect(j.panel.locator(':focus')).toHaveCount(1);
  await expect(j.panel).toBeVisible();

  // Open with focus inside the panel: nothing happens (Alt+J does not close).
  await j.closeButton.focus();
  await page.keyboard.press('Alt+KeyJ');
  await expect(j.closeButton).toBeFocused();
  await expect(j.panel).toBeVisible();

  // Escape collapses and focus returns to the bar.
  await page.keyboard.press('Escape');
  await expect(j.panel).toBeHidden();
  await expect(j.bar).toBeFocused();

  // In a text field Alt+J is left to the field.
  const search = page.getByRole('textbox', { name: 'Search events' });
  await search.focus();
  await page.keyboard.press('Alt+KeyJ');
  await expect(search).toBeFocused();
  await expect(j.bar).toHaveAttribute('aria-expanded', 'false');
  await expect(j.panel).toHaveCount(0);

  // The same page outside the field: Alt+J opens.
  await j.bar.focus();
  await page.keyboard.press('Alt+KeyJ');
  await expect(j.panel).toBeVisible();
});

test('Home and Settings have no Javi bar or window: Home has the Javi card, and Alt+J does nothing there', async ({ page }) => {
  const j = javi(page);
  for (const path of ['/', '/settings', '/settings/data']) {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 2 }).first()).toBeVisible();
    await expect(j.bar).toHaveCount(0);
    await page.keyboard.press('Alt+KeyJ');
    await expect(j.panel).toHaveCount(0);
  }
  await page.goto('/');
  await expect(page.getByRole('region', { name: 'Javi' })).toBeVisible();
});
