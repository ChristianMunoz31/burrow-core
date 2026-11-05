// POST /api/data/erase/request, then POST /api/data/erase: the owner-requested "Erase all my data".
// Registered behind the auth gate (web sign-in) and the desktop gate in server.js, so both run first, as do
// the host guard, CORS and the desktop cross-site and origin checks. Errors are { error, code, message };
// success is { data }. Every response is no-store. Nothing here is reachable by GET, by AI, by import or by
// the state API; this is the only module that imports server/erase/eraseService.js.
import rateLimit from 'express-rate-limit';
import { recordAudit } from './auditHook.js';
import { makeRequireSignIn } from './export/access.js';
import { resolveHostPolicy } from './hostGuard.js';
import { makeRequireSameOrigin } from './sameOriginGuard.js';
import { ERASE_TOKEN_TTL_MS, createEraseTokenStore, sessionKeyOf } from './erase/eraseTokens.js';
import { PRE_COMMIT_BUSY_CODES, eraseAllData, eraseUnavailable, isEraseError } from './erase/eraseService.js';

// Typed exactly, case-sensitive.
export const ERASE_PHRASE = 'ERASE';
export const ERASE_PATH = '/api/data/erase';
export const ERASE_REQUEST_PATH = '/api/data/erase/request';

/** Case and trailing-slash insensitive, like Express routing. Used by the CORS layer in server.js. */
export const isEraseRoutePath = (p) => {
  const normalized = String(p).toLowerCase().replace(/\/+$/, '');
  return normalized === ERASE_PATH || normalized === ERASE_REQUEST_PATH;
};

export const ERASE_ROUTE_ERRORS = Object.freeze({
  erase_origin_blocked: {
    status: 403,
    message: 'Burrow only erases from its own window. Open Burrow, go to Settings, then Data & storage, and use Erase all my data there.',
  },
  unsupported_media_type: { status: 415, message: 'Send the request as JSON.' },
  invalid_request: { status: 400, message: 'That request was not valid. Reload Burrow, then try again.' },
  erase_token_required: {
    status: 400,
    message: 'This erase was not confirmed. Choose Erase all my data again and follow the steps.',
  },
  erase_token_invalid: {
    status: 403,
    message: 'This erase confirmation is not valid. Choose Erase all my data again and follow the steps.',
  },
  erase_token_used: {
    status: 409,
    message: 'This erase confirmation was already used. Choose Erase all my data again if you still want to erase.',
  },
  erase_token_expired: {
    status: 410,
    message: 'This erase confirmation expired after 2 minutes. Choose Erase all my data again to start over.',
  },
  erase_phrase_mismatch: { status: 400, message: 'Type ERASE in capital letters exactly, then try again.' },
  erase_password_required: { status: 401, message: 'Enter your Burrow password to erase your data.' },
  erase_password_invalid: { status: 401, message: 'That password is not right. Check it and try again. Nothing was erased.' },
  method_not_allowed: { status: 405, message: 'Use the Erase all my data button in Settings, then Data & storage.' },
  rate_limited: { status: 429, message: 'Too many erase attempts. Wait 15 minutes, then try again. Nothing was erased.' },
});

const send = (res, code, extra = {}) => {
  const { status, message } = ERASE_ROUTE_ERRORS[code];
  res.set('Cache-Control', 'no-store');
  return res.status(status).json({ error: code, code, message, ...extra });
};

const limiter = (max, { refundWhen } = {}) =>
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    // express-rate-limit only consults requestWasSuccessful when skipFailedRequests is on.
    ...(refundWhen ? { skipFailedRequests: true, requestWasSuccessful: (_req, res) => !refundWhen(res) } : {}),
    handler: (_req, res) => send(res, 'rate_limited'),
  });

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isOptionalBool = (v) => v === undefined || typeof v === 'boolean';

/**
 * @param {import('express').Express} app
 * @param {{ authEnabled?: boolean, verifyPassword?: (input: unknown) => boolean,
 *   tokenStore?: ReturnType<typeof createEraseTokenStore>, erase?: typeof eraseAllData,
 *   hostPolicy?: ReturnType<typeof resolveHostPolicy>, unavailable?: typeof eraseUnavailable }} [opts]
 *   verifyPassword is the timing-safe check used by the web sign-in; it is only asked when authEnabled.
 *   tokenStore, erase, hostPolicy and unavailable are test seams.
 */
export function registerEraseRoutes(
  app,
  { authEnabled = false, verifyPassword = () => false, tokenStore, erase = eraseAllData, hostPolicy = resolveHostPolicy(), unavailable = eraseUnavailable } = {},
) {
  const tokens = tokenStore ?? createEraseTokenStore();
  const requireSignIn = makeRequireSignIn({ authEnabled, action: 'Erasing your data' });
  // Erase-only guard, ahead of the sign-in check and independent of ALLOWED_ORIGINS (see server/sameOriginGuard.js).
  const requireSameOrigin = makeRequireSameOrigin({ hostPolicy, onBlocked: (res) => send(res, 'erase_origin_blocked') });
  // A busy answer is given before the limiter and the token are touched: it costs the user nothing.
  const refuseWhenBusy = (_req, res, next) => {
    const busy = unavailable();
    if (!busy) return next();
    res.locals.eraseBusy = true;
    return res.status(busy.status).json({ error: busy.code, code: busy.code, message: busy.message });
  };
  const noStore = (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  };
  const requireJson = (req, res, next) => (req.is('application/json') ? next() : send(res, 'unsupported_media_type'));
  // Requests that ask for a token and attempts to erase have separate budgets: an attempt is 2 requests.
  const requestLimiter = limiter(6);
  // A refusal that happens before anything is deleted (busy) gives its slot back; every other attempt counts.
  const eraseLimiter = limiter(3, { refundWhen: (res) => res.locals.eraseBusy === true });

  app.post(ERASE_REQUEST_PATH, noStore, requireSameOrigin, requireSignIn, requestLimiter, requireJson, async (req, res) => {
    const { token, expiresAt } = tokens.issue(sessionKeyOf(req));
    await recordAudit({ kind: 'auth', feature: 'data_erase_request', status: 'ok' });
    return res.json({
      data: { token, expiresAt: new Date(expiresAt).toISOString(), expiresInSeconds: Math.round(ERASE_TOKEN_TTL_MS / 1000) },
    });
  });

  app.post(ERASE_PATH, noStore, requireSameOrigin, requireSignIn, refuseWhenBusy, eraseLimiter, requireJson, async (req, res) => {
    const body = req.body;
    if (!isPlainObject(body) || !isOptionalBool(body.deleteBackups)) {
      return send(res, 'invalid_request');
    }
    const session = sessionKeyOf(req);
    const verdict = tokens.check(session, body.token);
    if (verdict !== 'ok') return send(res, `erase_token_${verdict === 'missing' ? 'required' : verdict}`);
    if (body.phrase !== ERASE_PHRASE) return send(res, 'erase_phrase_mismatch');
    if (authEnabled) {
      if (typeof body.password !== 'string' || body.password === '') return send(res, 'erase_password_required');
      if (!verifyPassword(body.password)) return send(res, 'erase_password_invalid');
    }
    if (!tokens.consume(session, body.token)) return send(res, 'erase_token_used');
    const deleteBackups = body.deleteBackups === true;
    try {
      const result = await erase({ deleteBackups });
      return res.json({ data: { erased: true, ...result } });
    } catch (e) {
      const known = isEraseError(e);
      await recordAudit({
        kind: 'auth',
        feature: 'data_erase_failed',
        status: 'error',
        meta: { reason: known ? e.code : 'unknown' },
      });
      if (known) {
        // Refused before anything was deleted: the token and the rate-limit slot are not spent.
        if (PRE_COMMIT_BUSY_CODES.includes(e.code)) {
          tokens.release(session, body.token);
          res.locals.eraseBusy = true;
        }
        return res.status(e.status).json({ error: e.code, code: e.code, message: e.message });
      }
      console.error('Erase error:', e?.code ?? e?.name ?? 'unknown');
      return res.status(500).json({ error: 'erase_failed', code: 'erase_failed', message: 'Nothing was erased. Close and reopen Burrow, then try again.' });
    }
  });

  // Never by GET (or anything else): the data browser has `GET /api/data/...` routes registered after this.
  app.all([ERASE_PATH, ERASE_REQUEST_PATH], (_req, res) => {
    res.set('Allow', 'POST');
    return send(res, 'method_not_allowed');
  });
}
