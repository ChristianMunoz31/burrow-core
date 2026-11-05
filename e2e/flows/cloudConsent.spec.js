// Cloud AI stays off until the opt-in and BOTH consent boxes are ticked, and Burrow never makes
// an outbound call while it is configured. The provider address is a placeholder; nothing here
// clicks a test-connection control. If saving a provider triggers a DNS lookup, this fails and
// that is a real finding (do not suppress it).
import { test, expect, useBurrow } from '../support/fixtures.js';
import { settingsAi } from '../pages/settingsAi.js';

const ctx = useBurrow({ seed: true, ollama: 'dead' });

test('cloud AI needs the key, the opt-in and both consent boxes, with zero outbound calls', async ({ page }) => {
  const ai = settingsAi(page);
  await ai.open();
  await ai.chooseCloud();

  // Blocked before anything is configured.
  await expect(ai.turnOnCloud()).toHaveAttribute('aria-disabled', 'true');

  await ai.providerAddress().fill('https://api.example.com/v1');
  await ai.cloudModel().fill('example-model');
  await ai.saveProvider().click();
  await expect(page.getByText('api.example.com', { exact: true })).toBeVisible();

  const keyRow = page.getByRole('list', { name: 'Cloud AI API key' });
  await keyRow.getByRole('button', { name: 'Set Cloud AI key' }).click();
  await keyRow.getByRole('textbox', { name: 'Cloud AI API key' }).fill('sk-test-not-real');
  await keyRow.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(ai.turnOnCloud()).not.toHaveAttribute('aria-disabled', 'true');

  // Still not on: pressing it asks for both statements first.
  await ai.turnOnCloud().click();
  const dialog = ai.consentDialog();
  await expect(dialog).toBeVisible();
  // The confirm button stays focusable (aria-disabled) so an early press explains what is missing.
  const confirm = dialog.getByRole('button', { name: 'Turn on cloud AI' });
  await confirm.click({ force: true });
  await expect(dialog.getByText('Tick both boxes to continue.')).toBeVisible();
  await dialog.getByRole('checkbox').first().check();
  await confirm.click({ force: true });
  await expect(dialog.getByText('Tick both boxes to continue.')).toBeVisible();
  await expect(page.getByText(/Javi is using your cloud AI/)).toHaveCount(0);

  await dialog.getByRole('checkbox').nth(1).check();
  await confirm.click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText(/Javi is using your cloud AI at api\.example\.com/)).toBeVisible();

  expect(ctx.server.outbound(), 'the server tried to reach the network').toEqual([]);
});
