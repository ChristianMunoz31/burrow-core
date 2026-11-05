// The Todos-only Work / Home / All filter (app_state `mode`) and the other forms without a Context field.
// Its own file (and so its own server), so the API rate limit of the other flows does not reach it.
import { test, expect, useBurrow } from '../support/fixtures.js';

useBurrow({ seed: true, ollama: 'fake' });

const heading = (page, name) => page.getByRole('heading', { level: 2, name, exact: true }).first();
test('the Todos Work / Home / All filter hides and shows todos and persists across a reload', async ({ page }) => {
  await page.goto('/todos');
  await expect(heading(page, 'Todos')).toBeVisible();

  const filter = page.getByRole('group', { name: 'Show todos' });
  const radio = (label) => filter.getByRole('radio', { name: label, exact: true });
  // Click the visible label text, as a user does. The value comes from useSyncedSetting (React Query),
  // which re-renders one macrotask after the click, so check() (which reads the state right after its
  // click) races it; toBeChecked() retries.
  async function pick(label) {
    await filter.getByText(label, { exact: true }).click();
    await expect(radio(label)).toBeChecked();
  }
  await pick('All');
  await expect(radio('All')).toBeChecked();

  /** Adds a todo through the form with an explicit Context. */
  async function addTodo(title, context) {
    await page.getByRole('button', { name: /^Add todo to / }).first().click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Title').fill(title);
    await dialog.getByLabel('Context').selectOption(context);
    await dialog.getByRole('button', { name: 'Add todo', exact: true }).click();
    await expect(dialog).toBeHidden();
  }
  await addTodo('Filter work todo', 'work');
  await addTodo('Filter home todo', 'home');
  const workTodo = page.getByText('Filter work todo', { exact: true });
  const homeTodo = page.getByText('Filter home todo', { exact: true });
  await expect(workTodo).toBeVisible();
  await expect(homeTodo).toBeVisible();

  const saved = page.waitForResponse(
    (r) => r.url().endsWith('/api/state/mode') && r.request().method() === 'PUT' && r.ok(),
  );
  await pick('Work');
  await saved;
  await expect(workTodo).toBeVisible();
  await expect(homeTodo).toHaveCount(0);

  // It survives a reload (app_state `mode`).
  await page.reload();
  await expect(heading(page, 'Todos')).toBeVisible();
  await expect(radio('Work')).toBeChecked();
  await expect(workTodo).toBeVisible();
  await expect(homeTodo).toHaveCount(0);

  await pick('Home');
  await expect(homeTodo).toBeVisible();
  await expect(workTodo).toHaveCount(0);

  await pick('All');
  await expect(workTodo).toBeVisible();
  await expect(homeTodo).toBeVisible();
});

test('other forms have no Context field (the tag is kept, not edited)', async ({ page }) => {
  await page.goto('/journal');
  await expect(heading(page, 'Journal')).toBeVisible();
  await page.getByRole('button', { name: /^(Add your first entry|New entry)$/ }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('Entry', { exact: true })).toBeVisible();
  await expect(dialog.getByLabel('Context')).toHaveCount(0);
});
