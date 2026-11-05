// Read-only data browser: /api/data/tables, /api/data/tables/:table and
// /api/data/tables/:table/overview. Gated by the session middleware in server.js and
// limited by the global /api limiter (read-only; a strict cap would be exhausted by
// normal browsing), plus a small dedicated limiter and a cache on the costly overview.
// No raw SQL: the table name comes only from the allowlist and every query goes through
// the server/db helper, which re-validates identifiers and binds all values.
import rateLimit from 'express-rate-limit';
import { count, getDb, op, select } from './db/index.js';
import { onDataReset } from './dataGeneration.js';
import { DATA_TABLES, getTableDef } from './dataBrowser/tables.js';
import { parseListParams, buildSearch, aggregateOverview } from './dataBrowser/query.js';
import { HIDDEN_APP_STATE_KEYS, redactAppStateRow } from './dataBrowser/redact.js';

const OVERVIEW_MAX_ROWS = 20000;
const OVERVIEW_CACHE_TTL_MS = 120_000;

// Results are cached per table for a short TTL and concurrent requests for the same
// table share one scan.
const overviewCache = new Map(); // table id -> { at, body }
const overviewInflight = new Map(); // table id -> Promise<body>
let cacheEpoch = 0; // bumped by clearOverviewCache so a scan that started earlier is not cached

/** Forgets cached and in-flight overviews (they hold per-month totals of the data). Used on a data reset. */
export function clearOverviewCache() {
  cacheEpoch += 1;
  overviewCache.clear();
  overviewInflight.clear();
}

onDataReset(clearOverviewCache);

/** Test hook: forget cached/in-flight overviews. */
export function __resetOverviewCacheForTests() {
  overviewCache.clear();
  overviewInflight.clear();
}

const send = (res, status, code, error) => res.status(status).json({ error, code });

function dbFailure(res, e) {
  console.error('Data browser error:', e?.code ?? 'unknown');
  return send(res, 500, 'server_error', 'Server error');
}

/** Hides app_state rows no API returns (the license activation, the developer override). */
const visibleWhere = (def) => (def.redact === 'app_state' ? { key: op.nin([...HIDDEN_APP_STATE_KEYS]) } : undefined);

function countRows(def) {
  try {
    return { count: count(def.id, { where: visibleWhere(def) }), status: 'ok' };
  } catch {
    return { count: null, status: 'unavailable' };
  }
}

/**
 * Reads the date (and amount) columns newest-first, up to the row cap plus one probe row,
 * and flags `truncated` only when rows were really left behind.
 */
async function buildOverview(def) {
  const rows = select(def.id, {
    where: visibleWhere(def),
    columns: [def.dateColumn, def.amountColumn].filter(Boolean),
    orderBy: [
      { column: def.dateColumn, dir: 'desc' },
      { column: def.primaryKey, dir: 'asc' },
    ],
    limit: OVERVIEW_MAX_ROWS + 1,
  });
  const truncated = rows.length > OVERVIEW_MAX_ROWS;
  return {
    table: def.id,
    dateColumn: def.dateColumn,
    granularity: 'month',
    ...aggregateOverview(def, truncated ? rows.slice(0, OVERVIEW_MAX_ROWS) : rows),
    truncated,
  };
}

function overviewFor(def) {
  const hit = overviewCache.get(def.id);
  if (hit && Date.now() - hit.at < OVERVIEW_CACHE_TTL_MS) return Promise.resolve(hit.body);
  let pending = overviewInflight.get(def.id);
  if (!pending) {
    const epoch = cacheEpoch;
    pending = buildOverview(def)
      .then((body) => {
        if (epoch === cacheEpoch) overviewCache.set(def.id, { at: Date.now(), body });
        return body;
      })
      .finally(() => {
        overviewInflight.delete(def.id);
      });
    overviewInflight.set(def.id, pending);
  }
  return pending;
}

export function registerDataBrowserRoutes(app) {
  // Dedicated, small cap: an overview is the most expensive read in the app.
  const overviewLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => {
      res.set('Cache-Control', 'no-store');
      res.status(429).json({ error: 'Too many requests, please try again later.', code: 'rate_limited' });
    },
  });

  // Wraps a handler: no-store, 503 when the local database cannot be opened, allowlisted table lookup.
  const handle = (needsTable, fn) => async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      try {
        getDb();
      } catch {
        return send(res, 503, 'not_configured', 'Local database is unavailable.');
      }
      let def;
      if (needsTable) {
        def = getTableDef(req.params.table);
        if (!def) return send(res, 404, 'unknown_table', 'Unknown table');
      }
      return await fn(req, res, def);
    } catch (e) {
      return dbFailure(res, e);
    }
  };

  app.get(
    '/api/data/tables',
    handle(false, async (req, res) => {
      const results = DATA_TABLES.map(countRows);
      res.json({
        tables: DATA_TABLES.map((def, i) => ({
          id: def.id,
          label: def.label,
          group: def.group,
          count: results[i].count,
          status: results[i].status,
          hasDateChart: !!def.dateColumn,
          hasAmountChart: !!def.amountColumn,
        })),
      });
    }),
  );

  app.get(
    '/api/data/tables/:table',
    handle(true, async (req, res, def) => {
      const parsed = parseListParams(def, req.query);
      if (!parsed.ok) return send(res, 400, parsed.code, parsed.error);
      const { page, pageSize, sort, order, q } = parsed.params;

      const search = buildSearch(def, q);
      const where = visibleWhere(def);
      const total = count(def.id, { where, search });
      let rows = select(def.id, {
        where,
        columns: def.columns.map((c) => c.name),
        search,
        orderBy: [
          { column: sort, dir: order, nulls: 'last', nocase: def.columns.find((c) => c.name === sort).type === 'text' },
          { column: def.primaryKey, dir: 'asc' },
        ],
        limit: pageSize,
        offset: (page - 1) * pageSize,
      });
      if (def.redact === 'app_state') rows = rows.map(redactAppStateRow);

      return res.json({
        table: def.id,
        label: def.label,
        primaryKey: def.primaryKey,
        columns: def.columns.map((c) => ({
          name: c.name,
          type: c.type,
          sortable: def.sortable.includes(c.name),
        })),
        amountColumn: def.amountColumn,
        rows,
        page,
        pageSize,
        total,
        sort,
        order,
        q,
      });
    }),
  );

  app.get(
    '/api/data/tables/:table/overview',
    overviewLimiter,
    handle(true, async (req, res, def) => {
      if (!def.dateColumn) {
        return res.json({
          table: def.id,
          dateColumn: null,
          granularity: 'month',
          rowsOverTime: null,
          sampled: 0,
          undated: 0,
          truncated: false,
        });
      }
      return res.json(await overviewFor(def));
    }),
  );
}
