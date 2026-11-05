import { useRef, useState } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import { Skeleton } from '../shared/Skeleton';
import CellValue from './CellValue';
import ValueViewer from './ValueViewer';
import { BTN } from '../settings/pillStyles';
import { rowRange } from '../../utils/dataFormat';

const ERROR_COPY = {
  not_configured: "Burrow can't open your data file. Try restarting Burrow.",
};

function SortIcon({ state }) {
  if (state === 'ascending') return <ArrowUp size={12} aria-hidden="true" />;
  if (state === 'descending') return <ArrowDown size={12} aria-hidden="true" />;
  return <ArrowUpDown size={12} aria-hidden="true" className="opacity-50" />;
}

function GridSkeleton() {
  return (
    <div role="status" aria-label="Loading rows" className="space-y-2 p-4">
      {Array.from({ length: 8 }).map((_, i) => (
        <Skeleton key={i} className="h-5 w-full" />
      ))}
    </div>
  );
}

/**
 * Read-only grid. The only horizontal scroll lives on the inner wrapper; the header is
 * sticky inside it. Presentational: the page owns data, sort and pagination.
 */
export default function DataGrid({
  data,
  loading,
  busy,
  error,
  sort,
  order,
  q,
  onSort,
  onClearSearch,
  onRetry,
  onResetView,
  children,
}) {
  const [viewer, setViewer] = useState(null);
  const regionRef = useRef(null);

  // Lives outside the data/loading/error branches so it is never remounted: a region that
  // appears together with its text is not reliably announced, e.g. on a table switch.
  let summary = '';
  if (data && !loading) {
    const { from, to } = rowRange(data.page, data.pageSize, data.total);
    summary = `Rows ${from.toLocaleString()} to ${to.toLocaleString()} of ${data.total.toLocaleString()}, ${
      sort ? `sorted by ${sort} ${order === 'asc' ? 'ascending' : 'descending'}` : 'default order'
    }`;
  }
  const liveSummary = (
    <p aria-live="polite" className="sr-only">
      {summary}
    </p>
  );

  // A failed background refetch keeps the loaded rows; the full panel is only for "nothing to show".
  if (error && !data) {
    return (
      <>
        {liveSummary}
        <div className="glass rounded-2xl p-5">
          <p role="alert" className="text-sm text-accent-amber">
            {ERROR_COPY[error.code] ?? "Couldn't load rows."}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" onClick={onRetry} className={BTN}>
              Retry
            </button>
            {error.status === 400 && (
              <button type="button" onClick={onResetView} className={BTN}>
                Reset view
              </button>
            )}
          </div>
        </div>
      </>
    );
  }

  if (loading || !data) {
    return (
      <>
        {liveSummary}
        <div className="glass rounded-2xl">
          <GridSkeleton />
        </div>
      </>
    );
  }

  const { columns, rows, primaryKey, amountColumn, label } = data;

  return (
    <>
      {liveSummary}
      <div className="glass min-w-0 rounded-2xl">
        {error && (
          <div className="flex flex-wrap items-center gap-3 px-4 pt-3">
            <p role="alert" className="text-sm text-accent-amber">
              Couldn&apos;t refresh. Showing last loaded rows.
            </p>
            <button type="button" onClick={onRetry} className={BTN}>
              Retry
            </button>
          </div>
        )}
        <div
          ref={regionRef}
          role="region"
          aria-label={`${label} rows`}
          tabIndex={0}
          className="max-h-[65vh] overflow-auto rounded-t-2xl focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:[outline-color:var(--focus-ring)]"
        >
          <table className="w-full border-collapse text-left text-sm" aria-busy={busy}>
            <caption className="sr-only">{label} rows</caption>
            <thead>
              <tr>
                {columns.map((col) => {
                  const active = col.sortable && sort === col.name;
                  const ariaSort = active ? (order === 'asc' ? 'ascending' : 'descending') : 'none';
                  return (
                    <th
                      key={col.name}
                      scope="col"
                      aria-sort={col.sortable ? ariaSort : undefined}
                      className="sticky top-0 z-10 whitespace-nowrap border-b border-slate-slate700 bg-[var(--glass-bg-flat)] px-3 py-2 text-xs font-semibold uppercase tracking-wide text-slate-slate400"
                    >
                      {col.sortable ? (
                        <button
                          type="button"
                          onClick={() => onSort(col)}
                          className="inline-flex items-center gap-1 rounded uppercase tracking-wide hover:text-slate-slate100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:[outline-color:var(--focus-ring)]"
                        >
                          {col.name}
                          <SortIcon state={ariaSort} />
                        </button>
                      ) : (
                        col.name
                      )}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody className={busy ? 'opacity-60' : undefined}>
              {rows.map((row, i) => (
                <tr key={row[primaryKey] ?? i} className="border-b border-slate-slate800 text-slate-slate100">
                  {columns.map((col) => (
                    <td key={col.name} className="px-3 py-2 align-top">
                      <CellValue
                        value={row[col.name]}
                        column={col}
                        amountColumn={amountColumn}
                        rowLabel={`row ${(data.page - 1) * data.pageSize + i + 1}`}
                        onExpand={setViewer}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length === 0 && (
            <div className="p-6 text-center text-sm text-slate-slate400">
              {q ? (
                <>
                  <p>No rows match “{q}”.</p>
                  <button type="button" onClick={onClearSearch} className={`${BTN} mt-3`}>
                    Clear search
                  </button>
                </>
              ) : (
                <p>No rows</p>
              )}
            </div>
          )}
        </div>
        {children}
        {viewer && (
          <ValueViewer
            title={viewer.title}
            content={viewer.content}
            trigger={viewer.trigger}
            focusFallback={() => regionRef.current?.focus()}
            onClose={() => setViewer(null)}
          />
        )}
      </div>
    </>
  );
}
