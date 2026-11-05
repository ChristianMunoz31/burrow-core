// Helpers for the Budget module: shape the budget aggregates (derived from
// transactions, or the bundled sample) into chart-ready data.

const currencyFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
});

export function formatCurrency(value) {
  const n = Number(value) || 0;
  return currencyFormatter.format(n === 0 ? 0 : n);
}

const compactFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  notation: 'compact',
  minimumFractionDigits: 0,
  maximumFractionDigits: 1,
});

// Short currency for chart axis ticks, e.g. $1.5K.
export function formatCurrencyCompact(value) {
  const n = Number(value) || 0;
  return compactFormatter.format(n === 0 ? 0 : n);
}

export function formatMonthShort(month) {
  const [y, m] = String(month).split('-').map(Number);
  const d = new Date(y, (m || 1) - 1, 1);
  return d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
}

export function formatMonthLong(month) {
  const [y, m] = String(month).split('-').map(Number);
  const d = new Date(y, (m || 1) - 1, 1);
  return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

// Sort by `valueOf` desc; roll the tail past `limit` into one "Other" row,
// summing the numeric fields in `sumKeys`.
export function topNWithOther(rows, limit, valueOf, sumKeys) {
  const sorted = [...rows].sort((a, b) => valueOf(b) - valueOf(a));
  if (sorted.length <= limit) return sorted;
  const rest = sorted.slice(limit);
  const other = { name: 'Other' };
  for (const key of sumKeys) {
    other[key] = rest.reduce((sum, r) => sum + (Number(r[key]) || 0), 0);
  }
  return [...sorted.slice(0, limit), other];
}

export function listMonths(...datasets) {
  const set = new Set();
  for (const rows of datasets) {
    for (const r of rows) if (r.month) set.add(r.month);
  }
  return [...set].sort();
}

// `planned` (optional) = [{ key, name, budgeted }] from the planner (key = the category's
// original/join name). When given, its budgeted amount replaces the baseline one carried
// on the dashboard rows (month overrides, onboarding defaults) and budget-only categories
// that have no spend row yet are added, so planned envelopes always chart.
export function budgetVsActualForMonth(categories, month, planned) {
  const plannedByKey = new Map((planned || []).map((p) => [p.key, p]));
  const seen = new Set();
  const rows = categories
    .filter((r) => r.month === month)
    .map((r) => {
      const p = plannedByKey.get(r.category);
      seen.add(r.category);
      return p
        ? { name: p.name, budgeted: Number(p.budgeted) || 0, spent: r.spent }
        : { name: r.category, budgeted: r.budgeted, spent: r.spent };
    });
  for (const p of plannedByKey.values()) {
    if (!seen.has(p.key)) rows.push({ name: p.name, budgeted: Number(p.budgeted) || 0, spent: 0 });
  }
  return topNWithOther(
    rows.filter((r) => r.budgeted !== 0 || r.spent !== 0),
    10,
    (r) => Math.max(Math.abs(r.budgeted), Math.abs(r.spent)),
    ['budgeted', 'spent'],
  );
}

export function trendSeries(trend) {
  return [...trend]
    .sort((a, b) => String(a.month).localeCompare(String(b.month)))
    .map((r) => ({
      month: r.month,
      income: Number(r.income) || 0,
      expense: Number(r.expense) || 0,
    }));
}

export function summaryForMonth(summary, month) {
  return summary.find((r) => r.month === month) || null;
}
