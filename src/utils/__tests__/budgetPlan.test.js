import { describe, it, expect } from 'vitest';
import {
  buildPlan,
  hybridSummary,
  targetKey,
  baselineAmount,
  planMonths,
  budgetMonths,
  selectMonth,
  INCOME_CATEGORY_ID,
  payeeOccurrencesInMonth,
  payeeIncomeForMonth,
  withDerivedIncome,
  applySpentOverrides,
  resolveStructure,
} from '../budgetPlan';
import { getCategoryBudget, categorizeTransaction } from '../budgetConfig';
import budgetConfig from '../../data/budgetConfig.json';
import budgetOverrides from '../../data/budgetOverrides.json';

// Pick a real month/category from the config so the tests exercise the actual
// baseline data (fallbackBudget, 0 in the starter taxonomy) rather than fixtures.
const MONTH = planMonths()[0];
const incomeGroupIds = new Set(budgetConfig.groups.filter((g) => g.isIncome).map((g) => g.id));
const firstCat = budgetConfig.categories.find((c) => !incomeGroupIds.has(c.groupId));
const firstCatId = firstCat.id;
const firstCatBaseline = budgetOverrides.categoryRules[firstCat.key].fallbackBudget;

describe('planMonths', () => {
  it('is the current month plus the next 12, contiguous, in YYYY-MM form', () => {
    const months = planMonths();
    expect(months).toHaveLength(13);
    expect(months.every((m) => /^\d{4}-(0[1-9]|1[0-2])$/.test(m))).toBe(true);
    expect(new Set(months).size).toBe(13);
    expect([...months].sort()).toEqual(months);
  });

  it('rolls over the year boundary', () => {
    expect(planMonths(new Date(2026, 11, 15))).toEqual([
      '2026-12', '2027-01', '2027-02', '2027-03', '2027-04', '2027-05', '2027-06',
      '2027-07', '2027-08', '2027-09', '2027-10', '2027-11', '2027-12',
    ]);
    const jan = planMonths(new Date(2026, 0, 31));
    expect(jan[0]).toBe('2026-01');
    expect(jan[12]).toBe('2027-01');
  });
});

describe('budgetMonths', () => {
  const NOW = new Date(2026, 9, 1); // Oct 2026 -> through 2027-10

  it('is just the plan range when there is no data', () => {
    expect(budgetMonths([], NOW)).toEqual(planMonths(NOW));
    expect(budgetMonths(undefined, NOW)).toEqual(planMonths(NOW));
  });

  it('extends back to an earliest data month older than now, with no gaps', () => {
    const months = budgetMonths(['2025-11', '2026-02'], NOW);
    expect(months[0]).toBe('2025-11');
    expect(months[months.length - 1]).toBe('2027-10');
    expect(months).toHaveLength(24);
    expect(months).toContain('2026-01'); // gap between data months is filled
    expect([...new Set(months)]).toEqual(months);
    expect([...months].sort()).toEqual(months);
  });

  it('does not shrink the range for data months after the current month', () => {
    const months = budgetMonths(['2026-12'], NOW);
    expect(months).toEqual(planMonths(NOW));
  });

  it('keeps a data month more than 12 months ahead selectable', () => {
    const months = budgetMonths(['2028-03'], NOW);
    expect(months[0]).toBe('2026-10');
    expect(months[months.length - 1]).toBe('2028-03');
    expect(months).toHaveLength(18);
    expect(months).toContain('2027-12'); // gap-free
  });

  it('clamps the start to 120 months before the current month', () => {
    const months = budgetMonths(['1970-01'], NOW);
    expect(months[0]).toBe('2016-10');
    expect(months[months.length - 1]).toBe('2027-10');
    expect(months).toHaveLength(121 + 12);
  });

  it('clamps the end to 120 months after the current month', () => {
    const months = budgetMonths(['9999-12'], NOW);
    expect(months[0]).toBe('2026-10');
    expect(months[months.length - 1]).toBe('2036-10');
    expect(months).toHaveLength(121);
  });

  it('handles years under 100 without mapping to 19xx', () => {
    expect(budgetMonths(['0050-01'], NOW)[0]).toBe('2016-10');
    expect(budgetMonths([], NOW).every((m) => m >= '2026-10')).toBe(true);
  });

  it('ignores malformed entries', () => {
    const months = budgetMonths(['bogus', '2026-13', '', null, 42, '2026-5', '2026-08'], NOW);
    expect(months[0]).toBe('2026-08');
    expect(months).toHaveLength(15);
  });
});

describe('selectMonth', () => {
  const NOW = new Date(2026, 9, 15); // Oct 2026
  const months = budgetMonths(['2026-06', '2026-08'], NOW);

  it('returns the pick when it is in range', () => {
    expect(selectMonth(months, '2027-01', NOW)).toBe('2027-01');
  });

  it('falls back to the current month when the pick is outside the range', () => {
    expect(selectMonth(months, '2020-01', NOW)).toBe('2026-10');
  });

  it('falls back when a pick becomes invalid after the months change', () => {
    const shrunk = budgetMonths([], NOW);
    expect(selectMonth(shrunk, '2026-06', NOW)).toBe('2026-10');
  });

  it('uses the current month when nothing is picked, even when past data months exist', () => {
    expect(selectMonth(months, '', NOW)).toBe('2026-10');
  });

  it('uses the current month when there is no data', () => {
    expect(selectMonth(budgetMonths([], NOW), '', NOW)).toBe('2026-10');
  });

  it('does not let a future data month win over the current month', () => {
    const withFuture = budgetMonths(['2026-06', '2027-02'], NOW);
    expect(selectMonth(withFuture, '', NOW)).toBe('2026-10');
  });

  it('returns the first month, or empty string, when the current month is absent', () => {
    expect(selectMonth(['2025-01', '2025-02'], '', NOW)).toBe('2025-01');
    expect(selectMonth([], '', NOW)).toBe('');
  });
});

describe('budgetOverrides default subcategories', () => {
  const groupByName = new Map(
    budgetConfig.groups.map((g) => [g.displayName || g.name, g]),
  );
  const rules = budgetOverrides.groupRules || {};

  it.each(Object.entries(rules))('%s names real categories in its own group', (groupName, rule) => {
    const group = groupByName.get(groupName);
    expect(group, `group ${groupName}`).toBeTruthy();
    const names = new Set(
      budgetConfig.categories.filter((c) => c.groupId === group.id).map((c) => c.name),
    );
    if (rule.defaultSubcategory != null) {
      expect(names.has(rule.defaultSubcategory), `${groupName} default`).toBe(true);
    }
    if (rule.transferDefaultSubcategory != null) {
      expect(names.has(rule.transferDefaultSubcategory), `${groupName} transfer`).toBe(true);
    }
  });
});

describe('every month has a resolved budget', () => {
  const FAR = '2031-07';
  const nonIncomeGroupIds = new Set(
    budgetConfig.groups.filter((g) => !g.isIncome).map((g) => g.id),
  );
  const nonIncomeCats = budgetConfig.categories.filter((c) => nonIncomeGroupIds.has(c.groupId));

  it('gives every non-Income category a finite fallbackBudget returned for any month', () => {
    for (const c of nonIncomeCats) {
      const rule = budgetOverrides.categoryRules[c.key];
      expect(rule, c.key).toBeTruthy();
      expect(Number.isFinite(rule.fallbackBudget), c.key).toBe(true);
      expect(getCategoryBudget(c.id, '2031-07')).toBe(rule.fallbackBudget);
      expect(getCategoryBudget(c.id, '2019-02')).toBe(rule.fallbackBudget);
    }
  });

  it('has no orphan categoryRules keys', () => {
    const keys = new Set(budgetConfig.categories.map((c) => c.key));
    const orphans = Object.keys(budgetOverrides.categoryRules).filter((k) => !keys.has(k));
    expect(orphans).toEqual([]);
  });

  it('buildPlan for a far-future month budgets every visible category at baseline', () => {
    const { groups } = buildPlan(FAR, {}, []);
    const rows = groups.flatMap((g) => g.categories);
    // Nothing is budgeted in the starter taxonomy, so no group is visible until the user plans.
    expect(rows).toEqual([]);
    expect(groups).toEqual([]);
    for (const c of nonIncomeCats) {
      const base = budgetOverrides.categoryRules[c.key].fallbackBudget;
      const row = rows.find((r) => r.id === c.id);
      if (base > 0) {
        expect(row, c.key).toBeTruthy();
        expect(row.budgeted).toBe(base);
        expect(row.overridden).toBe(false);
      }
    }
  });

  it('lets a month override win for a far-future month', () => {
    const medical = budgetConfig.categories.find((c) => c.key === 'Essentials / Health');
    const { groups } = buildPlan(FAR, { [targetKey(FAR, medical.id)]: 120 }, []);
    const row = groups.flatMap((g) => g.categories).find((c) => c.id === medical.id);
    expect(row.budgeted).toBe(120);
    expect(row.overridden).toBe(true);
  });
});

describe('Savings transfer default', () => {
  it('routes an unknown-merchant transfer to Savings', () => {
    const res = categorizeTransaction({
      type: 'debit',
      category: 'Transfer',
      merchant: 'Some Unknown Merchant',
    });
    const es = budgetConfig.categories.find((c) => c.key === 'Savings / Savings');
    expect(res.subcategoryId).toBe(es.id);
    expect(res.bucketId).toBe('savings');
  });
});

describe('targetKey', () => {
  it('joins month and category id', () => {
    expect(targetKey('2026-06', 'abc')).toBe('2026-06|abc');
  });
});

describe('baselineAmount', () => {
  it('reads the hand-curated fallbackBudget', () => {
    expect(baselineAmount(MONTH, firstCatId)).toBe(firstCatBaseline);
  });

  it('is month-independent and 0 for an unknown category', () => {
    expect(baselineAmount('1999-01', firstCatId)).toBe(firstCatBaseline);
    expect(baselineAmount(MONTH, 'no-such-id')).toBe(0);
  });
});

describe('buildPlan', () => {
  it('seeds budgeted from the baseline when there is no override', () => {
    // The starter taxonomy has no baseline amounts, so supply a default to surface the row.
    const { groups } = buildPlan(MONTH, {}, [], undefined, { [firstCatId]: 0 });
    const row = groups.flatMap((g) => g.categories).find((c) => c.id === firstCatId);
    expect(row).toBeTruthy();
    expect(row.baseline).toBe(firstCatBaseline);
    expect(row.budgeted).toBe(0);
    expect(row.overridden).toBe(false);
  });

  it('applies a user override and marks the row edited', () => {
    const overrides = { [targetKey(MONTH, firstCatId)]: 999 };
    const { groups } = buildPlan(MONTH, overrides, []);
    const row = groups.flatMap((g) => g.categories).find((c) => c.id === firstCatId);
    expect(row.budgeted).toBe(999);
    expect(row.overridden).toBe(true);
    expect(row.remaining).toBe(999); // no spend supplied
  });

  it('joins actual spend by category name and computes remaining', () => {
    const dashboard = [{ month: MONTH, category: firstCat.name, spent: 40 }];
    const overrides = { [targetKey(MONTH, firstCatId)]: 100 };
    const { groups } = buildPlan(MONTH, overrides, dashboard);
    const row = groups.flatMap((g) => g.categories).find((c) => c.id === firstCatId);
    expect(row.spent).toBe(40);
    expect(row.remaining).toBe(60);
  });

  it('computes income/expense/net totals across groups', () => {
    const { totals } = buildPlan(MONTH, {}, []);
    expect(totals.netBudgeted).toBeCloseTo(totals.incomeBudgeted - totals.expenseBudgeted, 5);
    expect(typeof totals.expenseBudgeted).toBe('number');
  });

  it('hides groups with nothing planned, spent, or overridden', () => {
    // A structure whose only category has no baseline, no data and no overrides.
    const empty = {
      groups: [{ id: 'g-empty', name: 'Empty', isIncome: false, sortOrder: 0 }],
      categories: [{ id: 'c-empty', name: 'Nothing', groupId: 'g-empty', sortOrder: 0 }],
    };
    const { groups } = buildPlan(MONTH, {}, [], empty);
    expect(groups.length).toBe(0);
  });
});

describe('hybridSummary', () => {
  it('blends actual income with planned expenses', () => {
    const s = hybridSummary(
      { income: 4000, expenses: 1234 },
      { incomeSpent: 4000, expenseBudgeted: 3000 },
    );
    expect(s.income).toBe(4000); // actual income, not the planned 0
    expect(s.expenses).toBe(3000); // planner's budgeted total
    expect(s.net).toBe(1000);
    expect(s.savingsRate).toBeCloseTo(25, 5);
  });

  it('says which figures are planned and which are actual', () => {
    const flags = (totals) => {
      const { incomePlanned, expensesPlanned } = hybridSummary({ income: 4000, expenses: 1234 }, totals);
      return [incomePlanned, expensesPlanned];
    };
    expect(flags({ incomeBudgeted: 0, expenseBudgeted: 3000 })).toEqual([false, true]);
    expect(flags({ incomeBudgeted: 5000, expenseBudgeted: 3000 })).toEqual([true, true]);
    expect(flags({ incomeBudgeted: 0, expenseBudgeted: 0 })).toEqual([false, false]);
    expect(flags({ incomeBudgeted: 5000, expenseBudgeted: 0 })).toEqual([true, false]);
  });

  it('falls back to the plan actual income when no summary row exists', () => {
    const s = hybridSummary(null, { incomeSpent: 1500, expenseBudgeted: 500 });
    expect(s.income).toBe(1500);
    expect(s.expenses).toBe(500);
    expect(s.net).toBe(1000);
  });

  it('uses actual spend when nothing is planned (expenseBudgeted is 0, not null)', () => {
    const s = hybridSummary(
      { income: 4000, expenses: 1234.5 },
      { incomeBudgeted: 0, incomeSpent: 4000, expenseBudgeted: 0, expenseSpent: 1234.5 },
    );
    expect(s.expenses).toBe(1234.5);
    expect(s.net).toBe(2765.5);
    expect(s.savingsRate).toBeCloseTo(69.1375, 4);
  });

  it('falls back to the plan actual spend when no summary row exists and nothing is planned', () => {
    const s = hybridSummary(null, { incomeSpent: 1000, expenseBudgeted: 0, expenseSpent: 250 });
    expect(s.expenses).toBe(250);
    expect(s.net).toBe(750);
  });

  it('guards savingsRate against zero income', () => {
    const s = hybridSummary(null, { incomeSpent: 0, expenseBudgeted: 800 });
    expect(s.income).toBe(0);
    expect(s.expenses).toBe(800);
    expect(s.net).toBe(-800);
    expect(s.savingsRate).toBe(0); // no divide-by-zero
  });

  it('prefers planned income when incomeBudgeted > 0', () => {
    const s = hybridSummary(
      { income: 4000, expenses: 0 },
      { incomeBudgeted: 5200, incomeSpent: 4000, expenseBudgeted: 3000 },
    );
    expect(s.income).toBe(5200); // planned income wins over actual 4000
    expect(s.expenses).toBe(3000);
    expect(s.net).toBe(2200);
  });
});

// June 2026 (30 days) gives deterministic day-stepping math.
const M = '2026-06';

describe('payeeOccurrencesInMonth', () => {
  it('monthly: 1 when the interval lands on the month, 0 otherwise', () => {
    const base = { amount: 100, unit: 'month', anchorDate: '2026-04-01' };
    expect(payeeOccurrencesInMonth({ ...base, every: 2 }, M)).toBe(1); // 2 months on
    expect(payeeOccurrencesInMonth({ ...base, every: 3 }, M)).toBe(0); // off-cycle
    expect(payeeOccurrencesInMonth({ ...base, every: 1 }, M)).toBe(1);
  });

  it('monthly: 0 when the anchor is after the month', () => {
    expect(
      payeeOccurrencesInMonth({ amount: 100, every: 1, unit: 'month', anchorDate: '2026-07-01' }, M),
    ).toBe(0);
  });

  it('weekly: counts each landing within the month', () => {
    // June 1, 8, 15, 22, 29 → 5
    expect(
      payeeOccurrencesInMonth({ amount: 1, every: 1, unit: 'week', anchorDate: '2026-06-01' }, M),
    ).toBe(5);
    // Biweekly from June 5 → June 5, 19 (next is July 3) → 2
    expect(
      payeeOccurrencesInMonth({ amount: 1, every: 2, unit: 'week', anchorDate: '2026-06-05' }, M),
    ).toBe(2);
  });

  it('daily: counts every day in the month, even when anchored earlier', () => {
    expect(
      payeeOccurrencesInMonth({ amount: 1, every: 1, unit: 'day', anchorDate: '2026-05-20' }, M),
    ).toBe(30);
  });

  it('returns 0 for a missing or invalid anchor', () => {
    expect(payeeOccurrencesInMonth({ amount: 1, every: 1, unit: 'week' }, M)).toBe(0);
    expect(payeeOccurrencesInMonth(null, M)).toBe(0);
  });
});

describe('payeeIncomeForMonth', () => {
  it('sums amount × occurrences across payees', () => {
    const payees = [
      { id: 'a', amount: 2000, every: 2, unit: 'week', anchorDate: '2026-06-05' }, // 2 × 2000
      { id: 'b', amount: 500, every: 1, unit: 'month', anchorDate: '2026-06-01' }, // 1 × 500
    ];
    expect(payeeIncomeForMonth(payees, M)).toBe(4500);
  });

  it('returns 0 for a non-array', () => {
    expect(payeeIncomeForMonth(undefined, M)).toBe(0);
  });
});

describe('withDerivedIncome', () => {
  const incomeKey = targetKey(M, INCOME_CATEGORY_ID);

  it('injects payee income onto the income category when unset', () => {
    const out = withDerivedIncome({}, M, 3200);
    expect(out[incomeKey]).toBe(3200);
  });

  it('injects 0 (keeps the income row visible) when there is no payee income', () => {
    const out = withDerivedIncome({}, M, 0);
    expect(out[incomeKey]).toBe(0);
  });

  it('leaves a manual income entry untouched (manual wins)', () => {
    const manual = { [incomeKey]: 9999 };
    const out = withDerivedIncome(manual, M, 3200);
    expect(out[incomeKey]).toBe(9999);
    expect(out).toBe(manual); // unchanged reference - no needless clone
  });
});

describe('applySpentOverrides', () => {
  const firstCatId2 = firstCatId;
  const catName = firstCat.name;
  const month = MONTH;

  it('returns the input untouched when there are no overrides for the month', () => {
    const cats = [{ month, category: catName, spent: 40 }];
    expect(applySpentOverrides(cats, month, {})).toBe(cats);
  });

  it('replaces spent on a matching dashboard row', () => {
    const cats = [{ month, category: catName, spent: 40, budgeted: 0 }];
    const out = applySpentOverrides(cats, month, { [targetKey(month, firstCatId2)]: 100 });
    expect(out.find((r) => r.category === catName).spent).toBe(100);
  });

  it('appends a synthetic row for an overridden category absent from the dashboard', () => {
    const out = applySpentOverrides([], month, { [targetKey(month, firstCatId2)]: 75 });
    const row = out.find((r) => r.category === catName);
    expect(row).toMatchObject({ month, category: catName, budgeted: 0, spent: 75 });
  });

  it('flows an overridden spent through buildPlan remaining', () => {
    const overrides = { [targetKey(month, firstCatId2)]: 50 };
    const cats = applySpentOverrides([], month, overrides);
    const { groups } = buildPlan(month, { [targetKey(month, firstCatId2)]: 200 }, cats);
    const row = groups.flatMap((g) => g.categories).find((c) => c.id === firstCatId2);
    expect(row.spent).toBe(50);
    expect(row.remaining).toBe(150);
  });
});

describe('resolveStructure', () => {
  const configCat = budgetConfig.categories.find((c) => c.id !== INCOME_CATEGORY_ID);

  it('returns the default structure unchanged for an empty overlay', () => {
    const { groups, categories } = resolveStructure({});
    expect(groups.length).toBe(budgetConfig.groups.length);
    expect(categories.length).toBe(budgetConfig.categories.length);
    const c = categories.find((x) => x.id === configCat.id);
    expect(c.name).toBe(configCat.name);
    expect(c.baselineName).toBe(configCat.name);
  });

  it('renames for display but preserves baselineName for the spend join', () => {
    const { categories } = resolveStructure({ categories: { renamed: { [configCat.id]: 'Renamed X' } } });
    const c = categories.find((x) => x.id === configCat.id);
    expect(c.name).toBe('Renamed X');
    expect(c.baselineName).toBe(configCat.name);
  });

  it('hides a category (dropped unless includeHidden) but never the pinned income category', () => {
    const overlay = { categories: { hidden: [configCat.id, INCOME_CATEGORY_ID] } };
    const visible = resolveStructure(overlay);
    expect(visible.categories.find((x) => x.id === configCat.id)).toBeUndefined();
    expect(visible.categories.find((x) => x.id === INCOME_CATEGORY_ID)).toBeTruthy(); // pinned
    const all = resolveStructure(overlay, { includeHidden: true });
    expect(all.categories.find((x) => x.id === configCat.id).hidden).toBe(true);
  });

  it('moves a category to another group and applies custom order', () => {
    const otherGroup = budgetConfig.groups.find((g) => g.id !== configCat.groupId);
    const { categories } = resolveStructure({
      categories: { moved: { [configCat.id]: otherGroup.id }, order: { [configCat.id]: 1 } },
    });
    const c = categories.find((x) => x.id === configCat.id);
    expect(c.groupId).toBe(otherGroup.id);
    expect(c.sortOrder).toBe(1);
  });

  it('appends custom groups and categories flagged custom', () => {
    const overlay = {
      groups: { added: [{ id: 'g-new', name: 'Goals', isIncome: false, sortOrder: 99999 }] },
      categories: { added: [{ id: 'c-new', name: 'Vacation', groupId: 'g-new', sortOrder: 0 }] },
    };
    const { groups, categories } = resolveStructure(overlay);
    expect(groups.find((x) => x.id === 'g-new')).toMatchObject({ name: 'Goals', custom: true });
    expect(categories.find((x) => x.id === 'c-new')).toMatchObject({
      name: 'Vacation', groupId: 'g-new', custom: true, baselineName: 'Vacation',
    });
  });
});

describe('buildPlan with a custom structure', () => {
  const configCat = budgetConfig.categories.find((c) => c.id !== INCOME_CATEGORY_ID);

  it('budgets and totals an added custom category', () => {
    const structure = resolveStructure({
      groups: { added: [{ id: 'g-goals', name: 'Goals', isIncome: false, sortOrder: 99999 }] },
      categories: { added: [{ id: 'c-vac', name: 'Vacation', groupId: 'g-goals', sortOrder: 0 }] },
    });
    const base = buildPlan(MONTH, {}, [], resolveStructure({})).totals;
    const { groups, totals } = buildPlan(MONTH, { [targetKey(MONTH, 'c-vac')]: 300 }, [], structure);
    const row = groups.flatMap((g) => g.categories).find((c) => c.id === 'c-vac');
    expect(row.budgeted).toBe(300);
    expect(row.custom).toBe(true);
    // The custom $300 adds to the expense total (asserting the delta is robust to
    // whatever the baseline already budgets).
    expect(totals.expenseBudgeted - base.expenseBudgeted).toBeCloseTo(300, 2);
  });

  it('joins spend for a renamed config category via baselineName', () => {
    const structure = resolveStructure({ categories: { renamed: { [configCat.id]: 'Renamed Y' } } });
    const dashboard = [{ month: MONTH, category: configCat.name, spent: 42 }]; // keyed by ORIGINAL name
    const { groups } = buildPlan(MONTH, { [targetKey(MONTH, configCat.id)]: 100 }, dashboard, structure);
    const row = groups.flatMap((g) => g.categories).find((c) => c.id === configCat.id);
    expect(row.name).toBe('Renamed Y');
    expect(row.spent).toBe(42);
    expect(row.remaining).toBe(58);
  });

  it('excludes a hidden category from the plan', () => {
    const structure = resolveStructure({ categories: { hidden: [configCat.id] } });
    const { groups } = buildPlan(MONTH, { [targetKey(MONTH, configCat.id)]: 500 }, [], structure);
    expect(groups.flatMap((g) => g.categories).find((c) => c.id === configCat.id)).toBeUndefined();
  });
});

describe('buildPlan with subcategory defaults', () => {
  it('seeds budgeted from a default over the baseline when there is no override', () => {
    const { groups } = buildPlan(MONTH, {}, [], resolveStructure({}), { [firstCatId]: 250 });
    const row = groups.flatMap((g) => g.categories).find((c) => c.id === firstCatId);
    expect(row).toBeTruthy();
    expect(row.budgeted).toBe(250);
    expect(row.fromDefault).toBe(true);
    expect(row.overridden).toBe(false);
  });

  it('lets a month override beat the default', () => {
    const overrides = { [targetKey(MONTH, firstCatId)]: 999 };
    const { groups } = buildPlan(MONTH, overrides, [], resolveStructure({}), { [firstCatId]: 250 });
    const row = groups.flatMap((g) => g.categories).find((c) => c.id === firstCatId);
    expect(row.budgeted).toBe(999);
    expect(row.overridden).toBe(true);
    expect(row.fromDefault).toBe(false);
  });

  it('applies a default where there is no baseline (custom category)', () => {
    const structure = resolveStructure({
      groups: { added: [{ id: 'g-goals', name: 'Goals', isIncome: false, sortOrder: 99999 }] },
      categories: { added: [{ id: 'c-vac', name: 'Vacation', groupId: 'g-goals', sortOrder: 0 }] },
    });
    const { groups } = buildPlan(MONTH, {}, [], structure, { 'c-vac': 300 });
    const row = groups.flatMap((g) => g.categories).find((c) => c.id === 'c-vac');
    expect(row.budgeted).toBe(300);
    expect(row.fromDefault).toBe(true);
  });

  it('respects a default of 0 and keeps the row visible', () => {
    const structure = resolveStructure({
      groups: { added: [{ id: 'g-goals', name: 'Goals', isIncome: false, sortOrder: 99999 }] },
      categories: { added: [{ id: 'c-vac', name: 'Vacation', groupId: 'g-goals', sortOrder: 0 }] },
    });
    const { groups } = buildPlan(MONTH, {}, [], structure, { 'c-vac': 0 });
    const row = groups.flatMap((g) => g.categories).find((c) => c.id === 'c-vac');
    expect(row).toBeTruthy();
    expect(row.budgeted).toBe(0);
    expect(row.fromDefault).toBe(true);
  });
});
