import { useRef, useState } from 'react';
import { RotateCcw, SlidersHorizontal } from 'lucide-react';
import { useBudgetPlan } from '../../hooks/useBudgetPlan';
import { formatCurrency } from '../../utils/budgetAggregate';
import { spentKey, targetKey } from '../../utils/budgetPlan';
import { evalAmount } from '../../utils/evalAmount';
import { usePageContext } from '../../contexts/PageContextContext';
import { buildBudgetPlannerContext, hasBudget } from '../../utils/javiBuilders/budget';
import IncomePayees from './IncomePayees';
import CategoryEditor from './CategoryEditor';
import { btnSecondary } from '../shared/formStyles';

// A single editable amount cell: a controlled text field that commits on blur or
// Enter, so typing doesn't fire a sync per keystroke. Reverts on Escape. Accepts
// math expressions (e.g. 50+25) via evalAmount; invalid input reverts (no commit),
// while clearing the field commits 0. Used for both the Budgeted and Spent columns.
function AmountInput({ value, onCommit, ariaLabel = 'Amount' }) {
  const [draft, setDraft] = useState(null);
  // Set by Escape so the blur that follows discards the draft instead of committing it.
  const cancelled = useRef(false);
  const display = draft != null ? draft : String(value ?? 0);
  return (
    <input
      type="text"
      inputMode="decimal"
      title="Accepts math, e.g. 50+25"
      value={display}
      onChange={(e) => setDraft(e.target.value)}
      onFocus={(e) => e.target.select()}
      onBlur={() => {
        if (cancelled.current) {
          cancelled.current = false;
          setDraft(null);
          return;
        }
        if (draft != null) {
          if (draft.trim() === '') {
            onCommit(0);
            setDraft(null);
          } else {
            const n = evalAmount(draft);
            if (n == null) {
              setDraft(null);
            } else {
              onCommit(n);
              setDraft(null);
            }
          }
        }
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        else if (e.key === 'Escape') {
          cancelled.current = true;
          setDraft(null);
          e.currentTarget.blur();
        }
      }}
      className="w-24 glass-input rounded-md px-2 py-1 text-right text-xs tabular-nums text-slate-slate100 focus:border-slate-slateBlue focus:outline-none focus:ring-1 focus:ring-slate-slateBlueLight/40"
      aria-label={ariaLabel}
    />
  );
}

export default function BudgetPlanner({ month, categories, source = 'transactions' }) {
  const { plan, targets, setTargets, payees, setPayees, spentOv, setSpentOv, structure, setStructure, defaults, setDefaults } =
    useBudgetPlan(month, categories);
  const [editing, setEditing] = useState(false);

  usePageContext(
    'budget-planner',
    () => buildBudgetPlannerContext({ month, source, plan }),
    hasBudget(source, targets, payees) && plan,
  );

  const setTarget = (categoryId, amount) =>
    setTargets((prev) => ({ ...prev, [targetKey(month, categoryId)]: amount }));

  const clearTarget = (categoryId) =>
    setTargets((prev) => {
      const next = { ...prev };
      delete next[targetKey(month, categoryId)];
      return next;
    });

  const setSpent = (categoryId, amount) =>
    setSpentOv((prev) => ({ ...prev, [spentKey(month, categoryId)]: amount }));

  const clearSpent = (categoryId) =>
    setSpentOv((prev) => {
      const next = { ...prev };
      delete next[spentKey(month, categoryId)];
      return next;
    });

  // A category counts as "edited" only when the user typed a value (a real entry
  // in targets), not when income was auto-filled from payees.
  const isManualTarget = (categoryId) =>
    Object.prototype.hasOwnProperty.call(targets || {}, targetKey(month, categoryId));
  const isSpentEdited = (categoryId) =>
    Object.prototype.hasOwnProperty.call(spentOv || {}, spentKey(month, categoryId));

  if (!month) return null;

  const { groups, totals } = plan;

  const remainingClass = (n) =>
    n < 0 ? 'text-accent-red' : n > 0 ? 'text-accent-green' : 'text-slate-slate400';

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => setEditing((v) => !v)}
          className={`${btnSecondary} inline-flex items-center gap-1.5`}
        >
          <SlidersHorizontal size={12} /> {editing ? 'Done' : 'Manage categories'}
        </button>
      </div>

      {editing && (
        <CategoryEditor
          structure={structure}
          setStructure={setStructure}
          defaults={defaults}
          setDefaults={setDefaults}
        />
      )}

      {groups.length === 0 ? (
        <p className="text-xs text-slate-slate400">
          No budget set for this month yet. Open{' '}
          <span className="text-slate-slate300">Manage categories</span> to set a default amount for
          each category, or add your own.
        </p>
      ) : (
      <>
      {/* Plan summary */}
      <div className="grid grid-cols-3 gap-3 text-center">
        <div className="glass-subtle rounded-lg p-2">
          <p className="text-[10px] uppercase tracking-wide text-slate-slate400">Planned income</p>
          <p className="text-sm font-bold tabular-nums text-accent-green">
            {formatCurrency(totals.incomeBudgeted)}
          </p>
        </div>
        <div className="glass-subtle rounded-lg p-2">
          <p className="text-[10px] uppercase tracking-wide text-slate-slate400">Planned expenses</p>
          <p className="text-sm font-bold tabular-nums text-slate-slate100">
            {formatCurrency(totals.expenseBudgeted)}
          </p>
        </div>
        <div className="glass-subtle rounded-lg p-2">
          <p className="text-[10px] uppercase tracking-wide text-slate-slate400">Planned net</p>
          <p className={`text-sm font-bold tabular-nums ${remainingClass(totals.netBudgeted)}`}>
            {formatCurrency(totals.netBudgeted)}
          </p>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs" aria-label="Budget planner by category">
          <thead className="text-[10px] uppercase tracking-wide text-slate-slate400">
            <tr className="border-b border-slate-slate700">
              <th scope="col" className="px-2 py-1.5 font-medium">Category</th>
              <th scope="col" className="px-2 py-1.5 font-medium text-right">Budgeted</th>
              <th scope="col" className="px-2 py-1.5 font-medium text-right">Spent</th>
              <th scope="col" className="px-2 py-1.5 font-medium text-right">Remaining</th>
              <th scope="col" className="px-1 py-1.5" aria-label="Reset" />
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => (
              <GroupRows
                key={g.id}
                group={g}
                onSet={setTarget}
                onClear={clearTarget}
                onSetSpent={setSpent}
                onClearSpent={clearSpent}
                isManualTarget={isManualTarget}
                isSpentEdited={isSpentEdited}
                remainingClass={remainingClass}
              />
            ))}
          </tbody>
        </table>
      </div>

      <IncomePayees month={month} payees={payees} setPayees={setPayees} />

      <p className="text-[11px] text-slate-slate400">
        Budgeted amounts start from each category's default budget. Income comes from your payees
        below, or you can type a planned income on the Income row. You can change Spent to try
        out a what-if plan.
        Changes save automatically. Amounts accept math, e.g. 50+25.
      </p>
      </>
      )}
    </div>
  );
}

function GroupRows({
  group,
  onSet,
  onClear,
  onSetSpent,
  onClearSpent,
  isManualTarget,
  isSpentEdited,
  remainingClass,
}) {
  return (
    <>
      <tr className="border-y border-slate-slate700/60 bg-slate-slate800/60">
        <td className="px-2 py-2 font-semibold text-slate-slate100">{group.name}</td>
        <td className="px-2 py-1.5 text-right font-semibold tabular-nums text-slate-slate200">
          {formatCurrency(group.budgeted)}
        </td>
        <td className="px-2 py-1.5 text-right font-semibold tabular-nums text-slate-slate200">
          {formatCurrency(group.spent)}
        </td>
        <td className={`px-2 py-1.5 text-right font-semibold tabular-nums ${remainingClass(group.remaining)}`}>
          {formatCurrency(group.remaining)}
        </td>
        <td />
      </tr>
      {group.categories.map((c) => {
        const budgetEdited = isManualTarget(c.id);
        const spentEdited = isSpentEdited(c.id);
        return (
          <tr key={c.id} className="border-b border-slate-slate800/60 hover:bg-slate-slate800/30">
            <td className="px-2 py-1 pl-5 text-slate-slate300">
              {c.name}
              {budgetEdited && (
                <span className="ml-1.5 text-[9px] uppercase tracking-wide text-accent-yellow">edited</span>
              )}
            </td>
            <td className="px-2 py-1 text-right">
              <AmountInput
                value={c.budgeted}
                onCommit={(amt) => onSet(c.id, amt)}
                ariaLabel={`Budgeted amount for ${c.name}`}
              />
            </td>
            <td className="px-2 py-1 text-right">
              <AmountInput
                value={c.spent}
                onCommit={(amt) => onSetSpent(c.id, amt)}
                ariaLabel={`Spent amount for ${c.name}`}
              />
            </td>
            <td className={`px-2 py-1 text-right tabular-nums ${remainingClass(c.remaining)}`}>
              {formatCurrency(c.remaining)}
            </td>
            <td className="px-1 py-1 text-center">
              <div className="flex items-center justify-center gap-1">
                {budgetEdited && (
                  <button
                    type="button"
                    onClick={() => onClear(c.id)}
                    aria-label={`Reset budgeted ${c.name} to its default`}
                    title="Reset budgeted to its default"
                    className="rounded p-1 text-slate-slate400 hover:text-slate-slate200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-slate-slateBlueLight"
                  >
                    <RotateCcw size={13} />
                  </button>
                )}
                {spentEdited && (
                  <button
                    type="button"
                    onClick={() => onClearSpent(c.id)}
                    aria-label={`Reset spent ${c.name} to your transactions`}
                    title="Reset spent to your transactions"
                    className="rounded p-1 text-slate-slate400 hover:text-accent-yellow focus-visible:outline focus-visible:outline-2 focus-visible:outline-slate-slateBlueLight"
                  >
                    <RotateCcw size={13} />
                  </button>
                )}
              </div>
            </td>
          </tr>
        );
      })}
    </>
  );
}
