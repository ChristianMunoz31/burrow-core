import { Target } from 'lucide-react';
import WidgetCard from '../shared/WidgetCard';
import { WidgetSkeleton } from '../shared/Skeleton';
import { useHabits } from '../../hooks/useHabits';
import { isoToday } from '../../utils/habits';

export default function HabitsWidget() {
  const { habits, loading, error } = useHabits();

  if (loading) {
    return (
      <WidgetCard busy to="/habits" title="Habits" icon={Target} accent="text-accent-teal">
        <WidgetSkeleton />
      </WidgetCard>
    );
  }

  if (error) {
    return (
      <WidgetCard to="/habits" title="Habits" icon={Target} accent="text-accent-teal">
        <p className="text-xs text-slate-slate400">
          {error.status === 503
            ? "Burrow can't open your data file."
            : "Couldn't load your habits. Open Habits to try again."}
        </p>
      </WidgetCard>
    );
  }

  const today = isoToday();
  const doneToday = habits.filter((h) =>
    Array.isArray(h.completions) && h.completions.some((d) => d === today),
  ).length;

  return (
    <WidgetCard to="/habits" title="Habits" icon={Target} accent="text-accent-teal">
      <div className="text-3xl font-bold text-slate-slate100 tabular-nums leading-none">
        {doneToday}<span className="text-base text-slate-slate500 font-medium"> / {habits.length}</span>
      </div>
      <div className="text-xs text-slate-slate400 mt-1">done today</div>
      {habits.length > 0 && (
        <div className="flex gap-1 mt-3">
          {habits.slice(0, 8).map((h) => {
            const done = h.completions?.includes(today);
            return (
              <span
                key={h.id}
                title={h.title}
                className={`w-2.5 h-2.5 rounded-full ${
                  done ? 'bg-teal-tealLight1' : 'bg-slate-slate700'
                }`}
              />
            );
          })}
        </div>
      )}
    </WidgetCard>
  );
}
