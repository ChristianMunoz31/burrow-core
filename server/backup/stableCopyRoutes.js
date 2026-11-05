// REST API for the one-way copy from the stable Burrow: GET and POST /api/backups/stable-copy.
// Registered only in the dev channel (a stable build answers 404 not_found like any unknown /api path).
// Same guard, error contract and no-store rules as /api/backups.
import { getChannel } from '../channel.js';
import { makeRequireSignIn } from '../export/access.js';
import { BackupError } from './errors.js';
import { limiter, requireJson, sendError } from './routes.js';
import { copyFromStable, getStableCopyStatus } from './stableCopy.js';

/**
 * @param {import('express').Express} app
 * @param {{ authEnabled?: boolean, channel?: 'stable' | 'dev' }} [opts]
 */
export function registerStableCopyRoutes(app, { authEnabled = false, channel = getChannel() } = {}) {
  if (channel !== 'dev') return;
  const noStore = (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  };
  const guard = [noStore, makeRequireSignIn({ authEnabled, action: 'Backup' })];
  const copyLimiter = limiter(5);

  app.get('/api/backups/stable-copy', ...guard, async (_req, res) => {
    try {
      return res.json({ data: await getStableCopyStatus() });
    } catch (e) {
      return sendError(res, e);
    }
  });

  app.post('/api/backups/stable-copy', ...guard, requireJson, copyLimiter, async (req, res) => {
    const body = req.body;
    const validBody =
      body !== null &&
      typeof body === 'object' &&
      !Array.isArray(body) &&
      Object.keys(body).length === 1 &&
      body.confirm === true;
    if (!validBody) return sendError(res, new BackupError('invalid_request'));
    try {
      return res.json({ data: await copyFromStable() });
    } catch (e) {
      return sendError(res, e);
    }
  });
}
