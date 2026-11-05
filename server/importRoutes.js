// POST /api/import: restores an export ZIP (current or legacy v1 format) into the local
// database. Registered behind the auth gate in server.js. Without sign-in enabled, only
// loopback clients may import. Responses use the { data } / { error, code } envelope.
import express from 'express';
import rateLimit from 'express-rate-limit';
import { getDb } from './db/index.js';
import { makeRequireSignIn } from './export/access.js';
import { IMPORT_API_MAX_TOTAL_BYTES, ImportError, importZipBuffer } from './import/importExport.js';
import { recordAudit } from './auditHook.js';

export const IMPORT_MAX_BODY = '16mb';

const send = (res, status, code, error) => res.status(status).json({ error, code });
const auditFailure = (dryRun) =>
  recordAudit({ kind: 'export', feature: 'data_import', status: 'error', meta: { tables: 0, rows: 0, dry_run: dryRun } });

/**
 * @param {import('express').Express} app
 * @param {{ authEnabled?: boolean }} [opts] other options (e.g. a hosting flag) are accepted and ignored
 */
export function registerImportRoutes(app, { authEnabled = false } = {}) {
  const noStore = (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  };
  const importLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req, res) => {
      res.set('Cache-Control', 'no-store');
      res.status(429).json({ error: 'Too many imports, please try again later.', code: 'rate_limited' });
    },
  });

  app.post(
    '/api/import',
    noStore,
    makeRequireSignIn({ authEnabled, action: 'Import' }),
    importLimiter,
    express.raw({ type: ['application/zip', 'application/octet-stream'], limit: IMPORT_MAX_BODY }),
    async (req, res) => {
      const dryRun = req.query.dryRun === '1' || req.query.dryRun === 'true';
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        return send(res, 400, 'invalid_request', 'Send the export ZIP as the request body.');
      }
      let db;
      try {
        db = getDb();
      } catch {
        await auditFailure(dryRun);
        return send(res, 503, 'not_configured', 'Local database is unavailable.');
      }
      try {
        const bytes = new Uint8Array(req.body.buffer, req.body.byteOffset, req.body.byteLength);
        const result = importZipBuffer(bytes, { db, dryRun, maxTotalBytes: IMPORT_API_MAX_TOTAL_BYTES });
        await recordAudit({
          kind: 'export',
          feature: 'data_import',
          status: 'ok',
          meta: { tables: result.tables.length, rows: result.totals.received, dry_run: dryRun },
        });
        return res.json({ data: result });
      } catch (e) {
        await auditFailure(dryRun);
        if (e instanceof ImportError) return send(res, e.status, e.code, e.message);
        console.error('Import error:', e?.code ?? 'unknown');
        return send(res, 500, 'server_error', 'Import failed');
      }
    },
  );
}
