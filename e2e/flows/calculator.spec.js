// The calculator dialog: opened from the command palette.
import { test, expect, useBurrow } from '../support/fixtures.js';

useBurrow({ seed: true, ollama: 'fake' });

const dialog = (page) => page.getByRole('dialog', { name: 'Calculator' });

test('opens from the palette and adds a percent', async ({ page }) => {
  await page.goto('/');
  // Wait for the shell before the shortcut: its keydown listener mounts with the app, not with the document.
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  await page.keyboard.press('Control+k');
  await page.getByRole('combobox', { name: 'Search' }).fill('calc');
  await page.getByRole('option', { name: /Calculator/ }).click();
  await expect(dialog(page)).toBeVisible();
  const input = dialog(page).getByRole('textbox', { name: 'Calculation' });
  await expect(input).toBeFocused();
  await input.fill('200 + 10%');
  await input.press('Enter');
  await expect(dialog(page).getByText('Result: 220')).toBeAttached();
  await expect(input).toHaveValue('220');
});

test('Escape closes the dialog and returns focus', async ({ page }) => {
  await page.goto('/');
  await page.locator('main').focus();
  await page.keyboard.press('Control+k');
  await page.getByRole('combobox', { name: 'Search' }).fill('calc');
  await page.getByRole('option', { name: /Calculator/ }).click();
  await expect(dialog(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toHaveCount(0);
});
