// /api/license routes (docs/LICENSING.md section 10). Registered after the auth gate in server.js.
// Request bodies are never logged, store text is never echoed, and keyHash, instanceId and the key are
// never returned.
import {
  LicenseError,
  activateLicense,
  deactivateLicense,
  dismissTrialNotice,
  getLicenseStatus,
  removeLicense,
} from './license/index.js';
import { STORE_ERROR_STATUS, storeErrorMessage } from './license/messages.js';

const MSG_UNAVAILABLE = 'Burrow could not read the license state. Your data is safe.';

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function sendLicenseError(res, err) {
  if (err instanceof LicenseError) {
    const body = { error: err.code, message: err.publicMessage };
    if (err.detail !== undefined) body.detail = err.detail;
    return res.status(err.httpStatus).json(body);
  }
  console.error('License error:', err?.code || err?.name || 'unknown');
  return res.status(500).json({ error: 'license_unavailable', message: MSG_UNAVAILABLE });
}

const invalidRequest = (res) =>
  res.status(STORE_ERROR_STATUS.invalid_request).json({ error: 'invalid_request', message: storeErrorMessage('invalid_request') });

/**
 * @param {import('express').Express} app
 */
export function registerLicenseRoutes(app) {
  app.use('/api/license', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  app.get('/api/license', (req, res) => {
    try {
      res.json(getLicenseStatus());
    } catch (err) {
      sendLicenseError(res, err);
    }
  });

  app.post('/api/license/activate', async (req, res) => {
    const body = req.body;
    if (!isPlainObject(body) || typeof body.licenseKey !== 'string') return invalidRequest(res);
    if (Object.hasOwn(body, 'store') && body.store !== undefined && typeof body.store !== 'string') return invalidRequest(res);
    try {
      res.json(await activateLicense({ licenseKey: body.licenseKey, store: body.store }));
    } catch (err) {
      sendLicenseError(res, err);
    }
  });

  app.post('/api/license/deactivate', async (req, res) => {
    const body = req.body ?? {};
    if (!isPlainObject(body) || (body.licenseKey !== undefined && typeof body.licenseKey !== 'string')) return invalidRequest(res);
    try {
      res.json(await deactivateLicense({ licenseKey: body.licenseKey }));
    } catch (err) {
      sendLicenseError(res, err);
    }
  });

  // The trial starts on its own at first launch; this only records that a one-time notice was dismissed.
  app.post('/api/license/trial/notice', (req, res) => {
    const body = req.body;
    if (!isPlainObject(body) || typeof body.notice !== 'string') return invalidRequest(res);
    try {
      res.json(dismissTrialNotice(body.notice));
    } catch (err) {
      sendLicenseError(res, err);
    }
  });

  // A malformed JSON body on the three POST body routes is a bad request. Every other error (including 413)
  // falls through to the global handler.
  app.use('/api/license', (err, req, res, next) => {
    if (err?.type === 'entity.parse.failed' && req.method === 'POST' && (req.path === '/activate' || req.path === '/deactivate' || req.path === '/trial/notice')) {
      res.set('Cache-Control', 'no-store');
      return invalidRequest(res);
    }
    return next(err);
  });

  app.delete('/api/license', async (req, res) => {
    try {
      res.json(await removeLicense());
    } catch (err) {
      sendLicenseError(res, err);
    }
  });
}
