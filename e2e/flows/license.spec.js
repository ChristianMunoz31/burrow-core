// @license Settings > License: a fresh data folder starts the free local 14-day trial by itself. Selectors live
// in pages/settingsLicense.js because the store-licensing rework will change this screen; assertions are on visible words.
import { test, expect, useBurrow } from '../support/fixtures.js';
import { settingsLicense } from '../pages/settingsLicense.js';

useBurrow({ seed: true, ollama: 'dead' });

test('@license a fresh server already has the trial running, with no start button', async ({ page }) => {
  const license = settingsLicense(page);
  await license.open();
  await expect(license.stateHeading()).toContainText(/trial/i);
  await expect(page.getByText(/\b14 days?\b/i).first()).toBeVisible();
  await expect(license.trialBadge()).toBeVisible();
  await expect(license.startTrialButton()).toHaveCount(0);
});

// The welcome banner (TrialNotice) shows only in a build with the Pro UI: pro/e2e/flows/license.pro.spec.js.
