// Every routed page renders its heading with no console errors (seeded data, fake Ollama), and every page
// a person navigates to is reachable from the shell: Home through the wordmark, Settings through the gear,
// the rest through the one menu (each under its Financials, Health or Productivity dropdown, Calendar a plain row under Home).
import { test, expect, useBurrow } from '../support/fixtures.js';
import { ROUTES } from '../support/routes.js';
import { nav } from '../pages/nav.js';

useBurrow({ seed: true, ollama: 'fake' });

test('every route renders', async ({ page }) => {
  const n = nav(page);
  for (const route of ROUTES) {
    await test.step(route.path, async () => {
      await n.open(route);
    });
  }
});

test('every page is reachable through the wordmark, the gear or the drawer', async ({ page }) => {
  const n = nav(page);
  await page.goto('/');
  for (const route of ROUTES.filter((r) => r.via === 'drawer')) {
    await test.step(route.heading, async () => {
      await n.openDrawer();
      // A section's rows show only while it is expanded; Calendar is a plain row.
      const scope = route.section ? await n.openSection(route.section) : page.getByRole('navigation', { name: 'Main' });
      await scope.getByRole('link', { name: route.heading, exact: true }).click();
      await expect(page).toHaveURL(new RegExp(route.path));
      await n.expectLoaded(route);
    });
  }
  await n.openSettings();
  await n.goHome();
  expect(ROUTES.filter((r) => r.via === 'wordmark').map((r) => r.path)).toEqual(['/']);
  expect(ROUTES.filter((r) => r.via === 'gear').map((r) => r.path)).toEqual(['/settings']);
});
