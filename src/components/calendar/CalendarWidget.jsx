import { useMemo } from 'react';
import { Calendar } from 'lucide-react';
import WidgetCard from '../shared/WidgetCard';
import { WidgetSkeleton } from '../shared/Skeleton';
import { useCalendar } from '../../hooks/useCalendar';

const TIME_FMT = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' });
const DAY_FMT = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

export default function CalendarWidget() {
  const { events, loading, error } = useCalendar();
  const next = useMemo(() => {
    const now = new Date().getTime();
    return events
      .filter((e) => {
        const when = e.end || e.start;
        if (!when) return false;
        const t = new Date(when).getTime();
        return Number.isFinite(t) && t >= now;
      })
      .slice(0, 3);
  }, [events]);

  return (
    <WidgetCard busy={loading} to="/calendar" title="Calendar" icon={Calendar} accent="text-accent-blue">
      {loading && <WidgetSkeleton />}
      {!loading && error && (
        <p className="text-xs text-slate-slate400">
          {error.status === 503
            ? "Burrow can't open your data file."
            : "Couldn't load your calendar. Open Calendar to try again."}
        </p>
      )}
      {!loading && !error && (
        <>
          {next.length === 0 && <p className="text-sm text-slate-slate400">Nothing upcoming.</p>}
          <ul className="space-y-2">
            {next.map((e) => {
              const start = new Date(e.start);
              return (
                <li key={e.id || e.uid} className="text-sm text-slate-slate200">
                  <div className="truncate">· {e.summary}</div>
                  <div className="text-xs text-slate-slate500 ml-2">
                    {DAY_FMT.format(start)}
                    {!e.allDay && ` · ${TIME_FMT.format(start)}`}
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </WidgetCard>
  );
}
