// Settings > Data & storage > Backups (src/components/settings/BackupsControl.jsx).
import { expect } from '../support/fixtures.js';

export function backups(page) {
  const section = page.getByRole('region', { name: 'Backups' });
  return {
    section,
    async open() {
      await page.goto('/settings#data-storage');
      await expect(section).toBeVisible();
      await section.scrollIntoViewIfNeeded();
    },
    async backUpNow() {
      await section.getByRole('button', { name: 'Back up now' }).click();
      await expect(section.getByRole('table', { name: 'Your backups, newest first' })).toBeVisible();
      await expect(section.getByRole('button', { name: /^Restore backup from / }).first()).toBeVisible();
    },
    /** Restores the newest listed backup and waits for the page to reload. */
    async restoreNewest() {
      await section.getByRole('button', { name: /^Restore backup from / }).first().click();
      const confirm = section.getByRole('group', { name: 'Confirm restore' });
      await expect(confirm).toBeVisible();
      await Promise.all([page.waitForEvent('load'), confirm.getByRole('button', { name: 'Restore', exact: true }).click()]);
    },
  };
}
