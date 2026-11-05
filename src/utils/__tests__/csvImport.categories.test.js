import { describe, expect, it, vi } from 'vitest';

// The shipped starter config has no merchant hints, so prove the rule path by stubbing the
// budget classifier (the same function the Budget page uses) with one grocery hint.
vi.mock('../budgetConfig', async (orig) => {
  const actual = await orig();
  const grocery = actual.CATEGORIES.find((c) => c.name === 'Groceries');
  return {
    ...actual,
    categorizeTransaction: (t) =>
      grocery && /grocery/i.test(t.merchant) && t.type !== 'credit'
        ? { bucketId: 'essentials', subcategoryId: grocery.id, confidence: 'hint' }
        : actual.categorizeTransaction(t),
  };
});

import { autoCategory, buildRows, detectFormat, parseCsvTable } from '../csvImport';

describe('autoCategory (rule based)', () => {
  it('credits are Income whatever the merchant says', () => {
    expect(autoCategory({ merchant: 'Corner Grocery', type: 'credit' })).toBe('Income');
    expect(autoCategory({ merchant: 'Employer Payroll', type: 'credit' })).toBe('Income');
  });

  it('a recognized merchant maps to its category name', () => {
    expect(autoCategory({ merchant: 'Corner Grocery', type: 'debit' })).toBe('Groceries');
  });

  it('an unknown merchant falls back to Other', () => {
    expect(autoCategory({ merchant: 'Zzqx Widgets', type: 'debit' })).toBe('Other');
  });
});

describe('buildRows categories', () => {
  const csv =
    'Date,Description,Category,Amount\n2026-05-01,Corner Grocery,Hobby Stuff,-5\n2026-05-02,Corner Grocery,,-6\n2026-05-03,Zzqx Widgets,,-7\n2026-05-04,Employer Payroll,,100\n';
  it('the category column wins; otherwise rules; never the network', () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const t = parseCsvTable(csv);
    const { rows } = buildRows(t, detectFormat(t.headers).mapping, { dateOrder: 'ymd' });
    expect(rows.map((r) => r.category)).toEqual(['Hobby Stuff', 'Groceries', 'Other', 'Income']);
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
