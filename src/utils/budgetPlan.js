// Helpers for the in-app Budget Planner: merge the baseline envelope amounts
// (the hand-curated fallbackBudget per category, via getCategoryBudget) with the
// user's in-app overrides and the actual spend (derived from transactions) into
// grouped, editable rows for a given month.
import budgetConfig from '../data/budgetConfig.json';
import { getCategoryBudget } from './budgetConfig';

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
// Plain year/month arithmetic (no Date) so years under 100 never map to 19xx.
// A "month index" is year * 12 + zero-based month.
const monthIndex = (key) => {
  const [y, m] = key.split('-').map(Number);
  return y * 12 + (m - 1);
};
const keyFromIndex = (idx) => {
  const y = Math.floor(idx / 12);
  return `${String(y).padStart(4, '0')}-${String((idx % 12) + 1).padStart(2, '0')}`;
};
const monthKey = (y, m0) => keyFromIndex(y * 12 + m0);

// How many months past the current one the planner lets the user budget.
const MONTHS_AHEAD = 12;
// How far back the range may reach, guarding a bogus epoch-ish data row.
const MONTHS_BACK_MAX = 120;
// Upper clamp for the end of the range, so a bogus far-future row (e.g. 9999-12)
// cannot balloon the month list.
const MONTHS_AHEAD_MAX = 120;

const currentKey = (now) => monthKey(now.getFullYear(), now.getMonth());

// Months the planner always offers: the current month plus the next 12 (13
// contiguous YYYY-MM strings), computed from `now` at call time. Callers that
// memoize the result keep it until their inputs change (it does not roll over
// on its own in a long-open tab); tests can inject a date.
export function planMonths(now = new Date()) {
  const y = now.getFullYear();
  const m = now.getMonth();
  return Array.from({ length: MONTHS_AHEAD + 1 }, (_, i) => monthKey(y, m + i));
}

// Every month the Budget page can show, as a sorted contiguous YYYY-MM range
// from min(earliest data month, current month) through max(current + 12, latest
// data month). The start is clamped to at most 120 months before the current
// month and the end to at most 120 months after it. No gaps, so each month in
// between is selectable (and has a resolved baseline budget). Malformed entries
// in dataMonths are ignored.
export function budgetMonths(dataMonths, now = new Date()) {
  const curIdx = monthIndex(currentKey(now));
  const valid = (Array.isArray(dataMonths) ? dataMonths : []).filter(
    (m) => typeof m === 'string' && MONTH_RE.test(m),
  );
  const idxs = valid.map(monthIndex);
  const startIdx = Math.max(Math.min(curIdx, ...idxs), curIdx - MONTHS_BACK_MAX);
  const endIdx = Math.min(Math.max(curIdx + MONTHS_AHEAD, ...idxs), curIdx + MONTHS_AHEAD_MAX);
  const out = [];
  for (let i = startIdx; i <= endIdx; i++) out.push(keyFromIndex(i));
  return out;
}

// The month the Budget page should show. Keeps `picked` while it is still in
// `months`; otherwise the current calendar month if it is in the list; otherwise
// the first month or ''. An optional `preferred` month (e.g. the latest month with
// data, from the Settings page) replaces the current month as the default when it
// is in the list.
export function selectMonth(months, picked, now = new Date(), preferred = '') {
  const list = Array.isArray(months) ? months : [];
  if (picked && list.includes(picked)) return picked;
  if (preferred && list.includes(preferred)) return preferred;
  const cur = currentKey(now);
  if (list.includes(cur)) return cur;
  return list[0] || '';
}

// The most recent month that has transaction data and is inside `months`, or ''.
export function latestDataMonth(dataMonths, months) {
  const list = Array.isArray(months) ? months : [];
  const valid = (Array.isArray(dataMonths) ? dataMonths : []).filter(
    (m) => typeof m === 'string' && MONTH_RE.test(m) && list.includes(m),
  );
  return valid.length ? valid.reduce((a, b) => (b > a ? b : a)) : '';
}

export function targetKey(month, categoryId) {
  return `${month}|${categoryId}`;
}

// Spent overrides share the same `month|categoryId` key shape as budget targets.
export const spentKey = targetKey;

// The category that recurring income deposits ("payees") attach to. Resolve from
// the config: the first category in an income group named "Income",
// falling back to the first income-group category.
export const INCOME_CATEGORY_ID = (() => {
  const incomeGroupIds = new Set(
    (budgetConfig.groups || []).filter((g) => g.isIncome).map((g) => g.id),
  );
  const incomeCats = (budgetConfig.categories || []).filter((c) =>
    incomeGroupIds.has(c.groupId),
  );
  const named = incomeCats.find((c) => c.name === 'Income');
  return (named || incomeCats[0])?.id || null;
})();

// Number of milliseconds in a day; used to compare calendar days in UTC so the
// occurrence math is timezone-independent.
const DAY_MS = 86400000;

// Whole-day index (days since epoch, UTC) for a 'YYYY-MM-DD' date string.
function dayIndex(dateStr) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  if (!y || !m || !d) return null;
  return Math.round(Date.UTC(y, m - 1, d) / DAY_MS);
}

// First and last whole-day indices of a 'YYYY-MM' month, plus its year/month.
function monthBounds(month) {
  const [y, m] = String(month).split('-').map(Number);
  if (!y || !m) return null;
  return {
    y,
    m,
    start: Math.round(Date.UTC(y, m - 1, 1) / DAY_MS),
    end: Math.round(Date.UTC(y, m, 0) / DAY_MS), // day 0 of next month = last day
  };
}

// How many times a payee deposits within `month` (a 'YYYY-MM' string).
// payee: { amount, every, unit: 'day'|'week'|'month', anchorDate: 'YYYY-MM-DD' }.
// Occurrences are counted from the anchor forward only (never before it).
export function payeeOccurrencesInMonth(payee, month) {
  if (!payee) return 0;
  const bounds = monthBounds(month);
  if (!bounds) return 0;
  const every = Math.max(1, Math.floor(Number(payee.every) || 1));
  const unit = payee.unit || 'month';

  if (unit === 'month') {
    const [ay, am] = String(payee.anchorDate || '').split('-').map(Number);
    if (!ay || !am) return 0;
    const monthsSinceAnchor = (bounds.y - ay) * 12 + (bounds.m - am);
    return monthsSinceAnchor >= 0 && monthsSinceAnchor % every === 0 ? 1 : 0;
  }

  // 'day' / 'week' → step a fixed number of days from the anchor.
  const anchor = dayIndex(payee.anchorDate);
  if (anchor == null) return 0;
  const step = every * (unit === 'week' ? 7 : 1);
  if (anchor > bounds.end) return 0;
  const firstK = Math.max(0, Math.ceil((bounds.start - anchor) / step));
  const firstDay = anchor + firstK * step;
  if (firstDay > bounds.end) return 0;
  return Math.floor((bounds.end - firstDay) / step) + 1;
}

// Total planned income from all payees for a month: Σ amount × occurrences.
export function payeeIncomeForMonth(payees, month) {
  if (!Array.isArray(payees)) return 0;
  return payees.reduce(
    (sum, p) => sum + (Number(p?.amount) || 0) * payeeOccurrencesInMonth(p, month),
    0,
  );
}

// Returns a new overrides map that surfaces planned income on the income category
// for `month`. A manual entry (the user typed a planned income) always wins;
// otherwise the payee-derived total is injected, even when it's 0, so the income
// row stays visible and typeable in the planner. Injecting 0 is a no-op for the
// card math (incomeBudgeted only overrides actual income when > 0). Fed to the
// unchanged buildPlan.
export function withDerivedIncome(targets, month, payeeIncome) {
  const base = targets || {};
  if (!INCOME_CATEGORY_ID) return base;
  const key = targetKey(month, INCOME_CATEGORY_ID);
  if (Object.prototype.hasOwnProperty.call(base, key)) return base;
  return { ...base, [key]: payeeIncome > 0 ? payeeIncome : 0 };
}

// Returns a new dashboard-categories array with the user's manual "spent" edits
// applied for `month`. buildPlan joins spend by category *name*, so overrides
// (keyed by `month|categoryId`) are mapped to names here; categories without a
// dashboard row get a synthetic one so their override still shows.
// `structureCats` defaults to the static config; pass resolved categories (which
// carry `baselineName`) so spent edits on renamed/added categories map correctly.
export function applySpentOverrides(categories, month, spentOverrides, structureCats) {
  const overrides = spentOverrides || {};
  const keys = Object.keys(overrides).filter((k) => k.startsWith(`${month}|`));
  if (keys.length === 0) return categories || [];

  const cats = structureCats || budgetConfig.categories || [];
  const nameById = new Map(cats.map((c) => [c.id, c.baselineName ?? c.name]));
  const overrideByName = new Map();
  for (const k of keys) {
    const categoryId = k.slice(month.length + 1);
    const name = nameById.get(categoryId);
    if (name) overrideByName.set(name, Number(overrides[k]) || 0);
  }

  const seen = new Set();
  const next = (categories || []).map((r) => {
    if (r.month === month && overrideByName.has(r.category)) {
      seen.add(r.category);
      return { ...r, spent: overrideByName.get(r.category) };
    }
    return r;
  });
  // Append synthetic rows for overridden categories the dashboard doesn't cover.
  for (const [name, spent] of overrideByName) {
    if (!seen.has(name)) next.push({ month, category: name, budgeted: 0, spent });
  }
  return next;
}

// Baseline budgeted amount (dollars) for a category in a month: the hand-curated
// fallbackBudget. 0 for unknown categories or ones with no fallback.
export function baselineAmount(month, categoryId) {
  return Number(getCategoryBudget(categoryId, month)) || 0;
}

// The default planner structure: the static budgetConfig groups/categories.
// Pass a resolved overlay (see resolveStructure) to buildPlan to edit it.
export const DEFAULT_STRUCTURE = {
  groups: budgetConfig.groups || [],
  categories: budgetConfig.categories || [],
};

// Merge the user's `budget:structure` overlay onto the static config into the
// effective { groups, categories } the planner renders. Config items are matched
// by id and never mutated. Each resolved
// category carries `baselineName` (its original config name) so the spend join
// survives renames. The income category is pinned (never hidden) so payee-derived
// income keeps flowing.
export function resolveStructure(overlay, { includeHidden = false } = {}) {
  const ov = overlay || {};
  const g = ov.groups || {};
  const c = ov.categories || {};
  const gRenamed = g.renamed || {};
  const gHidden = new Set(g.hidden || []);
  const gOrder = g.order || {};
  const cRenamed = c.renamed || {};
  const cHidden = new Set(c.hidden || []);
  const cOrder = c.order || {};
  const cMoved = c.moved || {};

  const mapGroup = (grp, custom) => {
    const name = gRenamed[grp.id] || grp.displayName || grp.name;
    return {
      id: grp.id,
      name,
      displayName: name,
      isIncome: !!grp.isIncome,
      sortOrder: gOrder[grp.id] ?? grp.sortOrder ?? 0,
      custom,
      hidden: gHidden.has(grp.id),
    };
  };
  const groups = [
    ...(budgetConfig.groups || []).map((grp) => mapGroup(grp, false)),
    ...(g.added || []).map((grp) => mapGroup(grp, true)),
  ].filter((grp) => includeHidden || !grp.hidden);

  const mapCat = (cat, custom) => {
    const name = cRenamed[cat.id] || cat.name;
    // The income category is pinned, never hideable.
    const hidden = cat.id !== INCOME_CATEGORY_ID && cHidden.has(cat.id);
    return {
      id: cat.id,
      name,
      // Config cats join spend by their ORIGINAL name; added cats by their own.
      baselineName: custom ? name : cat.name,
      groupId: cMoved[cat.id] || cat.groupId,
      sortOrder: cOrder[cat.id] ?? cat.sortOrder ?? 0,
      custom,
      pinned: cat.id === INCOME_CATEGORY_ID,
      hidden,
    };
  };
  const categories = [
    ...(budgetConfig.categories || []).map((cat) => mapCat(cat, false)),
    ...(c.added || []).map((cat) => mapCat(cat, true)),
  ].filter((cat) => includeHidden || !cat.hidden);

  return { groups, categories };
}

// Build grouped planner rows for `month`, merging:
//   - baseline:   hand-curated fallbackBudget envelope amount
//   - default:    user's per-category default (defaults[categoryId]), seeds the
//                 budget every month, overriding the baseline
//   - override:   user's in-app edit (overrides[`month|categoryId`])
//   - spent:      actual spend from the dashboard, joined by category name
//   - structure:  the effective groups/categories (static config by default, or a
//                 resolved overlay from resolveStructure). Only the source of the
//                 lists changes, the budgeted/spent/remaining/total math is the same.
// Precedence for budgeted: month override → user default → baseline → 0.
// Returns { groups: [{ ...group, categories: [...], budgeted, spent, remaining }],
//           totals: { income/expense budgeted/spent, net } }.
export function buildPlan(month, overrides = {}, dashboardCategories = [], structure = DEFAULT_STRUCTURE, defaults = {}) {
  const spentByName = new Map();
  for (const r of dashboardCategories) {
    if (r.month === month) spentByName.set(r.category, Number(r.spent) || 0);
  }

  const groups = (structure.groups || [])
    .slice()
    .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0))
    .map((g) => ({
      id: g.id,
      name: g.displayName || g.name,
      isIncome: !!g.isIncome,
      categories: [],
      budgeted: 0,
      spent: 0,
      remaining: 0,
    }));
  const byId = new Map(groups.map((g) => [g.id, g]));

  const cats = (structure.categories || [])
    .slice()
    .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));

  for (const c of cats) {
    const g = byId.get(c.groupId);
    if (!g) continue;
    const baseline = baselineAmount(month, c.id);
    const key = targetKey(month, c.id);
    const overridden = Object.prototype.hasOwnProperty.call(overrides, key);
    const rawDefault = defaults?.[c.id];
    const hasDefault = rawDefault != null && rawDefault !== '';
    const budgeted = overridden
      ? Number(overrides[key]) || 0
      : hasDefault
        ? Number(rawDefault) || 0
        : baseline;
    const fromDefault = !overridden && hasDefault;
    const spent = spentByName.get(c.baselineName ?? c.name) || 0;
    g.categories.push({
      id: c.id,
      name: c.name,
      custom: !!c.custom,
      baseline,
      budgeted,
      spent,
      remaining: budgeted - spent,
      overridden,
      fromDefault,
    });
    g.budgeted += budgeted;
    g.spent += spent;
  }
  for (const g of groups) g.remaining = g.budgeted - g.spent;

  const totals = {
    incomeBudgeted: 0,
    incomeSpent: 0,
    expenseBudgeted: 0,
    expenseSpent: 0,
  };
  for (const g of groups) {
    if (g.isIncome) {
      totals.incomeBudgeted += g.budgeted;
      totals.incomeSpent += g.spent;
    } else {
      totals.expenseBudgeted += g.budgeted;
      totals.expenseSpent += g.spent;
    }
  }
  totals.netBudgeted = totals.incomeBudgeted - totals.expenseBudgeted;
  totals.netActual = totals.incomeSpent - totals.expenseSpent;

  // Hide groups with nothing planned and nothing spent (keeps the table focused
  // on months/categories that are actually in play). Custom (user-added)
  // categories always show so a freshly-added one is reachable to budget.
  const visibleGroups = groups.filter(
    (g) => g.categories.some((c) => c.budgeted !== 0 || c.spent !== 0 || c.overridden || c.custom || c.fromDefault),
  );

  return { groups: visibleGroups, totals };
}

// Planned envelopes (expense groups only) for the Budget vs. Actual chart, keyed by each
// category's original name so they join the dashboard rows even after a rename.
export function plannedExpenseEntries(plan, resolvedCategories = []) {
  const baselineById = new Map(resolvedCategories.map((c) => [c.id, c.baselineName ?? c.name]));
  const out = [];
  for (const g of plan?.groups || []) {
    if (g.isIncome) continue;
    for (const c of g.categories) {
      out.push({ key: baselineById.get(c.id) ?? c.name, name: c.name, budgeted: c.budgeted });
    }
  }
  return out;
}

// Summary-card values for a month, blending the transaction actuals with the planner.
// A positive plan replaces the actual for income and for expenses (so the cards react live
// as envelopes are edited); otherwise the real figure from transactions is shown. Net and
// savings derive from those. incomePlanned / expensesPlanned say which figures come from the plan, so the
// cards and Javi never pass a planned number off as money already spent.
export function hybridSummary(monthSummary, totals) {
  // Planned income (from typed-in amounts or recurring payees) takes precedence
  // when set; otherwise fall back to the real income from transactions.
  const incomePlanned = (totals?.incomeBudgeted ?? 0) > 0;
  const income = incomePlanned
    ? totals.incomeBudgeted
    : (monthSummary?.income ?? totals?.incomeSpent ?? 0);
  // Same rule for expenses: an unplanned month has expenseBudgeted 0 (not null), so `??`
  // alone would show $0 despite real spend. Only a positive plan replaces actual spend.
  const expensesPlanned = (totals?.expenseBudgeted ?? 0) > 0;
  const expenses = expensesPlanned
    ? totals.expenseBudgeted
    : (monthSummary?.expenses ?? totals?.expenseSpent ?? 0);
  const net = income - expenses;
  const savingsRate = income > 0 ? (net / income) * 100 : 0;
  return { income, expenses, net, savingsRate, incomePlanned, expensesPlanned };
}
