// Row normalizers (snake_case row -> API contract). Shared by the data routes and dataAccess.
import { FALLBACK_TODO_STATUS } from './todoStatus.js';

export const DEFAULT_TODO_COLUMNS = [
  { id: 'default-backlog', name: 'Backlog', order: 0, color: 'gray' },
  { id: 'default-doing', name: 'In Progress', order: 1, color: 'blue' },
  { id: 'default-done', name: 'Done', order: 2, color: 'green' },
];

export const normTxn = (r) => ({
  id: r.id,
  date: r.date,
  merchant: r.merchant,
  amount: r.amount,
  category: r.category,
  type: (r.type || '').toLowerCase(),
  createdTime: r.created_at,
});
// A todo with no stored status is implicitly in `openStatus` (the first board column's name,
// passed by callers that can read it) when open, or in 'Done' when done.
export const normTodo = (r, openStatus) => {
  const status = r.status || (r.done ? 'Done' : openStatus ?? FALLBACK_TODO_STATUS);
  return {
    id: r.id,
    title: r.title || '',
    description: r.description || '',
    done: !!r.done || status === 'Done',
    due: r.due || null,
    priority: r.priority || 'medium',
    status,
    order: typeof r.order === 'number' ? r.order : null,
    context: r.context || 'both',
    createdTime: r.created_at,
  };
};
export const normColumn = (r) => ({ id: r.id, name: r.name || '', order: typeof r.order === 'number' ? r.order : 0, color: r.color || 'gray' });
export const normJournal = (r) => ({
  id: r.id,
  title: r.title || '',
  date: r.date || r.created_at,
  body: r.body || '',
  mood: r.mood || null,
  tags: Array.isArray(r.tags) ? r.tags : [],
  context: r.context || 'both',
  createdTime: r.created_at,
});
export const normEvent = (r) => ({
  id: r.id,
  uid: r.uid || r.id,
  summary: r.summary || '(untitled)',
  description: r.description || '',
  location: r.location || '',
  start: r.start_at,
  end: r.end_at || null,
  allDay: !!r.all_day,
  source: r.source || 'manual',
  context: r.context || 'both',
  createdTime: r.created_at,
});
export const normNote = (r) => ({
  id: r.id,
  body: r.body || '',
  color: r.color || 'yellow',
  pinned: !!r.pinned,
  context: r.context || 'both',
  createdTime: r.created_at,
});
export const normBookmark = (r) => ({
  id: r.id,
  title: r.title || '',
  url: r.url || '',
  category: r.category || '',
  context: r.context || 'both',
  createdTime: r.created_at,
});
export const normFocus = (r) => ({
  id: r.id,
  kind: r.kind || 'focus',
  durationMin: r.duration_min,
  context: r.context || 'both',
  startedAt: r.started_at,
  createdTime: r.created_at,
});
export const normCountdown = (r) => ({
  id: r.id,
  title: r.title || '',
  targetDate: r.target_date,
  context: r.context || 'both',
  createdTime: r.created_at,
});
