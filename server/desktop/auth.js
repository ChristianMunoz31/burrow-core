// Desktop sidecar auth. The shell and this process share a per-launch 32-byte secret (stdin handshake).
// The shell opens GET /desktop/bootstrap?token=<hex> once; that sets an HttpOnly session cookie, and
// every other request must carry it. Both values are HMACs of the secret, so the secret itself
// never travels over HTTP.
import crypto from 'node:crypto';
import { isSameOrigin, resolveHostPolicy } from '../hostGuard.js';

export const BOOTSTRAP_PATH = '/desktop/bootstrap';
export const DESKTOP_COOKIE = 'burrow_desktop';
export const UNAUTHORIZED_HTML =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Burrow</title></head>' +
  '<body><p>Open Burrow from its app icon.</p></body></html>';

// Shown for a reused or wrong bootstrap token (for example a webview that lost its cookie).
export const LOST_SESSION_HTML =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Burrow</title></head>' +
  '<body><p>This Burrow window lost its session. Close Burrow and open it again.</p></body></html>';

const BOOTSTRAP_LABEL = 'burrow-bootstrap-v1';
const COOKIE_LABEL = 'burrow-cookie-v1';
const UPDATE_KEY_LABEL = 'burrow-update-key-v1';
const UPDATE_MSG_PREFIX = 'burrow-update-v1\n';
const DIALOG_KEY_LABEL = 'burrow-dialog-key-v1';
const DIALOG_REQUEST_PREFIX = 'burrow-dialog-request-v1\n';
const DIALOG_REPLY_PREFIX = 'burrow-dialog-reply-v1\n';
const DIALOG_FETCH_PREFIX = 'burrow-dialog-fetch-v1\n';
const DIALOG_COMMIT_PREFIX = 'burrow-dialog-commit-v1\n';
const SECRET_BYTES = 32;
const TOKEN_HEX_RE = /^[0-9a-f]{64}$/;
const API_PREFIX_RE = /^\/api(\/|$)/i;
const DIALOG_FILE_RE = /^\/desktop\/dialog-file\/[0-9a-f]{32}(\/ok)?$/;

/** @type {{ bootstrap: Buffer, cookieText: string, updateKey: Buffer, dialogKey: Buffer } | null} */
let state = null;
let bootstrapUsed = false;

const hmac = (secret, label) => crypto.createHmac('sha256', secret).update(label).digest();

/**
 * Install the launch secret (call once, before listening). Resets the single-use bootstrap flag.
 * @param {Buffer} secret 32 bytes
 */
export function initDesktopAuth(secret) {
  if (!Buffer.isBuffer(secret) || secret.length !== SECRET_BYTES) {
    throw new TypeError('Desktop secret must be a 32-byte Buffer');
  }
  state = {
    bootstrap: hmac(secret, BOOTSTRAP_LABEL),
    cookieText: hmac(secret, COOKIE_LABEL).toString('base64url'),
    updateKey: hmac(secret, UPDATE_KEY_LABEL),
    dialogKey: hmac(secret, DIALOG_KEY_LABEL),
  };
  bootstrapUsed = false;
}

/** Test seam: forget the secret so the gate fails closed. */
export function resetDesktopAuth() {
  state = null;
  bootstrapUsed = false;
}

const requireState = () => {
  if (!state) throw new Error('Desktop auth is not initialised');
  return state;
};

/** @returns {string} hex(HMAC-SHA256(secret, 'burrow-bootstrap-v1')) */
export const bootstrapToken = () => requireState().bootstrap.toString('hex');

/** @returns {string} base64url(HMAC-SHA256(secret, 'burrow-cookie-v1')) */
export const cookieValue = () => requireState().cookieText;

/**
 * MAC for one update request line: hex(HMAC-SHA256(updateKey, "burrow-update-v1\n" + version + "\n" + nonce)),
 * where updateKey = HMAC-SHA256(secret, "burrow-update-key-v1"). The shell verifies it before it acts.
 * @param {string} version strict x.y.z
 * @param {string} nonce 32 lowercase hex characters
 * @returns {string} 64 lowercase hex characters
 */
export const updateRequestMac = (version, nonce) =>
  crypto
    .createHmac('sha256', requireState().updateKey)
    .update(`${UPDATE_MSG_PREFIX}${version}\n${nonce}`)
    .digest('hex');

const safeEqual = (a, b) => a.length === b.length && crypto.timingSafeEqual(a, b);

const dialogMac = (message) => crypto.createHmac('sha256', requireState().dialogKey).update(message, 'utf8').digest();
const LOWER_HEX_64 = /^[0-9a-f]{64}$/;
const macMatches = (expected, presented) =>
  typeof presented === 'string' && LOWER_HEX_64.test(presented) && safeEqual(expected, Buffer.from(presented, 'hex'));

/**
 * MAC for one dialog request line (folder picker or save dialog): hex(HMAC-SHA256(dialogKey, "burrow-dialog-request-v1\n" +
 * kind + "\n" + id + "\n" + ttl + "\n" + name + "\n" + ext + "\n" + bytes)), where dialogKey =
 * HMAC-SHA256(secret, "burrow-dialog-key-v1"). The shell verifies it before it opens any window.
 * @param {{ kind: string, id: string, ttl: number, name: string, ext: string, bytes: number }} r
 * @returns {string} 64 lowercase hex characters
 */
export const dialogRequestMac = ({ kind, id, ttl, name, ext, bytes }) =>
  dialogMac(`${DIALOG_REQUEST_PREFIX}${kind}\n${id}\n${ttl}\n${name}\n${ext}\n${bytes}`).toString('hex');

/**
 * Timing-safe check of the MAC the shell put on a reply line.
 * @param {{ id: string, status: string, path: string, mac: string }} r
 * @returns {boolean}
 */
export function dialogReplyMacOk({ id, status, path, mac }) {
  if (!state) return false;
  return macMatches(dialogMac(`${DIALOG_REPLY_PREFIX}${id}\n${status}\n${path}`), mac);
}

/**
 * Timing-safe check of the proof header the shell sends when it fetches the bytes of a save request.
 * @param {string} id 32 lowercase hex characters
 * @param {unknown} proofHex
 * @returns {boolean}
 */
export function dialogFetchProofOk(id, proofHex) {
  if (!state) return false;
  return macMatches(dialogMac(`${DIALOG_FETCH_PREFIX}${id}`), proofHex);
}

/**
 * Timing-safe check of the proof header the shell sends for the commit check, right before it writes a saved file. A
 * separate prefix from the fetch proof, so the proof that fetched the bytes cannot also commit.
 * @param {string} id 32 lowercase hex characters
 * @param {unknown} proofHex
 * @returns {boolean}
 */
export function dialogCommitProofOk(id, proofHex) {
  if (!state) return false;
  return macMatches(dialogMac(`${DIALOG_COMMIT_PREFIX}${id}`), proofHex);
}

/** Vitest only: the dialog key as hex, so a test can build the replies the shell would send. */
export function dialogKeyHexForTests() {
  if (!process.env.VITEST) throw new Error('dialogKeyHexForTests is a test seam');
  return requireState().dialogKey.toString('hex');
}

const readCookie = (req, name) => {
  const header = req.headers.cookie;
  if (typeof header !== 'string') return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
};

const hasValidCookie = (req) => {
  if (!state) return false;
  const presented = readCookie(req, DESKTOP_COOKIE);
  if (!presented) return false;
  return safeEqual(Buffer.from(presented), Buffer.from(state.cookieText));
};

const denyJson = (res, status, body) => {
  res.set('Cache-Control', 'no-store');
  return res.status(status).json(body);
};

/**
 * Middleware enforcing the desktop gate. Mount right after the host guard.
 * `serveDialogFile` answers `GET /desktop/dialog-file/<id>` and `GET /desktop/dialog-file/<id>/ok` before the cookie checks, like the bootstrap path: the shell
 * has no cookie, and the handler itself requires a valid proof header (uniform 404 otherwise).
 * @param {{ env?: Record<string, string | undefined>, serveDialogFile?: (req: import('express').Request, res: import('express').Response) => unknown }} [opts]
 * @returns {import('express').RequestHandler}
 */
export function createDesktopGate({ env = process.env, serveDialogFile } = {}) {
  const policy = resolveHostPolicy(env);
  return (req, res, next) => {
    if (typeof serveDialogFile === 'function' && req.method === 'GET' && DIALOG_FILE_RE.test(req.path)) {
      return serveDialogFile(req, res);
    }

    if (req.method === 'GET' && req.path === BOOTSTRAP_PATH) {
      const token = req.query.token;
      const valid =
        !bootstrapUsed &&
        state !== null &&
        typeof token === 'string' &&
        TOKEN_HEX_RE.test(token) &&
        safeEqual(Buffer.from(token, 'hex'), Buffer.from(state.bootstrap));
      if (!valid) {
        res.set('Cache-Control', 'no-store');
        return res.status(403).type('text/html').send(LOST_SESSION_HTML);
      }
      bootstrapUsed = true;
      res.set('Cache-Control', 'no-store');
      res.append('Set-Cookie', `${DESKTOP_COOKIE}=${state.cookieText}; HttpOnly; SameSite=Strict; Path=/`);
      return res.redirect(302, '/');
    }

    if (String(req.get('sec-fetch-site') || '').toLowerCase() === 'cross-site') {
      return denyJson(res, 403, { error: 'cross_site_blocked' });
    }
    const origin = req.get('origin');
    if (origin && req.method !== 'GET' && req.method !== 'HEAD' && !isSameOrigin(origin, req.get('host'), policy)) {
      return denyJson(res, 403, { error: 'origin_not_allowed' });
    }

    if (hasValidCookie(req)) return next();
    if (API_PREFIX_RE.test(req.path)) return denyJson(res, 401, { error: 'desktop_auth_required' });
    res.set('Cache-Control', 'no-store');
    return res.status(401).type('text/html').send(UNAUTHORIZED_HTML);
  };
}
