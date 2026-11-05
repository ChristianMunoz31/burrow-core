import { useMemo } from 'react';
import { CalendarClock } from 'lucide-react';
import WidgetCard from '../shared/WidgetCard';
import { WidgetSkeleton } from '../shared/Skeleton';
import { useCountdowns } from '../../hooks/useCountdowns';
import { daysUntil } from '../../utils/countdown';

export default function CountdownsWidget() {
  const { countdowns, loading, error } = useCountdowns();
  const upcoming = useMemo(
    () => countdowns.filter((c) => (daysUntil(c.targetDate) ?? -1) >= 0).slice(0, 3),
    [countdowns],
  );

  return (
    <WidgetCard busy={loading} to="/countdowns" title="Countdowns" icon={CalendarClock} accent="text-accent-orange">
      {loading && <WidgetSkeleton />}
      {!loading && error && (
        <p className="text-xs text-slate-slate400">
          {error.status === 503 ? "Burrow can't open your data file." : 'Could not load countdowns.'}
        </p>
      )}
      {!loading && !error && (
        <>
          {upcoming.length === 0 ? (
            <p className="text-sm text-slate-slate400">Nothing upcoming.</p>
          ) : (
            <ul className="space-y-2">
              {upcoming.map((c) => {
                const days = daysUntil(c.targetDate);
                return (
                  <li key={c.id} className="flex items-center justify-between gap-2 text-sm">
                    <span className="truncate text-slate-slate200">· {c.title}</span>
                    <span className="shrink-0 tabular-nums text-slate-slate400">
                      {days === 0 ? 'today' : `${days}d`}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </WidgetCard>
  );
}
