import { Link } from 'react-router-dom';
import { PiggyBank } from 'lucide-react';
import SectionCard from '../shared/SectionCard';
import { sectionProps } from './settingsSections';
import SegmentedRadio from './SegmentedRadio';
import ResetControl from './ResetControl';

const VIEW_OPTIONS = [
  { value: 'dashboard', label: 'Dashboard' },
  { value: 'planner', label: 'Planner' },
];

const MONTH_OPTIONS = [
  { value: 'current', label: 'Current month' },
  { value: 'latest', label: 'Latest month with data' },
];

export default function BudgetSection({
  view,
  monthMode,
  onViewChange,
  onMonthModeChange,
  onReset,
}) {
  return (
    <SectionCard
      {...sectionProps('budget')}
      title="Budget"
      subtitle="What Budget shows when you open it."
      icon={PiggyBank}
    >
      <div className="space-y-6">
        <SegmentedRadio
          legend="Default view"
          name="settings-budget-view"
          value={view}
          onChange={onViewChange}
          options={VIEW_OPTIONS}
        />
        <SegmentedRadio
          legend="Default month"
          name="settings-budget-month"
          value={monthMode}
          onChange={onMonthModeChange}
          options={MONTH_OPTIONS}
        />
        <p className="text-xs text-slate-slate400">
          Per-category budgets are edited in the{' '}
          <Link
            to="/budget/planner"
            className="font-semibold text-slate-slate200 underline underline-offset-2 hover:text-slate-slate100"
          >
            Budget planner
          </Link>
          .
        </p>
      </div>
      <div className="mt-4 flex justify-end">
        <ResetControl label="budget settings" onConfirm={onReset} />
      </div>
    </SectionCard>
  );
}
