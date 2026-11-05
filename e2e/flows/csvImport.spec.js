// Budget: import the fictional bank CSV, then see the totals on the page.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, useBurrow } from '../support/fixtures.js';

useBurrow({ seed: false, ollama: 'dead' });

const CSV = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'transactions.csv');
const usd = (n) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);

// Totals computed here from the file itself, never hard-coded.
function totals() {
  const [, ...lines] = fs.readFileSync(CSV, 'utf8').trim().split(/\r?\n/);
  const rows = lines.map((l) => {
    const [date, description, amount] = l.split(',');
    return { date, description, amount: Number(amount) };
  });
  const income = rows.filter((r) => r.amount > 0).reduce((s, r) => s + r.amount, 0);
  const expenses = rows.filter((r) => r.amount < 0).reduce((s, r) => s - r.amount, 0);
  return { rows, income, expenses };
}

test('importing a CSV lists the rows and the dashboard totals match the file', async ({ page }) => {
  const { rows, income, expenses } = totals();
  await page.goto('/budget');
  // Skip the welcome dialog for this flow (covered by onboarding.spec.js).
  const welcome = page.getByRole('dialog', { name: 'Welcome to Burrow' });
  await expect(welcome).toBeVisible();
  await welcome.getByRole('button', { name: 'Skip for now' }).click();
  await expect(welcome).toBeHidden();

  await page.getByRole('button', { name: 'Import transactions' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Import transactions' });
  await dialog.getByLabel('Choose a CSV file').setInputFiles(CSV);

  await expect(dialog.getByRole('heading', { name: 'Match columns' })).toBeVisible();
  await expect(dialog.getByText(`${rows.length} rows found.`)).toBeVisible();
  await dialog.getByRole('button', { name: 'Check my transactions' }).click();

  await expect(dialog.getByRole('heading', { name: 'Check and import' })).toBeVisible();
  for (const r of rows) await expect(dialog.getByRole('cell', { name: r.description })).toBeVisible();
  await dialog.getByRole('button', { name: `Import ${rows.length} transactions` }).click();

  await expect(dialog.getByText(`Imported ${rows.length} transactions.`)).toBeVisible();
  await dialog.getByRole('button').filter({ hasText: /^Close$/ }).click();

  // The dashboard opens on the current month; the fixture rows are all in March 2026.
  await page.getByLabel('Budget month').selectOption({ label: 'March 2026' });

  const card = (title) => page.locator('h3', { hasText: new RegExp(`^${title}$`) }).locator('xpath=following-sibling::p');
  await expect(card('Expenses')).toHaveText(usd(expenses));
  await expect(card('Income')).toHaveText(usd(income));
  await expect(card('Net')).toHaveText(usd(income - expenses));
});
