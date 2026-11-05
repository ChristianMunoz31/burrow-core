// SQLite-backed implementations of the data routes (server/db).
// Registered in server.js; every route 503s when the local database cannot be opened.
//
// Every handler returns the JSON shape the frontend services/hooks expect.
import {
  assertId,
  httpErrorFor,
  insert,
  insertMany,
  nowIso,
  op,
  pingDb,
  remove,
  select,
  selectOne,
  toDbError,
  update,
  updateById,
  upsert,
  withTransaction,
} from './db/index.js';
import { HIDDEN_APP_STATE_KEYS } from './dataBrowser/redact.js';
import { isStateRouteDeniedKey } from './import/importExport.js';
import {
  DEFAULT_TODO_COLUMNS,
  normBookmark,
  normColumn,
  normCountdown,
  normEvent,
  normFocus,
  normJournal,
  normNote,
  normTodo,
  normTxn,
} from './normalize.js';
import { FALLBACK_TODO_STATUS, defaultTodoStatus, firstTodoColumn, listTodoColumns, resolveNewTodoStatus } from './todoStatus.js';

// node-ical is only needed for the ICS import, so it loads on first use (the promise is cached; a failed
// load is not, so a later import can retry).
let icalModule = null;
function loadIcal() {
  if (!icalModule) {
    icalModule = import('node-ical').then(
      (mod) => mod.default ?? mod,
      (e) => {
        icalModule = null;
        throw e;
      },
    );
  }
  return icalModule;
}

const UNAVAILABLE_BODY = { error: 'Local database is unavailable.' };

// Maps a data-layer failure to a fixed, leak-free response. Only the error code is logged.
const fail = (res, e) => {
  const d = toDbError(e);
  const { status, error } = httpErrorFor(d);
  if (status >= 500) console.error('Data route error:', d.code);
  return res.status(status).json({ error });
};

const notFound = (res) => res.status(404).json({ error: 'Not found' });

// Wraps an async handler so any throw becomes a fail() response. Express 5 leaves req.body undefined
// when no parser ran (no body or no JSON content type); handlers read it as an object, so default it.
const route = (handler) => async (req, res) => {
  try {
    req.body ??= {};
    await handler(req, res);
  } catch (e) {
    fail(res, e);
  }
};

// List GETs would otherwise stream an entire table. Apply a high safety ceiling
// (never truncates realistic personal-data volumes) plus opt-in ?limit/?offset
// pagination, layered AFTER the query's own ordering so ranges stay stable.
const LIST_CEILING = 5000;
const MAX_DELETE_IDS = 1000;
export function parseRange(req) {
  const rawLimit = Number(req.query?.limit);
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), LIST_CEILING) : LIST_CEILING;
  const rawOffset = Number(req.query?.offset);
  const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0;
  return { limit, offset };
}

const habitBody = (h) => ({
  id: h.id,
  title: h.title,
  frequency: h.frequency,
  color: h.color,
  context: h.context,
  completions: [],
  createdTime: h.created_at,
});

const DAY_MS = 24 * 60 * 60 * 1000;

// Give open todos with no stored status (NULL or '') an explicit status.
const stampLegacyOpenTodos = (status) =>
  update('todos', { status }, { where: { $or: [{ status: null, done: false }, { status: '', done: false }] } });

export function registerDataRoutes(app) {
  // When the database cannot be opened (unwritable data dir, corrupt file, file newer
  // than this app), short-circuit this module's routes with the documented 503.
  const DATA_PATHS = [
    '/api/transactions',
    '/api/todos',
    '/api/todo-columns',
    '/api/habits',
    '/api/journal',
    '/api/calendar',
    '/api/notes',
    '/api/bookmarks',
    '/api/focus',
    '/api/countdowns',
    '/api/state',
  ];
  app.use(DATA_PATHS, (req, res, next) => {
    // pingDb never throws: false covers both a failed open and a closed handle.
    if (!pingDb()) return res.status(503).json(UNAVAILABLE_BODY);
    next();
  });

  // ===== Transactions =====
  app.get(
    '/api/transactions',
    route(async (req, res) => {
      // The id sort is a tiebreaker so same-date rows page stably; ?offset counts from the newest row.
      // Fetched newest-first so the safety ceiling drops the oldest rows; flip back
      // so consumers still receive ascending order.
      const data = select('transactions', {
        columns: ['id', 'date', 'merchant', 'amount', 'category', 'type', 'created_at'],
        orderBy: [
          { column: 'date', dir: 'desc' },
          { column: 'id', dir: 'desc' },
        ],
        ...parseRange(req),
      });
      res.json(data.reverse().map(normTxn));
    }),
  );

  app.post(
    '/api/transactions',
    route(async (req, res) => {
      const { records } = req.body || {};
      if (!Array.isArray(records)) {
        return res.status(400).json({ error: 'records must be an array' });
      }
      const rows = records.map((t) => {
        const isCredit = (t.type || 'debit').toLowerCase() === 'credit';
        const absAmount = Math.abs(Number(t.amount) || 0);
        return {
          date: t.date,
          merchant: t.merchant,
          amount: isCredit ? absAmount : -absAmount,
          category: t.category,
          type: (t.type || 'debit').toLowerCase(),
        };
      });
      res.json(insertMany('transactions', rows).map(normTxn));
    }),
  );

  app.delete(
    '/api/transactions',
    route(async (req, res) => {
      const { recordIds } = req.body || {};
      const ids = Array.isArray(recordIds) ? recordIds : [];
      if (ids.length > MAX_DELETE_IDS) {
        return res.status(400).json({ error: `recordIds is limited to ${MAX_DELETE_IDS} per request` });
      }
      remove('transactions', { where: { id: op.in(ids) } });
      res.json({ success: true });
    }),
  );

  // ===== Todo columns =====
  app.get(
    '/api/todo-columns',
    route(async (req, res) => {
      // Seed the defaults as real rows on first use so columns are editable and
      // persisted (the hardcoded defaults have no stored id, so they can't be edited).
      const columns = withTransaction(() => {
        const existing = listTodoColumns();
        if (existing.length > 0) return existing;
        insertMany(
          'todo_columns',
          DEFAULT_TODO_COLUMNS.map(({ name, order, color }) => ({ name, order, color })),
        );
        return listTodoColumns();
      });
      res.json({ columns: columns.map(normColumn), source: 'local', writable: true });
    }),
  );

  app.post(
    '/api/todo-columns',
    route(async (req, res) => {
      const { name, order, color } = req.body || {};
      if (!name) return res.status(400).json({ error: 'name is required' });
      // A new column placed before the current first one must not pull status-less open todos
      // into it: pin them to the old first column's name.
      const row = withTransaction(() => {
        const oldFirst = firstTodoColumn();
        const inserted = insert('todo_columns', { name, order: typeof order === 'number' ? order : 99, color: color || 'gray' });
        if (oldFirst && firstTodoColumn()?.id !== oldFirst.id) stampLegacyOpenTodos(oldFirst.name);
        return inserted;
      });
      res.json(normColumn(row));
    }),
  );

  app.patch(
    '/api/todo-columns/:id',
    route(async (req, res) => {
      const fields = {};
      if ('name' in req.body) {
        const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
        if (!name) return res.status(400).json({ error: 'name is required' });
        fields.name = name;
      }
      if ('order' in req.body) fields.order = req.body.order;
      if ('color' in req.body) fields.color = req.body.color;
      // todos.status holds the column name as plain text (no FK), so a rename moves the
      // column's todos in the same transaction. A todo with no status is implicitly in
      // the first column (not done) or Done (done), so those follow a rename of that column too.
      const result = withTransaction(() => {
        const cur = selectOne('todo_columns', { where: { id: req.params.id } });
        if (!cur) return { notFound: true };
        const renamed = fields.name !== undefined && fields.name !== cur.name;
        if (renamed) {
          const lower = fields.name.toLowerCase();
          const taken = select('todo_columns', { columns: ['id', 'name'] }).some(
            (c) => c.id !== cur.id && typeof c.name === 'string' && c.name.toLowerCase() === lower,
          );
          if (taken) return { taken: true };
        }
        const oldFirst = firstTodoColumn();
        const row = updateById('todo_columns', req.params.id, fields);
        if (renamed) {
          const matches = [{ status: cur.name }];
          // normTodo treats an empty-string status like NULL, so both are implicit members.
          if (cur.name === 'Done') matches.push({ status: null, done: true }, { status: '', done: true });
          update('todos', { status: fields.name }, { where: { $or: matches } });
        }
        // Status-less open todos are implicit members of the first column. If the first column
        // changes (reorder) or is renamed, pin them to the old first column's final name so they
        // do not silently follow the new first column.
        if (oldFirst) {
          const oldIsPatched = oldFirst.id === cur.id;
          const firstChanged = firstTodoColumn()?.id !== oldFirst.id;
          if (firstChanged || (oldIsPatched && renamed)) {
            stampLegacyOpenTodos(oldIsPatched ? (fields.name ?? cur.name) : oldFirst.name);
          }
        }
        return { row };
      });
      if (result.notFound) return notFound(res);
      if (result.taken) {
        return res.status(409).json({
          error: 'column_name_taken',
          code: 'column_name_taken',
          message: 'A column with that name already exists.',
        });
      }
      res.json(normColumn(result.row));
    }),
  );

  app.delete(
    '/api/todo-columns/:id',
    route(async (req, res) => {
      // Status-less open todos are implicit members of the first column; keep them under its name
      // (they then show under "No column", like todos explicitly in that column).
      withTransaction(() => {
        const first = firstTodoColumn();
        if (first && String(first.id) === String(req.params.id)) stampLegacyOpenTodos(first.name);
        remove('todo_columns', { where: { id: req.params.id } });
      });
      res.json({ success: true });
    }),
  );

  // ===== Todos =====
  app.get(
    '/api/todos',
    route(async (req, res) => {
      const data = select('todos', {
        orderBy: [{ column: 'created_at', dir: 'asc' }, { column: 'rowid' }],
        ...parseRange(req),
      });
      const openStatus = defaultTodoStatus();
      res.json(data.map((r) => normTodo(r, openStatus)));
    }),
  );

  app.post(
    '/api/todos',
    route(async (req, res) => {
      const { title, description, due, priority, status, context } = req.body || {};
      if (!title) return res.status(400).json({ error: 'title is required' });

      const row = {
        title,
        done: status === 'Done',
        due: due || null,
        priority: priority || 'medium',
        context: context || 'both',
        status: resolveNewTodoStatus(status),
      };
      if (description) row.description = description;
      res.json(normTodo(insert('todos', row), FALLBACK_TODO_STATUS));
    }),
  );

  // Bulk reorder for the Kanban board. Body: { items: [{ id, status, order }] }.
  // Registered before /api/todos/:id so "reorder" isn't captured as an id.
  app.patch(
    '/api/todos/reorder',
    route(async (req, res) => {
      const items = Array.isArray(req.body?.items) ? req.body.items : [];
      // One transaction for the whole drag: all cards move or none do. Unknown ids are skipped.
      withTransaction(() => {
        for (const item of items) {
          if (!item?.id) continue;
          assertId(item.id, 'item id');
          const f = { order: typeof item.order === 'number' ? item.order : null };
          if ('status' in item) {
            f.status = item.status;
            f.done = item.status === 'Done';
          }
          update('todos', f, { where: { id: item.id } });
        }
      });
      res.json({ success: true });
    }),
  );

  app.patch(
    '/api/todos/:id',
    route(async (req, res) => {
      const f = {};
      if ('title' in req.body) f.title = req.body.title;
      if ('description' in req.body) f.description = req.body.description ?? '';
      if ('done' in req.body) f.done = !!req.body.done;
      if ('due' in req.body) f.due = req.body.due || null;
      if ('priority' in req.body) f.priority = req.body.priority;
      if ('status' in req.body) {
        f.status = req.body.status;
        f.done = req.body.status === 'Done';
      }
      if ('order' in req.body) f.order = req.body.order;
      if ('context' in req.body) f.context = req.body.context;
      const row = updateById('todos', req.params.id, f);
      if (!row) return notFound(res);
      res.json(normTodo(row, defaultTodoStatus()));
    }),
  );

  app.delete(
    '/api/todos/:id',
    route(async (req, res) => {
      remove('todos', { where: { id: req.params.id } });
      res.json({ success: true });
    }),
  );

  // ===== Habits (+ completions) =====
  app.get(
    '/api/habits',
    route(async (req, res) => {
      const horizon = new Date(Date.now() - 62 * DAY_MS).toISOString().slice(0, 10);
      const habits = select('habits', {
        columns: ['id', 'title', 'frequency', 'color', 'context', 'created_at'],
        orderBy: [{ column: 'rowid' }],
      });
      const comps = select('habit_completions', {
        columns: ['habit_id', 'date'],
        where: { date: op.gte(horizon) },
      });
      const byHabit = new Map();
      for (const c of comps) {
        if (!byHabit.has(c.habit_id)) byHabit.set(c.habit_id, []);
        byHabit.get(c.habit_id).push(c.date);
      }
      for (const arr of byHabit.values()) arr.sort();
      res.json(
        habits.map((h) => ({
          id: h.id,
          title: h.title || '',
          frequency: h.frequency || 'daily',
          color: h.color || 'blue',
          context: h.context || 'both',
          completions: byHabit.get(h.id) || [],
          createdTime: h.created_at,
        })),
      );
    }),
  );

  app.post(
    '/api/habits',
    route(async (req, res) => {
      const { title, frequency, color, context } = req.body || {};
      if (!title) return res.status(400).json({ error: 'title is required' });
      const row = insert('habits', {
        title,
        frequency: frequency || 'daily',
        color: color || 'blue',
        context: context || 'both',
      });
      res.json(habitBody(row));
    }),
  );

  app.patch(
    '/api/habits/:id',
    route(async (req, res) => {
      const f = {};
      for (const k of ['title', 'frequency', 'color', 'context']) if (k in req.body) f[k] = req.body[k];
      const row = updateById('habits', req.params.id, f);
      if (!row) return notFound(res);
      res.json(habitBody(row));
    }),
  );

  app.delete(
    '/api/habits/:id',
    route(async (req, res) => {
      // FK cascade removes the habit's completions.
      remove('habits', { where: { id: req.params.id } });
      res.json({ success: true });
    }),
  );

  app.post(
    '/api/habits/:id/completions',
    route(async (req, res) => {
      const date = req.body?.date || new Date().toISOString().slice(0, 10);
      // An unknown habit id violates the foreign key and answers 400.
      const row = insert('habit_completions', { habit_id: req.params.id, date });
      res.json({ id: row.id, date: row.date, habitId: req.params.id });
    }),
  );

  app.delete(
    '/api/habits/:id/completions',
    route(async (req, res) => {
      const date = req.query.date;
      if (!date) return res.status(400).json({ error: 'date query param required' });
      // Express parses ?date[gte]=x into an object; only a plain string date is accepted.
      if (typeof date !== 'string') return res.status(400).json({ error: 'date must be a string' });
      remove('habit_completions', { where: { habit_id: req.params.id, date } });
      res.json({ success: true });
    }),
  );

  // ===== Journal =====
  app.get(
    '/api/journal',
    route(async (req, res) => {
      const data = select('journal', {
        columns: ['id', 'title', 'date', 'body', 'mood', 'tags', 'context', 'created_at'],
        orderBy: [{ column: 'date', dir: 'desc' }, { column: 'rowid', dir: 'desc' }],
        ...parseRange(req),
      });
      res.json(data.map(normJournal));
    }),
  );

  app.post(
    '/api/journal',
    route(async (req, res) => {
      const { title, body, mood, tags, context, date } = req.body || {};
      if (!body) return res.status(400).json({ error: 'body is required' });
      const row = { body, date: date || nowIso() };
      if (title) row.title = title;
      if (mood) row.mood = mood;
      if (Array.isArray(tags) && tags.length) row.tags = tags;
      if (context) row.context = context;
      res.json(normJournal(insert('journal', row)));
    }),
  );

  app.patch(
    '/api/journal/:id',
    route(async (req, res) => {
      const f = {};
      if ('title' in req.body) f.title = req.body.title;
      if ('body' in req.body) f.body = req.body.body;
      if ('mood' in req.body) f.mood = req.body.mood;
      if ('tags' in req.body) f.tags = Array.isArray(req.body.tags) ? req.body.tags : [];
      if ('context' in req.body) f.context = req.body.context;
      if ('date' in req.body) f.date = req.body.date;
      const row = updateById('journal', req.params.id, f);
      if (!row) return notFound(res);
      res.json(normJournal(row));
    }),
  );

  app.delete(
    '/api/journal/:id',
    route(async (req, res) => {
      remove('journal', { where: { id: req.params.id } });
      res.json({ success: true });
    }),
  );

  // ===== Calendar events =====
  // A blank, user-owned calendar: events are added by hand here and/or imported
  // from .ics files. Returns the same { events: [...] } shape the read-only iCal
  // route used, so the existing widget keeps working.
  app.get(
    '/api/calendar',
    route(async (req, res) => {
      const data = select('calendar_events', {
        columns: ['id', 'summary', 'description', 'location', 'start_at', 'end_at', 'all_day', 'source', 'uid', 'context', 'created_at'],
        orderBy: [{ column: 'start_at', dir: 'asc' }, { column: 'rowid' }],
        ...parseRange(req),
      });
      res.json({ events: data.map(normEvent) });
    }),
  );

  app.post(
    '/api/calendar/events',
    route(async (req, res) => {
      const { summary, description, location, start, end, allDay, context } = req.body || {};
      if (!summary) return res.status(400).json({ error: 'summary is required' });
      if (!start) return res.status(400).json({ error: 'start is required' });
      const row = insert('calendar_events', {
        summary,
        description: description || '',
        location: location || '',
        start_at: start,
        end_at: end || null,
        all_day: !!allDay,
        source: 'manual',
        context: context || 'both',
      });
      res.json(normEvent(row));
    }),
  );

  app.patch(
    '/api/calendar/events/:id',
    route(async (req, res) => {
      const f = {};
      if ('summary' in req.body) f.summary = req.body.summary;
      if ('description' in req.body) f.description = req.body.description || '';
      if ('location' in req.body) f.location = req.body.location || '';
      if ('start' in req.body) f.start_at = req.body.start;
      if ('end' in req.body) f.end_at = req.body.end || null;
      if ('allDay' in req.body) f.all_day = !!req.body.allDay;
      if ('context' in req.body) f.context = req.body.context;
      const row = updateById('calendar_events', req.params.id, f);
      if (!row) return notFound(res);
      res.json(normEvent(row));
    }),
  );

  app.delete(
    '/api/calendar/events/:id',
    route(async (req, res) => {
      remove('calendar_events', { where: { id: req.params.id } });
      res.json({ success: true });
    }),
  );

  // Import an .ics file: the client uploads raw iCalendar text, we parse the
  // VEVENTs and insert any whose UID isn't already stored (so re-importing the
  // same file is a no-op rather than creating duplicates).
  app.post(
    '/api/calendar/import',
    route(async (req, res) => {
      const { ics, context } = req.body || {};
      if (!ics || typeof ics !== 'string') {
        return res.status(400).json({ error: 'ics text is required' });
      }
      if (ics.length > 500_000) {
        return res.status(413).json({ error: 'ICS file too large (max 500 KB)' });
      }
      const ical = await loadIcal();
      const parsed = ical.async ? await ical.async.parseICS(ics) : ical.parseICS(ics);
      const rows = [];
      for (const key of Object.keys(parsed)) {
        const ev = parsed[key];
        if (!ev || ev.type !== 'VEVENT' || !ev.start) continue;
        const allDay = ev.datetype === 'date' || !!ev.start.dateOnly;
        rows.push({
          summary: ev.summary || '(untitled)',
          description: ev.description || '',
          location: ev.location || '',
          start_at: new Date(ev.start).toISOString(),
          end_at: ev.end ? new Date(ev.end).toISOString() : null,
          all_day: allDay,
          source: 'ics',
          uid: ev.uid || null,
          context: context || 'both',
        });
      }
      if (rows.length === 0) {
        return res.json({ imported: 0, skipped: 0 });
      }

      const incomingUids = rows.map((r) => r.uid).filter(Boolean);
      const freshCount = withTransaction(() => {
        let existing = new Set();
        if (incomingUids.length) {
          existing = new Set(
            select('calendar_events', { columns: ['uid'], where: { uid: op.in(incomingUids) } }).map((d) => d.uid),
          );
        }
        const fresh = rows.filter((r) => !r.uid || !existing.has(r.uid));
        if (fresh.length) insertMany('calendar_events', fresh);
        return fresh.length;
      });
      res.json({ imported: freshCount, skipped: rows.length - freshCount });
    }),
  );

  // ===== Notes =====
  app.get(
    '/api/notes',
    route(async (req, res) => {
      const data = select('notes', {
        columns: ['id', 'body', 'color', 'pinned', 'context', 'created_at'],
        orderBy: [
          { column: 'pinned', dir: 'desc' },
          { column: 'created_at', dir: 'desc' },
          { column: 'rowid', dir: 'desc' },
        ],
        ...parseRange(req),
      });
      res.json(data.map(normNote));
    }),
  );

  app.post(
    '/api/notes',
    route(async (req, res) => {
      const { body, color, pinned, context } = req.body || {};
      if (!body) return res.status(400).json({ error: 'body is required' });
      const row = insert('notes', { body, color: color || 'yellow', pinned: !!pinned, context: context || 'both' });
      res.json(normNote(row));
    }),
  );

  app.patch(
    '/api/notes/:id',
    route(async (req, res) => {
      const f = {};
      if ('body' in req.body) f.body = req.body.body;
      if ('color' in req.body) f.color = req.body.color;
      if ('pinned' in req.body) f.pinned = !!req.body.pinned;
      if ('context' in req.body) f.context = req.body.context;
      const row = updateById('notes', req.params.id, f);
      if (!row) return notFound(res);
      res.json(normNote(row));
    }),
  );

  app.delete(
    '/api/notes/:id',
    route(async (req, res) => {
      remove('notes', { where: { id: req.params.id } });
      res.json({ success: true });
    }),
  );

  // ===== Bookmarks =====
  app.get(
    '/api/bookmarks',
    route(async (req, res) => {
      const data = select('bookmarks', {
        columns: ['id', 'title', 'url', 'category', 'context', 'created_at'],
        orderBy: [
          { column: 'category', dir: 'asc', nocase: true },
          { column: 'created_at', dir: 'desc' },
          { column: 'rowid', dir: 'desc' },
        ],
        ...parseRange(req),
      });
      res.json(data.map(normBookmark));
    }),
  );

  app.post(
    '/api/bookmarks',
    route(async (req, res) => {
      const { title, url, category, context } = req.body || {};
      if (!title) return res.status(400).json({ error: 'title is required' });
      if (!url) return res.status(400).json({ error: 'url is required' });
      const row = insert('bookmarks', { title, url, category: category || '', context: context || 'both' });
      res.json(normBookmark(row));
    }),
  );

  app.patch(
    '/api/bookmarks/:id',
    route(async (req, res) => {
      const f = {};
      if ('title' in req.body) f.title = req.body.title;
      if ('url' in req.body) f.url = req.body.url;
      if ('category' in req.body) f.category = req.body.category || '';
      if ('context' in req.body) f.context = req.body.context;
      const row = updateById('bookmarks', req.params.id, f);
      if (!row) return notFound(res);
      res.json(normBookmark(row));
    }),
  );

  app.delete(
    '/api/bookmarks/:id',
    route(async (req, res) => {
      remove('bookmarks', { where: { id: req.params.id } });
      res.json({ success: true });
    }),
  );

  // ===== Focus sessions =====
  app.get(
    '/api/focus',
    route(async (req, res) => {
      const horizon = new Date(Date.now() - 7 * DAY_MS).toISOString();
      const data = select('focus_sessions', {
        columns: ['id', 'kind', 'duration_min', 'context', 'started_at', 'created_at'],
        where: { started_at: op.gte(horizon) },
        orderBy: [{ column: 'started_at', dir: 'desc' }, { column: 'rowid', dir: 'desc' }],
      });
      res.json(data.map(normFocus));
    }),
  );

  app.post(
    '/api/focus',
    route(async (req, res) => {
      const { kind, durationMin, context, startedAt } = req.body || {};
      const minutes = Number(durationMin);
      if (!Number.isFinite(minutes) || minutes <= 0) {
        return res.status(400).json({ error: 'durationMin must be a positive number' });
      }
      const row = {
        kind: kind === 'break' ? 'break' : 'focus',
        duration_min: Math.round(minutes),
        context: context || 'both',
      };
      if (startedAt) row.started_at = startedAt;
      res.json(normFocus(insert('focus_sessions', row)));
    }),
  );

  // ===== Countdowns =====
  app.get(
    '/api/countdowns',
    route(async (req, res) => {
      const data = select('countdowns', {
        columns: ['id', 'title', 'target_date', 'context', 'created_at'],
        orderBy: [{ column: 'target_date', dir: 'asc' }, { column: 'rowid' }],
        ...parseRange(req),
      });
      res.json(data.map(normCountdown));
    }),
  );

  app.post(
    '/api/countdowns',
    route(async (req, res) => {
      const { title, targetDate, context } = req.body || {};
      if (!title) return res.status(400).json({ error: 'title is required' });
      if (!targetDate) return res.status(400).json({ error: 'targetDate is required' });
      const row = insert('countdowns', { title, target_date: targetDate, context: context || 'both' });
      res.json(normCountdown(row));
    }),
  );

  app.patch(
    '/api/countdowns/:id',
    route(async (req, res) => {
      const f = {};
      if ('title' in req.body) f.title = req.body.title;
      if ('targetDate' in req.body) f.target_date = req.body.targetDate;
      if ('context' in req.body) f.context = req.body.context;
      const row = updateById('countdowns', req.params.id, f);
      if (!row) return notFound(res);
      res.json(normCountdown(row));
    }),
  );

  app.delete(
    '/api/countdowns/:id',
    route(async (req, res) => {
      remove('countdowns', { where: { id: req.params.id } });
      res.json({ success: true });
    }),
  );

  // ===== App state (generic key/value settings) =====
  app.get(
    '/api/state',
    route(async (req, res) => {
      const map = {};
      for (const row of select('app_state', { columns: ['key', 'value'] })) {
        if (!HIDDEN_APP_STATE_KEYS.has(row.key)) map[row.key] = row.value;
      }
      res.json(map);
    }),
  );

  app.put(
    '/api/state/:key',
    route(async (req, res) => {
      if (isStateRouteDeniedKey(req.params.key)) {
        return res.status(403).json({ error: 'protected_key' });
      }
      if (!('value' in (req.body || {}))) {
        return res.status(400).json({ error: 'value is required' });
      }
      const row = upsert(
        'app_state',
        { key: req.params.key, value: req.body.value, updated_at: nowIso() },
        { conflict: ['key'] },
      );
      res.json({ key: row.key, value: row.value });
    }),
  );
}
