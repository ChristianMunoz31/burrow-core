// Visual baseline for the first-run welcome dialog (fresh, unseeded data), light and dark.
import { test, expect, useBurrow } from '../support/fixtures.js';
import { FIXED_NOW, settleAndShoot } from '../support/visual.js';

useBurrow({ seed: false, ollama: 'fake' });

for (const theme of ['light', 'dark']) {
  test.describe(theme, () => {
    test.use({ colorScheme: theme });

    test('onboarding', async ({ page }) => {
      await page.clock.install({ time: new Date(FIXED_NOW) });
      await page.goto('/');
      await expect(page.getByRole('dialog', { name: 'Welcome to Burrow' })).toBeVisible();
      await settleAndShoot(page, `onboarding-${theme}.png`);
    });
  });
}
