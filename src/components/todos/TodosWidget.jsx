import { CheckSquare } from 'lucide-react';
import WidgetCard from '../shared/WidgetCard';
import { WidgetSkeleton } from '../shared/Skeleton';
import { useTodos } from '../../hooks/useTodos';

export default function TodosWidget() {
  const { todos, loading, error } = useTodos();
  const open = todos.filter((t) => !t.done);
  const next = open
    .slice()
    .sort((a, b) => {
      if (a.due && b.due) return a.due.localeCompare(b.due);
      if (a.due) return -1;
      if (b.due) return 1;
      return 0;
    })
    .slice(0, 3);

  return (
    <WidgetCard busy={loading} to="/todos" title="Todos" icon={CheckSquare} accent="text-accent-green">
      {loading && <WidgetSkeleton />}
      {!loading && error && (
        <p className="text-xs text-slate-slate400">
          {error.status === 503
            ? "Burrow can't open your data file."
            : 'Could not load todos.'}
        </p>
      )}
      {!loading && !error && (
        <>
          <div className="text-3xl font-bold text-slate-slate100 tabular-nums leading-none">
            {open.length}
          </div>
          <div className="text-xs text-slate-slate400 mt-1">open</div>
          {next.length > 0 && (
            <ul className="mt-3 space-y-1">
              {next.map((t) => (
                <li key={t.id} className="text-xs text-slate-slate300 truncate">
                  · {t.title}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </WidgetCard>
  );
}
