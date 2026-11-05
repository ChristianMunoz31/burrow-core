import { Timer } from 'lucide-react';
import WidgetCard from '../shared/WidgetCard';
import { WidgetSkeleton } from '../shared/Skeleton';
import { useFocus } from '../../hooks/useFocus';

export default function FocusWidget() {
  const { today, loading, error } = useFocus();

  return (
    <WidgetCard busy={loading} to="/focus" title="Focus" icon={Timer} accent="text-accent-cyan">
      {loading && <WidgetSkeleton />}
      {!loading && error && (
        <p className="text-xs text-slate-slate400">
          {error.status === 503 ? "Burrow can't open your data file." : "Couldn't load your focus time. Open Focus to try again."}
        </p>
      )}
      {!loading && !error && (
        <>
          <div className="text-3xl font-bold text-slate-slate100 tabular-nums leading-none">
            {today.minutes}
            <span className="text-base font-medium text-slate-slate400"> min</span>
          </div>
          <div className="text-xs text-slate-slate400 mt-1">
            focused today · {today.count} session{today.count === 1 ? '' : 's'}
          </div>
          <div className="mt-3 text-xs text-accent-indigo">Start focusing →</div>
        </>
      )}
    </WidgetCard>
  );
}
