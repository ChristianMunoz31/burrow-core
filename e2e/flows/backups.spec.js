// Settings > Data & storage: back up now, change data, restore that backup, the change is gone.
import { test, expect, useBurrow } from '../support/fixtures.js';
import { backups } from '../pages/backups.js';
import { todos } from '../pages/todos.js';

useBurrow({ seed: true, ollama: 'dead' });

test('restoring a backup rolls the data back', async ({ page }) => {
  const b = backups(page);
  await b.open();
  await b.backUpNow();

  await todos(page).open();
  await todos(page).add('Added after the backup');
  await expect(todos(page).item('Added after the backup')).toBeVisible();

  await b.open();
  await b.restoreNewest();

  await todos(page).open();
  await expect(todos(page).item('Added after the backup')).toHaveCount(0);
});
