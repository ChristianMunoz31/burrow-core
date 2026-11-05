import { describe, it, expect } from 'vitest';
import {
  categoryPiesForMonth,
  incomeJoinNames,
  joinNameLabels,
  pieBucketsFromPlan,
  spendRowsExcludingIncome,
} from '../budgetPies';

const M = '2026-06';
const cat = (name, budgeted = 0) => ({ name, budgeted });
const row = (category, spent, month = M) => ({ month, category, budgeted: 0, spent });
const bucket = (id, cats) => ({ id, name: id.toUpperCase(), categories: cats });
const outerNames = (p) => p.outer.map((s) => s.name);
const innerNames = (p) => p.inner.map((s) => s.name);

const buckets = [
  bucket('a', [cat('A1', 50), cat('A2', 30), cat('A3', 20)]),
  bucket('b', [cat('B1', 0), cat('B2', 0)]),
];

describe('categoryPiesForMonth', () => {
  it('under budget: inner filler = remaining on a shared scale', () => {
    const [pie] = categoryPiesForMonth([row('A1', 40), row('A2', 10)], M, buckets);
    expect(pie).toMatchObject({
      id: 'a',
      budgeted: 100,
      spent: 50,
      remaining: 50,
      over: false,
      pctUsed: 50,
    });
    expect(pie.outer.every((s) => !s.isFiller)).toBe(true);
    expect(pie.outer.reduce((s, x) => s + x.value, 0)).toBe(100);
    const filler = pie.inner[pie.inner.length - 1];
    expect(filler).toMatchObject({ isFiller: true, kind: 'remaining', value: 50 });
    // both rings sum to the shared scale
    expect(pie.inner.reduce((s, x) => s + x.value, 0)).toBe(100);
    expect(pie.items.find((i) => i.name === 'A1')).toMatchObject({
      budgeted: 50,
      spent: 40,
      remaining: 10,
      over: false,
      pctUsed: 80,
    });
  });

  it('over budget: outer filler = overage, over flag, pct > 100', () => {
    const [pie] = categoryPiesForMonth([row('A1', 90), row('A2', 60)], M, buckets);
    expect(pie).toMatchObject({ budgeted: 100, spent: 150, remaining: 0, over: true, pctUsed: 150 });
    const filler = pie.outer[pie.outer.length - 1];
    expect(filler).toMatchObject({ isFiller: true, kind: 'over', value: 50 });
    expect(pie.inner.some((s) => s.isFiller)).toBe(false);
    expect(pie.outer.reduce((s, x) => s + x.value, 0)).toBe(150);
    const a1 = pie.items.find((i) => i.name === 'A1');
    expect(a1).toMatchObject({ over: true, pctUsed: 180 });
  });

  it('zero budget with spend: pctUsed null, over, only in the inner ring', () => {
    const b = [bucket('x', [cat('a', 100), cat('free', 0)])];
    const [pie] = categoryPiesForMonth([row('a', 10), row('free', 20)], M, b);
    const free = pie.items.find((i) => i.name === 'free');
    expect(free).toMatchObject({ budgeted: 0, spent: 20, pctUsed: null, over: true });
    expect(outerNames(pie)).not.toContain('free');
    expect(innerNames(pie)).toContain('free');
  });

  it('group with no budget at all has no outer ring, null pctUsed', () => {
    const [, pie] = categoryPiesForMonth([row('B1', 15)], M, buckets);
    expect(pie).toMatchObject({ budgeted: 0, spent: 15, pctUsed: null, over: true });
    expect(pie.outer).toEqual([]);
    expect(pie.inner).toHaveLength(1);
  });

  it('budget with zero spend: inner ring is all filler, pie still present', () => {
    const [pie] = categoryPiesForMonth([], M, buckets);
    expect(pie).toMatchObject({ spent: 0, budgeted: 100, remaining: 100, pctUsed: 0, over: false });
    expect(pie.inner).toEqual([{ name: 'Remaining', value: 100, isFiller: true, kind: 'remaining' }]);
    expect(pie.outer).toHaveLength(3);
  });

  it('group with neither budget nor spend has empty rings', () => {
    const [, pie] = categoryPiesForMonth([], M, buckets);
    expect(pie).toMatchObject({ id: 'b', budgeted: 0, spent: 0, items: [], outer: [], inner: [] });
  });

  it('exactly on budget has no filler and is not over', () => {
    const [pie] = categoryPiesForMonth([row('A1', 50), row('A2', 30), row('A3', 20)], M, buckets);
    expect(pie.over).toBe(false);
    expect(pie.pctUsed).toBe(100);
    expect([...pie.outer, ...pie.inner].some((s) => s.isFiller)).toBe(false);
  });

  describe('Other merging', () => {
    const b = [
      bucket('x', [cat('a', 50), cat('b', 40), cat('c', 30), cat('d', 20), cat('e', 10)]),
    ];

    it('merges the tail on both rings with the same entries and order', () => {
      const rows = [row('a', 5), row('b', 45), row('c', 1), row('d', 25), row('e', 1)];
      const [pie] = categoryPiesForMonth(rows, M, b, { maxSlices: 3, minShare: 0 });
      // ranks by max(budgeted, spent): a50 b45 c30 d25 e10 -> c, d, e merge
      expect(pie.items.map((i) => i.name)).toEqual(['a', 'b', 'Other']);
      const other = pie.items[2];
      expect(other).toMatchObject({ isOther: true, budgeted: 60, spent: 27 });
      const real = (ring) => ring.filter((s) => !s.isFiller).map((s) => s.name);
      expect(real(pie.outer)).toEqual(['a', 'b', 'Other']);
      expect(real(pie.inner)).toEqual(['a', 'b', 'Other']);
    });

    it('merges slices under minShare of the shared scale', () => {
      const bb = [bucket('x', [cat('a', 94), cat('b', 3), cat('c', 3)])];
      const [pie] = categoryPiesForMonth([], M, bb);
      expect(pie.items.map((i) => i.name)).toEqual(['a', 'Other']);
      expect(pie.items[1]).toMatchObject({ budgeted: 6, isOther: true });
    });

    it('keeps a lone small item under its own name', () => {
      const bb = [bucket('x', [cat('a', 98), cat('b', 2)])];
      const [pie] = categoryPiesForMonth([], M, bb);
      expect(pie.items.map((i) => i.name)).toEqual(['a', 'b']);
      expect(pie.items.some((i) => i.isOther)).toBe(false);
    });

    it('does not rename the last item when count equals maxSlices', () => {
      const bb = [bucket('x', [cat('a', 40), cat('b', 35), cat('c', 25)])];
      const [pie] = categoryPiesForMonth([], M, bb, { maxSlices: 3 });
      expect(pie.items.map((i) => i.name)).toEqual(['a', 'b', 'c']);
    });

    it('folds a real subcategory named Other into the merged entry', () => {
      const bb = [bucket('x', [cat('a', 50), cat('Other', 30), cat('c', 1), cat('d', 1)])];
      const [pie] = categoryPiesForMonth([row('Other', 4), row('c', 1)], M, bb);
      expect(pie.items.map((i) => i.name)).toEqual(['a', 'Other']);
      expect(pie.items[1]).toMatchObject({ budgeted: 32, spent: 5, isOther: true });
    });

    it('keeps a real Other as its own unflagged item when not merged', () => {
      const bb = [bucket('x', [cat('a', 60), cat('Other', 40)])];
      const [pie] = categoryPiesForMonth([], M, bb);
      expect(pie.items.map((i) => i.name)).toEqual(['a', 'Other']);
      expect(pie.items[1].isOther).toBeUndefined();
    });

    it('maxSlices 1 merges everything into Other', () => {
      const bb = [bucket('x', [cat('a', 50), cat('b', 30), cat('c', 20)])];
      const [pie] = categoryPiesForMonth([row('a', 10)], M, bb, { maxSlices: 1, minShare: 0 });
      expect(pie.items).toHaveLength(1);
      expect(pie.items[0]).toMatchObject({ name: 'Other', budgeted: 100, spent: 10, isOther: true });
    });
  });

  it('collects unmapped spend into a trailing unbudgeted Unassigned pie', () => {
    const pies = categoryPiesForMonth([row('Mystery', 99), row('A1', 1)], M, buckets);
    expect(pies.map((p) => p.id)).toEqual(['a', 'b', 'unassigned']);
    const un = pies[2];
    expect(un).toMatchObject({ name: 'Unassigned', budgeted: 0, spent: 99, unbudgeted: true });
    expect(un.outer).toEqual([]);
    expect(un.inner).toHaveLength(1);
    expect(un.inner[0]).toMatchObject({ name: 'Mystery', value: 99, isFiller: false });
  });

  it('omits Unassigned when all spend maps', () => {
    const pies = categoryPiesForMonth(
      [row('A1', 1), row('Mystery', 0), row('Zed', 5, '2026-05')],
      M,
      buckets,
    );
    expect(pies.map((p) => p.id)).toEqual(['a', 'b']);
  });

  it('reconciles group spend plus unassigned with total month spend', () => {
    const pies = categoryPiesForMonth([row('A1', 10), row('B2', 20.5), row('X', 3), row('Y', 4)], M, buckets);
    expect(pies.reduce((s, p) => s + p.spent, 0)).toBeCloseTo(37.5);
  });

  it('excludes other months', () => {
    const [pie] = categoryPiesForMonth([row('A1', 10, '2026-05'), row('A2', 20)], M, buckets);
    expect(pie.spent).toBe(20);
    expect(pie.items.find((i) => i.name === 'A1').spent).toBe(0);
  });

  it('ignores negative, zero, NaN and non-finite spend', () => {
    const [, pie] = categoryPiesForMonth(
      [row('B1', -20), row('B2', 0), row('B1', NaN), row('B2', Infinity)],
      M,
      buckets,
    );
    expect(pie.spent).toBe(0);
    expect(pie.inner).toEqual([]);
  });

  it('treats non-finite or negative budgets as 0', () => {
    const b = [bucket('x', [cat('a', NaN), cat('b', -5), cat('c', Infinity), cat('d', 10)])];
    const [pie] = categoryPiesForMonth([], M, b);
    expect(pie.budgeted).toBe(10);
    expect(pie.items.map((i) => i.name)).toEqual(['d']);
  });

  it('matches on name but displays label', () => {
    const b = [bucket('x', [{ name: 'Old Name', label: 'New Name', budgeted: 10 }, cat('plain', 5)])];
    const [pie] = categoryPiesForMonth([row('Old Name', 30), row('New Name', 99)], M, b);
    expect(pie.items.map((i) => i.name)).toEqual(['New Name', 'plain']);
    expect(pie.spent).toBe(30);
  });

  it('handles empty or undefined inputs', () => {
    expect(categoryPiesForMonth([], M, [])).toEqual([]);
    expect(categoryPiesForMonth(undefined, M, undefined)).toEqual([]);
    const pies = categoryPiesForMonth(undefined, M, buckets);
    expect(pies.map((p) => p.spent)).toEqual([0, 0]);
  });

  it('sums duplicate rows and rounds to cents', () => {
    const b = [bucket('x', [cat('A1', 0.005), cat('A2', 0)])];
    const [pie] = categoryPiesForMonth([row('A1', 10.004), row('A1', 10.004), row('A2', 0.333)], M, b);
    expect(pie.items.find((i) => i.name === 'A1').spent).toBe(20.01);
    expect(pie.items.find((i) => i.name === 'A2').spent).toBe(0.33);
    expect(pie.spent).toBe(20.34);
  });
});

const cents = (n) => Math.round(n * 100);
const ringSum = (ring) => ring.reduce((t, x) => t + cents(x.value), 0);

describe('rounding, keys and pct labels', () => {
  it('both rings sum to max(budgeted, spent) with fractional inputs (filler + Other)', () => {
    const b = [
      bucket('x', [cat('a', 10.005), cat('b', 20.333), cat('c', 0.337), cat('d', 0.331), cat('e', 5.1)]),
    ];
    const rows = [row('a', 3.337), row('a', 3.337), row('b', 0.1), row('c', 0.003), row('d', 0.4)];
    for (const rs of [rows, [...rows, row('e', 500.555)]]) {
      const [pie] = categoryPiesForMonth(rs, M, b, { maxSlices: 3, minShare: 0 });
      expect(pie.items.some((i) => i.isOther)).toBe(true);
      const target = Math.max(cents(pie.budgeted), cents(pie.spent));
      expect(ringSum(pie.outer)).toBe(target);
      expect(ringSum(pie.inner)).toBe(target);
      expect(pie.items.reduce((t, i) => t + cents(i.spent), 0)).toBe(cents(pie.spent));
      expect(pie.items.reduce((t, i) => t + cents(i.budgeted), 0)).toBe(cents(pie.budgeted));
    }
  });

  it('gives duplicate labels distinct keys and color indexes', () => {
    const b = [
      bucket('x', [
        { id: 'c1', name: 'n1', label: 'Same', budgeted: 10 },
        { id: 'c2', name: 'n2', label: 'Same', budgeted: 5 },
      ]),
    ];
    const [pie] = categoryPiesForMonth([], M, b);
    expect(pie.items.map((i) => i.key)).toEqual(['c1', 'c2']);
    expect(pie.items.map((i) => i.colorIndex)).toEqual([0, 1]);
    expect(pie.outer.map((s) => s.key)).toEqual(['c1', 'c2']);
  });

  it('keeps pctUsed consistent with the over flag near 100%', () => {
    const b = [bucket('x', [cat('a', 10000), cat('z', 10000)])];
    const [over, under] = [
      categoryPiesForMonth([row('a', 10004)], M, b)[0].items.find((i) => i.name === 'a'),
      categoryPiesForMonth([row('a', 9996)], M, b)[0].items.find((i) => i.name === 'a'),
    ];
    expect(over).toMatchObject({ over: true, pctUsed: 100.1 });
    expect(under).toMatchObject({ over: false, pctUsed: 99.9 });
  });
});

describe('plan join helpers', () => {
  const group = (id, extra = {}) => ({ id, name: id, isIncome: false, sortOrder: 0, ...extra });
  const rcat = (id, name, groupId, extra = {}) => ({
    id,
    name,
    baselineName: name,
    groupId,
    sortOrder: 0,
    pinned: false,
    hidden: false,
    ...extra,
  });
  const planOf = (...cats) => ({ groups: [{ categories: cats }] });

  it('(a) keeps a group buildPlan dropped, with budgeted 0', () => {
    const resolved = {
      groups: [group('g1', { sortOrder: 2 }), group('g2', { sortOrder: 1 }), group('inc', { isIncome: true })],
      categories: [rcat('c1', 'Rent', 'g1'), rcat('c2', 'Gym', 'g2')],
    };
    const buckets = pieBucketsFromPlan(resolved, planOf({ id: 'c1', budgeted: 900 }));
    expect(buckets.map((b) => b.id)).toEqual(['g2', 'g1']);
    expect(buckets[0].categories[0]).toMatchObject({ id: 'c2', budgeted: 0 });
    const pies = categoryPiesForMonth([row('Gym', 30)], M, buckets);
    expect(pies[0]).toMatchObject({ id: 'g2', spent: 30, budgeted: 0 });
  });

  it('(b) joins a renamed config category on its original name, showing the new one', () => {
    const resolved = {
      groups: [group('g1')],
      categories: [rcat('c1', 'Dining Out', 'g1', { baselineName: 'Restaurants' })],
    };
    const buckets = pieBucketsFromPlan(resolved, planOf({ id: 'c1', budgeted: 100 }));
    const [pie] = categoryPiesForMonth([row('Restaurants', 40), row('Dining Out', 7)], M, buckets);
    expect(pie.items).toHaveLength(1);
    expect(pie.items[0]).toMatchObject({ name: 'Dining Out', spent: 40, budgeted: 100 });
  });

  it('(c) joins a custom category on its own name', () => {
    const resolved = { groups: [group('g1')], categories: [rcat('x1', 'Boat', 'g1', { custom: true })] };
    const buckets = pieBucketsFromPlan(resolved, planOf({ id: 'x1', budgeted: 50 }));
    const pies = categoryPiesForMonth([row('Boat', 20)], M, buckets);
    expect(pies.map((p) => p.id)).toEqual(['g1']);
    expect(pies[0].items[0]).toMatchObject({ name: 'Boat', spent: 20 });
  });

  it('(d) a spent override on Income never reaches Unassigned', () => {
    const all = {
      groups: [group('g1'), group('inc', { isIncome: true })],
      categories: [rcat('c1', 'Rent', 'g1'), rcat('i1', 'Income', 'inc', { pinned: true })],
    };
    const rows = spendRowsExcludingIncome([row('Income', 3000), row('Rent', 10)], all);
    const pies = categoryPiesForMonth(rows, M, pieBucketsFromPlan(all, planOf()));
    expect(pies.map((p) => p.id)).toEqual(['g1']);
  });

  it('(e) still excludes a hidden income category', () => {
    const all = {
      groups: [group('g1'), group('inc', { isIncome: true, hidden: true })],
      categories: [rcat('i2', 'Side Gig', 'inc', { hidden: true }), rcat('c1', 'Rent', 'g1')],
    };
    expect(incomeJoinNames(all).has('Side Gig')).toBe(true);
    const rows = spendRowsExcludingIncome([row('Side Gig', 500)], all);
    expect(rows).toEqual([]);
  });

  it('(f) hidden expense spend goes to Unassigned under its renamed label', () => {
    const all = {
      groups: [group('g1')],
      categories: [
        rcat('c1', 'Rent', 'g1'),
        rcat('c9', 'Hobbies', 'g1', { baselineName: 'Misc Fun', hidden: true }),
      ],
    };
    const visible = { groups: all.groups, categories: all.categories.filter((c) => !c.hidden) };
    const rows = spendRowsExcludingIncome([row('Misc Fun', 12)], all);
    const pies = categoryPiesForMonth(rows, M, pieBucketsFromPlan(visible, planOf()), {
      labelByJoinName: joinNameLabels(all),
    });
    const un = pies.find((p) => p.id === 'unassigned');
    expect(un.items.map((i) => i.name)).toEqual(['Hobbies']);
    expect(un.spent).toBe(12);
  });
});
