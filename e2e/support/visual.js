// Shared helpers for the visual project. Baselines are Linux only and come from the pinned
// Playwright container (see scripts/visualUpdate.js).
import { expect } from './fixtures.js';

// The demo data and both clocks (server preload and browser) agree on this instant.
export const FIXED_NOW = '2026-06-15T12:00:00Z';

// The data cards a Home that was never customized shows after the Javi card (docs/design/nav-sections-2026-10.md
// section 3, docs/design/javi-home-card-2026-10.md).
const HOME_DEFAULT_CARDS = ['Budget', 'Subscriptions', 'Todos', 'Journal', 'Habits', 'Calendar'];

const FREEZE_CSS = `
  *, *::before, *::after {
    transition: none !important;
    animation: none !important;
    scroll-behavior: auto !important;
    caret-color: transparent !important;
  }
`;

/** Text that changes with every build and must never be part of a baseline. */
export const maskedText = (page) => [
  page.getByText(/\b\d+\.\d+\.\d+(?:[-+][\w.]+)?\b/),
  page.getByText(/released|build date|built on/i),
];

/** Model text in the Javi panel (fake Ollama replies): masked so a baseline never depends on it. */
export const javiModelText = (page) => page.locator('[role="dialog"] .prose-jarvis');

/**
 * Takes the baseline screenshot `name` of `target` (a page or a locator) once the page is settled.
 * @param {import('@playwright/test').Page} page
 * @param {string} name file name, for example `home-light.png`
 * @param {{ target?: import('@playwright/test').Page | import('@playwright/test').Locator,
 *   mask?: import('@playwright/test').Locator[], fullPage?: boolean }} [opts] `mask` adds locators to the build-text
 *   masks; `fullPage` shoots the whole scrollable page (a page target only)
 */
export async function settleAndShoot(page, name, { target = page, mask = [], fullPage = false } = {}) {
  // Home: wait for its subtitle, the six default data cards and no busy region, so a baseline never captures a
  // card that is still loading (WidgetCard is aria-busy while its skeleton shows).
  if (new URL(page.url()).pathname === '/') {
    await expect(page.getByText('Everything important at a glance.', { exact: true })).toBeVisible();
    for (const title of HOME_DEFAULT_CARDS) {
      await expect(page.locator('main').getByRole('heading', { name: title, exact: true }).first()).toBeVisible();
    }
    await expect(page.locator('main [aria-busy="true"]')).toHaveCount(0);
  }
  await page.addStyleTag({ content: FREEZE_CSS });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForLoadState('networkidle');
  await expect(target).toHaveScreenshot(name, {
    animations: 'disabled',
    caret: 'hide',
    maxDiffPixelRatio: 0.002,
    ...(fullPage ? { fullPage: true } : {}),
    mask: [...maskedText(page), ...mask],
  });
}
