// Javi inbox: code-derived "new for you" items behind the launcher count. The app_state row `javi.inbox`
// holds read markers only (keys and timestamps, no content). Items are derived on every read: a page whose
// data changed since its last insight (the write observer below), today's briefing (Pro) and finished folder
// summaries. `unseen` lists the pages never opened in Javi or changed since, for the current-page notice
// (owner decision 2026-10-10: every write counts, also the user's own edit on the page on screen). Code
// only: this module never calls a model and imports nothing from the AI layer.
//
// Every read-modify-write of the row is synchronous (selectOne plus upsert inside one withTransaction, no
// await between them).
import { selectOne, upsert, withTransaction } from '../db/index.js';
import { onTableWrite } from '../db/writeEvents.js';
import { captureDataGeneration, onDataReset } from '../dataGeneration.js';
import { proAccess } from '../pro.js';
import { countSummariesSince } from '../folders/store.js';
import { JAVI_PAGE_LABELS, JAVI_PAGE_PATHS } from './pages.js';

export const INBOX_STATE_KEY = 'javi.inbox';
const BRIEFING_STATE_KEY = 'jarvis.briefing.latest';
const MAX_RAW_CHARS = 4096;

// health has no table, so it is never flagged by a write: it is unseen only until its first open.
export const INBOX_PAGES = Object.freeze([
  'budget', 'budget-planner', 'subscriptions', 'todos', 'habits', 'focus', 'countdowns', 'calendar', 'journal',
  'notes', 'bookmarks', 'health',
]);
export const INBOX_PAGE_SET = new Set(INBOX_PAGES);

export const TABLE_PAGES = Object.freeze({
  transactions: ['budget', 'budget-planner', 'subscriptions'],
  todos: ['todos'],
  habits: ['habits'], habit_completions: ['habits'],
  focus_sessions: ['focus'], countdowns: ['countdowns'],
  calendar_events: ['calendar'], journal: ['journal'],
  notes: ['notes'], bookmarks: ['bookmarks'],
});
// Exact keys, no prefix match: budget:defaultView and budget:defaultMonth are UI preferences.
const BUDGET_PAGES = ['budget', 'budget-planner'];
export const STATE_KEY_PAGES = Object.freeze({
  'budget:targets': BUDGET_PAGES, 'budget:payees': BUDGET_PAGES, 'budget:spent': BUDGET_PAGES,
  'budget:structure': BUDGET_PAGES, 'budget:defaults': BUDGET_PAGES,
});

const defaultNow = () => new Date();
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
/** Canonical ISO string, or null for anything that is not a valid date string. */
function iso(v) {
  if (typeof v !== 'string') return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/**
 * Normalized inbox state. A missing, oversized (over 4 KB of JSON), non-object or wrong-version value is an
 * in-memory baseline with createdAt = now. Pages are rebuilt over the allowlist only.
 * @returns {{ v: 1, createdAt: string, pages: Record<string, { seenAt: string, changedAt: string | null }>, briefingSeenAt: string | null, foldersSeenAt: string | null }}
 */
export function normalizeInbox(raw, now) {
  let ok = isPlainObject(raw) && raw.v === 1;
  if (ok) {
    try {
      ok = JSON.stringify(raw).length <= MAX_RAW_CHARS;
    } catch {
      ok = false;
    }
  }
  const createdAt = (ok && iso(raw.createdAt)) || now.toISOString();
  const pages = Object.create(null);
  if (ok && isPlainObject(raw.pages)) {
    for (const key of INBOX_PAGES) {
      if (!Object.hasOwn(raw.pages, key)) continue;
      const e = raw.pages[key];
      if (!isPlainObject(e) || Object.keys(e).length !== 2) continue;
      const seenAt = iso(e.seenAt);
      if (!seenAt || !Object.hasOwn(e, 'changedAt')) continue;
      const changedAt = e.changedAt === null ? null : iso(e.changedAt);
      if (e.changedAt !== null && !changedAt) continue;
      pages[key] = { seenAt, changedAt };
    }
  }
  return {
    v: 1,
    createdAt,
    pages,
    briefingSeenAt: (ok && iso(raw.briefingSeenAt)) || null,
    foldersSeenAt: (ok && iso(raw.foldersSeenAt)) || null,
  };
}

const readRow = () => selectOne('app_state', { columns: ['value'], where: { key: INBOX_STATE_KEY } });
const writeState = (state, now) =>
  upsert('app_state', { key: INBOX_STATE_KEY, value: state, updated_at: now.toISOString() }, { conflict: ['key'] });
const sameJson = (a, b) => {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
};

/** @returns {ReturnType<typeof normalizeInbox>} Never writes. */
export function readInbox({ now = defaultNow } = {}) {
  return normalizeInbox(readRow()?.value, now());
}

function briefingItem(state, nowMs) {
  if (!proAccess('briefings').allowed) return null;
  const b = selectOne('app_state', { columns: ['value'], where: { key: BRIEFING_STATE_KEY } })?.value;
  const at = isPlainObject(b) ? iso(b.generatedAt) : null;
  if (!at || Date.parse(at) > nowMs) return null;
  if (Date.parse(at) <= Date.parse(state.briefingSeenAt ?? state.createdAt)) return null;
  return { id: 'briefing', kind: 'briefing', page: 'home', to: '/', label: "Today's briefing is ready", at };
}

function foldersItem(state, now) {
  const { count, latestAt, latestId } = countSummariesSince(state.foldersSeenAt ?? state.createdAt, { now: () => now });
  if (count === 0 || !latestAt) return null;
  return {
    id: 'folders',
    kind: 'folders',
    page: null,
    to: count === 1 && latestId ? `/folders?folder=${encodeURIComponent(latestId)}` : '/folders',
    label: count === 1 ? 'A folder summary is ready' : `${count} folder summaries are ready`,
    at: latestAt,
    count,
  };
}

function itemsFor(state, now) {
  const items = [];
  for (const key of INBOX_PAGES) {
    const e = state.pages[key];
    if (!e || e.changedAt === null || !(e.changedAt > e.seenAt)) continue;
    items.push({
      id: `page:${key}`,
      kind: 'page',
      page: key,
      to: JAVI_PAGE_PATHS[key],
      label: `${JAVI_PAGE_LABELS[key]} changed since your last insight`,
      at: e.changedAt,
    });
  }
  const b = briefingItem(state, now.getTime());
  if (b) items.push(b);
  const f = foldersItem(state, now);
  if (f) items.push(f);
  return items.sort((a, b2) => (a.at < b2.at ? 1 : a.at > b2.at ? -1 : 0));
}

/** Pages with no marker (never opened in Javi) or changed since their marker, in INBOX_PAGES order. */
const unseenFor = (state) =>
  INBOX_PAGES.filter((key) => {
    const e = state.pages[key];
    return !e || (e.changedAt !== null && e.changedAt > e.seenAt);
  });

/** Unread items, Pro-filtered, future timestamps dropped, sorted by at desc. Never writes. */
export function listInboxItems({ now = defaultNow } = {}) {
  const n = now();
  return itemsFor(normalizeInbox(readRow()?.value, n), n);
}

/** The route answer: `items` as listInboxItems plus `unseen` page keys, from one read. Never writes. */
export function readInboxView({ now = defaultNow } = {}) {
  const n = now();
  const state = normalizeInbox(readRow()?.value, n);
  return { items: itemsFor(state, n), unseen: unseenFor(state) };
}

/** Advice success: seenAt = now, changedAt = null. Writes the baseline first when the row is missing. */
export function markPageSeen(page, { now = defaultNow } = {}) {
  if (!INBOX_PAGE_SET.has(page)) return;
  const n = now();
  withTransaction(() => {
    const state = normalizeInbox(readRow()?.value, n);
    state.pages[page] = { seenAt: n.toISOString(), changedAt: null };
    writeState(state, n);
  });
}

/**
 * Marks ids read. Page ids: seenAt = now, changedAt = null (also a page never seen before: opening Javi on a
 * page marks it seen). 'briefing' and
 * 'folders': marker = max(now, item.at), a no-op when no such item is listed. Writes the baseline when the
 * row is missing (even with no ids) and rewrites a non-canonical row. One synchronous transaction.
 * @param {string[]} ids validated, deduped ids
 */
export function markRead(ids, { now = defaultNow } = {}) {
  const n = now();
  const nowIso = n.toISOString();
  withTransaction(() => {
    const row = readRow();
    const state = normalizeInbox(row?.value, n);
    let dirty = !row || !sameJson(row.value, state);
    let items = null;
    const itemAt = (id) => {
      items ??= itemsFor(state, n);
      return items.find((i) => i.id === id)?.at ?? null;
    };
    for (const id of ids) {
      if (id === 'briefing' || id === 'folders') {
        const at = itemAt(id);
        if (!at) continue;
        state[id === 'briefing' ? 'briefingSeenAt' : 'foldersSeenAt'] = at > nowIso ? at : nowIso;
        dirty = true;
      } else if (id.startsWith('page:')) {
        const key = id.slice(5);
        if (!INBOX_PAGE_SET.has(key)) continue;
        state.pages[key] = { seenAt: nowIso, changedAt: null };
        dirty = true;
      }
    }
    if (dirty) writeState(state, n);
  });
}

let installed = null;

/** Installs the write observer and its data-reset hook once; returns unregister. */
export function installInboxWriteObserver({ now = defaultNow } = {}) {
  if (installed) return installed;
  const pending = new Set();
  let gen = null;

  const flush = () => {
    const pages = [...pending];
    const taken = gen;
    pending.clear();
    gen = null;
    if (pages.length === 0 || !taken || taken.isStale()) return;
    try {
      const n = now();
      const nowIso = n.toISOString();
      withTransaction(() => {
        const row = readRow();
        if (!row) return;
        const state = normalizeInbox(row.value, n);
        let flipped = false;
        for (const p of pages) {
          const e = state.pages[p];
          if (e && (e.changedAt === null || e.changedAt <= e.seenAt)) {
            // Strictly after seenAt, even for a write in the same millisecond as the read.
            e.changedAt = nowIso > e.seenAt ? nowIso : new Date(Date.parse(e.seenAt) + 1).toISOString();
            flipped = true;
          }
        }
        if (flipped) writeState(state, n);
      });
    } catch (e) {
      console.error('Javi inbox update failed:', e?.code ?? 'unknown');
    }
  };

  const offWrite = onTableWrite((table, key) => {
    let pages = null;
    if (table === 'app_state') {
      if (typeof key === 'string' && Object.hasOwn(STATE_KEY_PAGES, key)) pages = STATE_KEY_PAGES[key];
    } else if (Object.hasOwn(TABLE_PAGES, table)) {
      pages = TABLE_PAGES[table];
    }
    if (!pages) return;
    if (pending.size === 0) {
      gen = captureDataGeneration();
      setImmediate(flush);
    }
    for (const p of pages) pending.add(p);
  });
  const offReset = onDataReset(() => {
    pending.clear();
    gen = null;
  });
  installed = () => {
    offWrite();
    offReset();
    installed = null;
  };
  return installed;
}
