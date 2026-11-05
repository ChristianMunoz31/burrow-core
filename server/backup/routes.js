// REST API for backups: /api/backups. Registered behind the auth gate in server.js. Without sign-in
// enabled, only loopback clients may use it (like export and import). Every response is no-store.
// Success: { data }. Errors: { error: <code>, code: <code>, message }.
import rateLimit from 'express-rate-limit';
import { isDesktopMode } from '../runtime.js';
import { makeRequireSignIn } from '../export/access.js';
import { BackupError, isBackupError } from './errors.js';
import {
  applyRetentionIfIdle,
  createBackup,
  getBackupStatus,
  listBackupSummaries,
  pokeBackupScheduler,
} from './service.js';
import { toSummary } from './manifest.js';
import { backupsDir } from './paths.js';
import { inspectUpload, restoreBackup } from './restore.js';
import { dismissAutoOffReminder, getAutoBackup, getBackupSettings, saveAutoBackup, saveBackupSettings } from './settings.js';

const UPLOAD_TYPES = ['application/octet-stream', 'application/vnd.sqlite3'];
const RESTORE_KEYS = new Set(['id', 'uploadToken', 'confirm']);

export function sendError(res, e) {
  res.set('Cache-Control', 'no-store');
  if (isBackupError(e)) {
    if (e.code === 'db_restoring') res.set('Retry-After', '5');
    return res.status(e.status).json({ error: e.code, code: e.code, message: e.message });
  }
  if (e?.name === 'DbError') {
    const restoring = e.code === 'db_restoring';
    if (restoring) res.set('Retry-After', '5');
    return res.status(503).json({
      error: restoring ? 'db_restoring' : 'db_unavailable',
      code: restoring ? 'db_restoring' : 'db_unavailable',
      message: restoring ? 'Burrow is restoring a backup. This takes a few seconds.' : 'Local data is unavailable.',
    });
  }
  console.error('Backup error:', e?.code ?? e?.name ?? 'unknown');
  return res.status(500).json({ error: 'backup_failed', code: 'backup_failed', message: new BackupError('backup_failed').message });
}

/** A JSON-only route: anything else is rejected before it can do work (cross-site form posts). */
export const requireJson = (req, res, next) => {
  if (!req.is('application/json')) {
    return sendError(res, new BackupError('unsupported_media_type', { message: 'Send the request as JSON.' }));
  }
  return next();
};

const requireUploadType = (req, res, next) => {
  if (!req.is(UPLOAD_TYPES)) return sendError(res, new BackupError('unsupported_media_type'));
  return next();
};

export const limiter = (max) =>
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req, res) => {
      res.set('Cache-Control', 'no-store');
      res.status(429).json({ error: 'rate_limited', code: 'rate_limited', message: 'Too many requests. Try again later.' });
    },
  });

/**
 * @param {import('express').Express} app
 * @param {{ authEnabled?: boolean }} [opts]
 */
export function registerBackupRoutes(app, { authEnabled = false } = {}) {
  const noStore = (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  };
  const guard = [noStore, makeRequireSignIn({ authEnabled, action: 'Backup' })];
  const createLimiter = limiter(10);
  // Upload and restore share one budget.
  const restoreLimiter = limiter(10);

  app.get('/api/backups/status', ...guard, async (_req, res) => {
    try {
      return res.json({ data: await getBackupStatus() });
    } catch (e) {
      return sendError(res, e);
    }
  });

  app.get('/api/backups', ...guard, async (_req, res) => {
    try {
      const [backups, status, settings] = await Promise.all([
        listBackupSummaries(),
        getBackupStatus(),
        getBackupSettings(),
      ]);
      return res.json({ data: { backups, status, settings, location: backupsDir(), desktop: isDesktopMode() } });
    } catch (e) {
      return sendError(res, e);
    }
  });

  app.post('/api/backups', ...guard, requireJson, createLimiter, async (_req, res) => {
    try {
      const { meta } = await createBackup({ kind: 'manual' });
      return res.status(201).json({ data: { backup: toSummary(meta) } });
    } catch (e) {
      return sendError(res, e);
    }
  });

  app.put('/api/backups/settings', ...guard, requireJson, async (req, res) => {
    try {
      const settings = await saveBackupSettings(req.body);
      await applyRetentionIfIdle({ settings }).catch(() => {});
      return res.json({ data: settings });
    } catch (e) {
      return sendError(res, e);
    }
  });

  // The automatic backups switch: body { enabled: boolean }. Turning it on needs no confirmation and
  // brings the next scheduler check forward; the confirmation for turning it off is in the UI.
  app.put('/api/backups/auto', ...guard, requireJson, async (req, res) => {
    try {
      const before = await getAutoBackup();
      const auto = await saveAutoBackup(req.body);
      // Only an off -> on change needs the scheduler brought forward.
      if (auto.enabled && !before.enabled) pokeBackupScheduler();
      return res.json({ data: auto });
    } catch (e) {
      return sendError(res, e);
    }
  });

  // "Not now" on the Home reminder: remembered here (not in the browser: the desktop app's origin
  // changes every launch) so the reminder shows at most once a week.
  app.post('/api/backups/auto/dismiss-reminder', ...guard, requireJson, async (_req, res) => {
    try {
      return res.json({ data: await dismissAutoOffReminder() });
    } catch (e) {
      return sendError(res, e);
    }
  });

  app.post('/api/backups/upload', ...guard, requireUploadType, restoreLimiter, async (req, res) => {
    // The client going away (the answer was not sent yet) cancels the inspection: a queued check is
    // dropped and a running one is terminated. The request's own 'close' fires once the body is read,
    // so the response's 'close' is the disconnect signal.
    const gone = new AbortController();
    const onClose = () => {
      if (!res.writableEnded) gone.abort();
    };
    res.once('close', onClose);
    try {
      // `now` is the server clock at answer time: the browser works out how long the check lasts
      // from expiresAt minus now, so its own clock never decides when the upload runs out.
      return res.json({ data: { ...(await inspectUpload(req, { signal: gone.signal })), now: new Date().toISOString() } });
    } catch (e) {
      // The rest of an oversized or rejected body is not read: close the connection after answering.
      res.set('Connection', 'close');
      return sendError(res, e);
    } finally {
      res.off('close', onClose);
    }
  });

  app.post('/api/backups/restore', ...guard, requireJson, restoreLimiter, async (req, res) => {
    const body = req.body;
    const validBody =
      body !== null &&
      typeof body === 'object' &&
      !Array.isArray(body) &&
      Object.keys(body).every((k) => RESTORE_KEYS.has(k)) &&
      body.confirm === true &&
      (body.id === undefined) !== (body.uploadToken === undefined);
    if (!validBody) return sendError(res, new BackupError('invalid_request'));
    try {
      const result = await restoreBackup({ id: body.id, uploadToken: body.uploadToken });
      return res.json({ data: result });
    } catch (e) {
      return sendError(res, e);
    }
  });
}
