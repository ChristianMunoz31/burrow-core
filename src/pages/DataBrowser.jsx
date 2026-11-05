import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Search } from 'lucide-react';
import { useDataTables, useTableRows } from '../hooks/useDataBrowser';
import { Skeleton } from '../components/shared/Skeleton';
import TablePicker from '../components/dataBrowser/TablePicker';
import DataGrid from '../components/dataBrowser/DataGrid';
import GridPagination from '../components/dataBrowser/GridPagination';
import { PAGE_SIZES, lastPageOf } from '../utils/dataFormat';
import SettingsLayout from '../components/settings/SettingsLayout';
import { BTN } from '../components/settings/pillStyles';
import { usePageContext } from '../contexts/PageContextContext';
import { buildDataBrowserContext } from '../utils/javiBuilders/dataBrowser';

// Lazy: TableOverview pulls recharts, so the Rows tab renders without the charts chunk.
const TableOverview = lazy(() => import('../components/dataBrowser/TableOverview'));

const DEBOUNCE_MS = 300;
const NATURAL_DESC = new Set(['date', 'timestamptz', 'numeric', 'integer', 'real', 'boolean']);
const TABS = [
  { id: 'rows', label: 'Rows' },
  { id: 'overview', label: 'Overview' },
];

const positiveInt = (raw, fallback) => {
  const n = Number(raw);
  return /^\d+$/.test(raw ?? '') && n >= 1 ? n : fallback;
};

export default function DataBrowser() {
  const [searchParams, setSearchParams] = useSearchParams();
  const tablesQuery = useDataTables();
  const tables = useMemo(() => tablesQuery.data?.tables ?? [], [tablesQuery.data]);

  const tableParam = searchParams.get('table');
  const activeTable = tables.find((t) => t.id === tableParam) ?? tables[0] ?? null;
  const tableId = activeTable?.id ?? null;
  const page = positiveInt(searchParams.get('page'), 1);
  const sizeParam = Number(searchParams.get('pageSize'));
  const pageSize = PAGE_SIZES.includes(sizeParam) ? sizeParam : PAGE_SIZES[0];
  const orderParam = searchParams.get('order');
  const order = orderParam === 'asc' || orderParam === 'desc' ? orderParam : null;
  const sort = searchParams.get('sort') || null;
  const q = searchParams.get('q') ?? '';
  const view = searchParams.get('view') === 'overview' && activeTable?.hasDateChart ? 'overview' : 'rows';

  const [qInput, setQInput] = useState(q);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);

  // Back/forward or a table switch changes q in the URL; pull the input along unless the
  // user is mid-typing (debounce pending) or the URL merely caught up with what they typed.
  useEffect(() => {
    if (timer.current === null) setQInput((cur) => (cur.trim() === q ? cur : q));
  }, [q]);

  const update = useCallback(
    (patch, { replace = false } = {}) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const [key, value] of Object.entries(patch)) {
            if (value === null || value === undefined || value === '') next.delete(key);
            else next.set(key, String(value));
          }
          return next;
        },
        { replace },
      );
    },
    [setSearchParams],
  );
  // The debounce timer outlives the render that created it. setSearchParams' functional updater
  // sees the searchParams of *that* render, so a timer-captured `update` would clobber any
  // sort/page/view change made in the meantime. Always call the latest one.
  const updateRef = useRef(update);
  useEffect(() => {
    updateRef.current = update;
  }, [update]);

  const rowsQuery = useTableRows(tableId, {
    page,
    pageSize,
    sort,
    order,
    q,
  });
  // keepPreviousData can hand back the previous table's rows for a moment; never render those.
  const data = rowsQuery.data?.table === tableId ? rowsQuery.data : null;

  // Table metadata only: row values (which can include app_state) are never registered.
  usePageContext('data-browser', () =>
    buildDataBrowserContext({
      tables,
      activeTableId: tableId,
      view,
      page,
      pageSize,
      query: q,
      total: data?.total,
      columns: data?.columns,
    }),
  );

  // A stale ?page= past the end would strand the user on an empty page; jump to the last one.
  const lastPage = data ? lastPageOf(data.total, data.pageSize) : 1;
  const overshoot = !!data && !rowsQuery.isPlaceholderData && page > lastPage;
  useEffect(() => {
    if (overshoot) update({ page: lastPage === 1 ? null : lastPage }, { replace: true });
  }, [overshoot, lastPage, update]);

  const selectTable = (id) => {
    clearTimeout(timer.current);
    timer.current = null;
    setQInput('');
    setSearchParams(new URLSearchParams({ table: id }));
  };

  const onSearchChange = (value) => {
    setQInput(value);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      updateRef.current({ q: value.trim(), page: null }, { replace: true });
    }, DEBOUNCE_MS);
  };

  const clearSearch = () => {
    clearTimeout(timer.current);
    timer.current = null;
    setQInput('');
    update({ q: null, page: null });
  };

  const resetView = () => {
    clearTimeout(timer.current);
    timer.current = null;
    setQInput('');
    setSearchParams(new URLSearchParams(tableId ? { table: tableId } : {}));
  };

  const onSort = (col) => {
    const currentSort = data?.sort;
    const currentOrder = data?.order;
    const nextOrder =
      currentSort === col.name
        ? currentOrder === 'asc'
          ? 'desc'
          : 'asc'
        : NATURAL_DESC.has(col.type)
          ? 'desc'
          : 'asc';
    update({ sort: col.name, order: nextOrder, page: null });
  };

  const onTabKeyDown = (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return; // Alt+Left belongs to Back
    if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const enabled = TABS.filter((t) => t.id === 'rows' || activeTable?.hasDateChart);
    const idx = enabled.findIndex((t) => t.id === view);
    const next =
      e.key === 'Home'
        ? enabled[0]
        : e.key === 'End'
          ? enabled[enabled.length - 1]
          : enabled[(idx + (e.key === 'ArrowRight' ? 1 : enabled.length - 1)) % enabled.length];
    update({ view: next.id === 'rows' ? null : next.id });
    document.getElementById(`data-tab-${next.id}`)?.focus();
  };

  return (
    <SettingsLayout>
      <div className="mb-5">
        <h2 className="text-xl font-bold tracking-tight text-slate-slate100">Browse your data</h2>
        <p className="mt-1 text-sm text-slate-slate400">
          Everything Burrow has saved on this computer. Read-only: nothing here can be edited.
        </p>
      </div>

      {tablesQuery.isPending ? (
        <div role="status" aria-label="Loading tables" className="glass space-y-3 rounded-2xl p-5">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-5 w-full" />
          <Skeleton className="h-5 w-2/3" />
        </div>
      ) : tablesQuery.error ? (
        <div className="glass rounded-2xl p-5">
          <p role="alert" className="text-sm text-accent-amber">
            {tablesQuery.error.code === 'not_configured'
              ? "Burrow can't open your data file. Try restarting Burrow."
              : "Couldn't load the table list."}
          </p>
          <button type="button" onClick={() => tablesQuery.refetch()} className={`${BTN} mt-3`}>
            Retry
          </button>
        </div>
      ) : tables.length === 0 ? (
        <div className="glass rounded-2xl p-5">
          <p className="text-sm text-slate-slate400">No tables are available to browse.</p>
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[14rem_minmax(0,1fr)]">
          <TablePicker tables={tables} active={tableId} onSelect={selectTable} />

          <div className="min-w-0 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h3 className="text-sm font-bold text-slate-slate100">{activeTable?.label}</h3>
              <div
                role="tablist"
                aria-label="View"
                onKeyDown={onTabKeyDown}
                className="glass-subtle flex rounded-lg p-0.5"
              >
                {TABS.map((t) => {
                  const disabled = t.id === 'overview' && !activeTable?.hasDateChart;
                  const selected = view === t.id;
                  return (
                    <button
                      key={t.id}
                      id={`data-tab-${t.id}`}
                      type="button"
                      role="tab"
                      aria-selected={selected}
                      aria-controls="data-panel"
                      tabIndex={selected ? 0 : -1}
                      disabled={disabled}
                      onClick={() => update({ view: t.id === 'rows' ? null : t.id })}
                      className={`min-h-9 rounded-md px-3 py-1 text-sm font-semibold transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:[outline-color:var(--focus-ring)] disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-0 ${
                        selected ? 'bg-slate-slateBlue text-white' : 'text-slate-slate300 hover:text-slate-slate100'
                      }`}
                    >
                      {t.label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div
              id="data-panel"
              role="tabpanel"
              tabIndex={0}
              aria-labelledby={`data-tab-${view}`}
              className="min-w-0 space-y-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:[outline-color:var(--focus-ring)]"
            >
              {view === 'overview' ? (
                <Suspense
                  fallback={
                    <div role="status" aria-label="Loading overview" className="glass space-y-3 rounded-2xl p-5">
                      <Skeleton className="h-4 w-32" />
                      <Skeleton className="h-48 w-full" />
                    </div>
                  }
                >
                  <TableOverview table={tableId} />
                </Suspense>
              ) : (
                <>
                  <div className="relative">
                    <label htmlFor="data-search" className="sr-only">
                      Search rows
                    </label>
                    <Search
                      size={14}
                      aria-hidden="true"
                      className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-slate400"
                    />
                    <input
                      id="data-search"
                      type="search"
                      value={qInput}
                      onChange={(e) => onSearchChange(e.target.value)}
                      placeholder="Search rows"
                      maxLength={100}
                      className="glass-input w-full rounded-md py-2 pl-9 pr-3 text-sm text-slate-slate100"
                    />
                  </div>
                  <DataGrid
                    data={data}
                    loading={rowsQuery.isPending}
                    busy={rowsQuery.isPlaceholderData}
                    error={rowsQuery.error}
                    sort={data?.sort}
                    order={data?.order}
                    q={q}
                    onSort={onSort}
                    onClearSearch={clearSearch}
                    onRetry={() => rowsQuery.refetch()}
                    onResetView={resetView}
                  >
                    {data && (
                      <GridPagination
                        page={data.page}
                        pageSize={data.pageSize}
                        total={data.total}
                        onPage={(p) => update({ page: p === 1 ? null : p })}
                        onPageSize={(n) =>
                          update({
                            pageSize: n === PAGE_SIZES[0] ? null : n,
                            page: null,
                          })
                        }
                      />
                    )}
                  </DataGrid>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </SettingsLayout>
  );
}
