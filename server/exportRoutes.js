// POST /api/export: one ZIP with per-table JSON + CSV, Markdown for journal entries and notes,
// and a manifest. Registered behind the auth gate in server.js. The archive itself is built by
// server/export/buildArchive.js (shared with the backup worker); this file is the route, limiter and audit.
import express from 'express';
import rateLimit from 'express-rate-limit';
import { getDb } from './db/index.js';
import { makeRequireSignIn } from './export/access.js';
import { recordAudit } from './auditHook.js';
import {
  buildExportZip,
  EXPORTABLE_DEFS,
  EXPORT_DENY,
  EXPORT_MAX_ROWS_PER_TABLE,
  EXPORT_MAX_ZIP_BYTES,
  EXPORT_MAX_RAW_BYTES,
  EXPORT_PAGE_SIZE,
  EXPORT_DEADLINE_MS,
  EXPORT_CONCURRENCY,
  EXPORT_MAX_TABLES_PER_REQUEST,
} from './export/buildArchive.js';

export {
  buildExportZip,
  EXPORT_DENY,
  EXPORT_MAX_ROWS_PER_TABLE,
  EXPORT_MAX_ZIP_BYTES,
  EXPORT_MAX_RAW_BYTES,
  EXPORT_PAGE_SIZE,
  EXPORT_DEADLINE_MS,
  EXPORT_CONCURRENCY,
  EXPORT_MAX_TABLES_PER_REQUEST,
};

const EXPORT_MAX_INPUT_TABLES = 64;

const send = (res, status, code, error, extra = {}) => res.status(status).json({ error, code, ...extra });
const auditFailure = (meta = { tables: 0, rows: 0, bytes: 0 }) =>
  recordAudit({ kind: 'export', feature: 'data_export', status: 'error', meta });

/**
 * Validates the optional { tables: [ids] } body.
 * @returns {{ ok: true, tables: string[] | null } | { ok: false }}
 */
function parseTables(body, allowed) {
  if (body === undefined || body === null) return { ok: true, tables: null };
  if (typeof body !== 'object' || Array.isArray(body)) return { ok: false };
  if (body.tables === undefined) return { ok: true, tables: null };
  if (!Array.isArray(body.tables)) return { ok: false };
  if (body.tables.length > EXPORT_MAX_INPUT_TABLES) return { ok: false };
  const tables = [...new Set(body.tables)];
  if (tables.length === 0 || tables.length > EXPORT_MAX_TABLES_PER_REQUEST) return { ok: false };
  if (!tables.every((id) => typeof id === 'string' && allowed.has(id))) return { ok: false };
  return { ok: true, tables };
}

/**
 * @param {import('express').Express} app
 * @param {{ authEnabled?: boolean, buildOptions?: object }} [opts] without auth, only loopback clients may
 *   export (fail closed otherwise); buildOptions override buildExportZip limits
 */
export function registerExportRoutes(app, { authEnabled = false, buildOptions = {} } = {}) {
  const allowedIds = new Set(EXPORTABLE_DEFS.filter((d) => !EXPORT_DENY.has(d.id)).map((d) => d.id));

  // Dedicated limit: 30 per 15 min. A full export that is too large falls back to one
  // request per table (about 16), so the budget has to cover one whole fallback run.
  // Only cheap rejections (400/403/503, and a client that left) are refunded. 413 and 5xx
  // did real work, so they count. express-rate-limit only consults requestWasSuccessful
  // when skipFailedRequests is on.
  const exportLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    skipFailedRequests: true,
    requestWasSuccessful: (_req, res) => res.statusCode < 400 || res.statusCode === 413 || (res.statusCode >= 500 && res.statusCode !== 503),
    handler: (req, res) => {
      res.set('Cache-Control', 'no-store');
      res.status(429).json({ error: 'Too many exports, please try again later.', code: 'rate_limited' });
    },
  });

  const requireSignIn = makeRequireSignIn({ authEnabled, action: 'Export' });

  app.post('/api/export', requireSignIn, exportLimiter, express.json({ limit: '10kb' }), async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const parsed = parseTables(req.body, allowedIds);
    if (!parsed.ok) return send(res, 400, 'invalid_request', 'Invalid request body');
    let db;
    try {
      db = getDb();
    } catch {
      await auditFailure();
      return send(res, 503, 'not_configured', 'Local database is unavailable.');
    }
    const abort = new AbortController();
    const onClose = () => {
      if (!res.writableEnded) abort.abort();
    };
    res.once('close', onClose);
    try {
      const now = new Date();
      const { zip, manifest } = await buildExportZip({
        ...buildOptions,
        db,
        now,
        tables: parsed.tables,
        signal: abort.signal,
      });
      const body = Buffer.from(zip.buffer, zip.byteOffset, zip.byteLength);
      const complete = manifest.complete;
      const meta = { tables: manifest.totals.tables, rows: manifest.totals.rows, bytes: body.length };
      await recordAudit({
        kind: 'export',
        feature: 'data_export',
        status: complete ? 'ok' : 'error',
        meta: complete ? meta : { ...meta, partial: true },
      });
      const timestamp = now.toISOString().slice(0, 19).replace(/[:T]/g, '-');
      const suffix = !parsed.tables ? '' : parsed.tables.length === 1 ? `-${parsed.tables[0]}` : '-partial';
      res.set('Content-Type', 'application/zip');
      res.set(
        'Content-Disposition',
        `attachment; filename="burrow-export-${timestamp}${suffix}.zip"`,
      );
      res.set('X-Export-Complete', complete ? '1' : '0');
      res.set('Access-Control-Expose-Headers', 'X-Export-Complete, Content-Disposition');
      res.set('Content-Length', String(body.length));
      return res.send(body);
    } catch (e) {
      if (e?.code === 'export_aborted') {
        await auditFailure();
        return undefined;
      }
      const tooLarge = e?.code === 'export_too_large';
      if (!tooLarge) console.error('Export error:', e?.code ?? 'unknown');
      await auditFailure();
      return tooLarge
        ? send(res, 413, 'export_too_large', 'Export is too large to download in one file.', {
            tables: [...allowedIds],
          })
        : send(res, 500, 'server_error', 'Export failed');
    } finally {
      res.off('close', onClose);
    }
  });
}
