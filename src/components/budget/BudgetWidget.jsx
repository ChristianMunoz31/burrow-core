import { PiggyBank } from 'lucide-react';
import WidgetCard from '../shared/WidgetCard';
import { WidgetSkeleton } from '../shared/Skeleton';
import { useBudgetData } from '../../hooks/useBudgetData';
import { useBudgetPlan } from '../../hooks/useBudgetPlan';
import { planMonths } from '../../utils/budgetPlan';
import { formatCurrency } from '../../utils/budgetAggregate';

const EMPTY = Object.freeze([]);

const remainingClass = (n) =>
  n < 0 ? 'text-accent-red' : n > 0 ? 'text-accent-green' : 'text-slate-slate400';

// Budget card on Home: this month's Spent, Budgeted and Remaining, all computed
// by buildPlan from real transactions and the saved budget. No model is involved.
export default function BudgetWidget() {
  const { categories, source, loading } = useBudgetData();
  const month = planMonths(new Date())[0];
  // Bundled sample data never reaches the card.
  const { plan, ready } = useBudgetPlan(month, source === 'transactions' ? categories : EMPTY);
  const spent = plan.totals.expenseSpent;
  const budgeted = plan.totals.expenseBudgeted;
  // `|| 0` turns a rounded -0 into 0, so Remaining never reads "-$0.00".
  const remaining = Math.round((budgeted - spent) * 100) / 100 || 0;

  let body;
  if (loading || !ready) {
    body = <WidgetSkeleton />;
  } else if (source === 'error') {
    body = (
      <p className="text-xs text-slate-slate400">
        Couldn't load your transactions. Open Budget to try again.
      </p>
    );
  } else if (spent === 0 && budgeted === 0 && source === 'transactions') {
    body = <p className="text-xs text-slate-slate400">No spending recorded this month yet.</p>;
  } else if (spent === 0 && budgeted === 0) {
    body = (
      <>
        <p className="text-xs text-slate-slate400">No budget or spending this month yet.</p>
        <div className="mt-3 text-xs text-accent-indigo">Import transactions or set a budget →</div>
      </>
    );
  } else {
    body = (
      <>
        <div className="text-3xl font-bold text-slate-slate100 tabular-nums leading-none">
          {formatCurrency(spent)}
        </div>
        <div className="text-xs text-slate-slate400 mt-1">spent this month</div>
        {budgeted === 0 ? (
          <p className="mt-3 text-xs text-slate-slate400">No budget set for this month.</p>
        ) : (
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs tabular-nums">
            <span className="text-slate-slate300">Budgeted {formatCurrency(budgeted)}</span>
            <span className={remainingClass(remaining)}>Remaining {formatCurrency(remaining)}</span>
          </div>
        )}
      </>
    );
  }

  return (
    <WidgetCard busy={loading || !ready} to="/budget" title="Budget" icon={PiggyBank} accent="text-accent-green">
      {body}
    </WidgetCard>
  );
}
