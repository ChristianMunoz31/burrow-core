// Generic, modest sample aggregates so the Budget module renders before any
// transactions are imported (useBudgetData labels this source 'sample'). Same shape
// buildBudgetDashboard() produces. Category names come from the starter taxonomy in
// budgetConfig.json (so the per-group pies and the planner join on them), and each
// month's summary is derived from its rows so budgeted/spent always agree.
// All figures are illustrative round numbers, not real data.
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

const row = (month, category, budgeted, spent) => ({ month, category, budgeted, spent });

const MONTHLY_ROWS = [
  ['Housing', 1000, 1000],
  ['Groceries', 400, 380],
  ['Transport', 150, 140],
  ['Utilities', 150, 160],
  ['Subscriptions', 50, 50],
  ['Dining', 150, 170],
  ['Shopping', 100, 90],
];

const SAMPLE_MONTHS = ['2026-01', '2026-02', '2026-03'];

export const SAMPLE_CATEGORIES = SAMPLE_MONTHS.flatMap((month) =>
  MONTHLY_ROWS.map(([category, budgeted, spent]) => row(month, category, budgeted, spent)),
);

const SAMPLE_INCOME = Object.fromEntries(SAMPLE_MONTHS.map((m) => [m, 3000]));

export const SAMPLE_SUMMARY = Object.entries(SAMPLE_INCOME).map(([month, income]) => {
  const rows = SAMPLE_CATEGORIES.filter((r) => r.month === month);
  const budgeted = round2(rows.reduce((s, r) => s + r.budgeted, 0));
  const spent = round2(rows.reduce((s, r) => s + r.spent, 0));
  const net = round2(income - spent);
  return {
    month,
    income,
    expenses: spent,
    net,
    budgeted,
    spent,
    savingsRate: Math.round((net / income) * 100),
  };
});

export const SAMPLE_TREND = SAMPLE_SUMMARY.map((s) => ({
  month: s.month,
  income: s.income,
  expense: s.expenses,
}));
