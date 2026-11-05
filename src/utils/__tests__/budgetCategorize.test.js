import { describe, it, expect } from 'vitest';
import { categorizeTransaction, getCategoryDef } from '../budgetConfig';
import { budgetVsActualForMonth } from '../budgetAggregate';
import { buildPlan, plannedExpenseEntries, resolveStructure } from '../budgetPlan';

const debit = (category, merchant = 'Generic Merchant') => ({ type: 'debit', amount: 10, merchant, category });
const nameFor = (category) => getCategoryDef(categorizeTransaction(debit(category)).subcategoryId)?.name;

describe('categorizeTransaction with starter categories', () => {
  it.each([
    'Housing', 'Utilities', 'Subscriptions', 'Groceries', 'Transport', 'Health', 'Dining', 'Shopping', 'Savings', 'Buffer',
  ])('maps a category literally named %s to itself', (name) => {
    expect(nameFor(name)).toBe(name);
    expect(nameFor(`  ${name.toUpperCase()} `)).toBe(name);
  });

  it('maps starter ids and group names', () => {
    expect(nameFor('cat-dining')).toBe('Dining');
    expect(nameFor('Fixed Bills')).toBe('Utilities');
  });

  it.each([
    ['Housing', ['rent', 'mortgage', 'home']],
    ['Dining', ['restaurants', 'coffee', 'fast food', 'bars']],
    ['Transport', ['gas', 'fuel', 'transit', 'parking', 'rideshare', 'auto']],
    ['Health', ['medical', 'pharmacy', 'fitness', 'health insurance']],
    ['Subscriptions', ['streaming', 'software', 'memberships']],
    ['Utilities', ['electric', 'water', 'internet', 'phone']],
    ['Shopping', ['retail', 'clothing', 'electronics']],
    ['Groceries', ['grocery', 'supermarket']],
    ['Savings', ['transfer to savings', 'investment']],
  ])('maps generic aliases to %s', (expected, aliases) => {
    for (const a of aliases) expect(nameFor(a), a).toBe(expected);
  });

  it('matches aliases on word boundaries only', () => {
    expect(nameFor('Crowbars')).toBe('Buffer');
    expect(nameFor('Auto & Transport')).toBe('Transport');
  });

  it('keeps credits as income and unknown categories in Buffer', () => {
    expect(categorizeTransaction({ type: 'credit', amount: 5, category: 'Income' }).bucketId).toBe('income');
    expect(categorizeTransaction({ type: 'credit', amount: 5, category: 'Refund' }).bucketId).toBe('income');
    expect(nameFor('Mystery')).toBe('Buffer');
    expect(nameFor('Income')).toBe('Buffer');
  });
});

describe('budgetVsActualForMonth with planned envelopes', () => {
  const month = '2026-03';
  const resolved = resolveStructure({});
  const housing = resolved.categories.find((c) => c.name === 'Housing');
  const dining = resolved.categories.find((c) => c.name === 'Dining');

  it('feeds onboarding defaults into the Budgeted bars (including budget-only categories)', () => {
    const cats = [{ month, category: 'Dining', budgeted: 0, spent: 40 }];
    const plan = buildPlan(month, {}, cats, resolved, { [housing.id]: 1200, [dining.id]: 150 });
    const rows = budgetVsActualForMonth(cats, month, plannedExpenseEntries(plan, resolved.categories));
    expect(rows).toContainEqual({ name: 'Dining', budgeted: 150, spent: 40 });
    expect(rows).toContainEqual({ name: 'Housing', budgeted: 1200, spent: 0 });
  });

  it('without a plan keeps the baseline amounts', () => {
    const cats = [{ month, category: 'Dining', budgeted: 25, spent: 40 }];
    expect(budgetVsActualForMonth(cats, month)).toEqual([{ name: 'Dining', budgeted: 25, spent: 40 }]);
  });
});
