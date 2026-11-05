import { formatCurrency } from '../../utils/budgetAggregate';

function Card({ title, formatted, accent, dark }) {
  return (
    <div className="glass relative rounded-2xl px-5 py-6 transition-colors hover:border-slate-slate600 overflow-hidden">
      <span className={`absolute left-0 top-0 bottom-0 w-1 ${accent}`} />
      <h3 className="text-[10px] font-semibold uppercase tracking-widest mb-2.5 text-slate-slate400">
        {title}
      </h3>
      <p
        className={`text-xl sm:text-2xl lg:text-3xl font-bold ${dark} tabular-nums leading-none`}
        title={formatted}
      >
        {formatted}
      </p>
    </div>
  );
}

export default function BudgetSummaryCards({ summary }) {
  const income = summary?.income ?? 0;
  const expenses = summary?.expenses ?? 0;
  const net = summary?.net ?? income - expenses;
  const savingsRate = summary?.savingsRate ?? 0;

  const netColor = net >= 0 ? 'text-accent-green' : 'text-accent-red';
  const savingsColor =
    savingsRate >= 20
      ? 'text-accent-green'
      : savingsRate >= 0
        ? 'text-accent-yellow'
        : 'text-accent-red';

  const incomePlanned = !!summary?.incomePlanned;
  const expensesPlanned = !!summary?.expensesPlanned;
  const bothPlanned = incomePlanned && expensesPlanned;
  // Net and savings rate combine both sides: planned only when both are, and a mix says so.
  const mixed = incomePlanned !== expensesPlanned;

  return (
    <div className="mb-5">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Card
          title={incomePlanned ? 'Planned income' : 'Income'}
          formatted={formatCurrency(income)}
          accent="bg-gradient-to-b from-green-greenLight1 to-green-green"
          dark="text-accent-green"
        />
        <Card
          title={expensesPlanned ? 'Planned expenses' : 'Expenses'}
          formatted={formatCurrency(expenses)}
          accent="bg-gradient-to-b from-red-redLight1 to-red-red"
          dark="text-accent-red"
        />
        <Card
          title={bothPlanned ? 'Planned net' : 'Net'}
          formatted={formatCurrency(net)}
          accent="bg-gradient-to-b from-slate-slateBlueLight to-slate-slateBlue"
          dark={netColor}
        />
        <Card
          title={bothPlanned ? 'Planned savings rate' : 'Savings rate'}
          formatted={`${Math.round(savingsRate)}%`}
          accent="bg-gradient-to-b from-yellow-yellowLight1 to-yellow-yellow"
          dark={savingsColor}
        />
      </div>
      {mixed && (
        <p className="mt-2 text-[11px] text-slate-slate400">Plan vs actual</p>
      )}
    </div>
  );
}
