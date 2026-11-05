// The default todo status. todos.status holds a column NAME as plain text (no FK), so a todo
// created without a status must be given the first board column's current name; a hardcoded
// 'Backlog' stops matching any column once the owner renames it.
import { select } from './db/index.js';

export const FALLBACK_TODO_STATUS = 'Backlog';

/**
 * Board order for todo_columns rows fetched in rowid order: `order` ascending with NULL counted as 0
 * (like the client), ties by insertion. Array.prototype.sort is stable, so rowid order is kept on ties.
 */
export const sortTodoColumns = (rows) => rows.slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

/** All todo columns (full rows) in board order. */
export function listTodoColumns({ db } = {}) {
  return sortTodoColumns(select('todo_columns', { orderBy: [{ column: 'rowid' }], db }));
}

/**
 * First board column by order that can hold open todos, or null when there is none. A column
 * named exactly 'Done' is skipped: a status-less open todo must never read as done.
 */
export function firstTodoColumn({ db } = {}) {
  const col = listTodoColumns({ db }).find((c) => typeof c.name === 'string' && c.name && c.name !== 'Done');
  return col ?? null;
}

/** Status for a not-done todo with no status: the first column's name, else 'Backlog'. */
export function defaultTodoStatus({ db } = {}) {
  return firstTodoColumn({ db })?.name ?? FALLBACK_TODO_STATUS;
}

/** Status for a new todo: the given one if it is a non-blank string, else the default column. */
export function resolveNewTodoStatus(status) {
  return typeof status === 'string' && status.trim() ? status : defaultTodoStatus();
}
