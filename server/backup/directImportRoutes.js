// REST API for the copy from the direct Burrow: GET and POST /api/backups/direct-import, implemented in directImport.js.
// Registered in every build; a build that is not the Store build in the userprofile data location answers
// { available: false } to GET and 404 import_unavailable to POST, so a direct build never offers it. Behind the host guard,
// CORS (none on this path), the desktop gate and sign-in like /api/backups; POST also needs a same-origin request, JSON, and
// the exact body { confirm: true }, and shares a small rate limit. Every response is no-store.
import { makeRequireSignIn } from '../export/access.js';
import { resolveHostPolicy } from '../hostGuard.js';
import { makeRequireSameOrigin } from '../sameOriginGuard.js';
import { BackupError } from './errors.js';
import { getDirectImportStatus, importFromDirect, importOffered } from './directImport.js';
import { limiter, requireJson, sendError } from './routes.js';

export const DIRECT_IMPORT_PATH = '/api/backups/direct-import';

/** Case and trailing-slash insensitive, like Express routing. Used by the CORS layer in server.js. */
export const isDirectImportPath = (p) => String(p).toLowerCase().replace(/\/+$/, '') === DIRECT_IMPORT_PATH;

/**
 * @param {import('express').Express} app
 * @param {{ authEnabled?: boolean, hostPolicy?: ReturnType<typeof resolveHostPolicy>, status?: typeof getDirectImportStatus,
 *   run?: typeof importFromDirect, offered?: () => boolean }} [opts] status, run and offered are test seams.
 */
export function registerDirectImportRoutes(
  app,
  { authEnabled = false, hostPolicy = resolveHostPolicy(), status = getDirectImportStatus, run = importFromDirect, offered = importOffered } = {},
) {
  const noStore = (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  };
  const requireSignIn = makeRequireSignIn({ authEnabled, action: 'Importing your data' });
  const requireSameOrigin = makeRequireSameOrigin({ hostPolicy, onBlocked: (res) => sendError(res, new BackupError('import_origin_blocked')) });
  const importLimiter = limiter(5);

  app.get(DIRECT_IMPORT_PATH, noStore, requireSignIn, async (_req, res) => {
    try {
      return res.json({ data: await status() });
    } catch (e) {
      return sendError(res, e);
    }
  });

  app.post(DIRECT_IMPORT_PATH, noStore, requireSameOrigin, requireSignIn, requireJson, (req, res, next) => {
    if (!offered()) return sendError(res, new BackupError('import_unavailable'));
    return next();
  }, importLimiter, async (req, res) => {
    const body = req.body;
    const validBody = body !== null && typeof body === 'object' && !Array.isArray(body) && Object.keys(body).length === 1 && body.confirm === true;
    if (!validBody) return sendError(res, new BackupError('invalid_request'));
    try {
      return res.json({ data: await run() });
    } catch (e) {
      return sendError(res, e);
    }
  });
}
