// The header Back button and its shortcuts stay inside Burrow: they step back through in-app
// history and, with none, fall back to a parent page instead of leaving the app.
import { test, expect, useBurrow } from '../support/fixtures.js';
import { nav } from '../pages/nav.js';

useBurrow({ seed: true, ollama: 'fake' });

const back = (page) => page.getByRole('button', { name: 'Back', exact: true });
const heading = (page, name) => page.getByRole('heading', { level: 2, name, exact: true }).first();

/**
 * Opens the burger menu, expands the link's section and follows the link (a client-side navigation,
 * so it adds history).
 */
async function goVia(page, section, label) {
  const n = nav(page);
  await n.openDrawer();
  const scope = await n.openSection(section);
  await scope.getByRole('link', { name: label, exact: true }).click();
}

test('Back steps through in-app history, Alt+Left and mouse button 4 do the same', async ({ page }) => {
  await page.goto('/');
  await expect(heading(page, 'Overview')).toBeVisible();
  await expect(back(page)).toHaveCount(0);
  // Home shows a dimmed, disabled Back in the same slot: visible, but not a button anyone can reach.
  const placeholder = page.getByTestId('back-placeholder');
  await expect(placeholder).toBeVisible();
  await expect(placeholder).toBeDisabled();
  await expect(placeholder).toHaveAttribute('aria-hidden', 'true');
  const homeBox = await placeholder.boundingBox();

  await goVia(page, 'Productivity', 'Todos');
  // Same size and place as the real button, so nothing shifts.
  const backBox = await back(page).boundingBox();
  expect(backBox).toEqual(homeBox);
  await expect(heading(page, 'Todos')).toBeVisible();
  // Settings opens from the gear in the top bar (a client-side navigation too).
  await nav(page).openSettings();

  await back(page).click();
  await expect(heading(page, 'Todos')).toBeVisible();
  await expect(page).toHaveURL(/\/todos$/);

  await page.keyboard.press('Alt+ArrowLeft');
  await expect(heading(page, 'Overview')).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
  await expect(back(page)).toHaveCount(0);

  // Forward again, then mouse button 4 (XButton1; Playwright has no named button for it, so the event is dispatched).
  await goVia(page, 'Productivity', 'Todos');
  await expect(heading(page, 'Todos')).toBeVisible();
  await page.evaluate(() => {
    window.dispatchEvent(new MouseEvent('mouseup', { button: 3, bubbles: true, cancelable: true }));
  });
  await expect(heading(page, 'Overview')).toBeVisible();
});

test('a deep link with no history falls back to the parent page, never out of the app', async ({ page }) => {
  await page.goto('/settings/data');
  await expect(heading(page, 'Browse your data')).toBeVisible();
  await back(page).click();
  await expect(heading(page, 'Settings')).toBeVisible();
  await expect(page).toHaveURL(/\/settings$/);

  await back(page).click();
  await expect(heading(page, 'Overview')).toBeVisible();
  await expect(page).toHaveURL(/\/$/);

  await page.goto('/settings#updates');
  await expect(heading(page, 'Settings')).toBeVisible();
  await page.keyboard.press('Alt+ArrowLeft');
  await expect(heading(page, 'Overview')).toBeVisible();
});

test('Alt+Left does nothing while a dialog is open', async ({ page }) => {
  await page.goto('/todos');
  await expect(heading(page, 'Todos')).toBeVisible();
  await page.getByRole('button', { name: 'Navigation menu' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Alt+ArrowLeft');
  await expect(page).toHaveURL(/\/todos$/);
});
