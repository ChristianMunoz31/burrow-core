// Access & AI audit log in the local database. Best-effort: every function here resolves
// and never throws, and every feature keeps working when the database or the audit_log
// table is unavailable. Stores redacted, size-capped context only (known key/token/password
// formats are redacted; auth headers, cookies, IPs and user agents are never stored).
// Registers itself as the sink behind server/auditHook.js at import time.
import { getDb, insert, op, remove, select, withTransaction } from './db/index.js';
import { setAuditSink } from './auditHook.js';
import { REDACTED, SENSITIVE_KEY_RE, SENSITIVE_VALUE_RE, redactValue } from './dataBrowser/redact.js';
import { sanitizeAdviceText } from './javi/validateAdvice.js';

export const AUDIT_TABLE = 'audit_log';
export const AUDIT_KINDS = Object.freeze(['llm', 'export', 'auth']);
export const AUDIT_RETENTION_DAYS = 90;
export const AUDIT_MAX_ROWS = 5000;
export const AUDIT_CONTEXT_MAX_CHARS = 2000;
// Failed sign-ins are capped separately so a login flood cannot evict llm rows.
export const AUDIT_AUTH_ERROR_MAX_ROWS = 500;
export const AUDIT_SIGN_IN_COALESCE_MS = 60 * 1000;

const TRUNCATED_SUFFIX = '…[truncated]';
const FEATURE_RE = /^[a-z0-9_]{1,40}$/;
const PAGE_RE = /^[a-z0-9-]{1,40}$/;
const PROVIDER_RE = /^[a-z0-9_-]{1,20}$/;
const META_KEY_RE = /^[A-Za-z0-9_]{1,30}$/;
const META_MAX_KEYS = 10;
const META_VALUE_MAX_CHARS = 40;
// A cloud hostname can be longer than the default cap.
const META_VALUE_MAX_OVERRIDES = Object.freeze({ ai_host: 100, net_host: 100 });
// Names only (category ids): short lowercase identifiers, never free text.
const META_NAME_RE = /^[a-z][a-z0-9_]{0,19}$/;
const META_ARRAY_MAX_ITEMS = 12;
const MODEL_MAX_CHARS = 80;
const EMAIL_RE = /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,24}/g;
const COLUMNS = ['id', 'created_at', 'kind', 'feature', 'page', 'provider', 'model', 'status', 'context', 'meta'];
const MAX_LIST_LIMIT = 100;
const DEFAULT_LIST_LIMIT = 50;
const DAY_MS = 24 * 60 * 60 * 1000;
// Heavy redaction passes only ever see this much text.
const SCAN_MAX_CHARS = AUDIT_CONTEXT_MAX_CHARS * 4;
const PARTIAL_RUN_MAX_CHARS = 256;

const AUTH_HEADER_RE = /\b(proxy-authorization|authorization)\b\s*[:=]\s*(?:(?:basic|bearer|digest|token)\s+)?\S+/gi;
const COOKIE_LINE_RE = /\b(set-cookie|cookie)\b\s*[:=][^\n]*/gi;
// Identifier followed by `:` or `=` and a value. The value is a quoted string (closing quote optional,
// for clipped text) or a bare run that stops at whitespace, a quote or a closing bracket, so compact
// JSON neighbours survive. Whether it is redacted depends on the key (see redactAssignments).
const KEY_ASSIGN_RE =
  /(?<![A-Za-z0-9])([A-Za-z][A-Za-z0-9_.-]{0,63})(["']?)\s*[:=]\s*("[^"]*"?|'[^']*'?|[^\s"'}\]]+)/g;
// "api key: x" style (space-separated words), which the identifier pass cannot see.
const SPACED_KEY_RE = /\b((?:api|access|secret|private) key)(["']?)\s*[:=]\s*(?:"[^"]*"?|'[^']*'?|[^\s"'}\]]+)/gi;
const SB_KEY_RE = /\bsb_(?:secret|publishable)_[A-Za-z0-9_-]+/g;
const ENTROPY_RUN_RE = /[A-Za-z0-9+/=_-]{24,}/g;
const CARD_RE = /\b\d{13,19}\b|\b\d{4}(?:[ -]\d{4}){3,4}\b/g;

// Cursor: `<created_at>` (back-compat) or `<created_at>|<id>`.
const CURSOR_TS_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURSOR_MAX_CHARS = 80;

// Sign-in coalescing. Module-level state for the single server process.
const signIn = { lastWriteAt: null, pending: 0 };

/** Test hook: clear the failed sign-in coalescer. */
export function resetAuditState() {
  signIn.lastWriteAt = null;
  signIn.pending = 0;
}

/**
 * Parse a `before` cursor. Returns null when it is not strict ISO-8601 (optionally `|<uuid>`).
 * @param {unknown} raw
 * @returns {{ ts: string, id: string | null } | null}
 */
export function parseAuditCursor(raw) {
  if (typeof raw !== 'string' || raw.length > CURSOR_MAX_CHARS) return null;
  const parts = raw.split('|');
  if (parts.length > 2) return null;
  const [ts, id] = parts;
  const m = CURSOR_TS_RE.exec(ts);
  if (!m) return null;
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number);
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return null;
  if (day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return null;
  if (Number.isNaN(Date.parse(ts))) return null;
  if (id !== undefined && !UUID_RE.test(id)) return null;
  return { ts, id: id ?? null };
}

const normalizeKey = (key) => key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();

/** Redact the value of every `key: value` / `key=value` whose key looks sensitive (prefixed keys included). */
function redactAssignments(text) {
  // Local regex copy: lastIndex is per-call state, and the quoted branch recurses.
  const re = new RegExp(KEY_ASSIGN_RE.source, 'g');
  let out = '';
  let pos = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    const [match, key, quote, value] = m;
    let end = m.index + match.length;
    let replacement;
    if (SENSITIVE_KEY_RE.test(normalizeKey(key))) {
      replacement = `${key}${quote}: [redacted]`;
      // An unquoted secret may be several words (`password: correct horse`): take the rest of the line.
      if (value[0] !== '"' && value[0] !== "'") {
        const eol = text.indexOf('\n', end);
        end = eol === -1 ? text.length : eol;
      }
    } else if (value[0] !== '"' && value[0] !== "'") {
      replacement = match;
    } else {
      // Not sensitive: keep it, but still scan inside a quoted value (`msg: "password=abc"`).
      const head = match.slice(0, match.length - value.length);
      replacement = head + value[0] + redactAssignments(value.slice(1));
    }
    out += text.slice(pos, m.index) + replacement;
    pos = end;
    re.lastIndex = end;
  }
  return out + text.slice(pos);
}

const looksSecret = (text) => SENSITIVE_VALUE_RE.test(text) || sanitizeAdviceText(text) !== text;

function scrubFreeText(input) {
  const headers = input
    .replace(EMAIL_RE, '[email]')
    .replace(AUTH_HEADER_RE, '$1: [redacted]')
    .replace(COOKIE_LINE_RE, '$1: [redacted]');
  return redactAssignments(headers.replace(SPACED_KEY_RE, '$1$2: [redacted]'))
    .replace(SB_KEY_RE, REDACTED)
    .replace(ENTROPY_RUN_RE, (run) => (/\d/.test(run) && /[A-Za-z]/.test(run) ? REDACTED : run))
    .replace(CARD_RE, '[number]');
}

/** Clip to `max` UTF-16 units without leaving a lone high surrogate at the cut. */
function clip(s, max) {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/**
 * Redact and size-cap arbitrary context for storage.
 * @param {unknown} value
 * @returns {string | null}
 */
export function redactAuditContext(value) {
  if (value === null || value === undefined || value === '') return null;
  let text;
  try {
    // redactValue parses JSON-looking strings itself (bounded to 64KB).
    const redacted = redactValue(value);
    text = typeof redacted === 'string' ? redacted : JSON.stringify(redacted);
  } catch {
    return null;
  }
  if (typeof text !== 'string') return null;
  // Sanitize first, then clip, so the heavier passes never see more than SCAN_MAX_CHARS.
  const sanitized = sanitizeAdviceText(text);
  let scan = clip(sanitized, SCAN_MAX_CHARS);
  if (scan.length < sanitized.length) {
    // The cut may have split a token: drop the trailing partial run so a half secret cannot slip past.
    // Bounded, so compact whitespace-free JSON keeps its body instead of being wiped.
    let i = scan.length;
    const floor = Math.max(0, i - PARTIAL_RUN_MAX_CHARS);
    while (i > floor && !/\s/.test(scan[i - 1])) i -= 1;
    scan = scan.slice(0, i);
  }
  text = scrubFreeText(scan);
  if (text.trim() === '') return null;
  if (text.length > AUDIT_CONTEXT_MAX_CHARS) {
    text = clip(text, AUDIT_CONTEXT_MAX_CHARS - TRUNCATED_SUFFIX.length) + TRUNCATED_SUFFIX;
  }
  return text;
}

function normalizeMeta(meta) {
  const out = {};
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) return out;
  let count = 0;
  for (const [key, val] of Object.entries(meta)) {
    if (count >= META_MAX_KEYS) break;
    if (!META_KEY_RE.test(key) || SENSITIVE_KEY_RE.test(key.toLowerCase())) continue;
    if (typeof val === 'number') {
      if (!Number.isFinite(val)) continue;
      out[key] = val;
    } else if (typeof val === 'boolean') {
      out[key] = val;
    } else if (typeof val === 'string') {
      out[key] = clip(sanitizeAdviceText(val), META_VALUE_MAX_OVERRIDES[key] ?? META_VALUE_MAX_CHARS);
    } else if (Array.isArray(val)) {
      out[key] = val.filter((v) => typeof v === 'string' && META_NAME_RE.test(v)).slice(0, META_ARRAY_MAX_ITEMS);
    } else {
      continue;
    }
    count += 1;
  }
  return out;
}

/**
 * Validate an audit event into a row, or null when it must be dropped.
 * @param {unknown} event
 * @returns {object | null}
 */
export function normalizeAuditEvent(event) {
  if (event === null || typeof event !== 'object' || Array.isArray(event)) return null;
  const { kind, feature, page, provider, model, status, context, meta } = event;
  if (!AUDIT_KINDS.includes(kind)) return null;
  if (typeof feature !== 'string' || !FEATURE_RE.test(feature)) return null;
  const providerId = typeof provider === 'string' ? provider.toLowerCase() : null;
  const cleanModel = typeof model === 'string' ? clip(model.replace(/[^A-Za-z0-9._:/-]/g, ''), MODEL_MAX_CHARS) : '';
  const modelId = cleanModel && !looksSecret(cleanModel) ? cleanModel : '';
  return {
    kind,
    feature,
    page: typeof page === 'string' && PAGE_RE.test(page) ? page : null,
    provider: providerId && PROVIDER_RE.test(providerId) ? providerId : null,
    model: modelId || null,
    status: status === 'error' ? 'error' : 'ok',
    context: redactAuditContext(context),
    meta: normalizeMeta(meta),
  };
}

/**
 * Write one audit row. Never throws; resolves false when nothing was stored.
 * Retention is handled by the scheduled pruneAudit (server/scheduler.js).
 * @param {unknown} event
 * @param {{ db?: import('node:sqlite').DatabaseSync | null, nowMs?: () => number }} [opts]
 * @returns {Promise<boolean>}
 */
export async function logAudit(event, { db, nowMs = Date.now } = {}) {
  // Undoes the failed-sign-in window reservation when the write does not land.
  let rollback = () => {};
  try {
    let handle = db;
    if (!handle) {
      try {
        handle = getDb();
      } catch {
        return false;
      }
    }
    const row = normalizeAuditEvent(event);
    if (!row) return false;
    const isFailedSignIn = row.kind === 'auth' && row.feature === 'sign_in' && row.status === 'error';
    // Count the attempt before any early return, so swallowed attempts still show up in the next row.
    if (isFailedSignIn) signIn.pending += 1;
    const t = nowMs();
    // Pending count carried by this row; subtracted (not zeroed) on success so concurrent attempts survive.
    let snapshot = 0;
    if (isFailedSignIn) {
      // At most one failed sign-in row per window; the rest are counted.
      if (signIn.lastWriteAt !== null && t - signIn.lastWriteAt < AUDIT_SIGN_IN_COALESCE_MS) return false;
      snapshot = signIn.pending;
      row.meta = { ...row.meta, attempts: snapshot };
      const previous = signIn.lastWriteAt;
      signIn.lastWriteAt = t;
      rollback = () => {
        if (signIn.lastWriteAt === t) signIn.lastWriteAt = previous;
      };
    } else if (row.kind === 'auth' && row.feature === 'sign_in' && signIn.pending > 0) {
      snapshot = signIn.pending;
      row.meta = { ...row.meta, failed_attempts_before: snapshot };
    }
    try {
      insert(AUDIT_TABLE, row, { db: handle });
    } catch (e) {
      rollback();
      console.error('Audit write failed:', e?.code || 'unknown');
      return false;
    }
    rollback = () => {};
    // Only a stored row consumes the pending count; a failed write leaves it intact.
    if (row.kind === 'auth' && row.feature === 'sign_in' && (isFailedSignIn || row.status === 'ok')) {
      signIn.pending = Math.max(0, signIn.pending - snapshot);
    }
    return true;
  } catch (err) {
    rollback();
    console.error('Audit write failed:', err?.code || 'unknown');
    return false;
  }
}

// Keep the newest `maxRows` rows of a scope (all rows, or failed sign-ins) by deleting older ones.
function trimToNewest(db, maxRows, authErrorsOnly) {
  const scope = authErrorsOnly ? { kind: 'auth', status: 'error' } : undefined;
  const nth = select(AUDIT_TABLE, {
    columns: ['created_at'],
    where: scope,
    orderBy: [{ column: 'created_at', dir: 'desc' }],
    limit: 1,
    offset: maxRows - 1,
    db,
  })[0];
  if (!nth?.created_at) return 0;
  return remove(AUDIT_TABLE, { where: { ...scope, created_at: op.lt(nth.created_at) }, db });
}

/**
 * Delete rows older than the retention window, then failed sign-ins beyond their own cap,
 * then rows beyond the global cap. Never throws.
 * @param {{ db?: import('node:sqlite').DatabaseSync | null, now?: Date, maxAgeDays?: number, maxRows?: number }} [opts]
 * @returns {Promise<{ ok: boolean, deletedOld: number | null, deletedAuthErrors: number | null, deletedOverCap: number | null }>}
 */
export async function pruneAudit({
  db,
  now = new Date(),
  maxAgeDays = AUDIT_RETENTION_DAYS,
  maxRows = AUDIT_MAX_ROWS,
} = {}) {
  const failed = { ok: false, deletedOld: null, deletedAuthErrors: null, deletedOverCap: null };
  try {
    const handle = db ?? getDb();
    const cutoff = new Date(now.getTime() - maxAgeDays * DAY_MS).toISOString();
    return withTransaction(
      () => ({
        ok: true,
        deletedOld: remove(AUDIT_TABLE, { where: { created_at: op.lt(cutoff) }, db: handle }),
        deletedAuthErrors: trimToNewest(handle, AUDIT_AUTH_ERROR_MAX_ROWS, true),
        deletedOverCap: trimToNewest(handle, maxRows, false),
      }),
      handle,
    );
  } catch {
    return failed;
  }
}

const toEntry = (r) => ({
  id: String(r.id),
  createdAt: r.created_at,
  kind: r.kind,
  feature: r.feature,
  page: r.page ?? null,
  provider: r.provider ?? null,
  model: r.model ?? null,
  status: r.status === 'error' ? 'error' : 'ok',
  context: typeof r.context === 'string' ? r.context : null,
  meta: r.meta !== null && typeof r.meta === 'object' && !Array.isArray(r.meta) ? r.meta : {},
});

/**
 * Newest-first page of audit entries. Never throws.
 * @param {{ db?: import('node:sqlite').DatabaseSync | null, limit?: number, before?: string }} [opts]
 * @returns {Promise<{ entries: object[], nextBefore: string | null, available: boolean, reason?: 'not_configured' | 'error' }>}
 */
export async function listAudit({ db, limit = DEFAULT_LIST_LIMIT, before } = {}) {
  const unavailable = (reason) => ({ entries: [], nextBefore: null, available: false, reason });
  let handle = db;
  if (!handle) {
    try {
      handle = getDb();
    } catch {
      return unavailable('not_configured');
    }
  }
  const size = Math.min(Math.max(Math.trunc(Number(limit)) || DEFAULT_LIST_LIMIT, 1), MAX_LIST_LIMIT);
  try {
    const cursor = before ? parseAuditCursor(before) : null;
    if (before && !cursor) return unavailable('error');
    let where;
    if (cursor?.id) {
      where = {
        $or: [{ created_at: op.lt(cursor.ts) }, { created_at: cursor.ts, id: op.lt(cursor.id.toLowerCase()) }],
      };
    } else if (cursor) {
      where = { created_at: op.lt(cursor.ts) };
    }
    const data = select(AUDIT_TABLE, {
      columns: COLUMNS,
      where,
      orderBy: [{ column: 'created_at', dir: 'desc' }, { column: 'id', dir: 'desc' }],
      limit: size,
      db: handle,
    });
    const entries = data.map(toEntry);
    const last = entries[entries.length - 1];
    const nextBefore = entries.length === size ? `${last.createdAt}|${last.id}` : null;
    return { entries, nextBefore, available: true };
  } catch (err) {
    console.error('Audit list failed:', err?.code || 'unknown');
    return unavailable('error');
  }
}

/**
 * GET /api/audit?limit=50&before=<ISO>[|<id>]. Mounted after the auth gate.
 * @param {import('express').Express} app
 */
export function registerAuditRoutes(app) {
  app.get('/api/audit', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const invalid = () => res.status(400).json({ error: 'Invalid query', code: 'invalid_query' });
    const { limit: rawLimit, before: rawBefore } = req.query;

    let limit = DEFAULT_LIST_LIMIT;
    if (rawLimit !== undefined) {
      if (typeof rawLimit !== 'string' || !/^\d{1,3}$/.test(rawLimit)) return invalid();
      limit = Number(rawLimit);
      if (limit < 1 || limit > MAX_LIST_LIMIT) return invalid();
    }
    let before;
    if (rawBefore !== undefined) {
      if (parseAuditCursor(rawBefore) === null) return invalid();
      before = rawBefore;
    }

    const out = await listAudit({ limit, before });
    if (!out.available && out.reason === 'error') {
      return res.status(500).json({ error: 'Server error', code: 'server_error' });
    }
    return res.json({ data: out });
  });
}

setAuditSink(logAudit);
