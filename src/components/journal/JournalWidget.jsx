import { Notebook } from 'lucide-react';
import WidgetCard from '../shared/WidgetCard';
import { WidgetSkeleton } from '../shared/Skeleton';
import { useJournal } from '../../hooks/useJournal';
import { currentStreak, topMood } from '../../utils/journalStats';

const MOOD_DOT = {
  great: 'bg-green-greenLight1',
  good: 'bg-teal-tealLight1',
  okay: 'bg-yellow-yellowLight1',
  down: 'bg-orange-orangeLight1',
  rough: 'bg-red-redLight1',
};

export default function JournalWidget() {
  const { entries, loading, error } = useJournal();

  if (loading) {
    return (
      <WidgetCard busy to="/journal" title="Journal" icon={Notebook} accent="text-accent-purple">
        <WidgetSkeleton />
      </WidgetCard>
    );
  }

  if (error) {
    return (
      <WidgetCard to="/journal" title="Journal" icon={Notebook} accent="text-accent-purple">
        <p className="text-xs text-slate-slate400">
          {error.status === 503 ? "Burrow can't open your data file." : 'Could not load journal.'}
        </p>
      </WidgetCard>
    );
  }

  const streak = currentStreak(entries);
  const mood = topMood(entries);

  return (
    <WidgetCard to="/journal" title="Journal" icon={Notebook} accent="text-accent-purple">
      <div className="text-3xl font-bold text-slate-slate100 tabular-nums leading-none">
        {entries.length}
      </div>
      <div className="text-xs text-slate-slate400 mt-1">entries</div>
      <div className="mt-3 flex items-center gap-3 text-xs text-slate-slate500">
        <span>streak {streak}</span>
        {mood && (
          <span className="flex items-center gap-1">
            <span className={`w-2 h-2 rounded-full ${MOOD_DOT[mood] || 'bg-slate-slate500'}`} />
            mostly {mood}
          </span>
        )}
      </div>
    </WidgetCard>
  );
}
