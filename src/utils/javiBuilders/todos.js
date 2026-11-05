import { clip, localDay } from '../javiContext';
import { dueStatus } from '../relativeDay';
import { statusContext } from './_status';

const day = (v) => (v ? String(v).slice(0, 10) : null);

/**
 * Keys are plain words (small models echo key names into advice), and every item carries a
 * precomputed `status` such as "overdue by 3 days" so the model never does date arithmetic.
 * @param {{ todos?: Array<object>, loading?: boolean, error?: unknown, now?: Date }} input
 */
export function buildTodosContext({ todos, loading, error, now = new Date() } = {}) {
  const early = statusContext({ loading, error });
  if (early) return early;
  const list = Array.isArray(todos) ? todos : [];
  const today = localDay(now);
  const weekEnd = localDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 7));
  const open = list.filter((t) => !t?.done);
  const byColumn = {};
  for (const t of open) {
    const k = clip(t?.status || 'none', 40);
    byColumn[k] = (byColumn[k] ?? 0) + 1;
  }
  const byDue = (a, b) => String(day(a.due)).localeCompare(String(day(b.due)));
  const dueRow = (t) => ({
    title: clip(t.title, 120),
    status: dueStatus(day(t.due), today),
    due: day(t.due),
    priority: t.priority == null ? null : clip(t.priority, 20),
  });
  const overdue = open.filter((t) => day(t.due) && day(t.due) < today).sort(byDue);
  const dueSoon = open
    .filter((t) => day(t.due) && day(t.due) >= today && day(t.due) <= weekEnd)
    .sort(byDue);
  const highPriority = open.filter((t) => String(t.priority).toLowerCase() === 'high');
  return {
    // The lists below are capped, so every one has its full count here and the model never counts rows.
    counts: {
      total: list.length,
      open: open.length,
      done: list.length - open.length,
      'overdue count': overdue.length,
      'due this week count': dueSoon.length,
      'high priority count': highPriority.length,
      'by column': byColumn,
    },
    overdue: overdue.slice(0, 10).map(dueRow),
    'due this week': dueSoon.slice(0, 10).map(dueRow),
    'high priority': highPriority.slice(0, 10).map((t) => ({
      title: clip(t.title, 120),
      status: day(t.due) ? dueStatus(day(t.due), today) : 'no due date',
      due: day(t.due),
      column: t.status == null ? null : clip(t.status, 40),
    })),
  };
}
