import { clip } from '../javiContext';

/**
 * Table metadata only. Never row values (rows can include app_state).
 * @param {{ tables?: Array<object>, activeTableId?: string | null, view?: string, page?: number,
 *   pageSize?: number, query?: string, total?: number | null, columns?: Array<{name:string}> }} input
 */
export function buildDataBrowserContext({
  tables,
  activeTableId,
  view,
  page,
  pageSize,
  query,
  total,
  columns,
} = {}) {
  return {
    tables: (Array.isArray(tables) ? tables : []).slice(0, 30).map((t) => ({
      id: clip(t?.id, 60),
      label: clip(t?.label, 60),
      group: t?.group ? clip(t.group, 40) : null,
      count: Number.isFinite(t?.count) ? t.count : null,
      status: t?.status ? clip(t.status, 40) : null,
    })),
    active: {
      id: activeTableId ?? null,
      view: view ?? 'rows',
      page: page ?? 1,
      pageSize: pageSize ?? null,
      total: Number.isFinite(total) ? total : null,
      columns: (Array.isArray(columns) ? columns : []).slice(0, 30).map((c) => clip(c?.name, 60)),
    },
    searching: typeof query === 'string' && query.trim() !== '',
  };
}
