// Pure helpers for the Kanban board. Keep DOM- and React-free so they're
// easy to unit-test.

// Sort comparator for cards within a column: by numeric `order` ascending,
// nulls (never-reordered cards) last, tie-broken by createdTime so ordering is
// stable and backend-agnostic (no reliance on server row order).
function compareTodos(a, b) {
  const ao = typeof a?.order === 'number' ? a.order : Infinity;
  const bo = typeof b?.order === 'number' ? b.order : Infinity;
  if (ao !== bo) return ao - bo;
  const at = a?.createdTime || '';
  const bt = b?.createdTime || '';
  if (at < bt) return -1;
  if (at > bt) return 1;
  return 0;
}

// A todo with no status at all (legacy data) is implicitly in the FIRST column, whatever it is
// called now (a column named exactly 'Done' is never the default, so open todos never read as
// done; mirrors server/todoStatus.js). The server already fills this in; this keeps the board
// correct if one slips through. A status that names no column stays unmapped on purpose ("No column").
function effectiveStatus(todo, columns) {
  const status = todo?.status;
  if (status) return status;
  return todo?.done ? undefined : columns.find((c) => c?.name && c.name !== 'Done')?.name;
}

// Bucket todos by their `status` field, keyed on column.name. Columns with no
// matching todos still get an empty array entry, so the UI can render them.
// Each bucket is sorted by `order` (see compareTodos). Todos whose status
// doesn't match any column land in an extra '__orphan__' bucket so we don't
// silently drop them on the floor.
export function groupByColumn(todos = [], columns = []) {
  const map = new Map();
  for (const col of columns) {
    map.set(col.name, []);
  }
  const orphans = [];
  for (const todo of todos) {
    const name = effectiveStatus(todo, columns);
    if (name && map.has(name)) {
      map.get(name).push(todo);
    } else {
      orphans.push(todo);
    }
  }
  for (const list of map.values()) {
    list.sort(compareTodos);
  }
  if (orphans.length > 0) {
    map.set('__orphan__', orphans.sort(compareTodos));
  }
  return map;
}

// Compute the persisted ordering after a drag. Given the current todos, the
// columns, the dragged card id, and a normalized `over` descriptor, returns an
// array of `{ id, status, order }` for every card whose status or order
// changes (target column always re-stamped; source column too on a cross-column
// move). Returns [] when the drag is a no-op.
//
// `over` shapes: { type: 'column', columnName } or { type: 'todo', id, status }.
export function computeTodoReorder(todos = [], columns = [], activeId, over) {
  if (!over || activeId == null) return [];
  if (over.type === 'todo' && over.id === activeId) return [];

  const active = todos.find((t) => t.id === activeId);
  if (!active) return [];

  const grouped = groupByColumn(todos, columns);
  const sourceCol = effectiveStatus(active, columns);

  let targetCol;
  let targetIndex;
  if (over.type === 'column') {
    targetCol = over.columnName;
    const list = (grouped.get(targetCol) || []).filter((t) => t.id !== activeId);
    targetIndex = list.length;
  } else if (over.type === 'todo') {
    targetCol = over.status;
    const list = (grouped.get(targetCol) || []).filter((t) => t.id !== activeId);
    targetIndex = list.findIndex((t) => t.id === over.id);
    if (targetIndex < 0) targetIndex = list.length;
  } else {
    return [];
  }
  if (!targetCol) return [];

  const targetIds = (grouped.get(targetCol) || [])
    .filter((t) => t.id !== activeId)
    .map((t) => t.id);
  const idx = Math.max(0, Math.min(targetIndex, targetIds.length));
  targetIds.splice(idx, 0, activeId);

  const items = targetIds.map((id, i) => ({ id, status: targetCol, order: i }));

  if (sourceCol !== targetCol) {
    const sourceIds = (grouped.get(sourceCol) || [])
      .filter((t) => t.id !== activeId)
      .map((t) => t.id);
    sourceIds.forEach((id, i) => items.push({ id, status: sourceCol, order: i }));
  }

  const byId = new Map(todos.map((t) => [t.id, t]));
  const changed = items.some((it) => {
    const t = byId.get(it.id);
    return !t || t.status !== it.status || t.order !== it.order;
  });
  return changed ? items : [];
}

// Pick the next `order` value for a new column. Returns 0 when there are no
// columns yet, otherwise (max + 1) so it lands at the end.
export function nextOrder(columns = []) {
  if (!Array.isArray(columns) || columns.length === 0) return 0;
  let max = -Infinity;
  for (const col of columns) {
    const v = typeof col?.order === 'number' ? col.order : -Infinity;
    if (v > max) max = v;
  }
  return Number.isFinite(max) ? max + 1 : 0;
}

// Move a column from one index to another, then re-stamp `order` so that the
// returned list is already in canonical sort order. Out-of-range indexes are
// clamped; returns a new array (does not mutate input).
export function reorderColumns(columns = [], fromIdx, toIdx) {
  if (!Array.isArray(columns) || columns.length === 0) return [];
  const n = columns.length;
  const from = Math.max(0, Math.min(n - 1, fromIdx));
  const to = Math.max(0, Math.min(n - 1, toIdx));
  const next = columns.slice();
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next.map((col, idx) => ({ ...col, order: idx }));
}
