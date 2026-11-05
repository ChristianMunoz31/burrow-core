// Plain async data-access functions over the local SQLite store: the shared query layer used
// by the Jarvis tools, global search, and the daily briefing, so those features
// never duplicate the Express route queries. Reuses the row normalizers from
// normalize.js so shapes stay identical to the HTTP API. A database that cannot be
// opened surfaces as a DbError (status 503).
import { assertId, insert, nowIso, op, select, selectOne, update, updateById, upsert, withTransaction } from './db/index.js';
import { normTodo, normJournal, normEvent, normNote, normCountdown } from './normalize.js';
import { FALLBACK_TODO_STATUS, defaultTodoStatus, resolveNewTodoStatus } from './todoStatus.js';
import { localDayOf } from './relativeDay.js';

const startOfUtcDay = (d = new Date()) => `${d.toISOString().slice(0, 10)}T00:00:00.000Z`;
const addDaysIso = (iso, days) =>
  new Date(new Date(iso).getTime() + days * 24 * 60 * 60 * 1000).toISOString();

// Search terms are bound as parameters, so this only normalizes the echoed query: it drops
// punctuation that never helps a keyword match and caps the length.
const sanitizeSearch = (q) => String(q || '').replace(/[,()*%]/g, ' ').trim().slice(0, 80);

// ============================================================
// Reads
// ============================================================
export async function listTodos({ status, context, limit = 100 } = {}) {
  const openStatus = defaultTodoStatus();
  const where = {};
  // Open todos with no stored status are shown in the default column, so that filter matches them too.
  if (status === openStatus) {
    where.$or = [{ status }, { status: null, done: false }, { status: '', done: false }];
  } else if (status) where.status = status;
  if (context) where.context = context;
  const data = select('todos', {
    where,
    orderBy: [{ column: 'created_at', dir: 'asc' }, { column: 'rowid', dir: 'asc' }],
    limit,
  });
  return data.map((r) => normTodo(r, openStatus));
}

// Open (not done) todos, soonest due first — the set most useful to an assistant. The done
// filter and the due-date order run in SQL, so a done todo never uses up one of the 500 rows
// and a newer open todo is never cut off behind older finished ones.
export async function listOpenTodos({ limit = 50 } = {}) {
  const openStatus = defaultTodoStatus();
  const rows = select('todos', {
    where: { done: false },
    orderBy: [
      { column: 'due', dir: 'asc', nulls: 'last' },
      { column: 'created_at', dir: 'asc' },
      { column: 'rowid', dir: 'asc' },
    ],
    limit: 500,
  });
  return rows
    .map((r) => normTodo(r, openStatus))
    .filter((t) => !t.done)
    .sort((a, b) => {
      if (a.due && b.due) return a.due.localeCompare(b.due);
      if (a.due) return -1;
      if (b.due) return 1;
      return 0;
    })
    .slice(0, limit);
}

// Calendar events from the start of today (UTC) forward `days` days.
export async function listUpcomingEvents({ days = 7 } = {}) {
  const from = startOfUtcDay();
  const to = addDaysIso(from, days);
  const data = select('calendar_events', {
    where: { start_at: op.and(op.gte(from), op.lt(to)) },
    orderBy: [{ column: 'start_at', dir: 'asc' }, { column: 'rowid', dir: 'asc' }],
  });
  return data.map(normEvent);
}

export async function listNotes({ limit = 50 } = {}) {
  const data = select('notes', {
    columns: ['id', 'body', 'color', 'pinned', 'context', 'created_at'],
    orderBy: [{ column: 'pinned', dir: 'desc' }, { column: 'created_at', dir: 'desc' }],
    limit,
  });
  return data.map(normNote);
}

export async function listJournal({ limit = 20 } = {}) {
  const data = select('journal', {
    columns: ['id', 'title', 'date', 'body', 'mood', 'tags', 'context', 'created_at'],
    orderBy: [{ column: 'date', dir: 'desc' }, { column: 'rowid', dir: 'desc' }],
    limit,
  });
  return data.map(normJournal);
}

export async function listCountdowns({ upcomingOnly = false, limit = 50 } = {}) {
  const data = select('countdowns', {
    columns: ['id', 'title', 'target_date', 'context', 'created_at'],
    where: upcomingOnly ? { target_date: op.gte(new Date().toISOString().slice(0, 10)) } : undefined,
    orderBy: [{ column: 'target_date', dir: 'asc' }],
    limit,
  });
  return data.map(normCountdown);
}

// Habits with a `doneToday` flag — the shape an assistant / briefing wants.
export async function listHabitsToday() {
  const today = new Date().toISOString().slice(0, 10);
  const habits = select('habits', {
    columns: ['id', 'title', 'frequency', 'color', 'context', 'created_at'],
    orderBy: [{ column: 'rowid', dir: 'asc' }],
  });
  const comps = select('habit_completions', { columns: ['habit_id', 'date'], where: { date: today } });
  const doneIds = new Set(comps.map((c) => c.habit_id));
  return habits.map((h) => ({
    id: h.id,
    title: h.title || '',
    frequency: h.frequency || 'daily',
    context: h.context || 'both',
    doneToday: doneIds.has(h.id),
  }));
}

// Per-habit completion over the last `days` days (today included, UTC dates): which days
// were done and which were missed. Daily habits only count missed days on or after the
// habit was created.
export async function listHabitHistory({ days = 7 } = {}) {
  const n = Math.min(Math.max(Math.floor(Number(days)) || 7, 1), 60);
  const today = new Date();
  const dates = [];
  for (let i = n - 1; i >= 0; i -= 1) {
    dates.push(new Date(today.getTime() - i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10));
  }
  const habits = select('habits', {
    columns: ['id', 'title', 'frequency', 'created_at'],
    orderBy: [{ column: 'rowid', dir: 'asc' }],
  });
  // Completions are read a year back so currentStreak is not capped by the requested window.
  const streakFrom = new Date(today.getTime() - 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const windowFrom = streakFrom < dates[0] ? streakFrom : dates[0];
  const comps = select('habit_completions', {
    columns: ['habit_id', 'date'],
    where: { date: op.and(op.gte(windowFrom), op.lte(dates[dates.length - 1])) },
  });
  const doneBy = new Map();
  for (const c of comps) {
    if (!doneBy.has(c.habit_id)) doneBy.set(c.habit_id, new Set());
    doneBy.get(c.habit_id).add(String(c.date).slice(0, 10));
  }
  const todayIso = dates[dates.length - 1];
  // Consecutive done days ending today, or yesterday if today is not done yet (UTC dates).
  const streakOf = (done) => {
    let cursor = todayIso;
    if (!done.has(cursor)) cursor = addDaysIso(`${cursor}T00:00:00.000Z`, -1).slice(0, 10);
    let streak = 0;
    while (done.has(cursor)) {
      streak += 1;
      cursor = addDaysIso(`${cursor}T00:00:00.000Z`, -1).slice(0, 10);
    }
    return streak;
  };
  return {
    from: dates[0],
    to: todayIso,
    habits: habits.map((h) => {
      const done = doneBy.get(h.id) || new Set();
      const created = String(h.created_at || '').slice(0, 10);
      const tracked = dates.filter((d) => !created || d >= created);
      const doneDates = tracked.filter((d) => done.has(d));
      const missedDates = tracked.filter((d) => !done.has(d));
      return {
        id: h.id,
        title: h.title || '',
        frequency: h.frequency || 'daily',
        doneDates,
        missedDates,
        doneCount: doneDates.length,
        missedCount: missedDates.length,
        currentStreak: streakOf(done),
      };
    }),
  };
}

// Aggregate transactions for a month (YYYY-MM, default current UTC month) into a
// compact spend summary. amount is signed (credits +, debits -).
export async function getBudgetSummary({ month } = {}) {
  const m = /^\d{4}-\d{2}$/.test(month || '') ? month : new Date().toISOString().slice(0, 7);
  const from = `${m}-01`;
  const [y, mo] = m.split('-').map(Number);
  const next = mo === 12 ? `${y + 1}-01-01` : `${y}-${String(mo + 1).padStart(2, '0')}-01`;
  const data = select('transactions', {
    columns: ['amount', 'category', 'type', 'date'],
    where: { date: op.and(op.gte(from), op.lt(next)) },
  });

  let income = 0;
  let expenses = 0;
  const byCategory = new Map();
  for (const t of data) {
    const amt = Number(t.amount) || 0;
    if (amt >= 0) {
      income += amt;
    } else {
      const spend = Math.abs(amt);
      expenses += spend;
      const cat = t.category || 'Uncategorized';
      byCategory.set(cat, (byCategory.get(cat) || 0) + spend);
    }
  }
  const round = (n) => Math.round(n * 100) / 100;
  const topCategories = [...byCategory.entries()]
    .map(([category, spent]) => ({ category, spent: round(spent) }))
    .sort((a, b) => b.spent - a.spent)
    .slice(0, 10);
  return {
    month: m,
    income: round(income),
    expenses: round(expenses),
    net: round(income - expenses),
    transactionCount: data.length,
    topCategories,
  };
}

// One entry per searchable kind; each maps a row to a hit with a `to` route so the UI can
// jump straight to the module.
const SEARCHES = [
  {
    kind: 'todos',
    table: 'todos',
    columns: ['id', 'title', 'done', 'status'],
    search: ['title'],
    map: (r) => ({ kind: 'todo', id: r.id, title: r.title, to: '/todos', meta: r.done ? 'done' : r.status || 'open' }),
  },
  {
    kind: 'notes',
    table: 'notes',
    columns: ['id', 'body'],
    search: ['body'],
    map: (r) => ({ kind: 'note', id: r.id, title: (r.body || '').slice(0, 80), to: '/notes' }),
  },
  {
    kind: 'journal',
    table: 'journal',
    columns: ['id', 'title', 'body', 'date'],
    search: ['title', 'body'],
    map: (r) => ({
      kind: 'journal',
      id: r.id,
      title: r.title || (r.body || '').slice(0, 80),
      to: '/journal',
      meta: (r.date || '').slice(0, 10),
    }),
  },
  {
    kind: 'bookmarks',
    table: 'bookmarks',
    columns: ['id', 'title', 'url'],
    search: ['title', 'url'],
    map: (r) => ({ kind: 'bookmark', id: r.id, title: r.title, to: '/bookmarks', meta: r.url }),
  },
  {
    kind: 'countdowns',
    table: 'countdowns',
    columns: ['id', 'title', 'target_date'],
    search: ['title'],
    map: (r) => ({ kind: 'countdown', id: r.id, title: r.title, to: '/countdowns', meta: r.target_date }),
  },
  {
    kind: 'transactions',
    table: 'transactions',
    columns: ['id', 'merchant', 'amount', 'date', 'category'],
    search: ['merchant', 'category'],
    orderBy: [{ column: 'date', dir: 'desc' }, { column: 'rowid', dir: 'desc' }],
    map: (r) => ({
      kind: 'transaction',
      id: r.id,
      title: r.merchant || r.category,
      to: '/budget',
      meta: `$${Math.abs(Number(r.amount) || 0)} · ${(r.date || '').slice(0, 10)}${r.category ? ` · ${r.category}` : ''}`,
    }),
  },
];

// Cross-module keyword search (case-insensitive substring, Unicode aware). Returns hits
// grouped by kind. A kind that cannot be read yields no hits instead of failing the search.
export async function searchData({ query, kinds, limit = 6 } = {}) {
  const q = sanitizeSearch(query);
  if (!q) return { query: '', results: [] };
  const want = (kind) => !Array.isArray(kinds) || kinds.length === 0 || kinds.includes(kind);

  const results = [];
  for (const spec of SEARCHES) {
    if (!want(spec.kind)) continue;
    try {
      const rows = select(spec.table, {
        columns: spec.columns,
        search: { columns: spec.search, term: q },
        orderBy: spec.orderBy,
        limit,
      });
      results.push(...rows.map(spec.map));
    } catch {
      // best-effort: skip this kind
    }
  }
  return { query: q, results };
}

// ============================================================
// Writes (used by Jarvis tools; counted against the per-run write cap)
// ============================================================
export async function addTodo({ title, due, priority, status, context } = {}) {
  if (!title) throw Object.assign(new Error('title is required'), { status: 400 });
  const row = {
    title,
    done: status === 'Done',
    due: due || null,
    priority: priority || 'medium',
    context: context || 'both',
    status: resolveNewTodoStatus(status),
  };
  return normTodo(insert('todos', row), FALLBACK_TODO_STATUS);
}

// Complete a todo by id, or by a title substring match against open todos.
export async function completeTodo({ id, title } = {}) {
  let targetId = id;
  if (targetId !== undefined && targetId !== null && targetId !== '') {
    if (typeof targetId !== 'string' && typeof targetId !== 'number') {
      throw Object.assign(new Error('id must be a string'), { status: 400 });
    }
  }
  if (!targetId && title) {
    const open = await listOpenTodos({ limit: 200 });
    const match = open.find((t) => t.title.toLowerCase().includes(String(title).toLowerCase()));
    if (!match) throw Object.assign(new Error(`No open todo matching "${title}"`), { status: 404 });
    targetId = match.id;
  }
  if (!targetId) throw Object.assign(new Error('id or title is required'), { status: 400 });
  const data = updateById('todos', targetId, { done: true, status: 'Done' });
  if (!data) throw Object.assign(new Error('Todo not found'), { status: 404 });
  return normTodo(data, FALLBACK_TODO_STATUS); // the row is always 'Done' here
}

export async function addNote({ body, color, context } = {}) {
  if (!body) throw Object.assign(new Error('body is required'), { status: 400 });
  return normNote(insert('notes', { body, color: color || 'yellow', pinned: false, context: context || 'both' }));
}

export async function addJournalEntry({ title, body, mood, tags, context } = {}) {
  if (!body) throw Object.assign(new Error('body is required'), { status: 400 });
  const row = { body, date: nowIso() };
  if (title) row.title = title;
  if (mood) row.mood = mood;
  if (Array.isArray(tags) && tags.length) row.tags = tags;
  if (context) row.context = context;
  return normJournal(insert('journal', row));
}

export async function logHabitCompletion({ habitId, habitTitle, date } = {}) {
  let id = habitId;
  if (!id && habitTitle) {
    const habits = select('habits', { columns: ['id', 'title'], orderBy: [{ column: 'rowid', dir: 'asc' }] });
    const match = habits.find((h) =>
      (h.title || '').toLowerCase().includes(String(habitTitle).toLowerCase()),
    );
    if (!match) throw Object.assign(new Error(`No habit matching "${habitTitle}"`), { status: 404 });
    id = match.id;
  }
  if (!id) throw Object.assign(new Error('habitId or habitTitle is required'), { status: 400 });
  const day = date || new Date().toISOString().slice(0, 10);
  const data = insert('habit_completions', { habit_id: id, date: day });
  return { id: data.id, habitId: id, date: day };
}

export async function addCountdown({ title, targetDate, context } = {}) {
  if (!title) throw Object.assign(new Error('title is required'), { status: 400 });
  if (!targetDate) throw Object.assign(new Error('targetDate is required'), { status: 400 });
  return normCountdown(insert('countdowns', { title, target_date: targetDate, context: context || 'both' }));
}

// ============================================================
// App state (key/value): provider choice, briefing cache, notifications, profile, network opt-ins
// ============================================================
export async function getState(key, fallback = null) {
  const row = selectOne('app_state', { columns: ['value'], where: { key } });
  return row ? row.value : fallback;
}

export async function setState(key, value) {
  const row = upsert('app_state', { key, value, updated_at: nowIso() }, { conflict: ['key'] });
  return { key: row.key, value: row.value };
}

// ============================================================
// Jarvis conversations + long-term memory facts
// ============================================================
const toConversation = (r) => ({ id: r.id, title: r.title, createdTime: r.created_at, updatedTime: r.updated_at });

export async function createConversation({ title } = {}) {
  return toConversation(insert('jarvis_conversations', { title: title || null }));
}

export async function listConversations({ limit = 30 } = {}) {
  return select('jarvis_conversations', {
    columns: ['id', 'title', 'created_at', 'updated_at'],
    orderBy: [{ column: 'updated_at', dir: 'desc' }, { column: 'rowid', dir: 'desc' }],
    limit,
  }).map(toConversation);
}

export async function getMessages(conversationId, { limit = 40 } = {}) {
  assertId(conversationId, 'conversationId');
  const data = select('jarvis_messages', {
    columns: ['id', 'role', 'content', 'tool_calls', 'tool_call_id', 'created_at'],
    where: { conversation_id: conversationId },
    // Newest N (rowid keeps same-millisecond turns ordered), reversed below to chronological.
    orderBy: [{ column: 'created_at', dir: 'desc' }, { column: 'rowid', dir: 'desc' }],
    limit,
  });
  data.reverse();
  return data.map((r) => ({
    id: r.id,
    role: r.role,
    content: r.content,
    toolCalls: r.tool_calls || null,
    toolCallId: r.tool_call_id || null,
    createdTime: r.created_at,
  }));
}

/**
 * Every row of a conversation, oldest first, with only the columns cloud taint detection needs
 * (no content). The history window alone can start after a withheld turn.
 */
export async function getConversationTaintRows(conversationId) {
  assertId(conversationId, 'conversationId');
  const data = select('jarvis_messages', {
    columns: ['id', 'role', 'tool_calls', 'tool_call_id'],
    where: { conversation_id: conversationId },
    orderBy: [{ column: 'created_at', dir: 'asc' }, { column: 'rowid', dir: 'asc' }],
  });
  return data.map((r) => ({ id: r.id, role: r.role, toolCalls: r.tool_calls ?? null, toolCallId: r.tool_call_id || null }));
}

export async function appendMessage(conversationId, { role, content, toolCalls, toolCallId } = {}) {
  assertId(conversationId, 'conversationId');
  withTransaction(() => {
    insert('jarvis_messages', {
      conversation_id: conversationId,
      role,
      content: content ?? null,
      tool_calls: toolCalls || null,
      tool_call_id: toolCallId || null,
    });
    // Touch the conversation so it sorts to the top of the recent list.
    update('jarvis_conversations', { updated_at: nowIso() }, { where: { id: conversationId } });
  });
}

export async function listMemory({ limit = 100 } = {}) {
  const data = select('jarvis_memory', {
    columns: ['id', 'fact', 'category', 'weight', 'created_at'],
    orderBy: [{ column: 'weight', dir: 'desc' }, { column: 'rowid', dir: 'asc' }],
    limit,
  });
  return data.map((r) => ({ id: r.id, fact: r.fact, category: r.category, weight: r.weight }));
}

export async function upsertMemoryFact({ fact, category, weight, sourceConversationId } = {}) {
  if (!fact) throw Object.assign(new Error('fact is required'), { status: 400 });
  const data = insert('jarvis_memory', {
    fact,
    category: category || 'general',
    weight: typeof weight === 'number' ? weight : 1.0,
    source_conversation_id: sourceConversationId || null,
  });
  return { id: data.id, fact: data.fact, category: data.category };
}

// ============================================================
// Daily briefing context: the local-database slice of the morning digest.
// (Weather + health are added by jarvisAgent.runBriefing via integrations.)
// Each gather is individually fault-tolerant so one failing read does not sink
// the whole briefing.
// ============================================================
export async function buildBriefingContext() {
  // The server-local day, the same clock the "when" texts of the briefing snapshot use, so
  // overdue/due-today and "when" never disagree around midnight UTC.
  const today = localDayOf();
  const [events, openTodos, habits, countdowns, budget] = await Promise.all([
    listUpcomingEvents({ days: 1 }).catch(() => []),
    listOpenTodos({ limit: 25 }).catch(() => []),
    listHabitsToday().catch(() => []),
    listCountdowns({ upcomingOnly: true, limit: 10 }).catch(() => []),
    getBudgetSummary({}).catch(() => null),
  ]);
  const daysUntil = (d) => Math.ceil((new Date(`${d}T00:00:00Z`) - new Date(`${today}T00:00:00Z`)) / 86400000);
  const overdueTodos = openTodos.filter((t) => t.due && t.due < today);
  const dueTodayTodos = openTodos.filter((t) => t.due === today);
  const habitsRemaining = habits.filter((h) => !h.doneToday);
  return {
    today,
    events,
    // Overdue and due-today todos are listed on their own: leave them out before the cap so
    // they do not use up the ten slots.
    openTodos: openTodos.filter((t) => !(t.due && t.due <= today)).slice(0, 10),
    overdueTodos,
    overdueCount: overdueTodos.length,
    dueTodayTodos,
    dueTodayCount: dueTodayTodos.length,
    habitsRemaining,
    habitsRemainingCount: habitsRemaining.length,
    soonCountdowns: countdowns.filter((c) => {
      const n = daysUntil(c.targetDate);
      return n >= 0 && n <= 14;
    }),
    budget,
  };
}
