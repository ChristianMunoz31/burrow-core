// Derive the Budget module's aggregates (summary / categories / trend) from
// Burrow's own transactions, in the same shapes as src/data/budgetSample.js.
//
// Conventions mirror the rest of Burrow (SummaryCards, BudgetReport,
// BucketAverages, BucketTrends):
//   - income   = every `credit` row
//   - expenses = every `debit` row (transfers and credit-card payments included;
//                they are budgeted in Savings, so they count as spend)
//   - month    = the first 7 chars of the ISO date ('YYYY-MM')
//   - subcategory = categorizeTransaction() id -> CATEGORIES name
//   - budgeted = getCategoryBudget(id, month) (hand-curated fallbackBudget)
import {
  CATEGORIES,
  categorizeTransaction,
  getCategoryBudget,
} from './budgetConfig';

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])-\d{2}/;

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

function monthOf(date) {
  const match = MONTH_RE.exec(String(date ?? ''));
  return match ? `${match[1]}-${match[2]}` : null;
}

const EXPENSE_CATEGORIES = CATEGORIES.filter((c) => !c.isIncome);
const EXPENSE_IDS = new Set(EXPENSE_CATEGORIES.map((c) => c.id));
const BUFFER_ID = EXPENSE_CATEGORIES.find((c) => c.groupName === 'Buffer' && c.name === 'Buffer')?.id ?? null;

/**
 * Build the Budget dashboard aggregates from normalized transactions.
 *
 * @param {Array<{date: string, merchant: string, amount: number, category: string, type: 'credit'|'debit'}>} transactions
 * @param {{ months?: number }} [options] Trailing number of months (that have transactions) to keep.
 * @returns {{
 *   summary: Array<{month: string, income: number, expenses: number, net: number, budgeted: number, spent: number, savingsRate: number}>,
 *   categories: Array<{month: string, category: string, budgeted: number, spent: number}>,
 *   trend: Array<{month: string, income: number, expense: number}>
 * }}
 */
export function buildBudgetDashboard(transactions, { months = 12 } = {}) {
  const byMonth = new Map(); // month -> { income, expenses, spentById: Map }

  for (const t of Array.isArray(transactions) ? transactions : []) {
    const month = monthOf(t?.date);
    if (!month) continue;
    const amount = Math.abs(Number(t.amount)) || 0;
    let slot = byMonth.get(month);
    if (!slot) {
      slot = { income: 0, expenses: 0, spentById: new Map() };
      byMonth.set(month, slot);
    }
    if (t.type === 'credit') {
      slot.income += amount;
    } else if (t.type === 'debit') {
      slot.expenses += amount;
      // categorizeTransaction can return an income subcategory for a debit (a
      // loose income merchant hint such as "payroll"). Income rows are never
      // emitted, so attribute it to Buffer (as BudgetReport/BucketAverages do)
      // to keep sum(categories.spent) === summary.expenses.
      const { subcategoryId } = categorizeTransaction(t);
      const targetId = EXPENSE_IDS.has(subcategoryId) ? subcategoryId : BUFFER_ID;
      if (targetId) {
        slot.spentById.set(targetId, (slot.spentById.get(targetId) || 0) + amount);
      }
    }
  }

  const keep = [...byMonth.keys()].sort().slice(-Math.max(1, Math.floor(Number(months)) || 1));

  const summary = [];
  const categories = [];
  const trend = [];

  for (const month of keep) {
    const slot = byMonth.get(month);
    const income = round2(slot.income);
    const expenses = round2(slot.expenses);
    const net = round2(slot.income - slot.expenses);

    let budgeted = 0;
    for (const cat of EXPENSE_CATEGORIES) {
      const catBudget = getCategoryBudget(cat.id, month);
      const spent = round2(slot.spentById.get(cat.id) || 0);
      budgeted += catBudget;
      if (catBudget !== 0 || spent !== 0) {
        categories.push({ month, category: cat.name, budgeted: round2(catBudget), spent });
      }
    }

    summary.push({
      month,
      income,
      expenses,
      net,
      budgeted: round2(budgeted),
      spent: expenses,
      savingsRate: income > 0 ? Math.round((net / income) * 100) : 0,
    });
    trend.push({ month, income, expense: expenses });
  }

  return { summary, categories, trend };
}
