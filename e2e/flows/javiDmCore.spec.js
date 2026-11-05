// Javi's inbox in a core-only build (docs/design/javi-dm-2026-10.md 1.6, 2.1, 2.5, 3): the private module's UI is not
// compiled in, so there is no composer; the Javi card on Home provides an automatic insight, a page change made
// elsewhere is still counted, and a strip row moves focus to Collapse. The briefing and typed questions are covered
// by pro/e2e/flows/javiDmBriefing.spec.js and javiDm.pro.spec.js.
import { test, expect, useBurrow } from '../support/fixtures.js';
import { inboxIds, javi, seedCalendarChange } from '../pages/javi.js';

useBurrow({ seed: true, ollama: 'fake' });

const heading = (page, name) => page.getByRole('heading', { level: 2, name, exact: true }).first();

test('a core-only build counts a page change, shows no composer, and a page row opens Javi there with focus on Collapse', async ({ page }) => {
  // Home: no Javi bar; the Javi card provides its one insight on its own.
  const j = javi(page);
  await page.goto('/');
  await expect(heading(page, 'Overview')).toBeVisible();
  await page.waitForLoadState('networkidle');
  await expect(j.bar).toHaveCount(0);
  const card = page.getByRole('region', { name: 'Javi' });
  await expect(card.locator('p:not(.sr-only)').filter({ hasText: /Two todos are due today/ })).toBeVisible();
  expect(await inboxIds(page)).toEqual([]);

  // A page change made elsewhere is counted.
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
