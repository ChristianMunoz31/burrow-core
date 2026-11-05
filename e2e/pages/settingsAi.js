// Settings > AI (src/components/settings/AiSection.jsx, CloudAiBlock.jsx, CloudAiConsentDialog.jsx).
import { expect } from '../support/fixtures.js';

export function settingsAi(page) {
  return {
    async open() {
      await page.goto('/settings#ai');
      await expect(page.getByRole('heading', { name: 'AI', exact: true }).first()).toBeVisible();
    },
    runningChip() {
      return page.getByText('Ollama is running', { exact: true });
    },
    chooseCloud() {
      return page.getByRole('radio', { name: /cloud/i }).check({ force: true });
    },
    providerAddress: () => page.getByLabel('Provider address'),
    cloudModel: () => page.getByLabel('Cloud model'),
    saveProvider: () => page.getByRole('button', { name: 'Save provider' }),
    turnOnCloud: () => page.getByRole('button', { name: 'Turn on cloud AI' }),
    consentDialog: () => page.getByRole('dialog', { name: 'Turn on your own cloud AI' }),
  };
}
