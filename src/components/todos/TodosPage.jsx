import { useMemo } from 'react';
import { useTodos } from '../../hooks/useTodos';
import { useTodoColumns } from '../../hooks/useTodoColumns';
import { matchesMode, useMode } from '../../contexts/ModeContext';
import KanbanBoard from './KanbanBoard';
import SegmentedRadio from '../settings/SegmentedRadio';
import { ListSkeleton } from '../shared/Skeleton';
import LoadError from '../shared/LoadError';
import { usePageContext } from '../../contexts/PageContextContext';
import { buildTodosContext } from '../../utils/javiBuilders/todos';

const TODO_FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'work', label: 'Work' },
  { value: 'home', label: 'Home' },
];

export default function TodosPage() {
  const { todos, loading, error, refresh, add, update, reorder, remove } = useTodos();
  const {
    columns,
    loading: columnsLoading,
    error: columnsError,
    refresh: refreshColumns,
  } = useTodoColumns();
  const { mode: filter, setMode: setFilter } = useMode();
  const shown = useMemo(() => todos.filter((t) => matchesMode(filter, t.context)), [todos, filter]);
  const filterLabel = TODO_FILTERS.find((f) => f.value === filter)?.label;
  // The filter hides every todo: say so, and say how to get them back.
  const hiddenByFilter = filter !== 'all' && todos.length > 0 && shown.length === 0;

  const loadError = error || columnsError;
  const retry = () => {
    refresh();
    refreshColumns();
  };

  usePageContext('todos', () =>
    buildTodosContext({ todos: shown, loading: loading || columnsLoading, error: loadError, now: new Date() }),
    todos.length > 0 && todos,
  );

  return (
    <div className="space-y-5">
      {loadError && loadError.status === 503 && (
        <p role="alert" className="text-sm text-accent-red">
          Burrow can&apos;t open your data file. Try restarting Burrow.
        </p>
      )}
      {loadError && loadError.status !== 503 && <LoadError thing="todos" onRetry={retry} />}

      {!loadError && (loading || columnsLoading) && <ListSkeleton rows={4} />}

      {!loadError && !loading && !columnsLoading && (
        <KanbanBoard
          todos={shown}
          allTodos={todos}
          columns={columns}
          onReorder={reorder}
          onUpdate={update}
          onRemove={remove}
          onAdd={add}
          defaultContext={filter !== 'all' ? filter : 'work'}
          emptyNote={
            hiddenByFilter ? (
              <p className="text-sm text-slate-slate400">{`No ${filterLabel} todos. Show All to see every todo.`}</p>
            ) : null
          }
          toolbarStart={
            <SegmentedRadio
              legend="Show todos"
              hideLegend
              tone="quiet"
              name="todos-filter"
              value={filter}
              onChange={setFilter}
              options={TODO_FILTERS}
            />
          }
        />
      )}
    </div>
  );
}
