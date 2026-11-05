// Journal page (src/components/journal/).
import { expect } from '../support/fixtures.js';

export function journal(page) {
  return {
    async open() {
      await page.goto('/journal');
      await expect(page.getByRole('heading', { level: 2, name: 'Journal', exact: true })).toBeVisible();
    },
    async add(body) {
      await page.getByRole('button', { name: /^(Add your first entry|New entry)$/ }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByLabel('Entry', { exact: true }).fill(body);
      await dialog.getByRole('button', { name: 'Add entry' }).click();
      await expect(dialog).toBeHidden();
    },
    item: (text) => page.getByText(text, { exact: true }),
  };
}
