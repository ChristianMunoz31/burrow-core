import { Bookmark } from 'lucide-react';
import WidgetCard from '../shared/WidgetCard';
import { WidgetSkeleton } from '../shared/Skeleton';
import { useBookmarks } from '../../hooks/useBookmarks';

export default function BookmarksWidget() {
  const { bookmarks, loading, error } = useBookmarks();
  const recent = bookmarks.slice(0, 3);

  return (
    <WidgetCard busy={loading} to="/bookmarks" title="Bookmarks" icon={Bookmark} accent="text-accent-purple">
      {loading && <WidgetSkeleton />}
      {!loading && error && (
        <p className="text-xs text-slate-slate400">
          {error.status === 503 ? "Burrow can't open your data file." : 'Could not load bookmarks.'}
        </p>
      )}
      {!loading && !error && (
        <>
          <div className="text-3xl font-bold text-slate-slate100 tabular-nums leading-none">
            {bookmarks.length}
          </div>
          <div className="text-xs text-slate-slate400 mt-1">saved links</div>
          {recent.length > 0 && (
            <ul className="mt-3 space-y-1">
              {recent.map((b) => (
                <li key={b.id} className="text-xs text-slate-slate300 truncate">
                  · {b.title}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </WidgetCard>
  );
}
