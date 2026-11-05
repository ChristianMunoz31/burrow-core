// POST /api/transactions/import: bulk-adds parsed statement rows (from a CSV file or a published
// Google Sheet) with server-side dedupe, in one transaction. Registered behind the auth gate in
// server.js. Without sign-in enabled, only loopback clients may import. Envelope: { data } / { error, code }.
import express from 'express';
import rateLimit from 'express-rate-limit';
import { getDb } from './db/index.js';
import { makeRequireSignIn } from './export/access.js';
import { TransactionImportError, importTransactions } from './import/transactionImport.js';
import { recordAudit } from './auditHook.js';

export const TRANSACTION_IMPORT_PATH = '/api/transactions/import';
export const TRANSACTION_IMPORT_MAX_BODY = '4mb';

const send = (res, status, code, error, extra = {}) => res.status(status).json({ error, code, ...extra });

/**
 * @param {import('express').Express} app
 * @param {{ authEnabled?: boolean }} [opts]
 */
export function registerTransactionImportRoutes(app, { authEnabled = false } = {}) {
  const noStore = (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  };
  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req, res) => {
      res.set('Cache-Control', 'no-store');
      res.status(429).json({ error: 'Too many imports, please try again later.', code: 'rate_limited' });
    },
  });
  const audit = (status, meta) =>
    recordAudit({ kind: 'export', feature: 'transactions_import', status, meta });

  app.post(
    TRANSACTION_IMPORT_PATH,
    noStore,
    makeRequireSignIn({ authEnabled, action: 'Import' }),
    limiter,
    express.json({ limit: TRANSACTION_IMPORT_MAX_BODY }),
    async (req, res) => {
      const dryRun = req.query.dryRun === '1' || req.query.dryRun === 'true';
      const source = req.body?.source === 'sheet' || req.body?.source === 'file' ? req.body.source : 'unknown';
      const rowCount = Array.isArray(req.body?.rows) ? req.body.rows.length : 0;
      const failMeta = { rows: rowCount, inserted: 0, duplicates: 0, dry_run: dryRun, source };
      let db;
      try {
        db = getDb();
      } catch {
        await audit('error', failMeta);
        return send(res, 503, 'not_configured', 'Local database is unavailable.');
      }
      try {
        const result = importTransactions({ body: req.body, dryRun, db });
        await audit('ok', {
          rows: result.received,
          inserted: result.inserted,
          duplicates: result.duplicates,
          dry_run: dryRun,
          source: result.source,
        });
        const { received, inserted, duplicates, duplicateIndexes } = result;
        return res.json({ data: { received, inserted, duplicates, duplicateIndexes, dryRun } });
      } catch (e) {
        await audit('error', failMeta);
        if (e instanceof TransactionImportError) {
          return send(res, e.status, e.code, e.message, e.details ? { details: e.details } : {});
        }
        console.error('Transaction import error:', e?.code ?? 'unknown');
        return send(res, 500, 'server_error', 'Import failed');
      }
    },
  );
}
