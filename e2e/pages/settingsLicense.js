// Settings > License. The ONLY place that knows this screen's selectors: the store-licensing
// rework will change it, so specs tagged @license go through here and assert on visible words.
import { expect } from '../support/fixtures.js';

export function settingsLicense(page) {
  return {
    async open() {
      await page.goto('/settings#license');
      await expect(page.getByRole('heading', { name: 'License', exact: true }).first()).toBeVisible();
    },
    // The 14-day trial starts by itself, so there is no start button any more: specs assert it stays gone.
    startTrialButton: () => page.getByRole('button', { name: /try pro free/i }),
    stateHeading: () => page.getByTestId('license-state'),
    // Header pill "Pro trial: N days left" (a link to this screen).
    trialBadge: () => page.getByRole('link', { name: /pro trial: \d+ days? left/i }),
    // The one-time banner (role=status) shown after onboarding.
    trialNotice: () => page.getByTestId('trial-notice'),
  };
}
