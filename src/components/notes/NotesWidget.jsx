import { StickyNote } from 'lucide-react';
import WidgetCard from '../shared/WidgetCard';
import { WidgetSkeleton } from '../shared/Skeleton';
import { useNotes } from '../../hooks/useNotes';

export default function NotesWidget() {
  const { notes, loading, error } = useNotes();
  const recent = notes.slice(0, 2);

  return (
    <WidgetCard busy={loading} to="/notes" title="Notes" icon={StickyNote} accent="text-accent-yellow">
      {loading && <WidgetSkeleton />}
      {!loading && error && (
        <p className="text-xs text-slate-slate400">
          {error.status === 503 ? "Burrow can't open your data file." : 'Could not load notes.'}
        </p>
      )}
      {!loading && !error && (
        <>
          <div className="text-3xl font-bold text-slate-slate100 tabular-nums leading-none">
            {notes.length}
          </div>
          <div className="text-xs text-slate-slate400 mt-1">notes</div>
          {recent.length > 0 && (
            <ul className="mt-3 space-y-1">
              {recent.map((n) => (
                <li key={n.id} className="text-xs text-slate-slate300 truncate">
                  · {n.body}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </WidgetCard>
  );
}
