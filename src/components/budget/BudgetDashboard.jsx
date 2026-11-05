import { useMemo, useState } from 'react';
import { Settings2, Check, RotateCcw, Maximize2 } from 'lucide-react';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  closestCenter,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
} from '@dnd-kit/sortable';
import SectionCard from '../shared/SectionCard';
import Modal from '../shared/Modal';
import WidgetTile from '../home/WidgetTile';
import { btnSecondary } from '../shared/formStyles';
import { SHELL_ICON_BTN } from '../shell/shellStyles';
import { useHomeLayout } from '../../hooks/useHomeLayout';
import {
  budgetVsActualForMonth,
  formatMonthLong,
  summaryForMonth,
  trendSeries,
} from '../../utils/budgetAggregate';
import BudgetSummaryCards from './BudgetSummaryCards';
import BudgetVsActualChart from './BudgetVsActualChart';
import CategoryPies from './CategoryPies';
import IncomeExpenseTrendChart from './IncomeExpenseTrendChart';
import { hybridSummary, plannedExpenseEntries, resolveStructure } from '../../utils/budgetPlan';
import { useBudgetPlan } from '../../hooks/useBudgetPlan';
import { usePageContext } from '../../contexts/PageContextContext';
import { buildBudgetDashboardContext, hasBudget } from '../../utils/javiBuilders/budget';
import { BUCKETS } from '../../utils/budgetConfig';
import {
  categoryPiesForMonth,
  incomeJoinNames,
  joinNameLabels,
  pieBucketsFromPlan,
  spendRowsExcludingIncome,
} from '../../utils/budgetPies';

const CARD_KEYS = ['budgetVsActual', 'incomeVsExpenses', 'categoryPies'];
const LAYOUT_OPTIONS = { storageKey: 'pos:budgetLayout' };
const BTN_CLASS = `${btnSecondary} inline-flex items-center gap-1.5`;
// Static class maps (Tailwind JIT).
const SPAN_PAIRED = { budgetVsActual: 'lg:col-span-2', incomeVsExpenses: '', categoryPies: 'lg:col-span-3' };
const SPAN_FULL = { budgetVsActual: 'lg:col-span-3', incomeVsExpenses: 'lg:col-span-3', categoryPies: 'lg:col-span-3' };

export default function BudgetDashboard({ month, summary, categories, trend, source = 'transactions' }) {
  const trendData = useMemo(() => trendSeries(trend), [trend]);
  const monthSummary = useMemo(
    () => summaryForMonth(summary, month),
    [summary, month],
  );

  // Budget overrides live under the same synced keys the planner edits, so the
  // summary cards recompute the moment an envelope, payee, or spent edit changes.
  // We feed buildPlan the same augmented inputs the planner uses (planned income
  // from payees + manual spent edits); hybridSummary then prefers planned income.
  // Actuals with manual spent edits applied are shared by the plan and the pies so
  // both reflect the same numbers.
  const { plan, resolved, augCats, structure, targets, payees } = useBudgetPlan(month, categories);
  // Pie buckets follow the planner's effective structure (renames, moves, hidden
  // and custom groups). Spend joins on the original name (baselineName), the
  // slice shows the current name - same rule as buildPlan. Budgeted comes from
  // the resolved plan; groups/categories buildPlan dropped default to 0.
  const pieBuckets = useMemo(() => pieBucketsFromPlan(resolved, plan), [resolved, plan]);
  // includeHidden: a hidden income group/category is still income, not spend,
  // and hidden expense categories keep their current name as an Unassigned label.
  const allResolved = useMemo(() => resolveStructure(structure, { includeHidden: true }), [structure]);
  const incomeNames = useMemo(() => incomeJoinNames(allResolved), [allResolved]);
  const orphanLabels = useMemo(() => joinNameLabels(allResolved), [allResolved]);
  const pies = useMemo(
    () =>
      categoryPiesForMonth(spendRowsExcludingIncome(augCats, allResolved, incomeNames), month, pieBuckets, {
        labelByJoinName: orphanLabels,
      }),
    [augCats, month, pieBuckets, allResolved, incomeNames, orphanLabels],
  );
  // The chart's budgeted bars come from the plan (month override -> onboarding/planner
  // default -> baseline), not the baseline-only amounts on the dashboard rows.
  const budgetData = useMemo(
    () => budgetVsActualForMonth(augCats, month, plannedExpenseEntries(plan, resolved.categories)),
    [augCats, month, plan, resolved],
  );
  const cardSummary = useMemo(
    () => hybridSummary(monthSummary, plan.totals),
    [monthSummary, plan],
  );

  usePageContext('budget', () =>
    buildBudgetDashboardContext({ month, source, plan, rows: budgetData }),
    hasBudget(source, targets, payees) && plan,
  );

  const { ready, order, reorder, reset } = useHomeLayout(CARD_KEYS, undefined, LAYOUT_OPTIONS);
  const [editing, setEditing] = useState(false);
  const [maximized, setMaximized] = useState(null);

  const pieSubtitle = month
    ? `${formatMonthLong(month)} budgeted (outer ring) vs. spent (inner ring)`
    : 'Budgeted (outer ring) vs. spent (inner ring)';
  const CARDS = {
    budgetVsActual: {
      title: 'Budget vs. actual',
      render: (max) => <BudgetVsActualChart data={budgetData} height={max ? '100%' : undefined} />,
    },
    incomeVsExpenses: {
      title: 'Income vs. expenses',
      render: (max) => <IncomeExpenseTrendChart data={trendData} height={max ? '100%' : undefined} />,
    },
    categoryPies: {
      title: 'Spending by category group',
      subtitle: pieSubtitle,
      render: (max) => <CategoryPies pies={pies} buckets={BUCKETS} large={max} />,
    },
  };

  // One flat grid in the saved order. Pies always span the full row. Budget vs. actual (2 of 3
  // columns) and Income vs. expenses (1 of 3) share a row only when adjacent in the order;
  // otherwise each takes the full row.
  const paired = Math.abs(order.indexOf('budgetVsActual') - order.indexOf('incomeVsExpenses')) === 1;
  const spans = paired ? SPAN_PAIRED : SPAN_FULL;

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const name = (id) => CARDS[id]?.title ?? id;
  const at = (id) => `position ${order.indexOf(id) + 1} of ${order.length}`;
  const announcements = {
    onDragStart: ({ active }) => `Picked up ${name(active.id)}.`,
    onDragOver: ({ active, over }) =>
      over ? `${name(active.id)} moved to ${at(over.id)}.` : `${name(active.id)} is no longer over a position.`,
    onDragEnd: ({ active, over }) =>
      over ? `${name(active.id)} dropped at ${at(over.id)}.` : `${name(active.id)} dropped.`,
    onDragCancel: ({ active }) => `Moving ${name(active.id)} was cancelled.`,
  };

  const onDragEnd = ({ active, over }) => {
    if (!over || active.id === over.id) return;
    const oldIndex = order.indexOf(active.id);
    const newIndex = order.indexOf(over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    reorder(arrayMove(order, oldIndex, newIndex));
  };

  const tiles = order.map((key) => {
    const { title, subtitle, render } = CARDS[key];
    return (
      <WidgetTile key={key} id={key} editing={editing} className={spans[key]} dragLabel={`Move ${title}`}>
        <SectionCard
          title={title}
          subtitle={subtitle}
          variant="dense"
          className="h-full"
          action={
            editing ? undefined : (
              <button
                type="button"
                className={`${SHELL_ICON_BTN} -my-2`}
                aria-label={`Maximize ${title}`}
                onClick={() => setMaximized(key)}
              >
                <Maximize2 size={16} aria-hidden="true" />
              </button>
            )
          }
        >
          {render(false)}
        </SectionCard>
      </WidgetTile>
    );
  });
  const gridClass = 'grid grid-cols-1 gap-4 lg:grid-cols-3';

  return (
    <>
      <BudgetSummaryCards summary={cardSummary} />

      <div className="mb-3 flex flex-wrap items-center justify-end gap-2">
        {editing && <p className="mr-auto basis-full text-sm sm:basis-auto text-slate-slate400">Drag a chart by its handle to reorder it.</p>}
        {editing && (
          <button type="button" onClick={reset} className={BTN_CLASS}>
            <RotateCcw size={14} aria-hidden="true" /> Reset
          </button>
        )}
        <button type="button" onClick={() => setEditing((v) => !v)} disabled={!ready && !editing} className={BTN_CLASS}>
          {editing ? (
            <>
              <Check size={14} aria-hidden="true" /> Done
            </>
          ) : (
            <>
              <Settings2 size={14} aria-hidden="true" /> Customize
            </>
          )}
        </button>
      </div>

      {editing ? (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          accessibility={{ announcements }}
          onDragEnd={onDragEnd}
        >
          <SortableContext items={order} strategy={rectSortingStrategy}>
            <div className={gridClass}>{tiles}</div>
          </SortableContext>
        </DndContext>
      ) : (
        <div className={gridClass}>{tiles}</div>
      )}

      {maximized && (
        <Modal title={CARDS[maximized].title} size="full" onClose={() => setMaximized(null)}>
          {maximized === 'categoryPies' ? (
            <>
              <p className="mb-3 text-xs text-slate-slate400">{CARDS.categoryPies.subtitle}</p>
              {CARDS.categoryPies.render(true)}
            </>
          ) : (
            <div className="h-[60dvh] sm:h-[70dvh]">{CARDS[maximized].render(true)}</div>
          )}
        </Modal>
      )}
    </>
  );
}
