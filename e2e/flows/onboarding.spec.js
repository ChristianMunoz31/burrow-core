// A brand-new data dir: the welcome flow needs nothing but a display name and asks no start question.
import { test, expect, useBurrow } from '../support/fixtures.js';
import { onboarding } from '../pages/onboarding.js';
import { topBar } from '../pages/nav.js';

useBurrow({ ollama: 'fake' });

test('onboarding completes with only a display name and saves it', async ({ page }) => {
  await page.goto('/');
  // No start choice: the welcome step has no radio group.
  const welcome = page.getByRole('dialog', { name: 'Welcome to Burrow' });
  await expect(welcome).toBeVisible();
  await expect(welcome.getByRole('radio')).toHaveCount(0);
  await onboarding(page).complete('Riley');
  await expect(page.getByText('Everything important at a glance.', { exact: true })).toBeVisible();

  await expect(page.getByRole('heading', { level: 2, name: 'Overview' })).toBeVisible();
  // The calm top bar has no greeting: the name is only in Settings.
  await expect(topBar(page)).toBeVisible();
  await expect(topBar(page)).not.toContainText('Riley');

  // The name is saved: Settings shows it in the display name field.
  await page.goto('/settings#general');
  await expect(page.getByLabel('Display name')).toHaveValue('Riley');

  // Reloading does not bring the welcome flow back.
  await page.reload();
  await expect(page.getByRole('heading', { level: 2, name: 'Settings' })).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Welcome to Burrow' })).toHaveCount(0);
});
