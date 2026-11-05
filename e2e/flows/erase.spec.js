// Settings > Data & storage > Danger zone: erase everything (typed confirmation, final confirm, final export
// first), then Burrow is back at first-run onboarding with no data. Runs in the sandbox server only.
import { test, expect, useBurrow } from '../support/fixtures.js';
import { onboarding } from '../pages/onboarding.js';
import { todos } from '../pages/todos.js';

useBurrow({ seed: true, ollama: 'dead' });

test('erasing all data saves a final export, clears everything and returns to onboarding', async ({ page }) => {
  await todos(page).open();
  expect((await (await page.request.get('/api/todos')).json()).length).toBeGreaterThan(0);

  await page.goto('/settings#data-storage');
  const zone = page.getByRole('region', { name: 'Danger zone' });
  await zone.scrollIntoViewIfNeeded();
  await expect(zone).toContainText('This cannot be undone.');
  await zone.getByRole('button', { name: 'Erase all my data' }).click();

  const dialog = page.getByRole('dialog', { name: 'Erase all my data' });
  const review = dialog.getByRole('button', { name: 'Review and erase' });
  await expect(review).toBeDisabled();
  await dialog.getByLabel(/Type ERASE to confirm/).fill('erase');
  await expect(review).toBeDisabled();
  await dialog.getByLabel(/Type ERASE to confirm/).fill('ERASE');
  await expect(review).toBeEnabled();
  await review.click();

  const confirm = page.getByRole('alertdialog', { name: 'Erase everything now?' });
  await expect(confirm).toContainText('This cannot be undone.');

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.waitForEvent('load'),
    confirm.getByRole('button', { name: 'Erase my data' }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^burrow-export-.*\.zip$/);

  // First-run again: the welcome flow is back and the modules are empty.
  await expect(onboarding(page).dialog).toBeVisible();
  const res = await page.request.get('/api/todos');
  expect(await res.json()).toEqual([]);
  const state = await (await page.request.get('/api/state')).json();
  expect(state.profile).toBeUndefined();
});
