// First-run welcome dialog (src/components/onboarding/OnboardingFlow.jsx).
import { expect } from '../support/fixtures.js';

export function onboarding(page) {
  const dialog = page.getByRole('dialog', { name: 'Welcome to Burrow' });
  return {
    dialog,
    async expectVisible() {
      await expect(dialog).toBeVisible();
    },
    /** Welcome step: type a name (optional) and continue to the Javi step. */
    async continueWithName(name) {
      if (name) await dialog.getByLabel(/What should Burrow call you/).fill(name);
      await dialog.getByRole('button', { name: 'Continue' }).click();
    },
    /** Javi step: the Ollama setup is optional; skip it (or continue when Ollama is ready). */
    async passJaviStep() {
      const step = page.getByRole('dialog', { name: 'Set up Javi' });
      await expect(step).toBeVisible();
      await step.getByRole('button', { name: /^(Skip for now|Continue)$/ }).click();
    },
    /** Budget step: leave the starter amounts for later. */
    async finishWithoutBudget() {
      const step = page.getByRole('dialog', { name: 'Starter budget' });
      await expect(step).toBeVisible();
      await step.getByRole('button', { name: 'Skip', exact: true }).click();
    },
    /** The whole flow with only a display name. */
    async complete(name) {
      await this.expectVisible();
      await this.continueWithName(name);
      await this.passJaviStep();
      await this.finishWithoutBudget();
      await expect(page.getByRole('dialog')).toHaveCount(0);
    },
  };
}
