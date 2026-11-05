// Todos page (src/components/todos/).
import { expect } from '../support/fixtures.js';

export function todos(page) {
  return {
    async open() {
      await page.goto('/todos');
      await expect(page.getByRole('heading', { level: 2, name: 'Todos', exact: true })).toBeVisible();
    },
    /** Adds a todo through the form in the first column. */
    async add(title) {
      await page.getByRole('button', { name: /^Add todo to / }).first().click();
      const dialog = page.getByRole('dialog');
      await dialog.getByLabel('Title').fill(title);
      await dialog.getByRole('button', { name: 'Add todo', exact: true }).click();
      await expect(dialog).toBeHidden();
    },
    item: (title) => page.getByText(title, { exact: true }),
  };
}
