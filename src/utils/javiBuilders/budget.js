import { clip, round2 } from '../javiContext';
import { formatCurrency } from '../budgetAggregate';

// Keys are plain words: small models echo key names ("the overBudget items") into advice.
// Money fields leave the builder as "$1,234.56" strings so the model copies the symbol;
// all arithmetic and sorting stays on numbers until this final formatting step.
// Every figure a model may quote is computed here: totals, what is left, percentages, and the count
// and total of the over-budget list (so it never has to add up rows or count them). Each figure that
// can be planned or actual says which in its key (income planned, income received, and so on).
const usd = (n) => {
  const v = round2(n);
  return v === null ? null : formatCurrency(v);
};
const pct = (n) => {
  const v = round2(n);
  return v === null ? null : `${v}%`;
};

const groupRows = (plan) =>
  (plan?.groups ?? []).slice(0, 12).map((g) =>
    g.isIncome
      ? // Income is received, not spent, and what is left is still to come.
        { name: clip(g.name, 60), type: 'income', budgeted: usd(g.budgeted), received: usd(g.spent), 'still to come': usd(g.remaining) }
      : { name: clip(g.name, 60), type: 'expense', budgeted: usd(g.budgeted), spent: usd(g.spent), remaining: usd(g.remaining) },
  );

// No rate unless both figures are real numbers and there is income to divide by.
const rate = (net, income) => (Number.isFinite(net) && Number.isFinite(income) && income > 0 ? pct(Math.round((net / income) * 100)) : null);

const totalsOf = (plan) => {
  const t = plan?.totals ?? {};
  return {
    'income planned': usd(t.incomeBudgeted),
    'income received': usd(t.incomeSpent),
    'expenses planned': usd(t.expenseBudgeted),
    'expenses spent': usd(t.expenseSpent),
    'net planned': usd(t.netBudgeted),
    'net actual': usd(t.netActual),
    // Already worked out, negative when over: the model quotes them instead of subtracting.
    'expenses remaining': usd((t.expenseBudgeted ?? 0) - (t.expenseSpent ?? 0)),
    'savings rate planned': rate(t.netBudgeted, t.incomeBudgeted),
    'savings rate actual': rate(t.netActual, t.incomeSpent),
  };
};

/**
 * Javi's current-page notice (Budget and Budget Planner): real transactions (not the sample dashboard) or a saved
 * plan entry (a target or a payee). The pages pass `hasBudget(...) && plan` to usePageContext.
 * @param {string} source @param {object} targets @param {unknown[]} payees
 */
export const hasBudget = (source, targets, payees) =>
  source === 'transactions' || Object.keys(targets).length > 0 || payees.length > 0;

/**
 * The card summary is not sent: its figures mix planned and actual, and every one of them (with its
 * basis in the key) is already in `totals`.
 * @param {{ month?: string, source?: string, plan?: object,
 *   rows?: Array<{name:string,budgeted:number,spent:number}> }} input
 */
export function buildBudgetDashboardContext({ month, source, plan, rows } = {}) {
  const list = (Array.isArray(rows) ? rows : []).map((r) => ({
    category: clip(r?.name, 60),
    budgeted: round2(r?.budgeted) ?? 0,
    spent: round2(r?.spent) ?? 0,
  }));
  const overAll = list
    .map((r) => ({ ...r, over: round2(r.spent - r.budgeted) ?? 0 }))
    .filter((r) => r.budgeted > 0 && r.over > 0)
    .sort((a, b) => b.over - a.over);
  const overBudget = overAll.slice(0, 8).map((r) => ({
    category: r.category,
    budgeted: usd(r.budgeted),
    spent: usd(r.spent),
    over: usd(r.over),
  }));
  const topCategories = [...list]
    .sort((a, b) => b.spent - a.spent)
    .slice(0, 5)
    .map(({ category, spent }) => ({ category, spent: usd(spent) }));
  return {
    view: 'dashboard',
    month: month ?? null,
    source: source ?? 'transactions',
    totals: totalsOf(plan),
    groups: groupRows(plan),
    'categories over budget': overAll.length,
    'total over budget': usd(overAll.reduce((n, r) => n + r.over, 0)),
    'over budget': overBudget,
    'top spending': topCategories,
  };
}

/**
 * @param {{ month?: string, source?: string, plan?: object }} input
 */
export function buildBudgetPlannerContext({ month, source, plan } = {}) {
  const cats = [];
  for (const g of plan?.groups ?? []) {
    if (g.isIncome) continue;
    for (const c of g.categories ?? []) cats.push({ group: g.name, ...c });
  }
  const overspentAll = cats.filter((c) => (round2(c.remaining) ?? 0) < 0).sort((a, b) => a.remaining - b.remaining);
  const overspent = overspentAll
    .slice(0, 8)
    .map((c) => ({
      name: clip(c.name, 60),
      group: clip(c.group, 60),
      budgeted: usd(c.budgeted),
      spent: usd(c.spent),
      remaining: usd(c.remaining),
    }));
  const unbudgetedAll = cats
    .filter((c) => (round2(c.budgeted) ?? 0) === 0 && (round2(c.spent) ?? 0) > 0)
    .sort((a, b) => b.spent - a.spent);
  const unbudgeted = unbudgetedAll
    .slice(0, 5)
    .map((c) => ({ name: clip(c.name, 60), group: clip(c.group, 60), spent: usd(c.spent) }));
  return {
    view: 'planner',
    month: month ?? null,
    source: source ?? 'transactions',
    totals: totalsOf(plan),
    groups: groupRows(plan),
    // The lists are capped, so their full counts and totals are worked out here.
    'categories overspent': overspentAll.length,
    'total overspent': usd(overspentAll.reduce((n, c) => n - (round2(c.remaining) ?? 0), 0)),
    overspent,
    'categories without a budget': unbudgetedAll.length,
    'total spent without a budget': usd(unbudgetedAll.reduce((n, c) => n + (round2(c.spent) ?? 0), 0)),
    'spent without a budget': unbudgeted,
  };
}
