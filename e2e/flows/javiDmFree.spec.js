// Javi's inbox on Free (docs/design/javi-dm-2026-10.md 1.6, 2.1, 2.5, 3): the data folder's trial ended long ago and
// today's briefing exists (e2e/support/preseed.mjs), yet Free gets no briefing row and no briefing in the Javi card
// on Home (which offers Get insight instead); page items still work, and a strip row moves focus to Collapse (Free has no composer).
// javiDmBriefing.spec.js is the Pro control with the same seed.
import { test, expect, useBurrow } from '../support/fixtures.js';
import { PLAIN_REPLY } from '../../scripts/lib/fakeOllamaServer.js';
import { inboxIds, javi, seedCalendarChange } from '../pages/javi.js';

useBurrow({ seed: true, ollama: 'fake', preseed: { trialEnded: true, briefingToday: true } });

const heading = (page, name) => page.getByRole('heading', { level: 2, name, exact: true }).first();

test('Free sees no briefing row and no briefing on Home; a page row opens Javi there with focus on Collapse', async ({ page }) => {
  const license = await (await page.request.get('/api/license')).json();
  expect(license.pro).toBe(false);

  // Home: no Javi bar and no briefing; the Javi card asks for one insight only on a click.
  const j = javi(page);
  await page.goto('/');
  await expect(heading(page, 'Overview')).toBeVisible();
  await page.waitForLoadState('networkidle');
  await expect(page.getByRole('button', { name: "Open today's briefing in Javi" })).toHaveCount(0);
  await expect(j.bar).toHaveCount(0);
  const card = page.getByRole('region', { name: 'Javi' });
  await expect(card.getByText('A synthetic test briefing for the e2e run.')).toHaveCount(0);
  await card.getByRole('button', { name: 'Get insight' }).click();
  await expect(card.locator('p:not(.sr-only)').filter({ hasText: PLAIN_REPLY })).toBeVisible();
  await expect(card.getByRole('button', { name: /briefing/i })).toHaveCount(0);
  expect(await inboxIds(page)).toEqual([]);

  // A page change made elsewhere is still counted on Free, and the briefing is not among the rows.
  await seedCalendarChange(page);
  await expect(j.bar).toHaveAccessibleName('Javi, AI helper, 1 new for you');
  await j.open();
  await expect(j.panel.getByRole('textbox', { name: 'Message Javi' })).toHaveCount(0);
  await expect(j.stripRows()).toHaveText(['Calendar changed since your last insight']);

  await j.stripRows().first().click();
  await expect(page).toHaveURL(/\/calendar$/);
  await expect(heading(page, 'Calendar')).toBeVisible();
  await expect(j.panel.getByText('About Calendar', { exact: true })).toBeVisible();
  await expect(j.closeButton).toBeFocused();
  await expect.poll(() => inboxIds(page)).toEqual([]);
});
