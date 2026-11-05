// Pie-chart data for the Budget page: one two-ring donut per budget bucket
// (main category) comparing BUDGETED (outer ring) vs SPENT (inner ring) by
// subcategory for a month. Pure - buckets and rows are passed in.

const OTHER = 'Other';
const OTHER_KEY = '__other__';
export const UNASSIGNED_ID = 'unassigned';

const toCents = (n) => Math.round(n * 100) / 100;
const cleanAmount = (n) => {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? v : 0;
};

// Per-item derived fields shared by items and slices. Inputs are raw amounts.
function measure(budgeted, spent) {
  const b = toCents(budgeted);
  const s = toCents(spent);
  const over = s > b;
  let pctUsed = b > 0 ? Math.round((s / b) * 1000) / 10 : null;
  // One-decimal rounding must not contradict the over flag: 100.04% stays over
  // (100.1) and 99.96% stays under (99.9).
  if (pctUsed !== null) {
    if (over && pctUsed <= 100) pctUsed = 100.1;
    else if (!over && s < b && pctUsed >= 100) pctUsed = 99.9;
  }
  return { budgeted: b, spent: s, remaining: toCents(Math.max(0, b - s)), over, pctUsed };
}

// Rank by max(budgeted, spent), merge the tail into one "Other" entry that sums
// both amounts. `entries` are { label, budgeted, spent } (raw amounts).
function buildItems(entries, scale, maxSlices, minShare) {
  const rank = (e) => Math.max(e.budgeted, e.spent);
  const sorted = [...entries].sort((a, b) => rank(b) - rank(a));
  const isTail = (e, idx) => idx >= maxSlices - 1 || rank(e) / scale < minShare;
  const tailStart = sorted.findIndex(isTail);
  let final = sorted;
  if (tailStart !== -1 && sorted.length - tailStart >= 2) {
    let head = sorted.slice(0, tailStart);
    const tail = sorted.slice(tailStart);
    let budgeted = toCents(tail.reduce((s, e) => s + e.budgeted, 0));
    let spent = toCents(tail.reduce((s, e) => s + e.spent, 0));
    const existing = head.find((e) => e.label === OTHER);
    if (existing) {
      budgeted = toCents(budgeted + existing.budgeted);
      spent = toCents(spent + existing.spent);
      head = head.filter((e) => e !== existing);
    }
    final = [...head, { key: OTHER_KEY, label: OTHER, budgeted, spent, isOther: true }];
  }
  return final.map((e, colorIndex) => ({
    key: e.key,
    name: e.label,
    colorIndex,
    ...measure(e.budgeted, e.spent),
    ...(e.isOther ? { isOther: true } : {}),
  }));
}

// Both rings share one scale (max of the two totals), so the ring with the
// smaller total gets a trailing filler slice for the gap.
function buildRings(items, totalBudgeted, totalSpent) {
  const outer = items
    .filter((i) => i.budgeted > 0)
    .map((i) => ({ ...i, value: i.budgeted, isFiller: false }));
  const inner = items
    .filter((i) => i.spent > 0)
    .map((i) => ({ ...i, value: i.spent, isFiller: false }));
  const gap = toCents(Math.abs(totalBudgeted - totalSpent));
  if (totalSpent > totalBudgeted && totalBudgeted > 0 && gap > 0) {
    outer.push({ name: 'Over', value: gap, isFiller: true, kind: 'over' });
  } else if (totalBudgeted > totalSpent && gap > 0) {
    inner.push({ name: 'Remaining', value: gap, isFiller: true, kind: 'remaining' });
  }
  return { outer, inner };
}

function buildPie(id, name, entries, { maxSlices, minShare, unbudgeted = false }) {
  // Entries are already in cents; totals come from those rounded values so both
  // rings reconcile exactly.
  const totalB = toCents(entries.reduce((s, e) => s + e.budgeted, 0));
  const totalS = toCents(entries.reduce((s, e) => s + e.spent, 0));
  const scale = Math.max(totalB, totalS);
  const items = scale > 0 ? buildItems(entries, scale, maxSlices, minShare) : [];
  const { outer, inner } = scale > 0 ? buildRings(items, totalB, totalS) : { outer: [], inner: [] };
  return {
    id,
    name,
    ...measure(totalB, totalS),
    ...(unbudgeted ? { unbudgeted: true } : {}),
    items,
    outer,
    inner,
  };
}

/**
 * Compare a month's budget and spend per bucket for two-ring donuts.
 *
 * Spend: only rows for `month` with a finite spent > 0 count (refunds, zero and
 * NaN are dropped). Budget: non-finite or negative `budgeted` is treated as 0.
 * A bucket category matches rows on `cat.name` (the spend-join name) and is
 * displayed as `cat.label ?? cat.name`. Categories with neither budget nor
 * spend are omitted. All amounts are rounded to cents when entries are built and
 * totals are summed from those rounded values, so both rings reconcile.
 *
 * Items are ranked by max(budgeted, spent) desc. Items past index
 * `maxSlices - 1`, or whose max(budgeted, spent) is under `minShare` of the
 * group's shared scale, merge into one trailing "Other" item (`isOther: true`)
 * summing BOTH budgeted and spent, only when that merges 2+ items; a real
 * subcategory named "Other" is folded in. Both rings derive from the same
 * items, so they hold the same entries in the same order. Every item carries a
 * stable `key` (category id when given, else its join name; orphans and Other
 * have their own) and a `colorIndex` so colors/React keys never collide on
 * duplicate labels.
 *
 * Both rings share one scale: max(group budgeted, group spent). The ring with
 * the smaller total gets a trailing filler slice (`isFiller: true`): under
 * budget the inner ring gets `kind: 'remaining'`; over budget the outer ring
 * gets `kind: 'over'` (omitted when the group has no budget at all). Every
 * slice with an amount in a ring carries `value`; an item with zero budget is
 * absent from `outer`, one with zero spend is absent from `inner`.
 *
 * Spend whose category name maps to no bucket goes into a trailing
 * `{ id: 'unassigned', name: 'Unassigned', unbudgeted: true }` pie (only when
 * non-empty): no budget by definition, so `outer` is empty. Orphans are labelled
 * `options.labelByJoinName.get(name) ?? name`.
 *
 * @param {Array<{month: string, category: string, spent: number}>} categoryRows
 * @param {string} month 'YYYY-MM'
 * @param {Array<{id: string, name: string, categories: Array<{id?: string, name: string, label?: string, budgeted?: number}>}>} buckets
 * @param {{maxSlices?: number, minShare?: number, labelByJoinName?: Map<string, string>}} [options]
 * @returns {Array<{
 *   id: string, name: string, budgeted: number, spent: number,
 *   remaining: number, over: boolean, pctUsed: number|null, unbudgeted?: true,
 *   items: Array<{key: string, colorIndex: number, name: string, budgeted: number,
 *     spent: number, remaining: number, over: boolean, pctUsed: number|null, isOther?: true}>,
 *   outer: Array<object>, inner: Array<object>
 * }>} ring slices are items plus `{value, isFiller}`, or fillers
 *   `{name, value, isFiller: true, kind: 'remaining'|'over'}`. Amounts in cents.
 */
export function categoryPiesForMonth(
  categoryRows,
  month,
  buckets,
  { maxSlices = 6, minShare = 0.05, labelByJoinName } = {},
) {
  if (!Array.isArray(buckets) || buckets.length === 0) return [];
  const rows = Array.isArray(categoryRows) ? categoryRows : [];
  const opts = { maxSlices, minShare };

  const spendByName = new Map();
  for (const r of rows) {
    if (!r || r.month !== month) continue;
    const spent = cleanAmount(r.spent);
    if (spent <= 0) continue;
    spendByName.set(r.category, (spendByName.get(r.category) || 0) + spent);
  }

  const mapped = new Set();
  const pies = buckets.map((bucket) => {
    const entries = [];
    for (const cat of bucket.categories || []) {
      mapped.add(cat.name);
      const spent = toCents(spendByName.get(cat.name) || 0);
      const budgeted = toCents(cleanAmount(cat.budgeted));
      if (spent > 0 || budgeted > 0) {
        entries.push({
          key: cat.id ?? `name:${cat.name}`,
          label: cat.label ?? cat.name,
          budgeted,
          spent,
        });
      }
    }
    return buildPie(bucket.id, bucket.name, entries, opts);
  });

  const orphans = [];
  for (const [name, total] of spendByName) {
    if (mapped.has(name)) continue;
    const spent = toCents(total);
    if (spent <= 0) continue;
    orphans.push({
      key: `orphan:${name}`,
      label: labelByJoinName?.get(name) ?? name,
      budgeted: 0,
      spent,
    });
  }
  if (orphans.length > 0) {
    pies.push(buildPie(UNASSIGNED_ID, 'Unassigned', orphans, { ...opts, unbudgeted: true }));
  }
  return pies;
}

/**
 * Pie buckets from the planner's resolved structure plus the built plan.
 * Non-income groups and their categories are sorted by `sortOrder`. A category
 * joins spend on `baselineName ?? name` and shows `name`; its budget comes from
 * the plan by id (0 when buildPlan dropped it).
 *
 * @param {{groups: Array<object>, categories: Array<object>}} resolved
 * @param {{groups?: Array<{categories?: Array<{id: string, budgeted?: number}>}>}} plan
 */
export function pieBucketsFromPlan(resolved, plan) {
  const budgetById = new Map(
    (plan?.groups || []).flatMap((g) =>
      (g.categories || []).map((c) => [c.id, Number(c.budgeted) || 0]),
    ),
  );
  const bySort = (a, b) => (a.sortOrder || 0) - (b.sortOrder || 0);
  return resolved.groups
    .filter((g) => !g.isIncome)
    .slice()
    .sort(bySort)
    .map((g) => ({
      id: g.id,
      name: g.name,
      categories: resolved.categories
        .filter((c) => c.groupId === g.id)
        .slice()
        .sort(bySort)
        .map((c) => ({
          id: c.id,
          name: c.baselineName ?? c.name,
          label: c.name,
          budgeted: budgetById.get(c.id) ?? 0,
        })),
    }));
}

/**
 * Spend-join names that are income (pinned category or one in an income group).
 * Pass the includeHidden resolve so a hidden income group is still income.
 *
 * @param {{groups: Array<object>, categories: Array<object>}} allResolved
 * @returns {Set<string>}
 */
export function incomeJoinNames(allResolved) {
  const incomeGroupIds = new Set(allResolved.groups.filter((g) => g.isIncome).map((g) => g.id));
  return new Set(
    allResolved.categories
      .filter((c) => c.pinned || incomeGroupIds.has(c.groupId))
      .map((c) => c.baselineName ?? c.name),
  );
}

/**
 * Map spend-join name -> the user's current category name, over every category
 * (including hidden). Labels orphan spend in the Unassigned pie.
 *
 * @param {{categories: Array<object>}} allResolved includeHidden resolve
 * @returns {Map<string, string>}
 */
export function joinNameLabels(allResolved) {
  return new Map(allResolved.categories.map((c) => [c.baselineName ?? c.name, c.name]));
}

/**
 * Drop income rows (e.g. a manual spent edit on Income) so they never surface
 * as Unassigned spend.
 *
 * @param {Array<{category: string}>} rows
 * @param {{groups: Array<object>, categories: Array<object>}} allResolved includeHidden resolve
 * @param {Set<string>} [incomeNames] precomputed `incomeJoinNames(allResolved)`
 */
export function spendRowsExcludingIncome(rows, allResolved, incomeNames = incomeJoinNames(allResolved)) {
  return rows.filter((r) => !incomeNames.has(r.category));
}
