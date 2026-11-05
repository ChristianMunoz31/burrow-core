// Network activity: the read-only list behind Settings > Privacy & activity > Network activity.
// Rows are written by recordNetworkCall (server/networkCall.js).
// Reads: the list merges those rows with the rows other paths already write
// (`model_pull`, and the AI rows whose meta says the call went to a cloud or another-computer host).
// The response is built field by field, so nothing else in an audit row can leak.
import { isFeatureId } from './netPolicy.js';
import { HOST_RE, MODEL_PULL_FEATURE, NETWORK_CALL_FEATURE } from './networkCall.js';
import { getDb, select, op } from './db/index.js';
import { AUDIT_MAX_ROWS, parseAuditCursor } from './audit.js';

export const NETWORK_ACTIVITY_MAX_LIMIT = 100;
export const NETWORK_ACTIVITY_DEFAULT_LIMIT = 50;
const BATCH_SIZE = 100;
const UNKNOWN_HOST = 'unknown host';
const LAN_HOST = 'Another computer on your network';
const OLLAMA_HOST = 'Ollama on this computer';

const LABELS = Object.freeze({
  weather: 'Weather',
  oura: 'Oura Ring',
  sheets: 'Google Sheets import',
  cloudAi: 'Cloud helper',
  aiLan: 'Helper on another computer',
  updates: 'Updates',
  license: 'License',
  model_pull: 'Model download (through Ollama)',
});
// The click-to-install handoff: the Burrow app (not the local server) does the download.
const UPDATE_DOWNLOAD_LABEL = 'Update download (Burrow app)';

// Audit rows that can describe an outbound call. Everything else in the log is never read here.
const SOURCE_FEATURES = Object.freeze([
  NETWORK_CALL_FEATURE,
  'model_pull',
  'jarvis',
  'briefing',
  'javi_advice',
  'cross_insights_explain',
  'folder_summary',
  'folder_index',
  'folder_report',
  'folder_ask',
]);

const safeHost = (value) => (typeof value === 'string' && HOST_RE.test(value) ? value : UNKNOWN_HOST);

/** Maps one audit row to a network-activity entry, or null when the row was not an outbound call. */
function toEntry(row) {
  const meta = row.meta !== null && typeof row.meta === 'object' && !Array.isArray(row.meta) ? row.meta : {};
  let feature;
  let host;
  if (row.feature === NETWORK_CALL_FEATURE) {
    if (meta.net_feature !== MODEL_PULL_FEATURE && !isFeatureId(meta.net_feature)) return null;
    feature = meta.net_feature;
    host = safeHost(meta.net_host);
  } else if (row.feature === 'model_pull') {
    feature = 'model_pull';
    host = OLLAMA_HOST;
  } else {
    // An AI row counts only when a call really left for a cloud or another-computer host.
    if (meta.ai_kind !== 'cloud' && meta.ai_kind !== 'lan') return null;
    if (!(Number(meta.calls) > 0)) return null;
    feature = meta.ai_kind === 'cloud' ? 'cloudAi' : 'aiLan';
    host = meta.ai_kind === 'cloud' ? safeHost(meta.ai_host) : LAN_HOST;
  }
  const blocked = meta.result === 'blocked';
  const started = row.feature === NETWORK_CALL_FEATURE && feature === 'updates' && meta.net_result === 'started';
  const byApp = started && meta.net_by === 'app';
  let result = row.status === 'error' ? 'failed' : 'ok';
  if (started && row.status !== 'error') result = 'started';
  if (blocked) result = 'blocked';
  return {
    id: String(row.id),
    feature,
    label: byApp ? UPDATE_DOWNLOAD_LABEL : (LABELS[feature] ?? feature),
    host,
    at: row.created_at,
    result,
  };
}

const cursorOf = (row) => `${row.created_at}|${row.id}`;

/**
 * Newest-first page of outbound connections.
 * @param {{ db?: import('node:sqlite').DatabaseSync, limit?: number, before?: string }} [opts]
 * @returns {{ entries: object[], nextBefore: string | null }}
 */
export function listNetworkActivity({ db, limit = NETWORK_ACTIVITY_DEFAULT_LIMIT, before } = {}) {
  const handle = db ?? getDb();
  const size = Math.min(Math.max(Math.trunc(Number(limit)) || NETWORK_ACTIVITY_DEFAULT_LIMIT, 1), NETWORK_ACTIVITY_MAX_LIMIT);
  let cursor = before ? parseAuditCursor(before) : null;
  const entries = [];
  let scanned = 0;
  // At most AUDIT_MAX_ROWS rows are scanned per request, so one request stays bounded. A page ends early
  // when it is full or when that cap is hit. In the second case the page may be short or empty and
  // nextBefore points at the last row scanned, so the client keeps paging from there. A null
  // nextBefore means nothing older exists.
  for (;;) {
    let where = { feature: op.in(SOURCE_FEATURES) };
    if (cursor?.id) {
      where = {
        ...where,
        $or: [{ created_at: op.lt(cursor.ts) }, { created_at: cursor.ts, id: op.lt(cursor.id.toLowerCase()) }],
      };
    } else if (cursor) {
      where = { ...where, created_at: op.lt(cursor.ts) };
    }
    const rows = select('audit_log', {
      columns: ['id', 'created_at', 'feature', 'status', 'meta'],
      where,
      orderBy: [{ column: 'created_at', dir: 'desc' }, { column: 'id', dir: 'desc' }],
      limit: BATCH_SIZE,
      db: handle,
    });
    for (let i = 0; i < rows.length; i += 1) {
      const entry = toEntry(rows[i]);
      if (entry) entries.push(entry);
      if (entries.length >= size) {
        // More may exist only if rows remain in this batch or the batch was full.
        const more = i < rows.length - 1 || rows.length === BATCH_SIZE;
        return { entries, nextBefore: more ? cursorOf(rows[i]) : null };
      }
    }
    if (rows.length < BATCH_SIZE) return { entries, nextBefore: null };
    scanned += rows.length;
    const lastRow = rows[rows.length - 1];
    if (scanned >= AUDIT_MAX_ROWS) return { entries, nextBefore: cursorOf(lastRow) };
    cursor = parseAuditCursor(cursorOf(lastRow));
  }
}

/**
 * GET /api/privacy/network-activity?limit=<1..100>&before=<cursor>. Read-only, no-store, mounted
 * after the auth and desktop gates.
 * @param {import('express').Express} app
 */
export function registerNetworkActivityRoutes(app) {
  app.get('/api/privacy/network-activity', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const invalid = () => res.status(400).json({ error: 'invalid_query', message: 'That request was not valid. Close and reopen Settings to try again.' });
    const { limit: rawLimit, before: rawBefore } = req.query;
    let limit = NETWORK_ACTIVITY_DEFAULT_LIMIT;
    if (rawLimit !== undefined) {
      if (typeof rawLimit !== 'string' || !/^\d{1,3}$/.test(rawLimit)) return invalid();
      limit = Number(rawLimit);
      if (limit < 1 || limit > NETWORK_ACTIVITY_MAX_LIMIT) return invalid();
    }
    let before;
    if (rawBefore !== undefined) {
      if (parseAuditCursor(rawBefore) === null) return invalid();
      before = rawBefore;
    }
    try {
      return res.json({ data: listNetworkActivity({ limit, before }) });
    } catch (err) {
      console.error('Network activity list failed:', err?.code || 'unknown');
      return res.status(500).json({
        error: 'network_activity_unavailable',
        message: "Couldn't load network activity. Close and reopen Settings to try again.",
      });
    }
  });
}
