// MUST be first: populates process.env before other modules read it at
// import-evaluation time.
import './loadEnv.js';
import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fetch from 'node-fetch';
import { registerDataRoutes } from './server/dataRoutes.js';
import { fetchWeather, fetchOura } from './server/integrations.js';
import { describeAi } from './server/ai/index.js';
import { registerAiSettingsRoutes } from './server/aiSettingsRoutes.js';
import * as dataAccess from './server/dataAccess.js';
import { registerJaviAdvisorRoutes } from './server/javiAdvisorRoutes.js';
import { registerJaviInboxRoutes } from './server/javiInboxRoutes.js';
import { installInboxWriteObserver } from './server/javi/inbox.js';
import { registerExportRoutes } from './server/exportRoutes.js';
import { registerImportRoutes } from './server/importRoutes.js';
import { isEraseRoutePath, registerEraseRoutes } from './server/eraseRoutes.js';
import { registerBackupRoutes } from './server/backup/routes.js';
import { registerStableCopyRoutes } from './server/backup/stableCopyRoutes.js';
import { isDirectImportPath, registerDirectImportRoutes } from './server/backup/directImportRoutes.js';
import { CANCELLED_REASONS, EXIT_IMPORT_RECOVERY, importOffered, reconcileDirectImport, recordCancelledImport } from './server/backup/directImport.js';
import { registerAppInfoRoutes } from './server/appInfoRoutes.js';
import { getChannel, isDevChannel } from './server/channel.js';
import { getDistribution } from './server/distribution.js';
import { checkDataLocation, getDataLocation } from './server/dataLocation.js';
import { logDataFolderWarning } from './server/dataFolderHealth.js';
import { checkDevDataDir, checkShellChannel } from './server/channelGuards.js';
import { ensureDataDirOwnership, resolveStableDataDir } from './server/paths.js';
import { EXIT_DATA_DIR_NOT_OURS } from './server/dataFolderOwnership.js';
import { restoreGateMiddleware } from './server/backup/lock.js';
import { EXIT_RESTORE_RECOVERY, reconcileRestoreJournal } from './server/backup/restore.js';
import { startBackupScheduler, stopBackupScheduler } from './server/backup/service.js';
import { drainBackupWorker, resumeBackupWorker } from './server/backup/worker/client.js';
import { registerTransactionImportRoutes, TRANSACTION_IMPORT_PATH } from './server/transactionImportRoutes.js';
import { peekSecret, secretsPrimer } from './server/secrets/index.js';
import { registerSecretsRoutes } from './server/secretsRoutes.js';
import { registerDataBrowserRoutes } from './server/dataBrowserRoutes.js';
import { registerFolderRoutes } from './server/folderRoutes.js';
import { cancelAllFolderJobs, drainFolderJobs } from './server/folders/jobs.js';
import { recordAudit } from './server/auditHook.js';
import { registerAuditRoutes } from './server/audit.js';
import { recordNetworkCall, statusFromHttp } from './server/networkCall.js';
import { registerNetworkActivityRoutes } from './server/networkAudit.js';
import {
  checkStartupSecurity,
  formatListenUrl,
  isLoopbackHost,
  isSchedulerEnabled,
  resolveAllowedOrigins,
  resolveListenConfig,
  resolveTrustProxy,
} from './server/config.js';
import { createHostGuard, isSameOrigin, resolveHostPolicy } from './server/hostGuard.js';
import { requireNetwork } from './server/netPolicy.js';
import { registerSettingsRoutes } from './server/settingsRoutes.js';
import { INVALID_LOCATION_MESSAGE, resolveWeatherLocation } from './server/weatherLocation.js';
import {
  registerManualDownloadRoute,
  registerUpdateInstallRoute,
  releaseUpdateInstallLease,
} from './server/updateInstallRoutes.js';
import { initLicense } from './server/license/index.js';
import { storeErrorMessage } from './server/license/messages.js';
import { registerLicenseRoutes } from './server/licenseRoutes.js';
import { devExtensionRouter, loadDevExtensions } from './server/devExtensions.js';
import { loadProExtensions, proSlotRouter } from './server/proExtensions.js';
import { registerStaticRoutes } from './server/staticRoutes.js';
import { startScheduler, stopScheduler } from './server/scheduler.js';
import { clearDbShutdown, getDb, isDbError, resolveDbPath, shutdownDb } from './server/db/index.js';
import { envDir, getAppVersion, getCommit, isDesktopMode } from './server/runtime.js';
import { createDesktopGate, initDesktopAuth } from './server/desktop/auth.js';
import { resetDialogs, serveDialogFile } from './server/desktop/dialogBroker.js';
import { attachShellInbox } from './server/desktop/shellInbox.js';
import { buildCsp, createSecurityHeaders } from './server/desktop/csp.js';
import { readSecretLine } from './server/desktop/handshake.js';

// Desktop (Tauri sidecar) mode: per-launch secret gate, strict CSP, no APP_PASSWORD. Decided once at
// import time, like the other env-driven switches below.
const DESKTOP = isDesktopMode();

const DIST_DIR = envDir('BURROW_DIST_DIR') ?? path.join(path.dirname(fileURLToPath(import.meta.url)), 'dist');

const app = express();

// Trust no proxy by default (Burrow listens on loopback). Set BURROW_TRUST_PROXY=1
// only when running behind exactly one reverse proxy, so rate limiting and the
// cookie Secure flag see the real client IP and protocol.
app.set('trust proxy', resolveTrustProxy());

// Express 5 defaults to the 'simple' query parser. Keep qs ('extended') so bracket and repeated params
// (limit[]=5, limit=1&limit=2) still parse as arrays and the strict route validators can reject them.
app.set('query parser', 'extended');

// DNS-rebinding guard: MUST be the first middleware. Any Host outside the allowlist
// (loopback names, BURROW_ALLOWED_HOSTS, a non-loopback BURROW_HOST) gets 421.
app.use(createHostGuard());

if (DESKTOP) {
  // The CSP hashes the inline script in the built index.html once, here. Headers go on every response
  // (the SPA fallback can serve index.html for any path), including the gate's own pages, so they are
  // mounted before the gate.
  let indexHtml = '';
  try {
    indexHtml = fs.readFileSync(path.join(DIST_DIR, 'index.html'), 'utf8');
  } catch {
    // no built UI: the API still works, the CSP just carries no script hashes
  }
  app.use(createSecurityHeaders(buildCsp(indexHtml)));
  app.use(createDesktopGate({ serveDialogFile }));
}

// CORS allowlist. Requests with no Origin (curl, server-to-server) are allowed.
// Browsers also send Origin on same-origin POSTs, so an Origin whose scheme/host/port
// is an allowed host AND equals the request's Host is allowed too (this is what lets the
// bundled UI work on any allowed host/port). Other cross-origin browser requests
// must match ALLOWED_ORIGINS (comma-separated) or the loopback defaults in config.js.
const ALLOWED_ORIGINS = resolveAllowedOrigins();
const HOST_POLICY = resolveHostPolicy();
app.use(
  cors((req, callback) => {
    // The two erase routes and the import from the direct Burrow are never cross-origin: no CORS headers at all (a page
    // on the dev port or any other allowed origin cannot read a token or start a copy). They also run their own same-origin guard.
    if (isEraseRoutePath(req.path) || isDirectImportPath(req.path)) return callback(null, { origin: false });
    const origin = req.get('origin');
    if (!origin || ALLOWED_ORIGINS.includes(origin) || isSameOrigin(origin, req.get('host'), HOST_POLICY)) {
      return callback(null, { origin: true });
    }
    return callback(new Error('Not allowed by CORS'));
  }),
);
// POST /api/export applies its own (much smaller) JSON limit in its route, so the global
// parser must not consume the body first and make that limit dead.
// Express routes case-insensitively and ignores trailing slashes; path checks must too.
const normalizePath = (p) => p.toLowerCase().replace(/\/+$/, '');
const jsonParser = express.json({ limit: '2mb' });
// POST /api/transactions/import parses its own body (explicit 4mb limit, JSON too_large 413).
const OWN_BODY_PATHS = new Set(['/api/export', TRANSACTION_IMPORT_PATH]);
app.use((req, res, next) => (OWN_BODY_PATHS.has(normalizePath(req.path)) ? next() : jsonParser(req, res, next)));

// Rate limiting. A modest global cap on /api plus tighter caps on the
// abuse-prone endpoints: AI POSTs (model time) and /api/sheets/csv (outbound proxy).
// AI status GETs are not counted against the AI budgets.
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.', code: 'rate_limited' },
  // The Folders progress poll (every 2 s while a scan runs) and the dialog poll (every second while a native window is open)
  // have their own, larger limiter in the route, and so does the file preview (240 per 5 minutes), which stepping through a folder calls often.
  // The Javi inbox (a read POST on every navigation) has its own limiter too (inboxLimiter), any method.
  skip: (req) =>
    /^\/jarvis\/inbox(\/read)?$/i.test(req.path) ||
    (req.method === 'GET' && /^\/folders\/([0-9a-f-]{36}\/job|dialogs\/[0-9a-f]{32}|[0-9a-f-]{36}\/files\/[0-9a-f-]{36}\/preview)$/i.test(req.path)),
});
const strictLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.', code: 'rate_limited' },
});
// Dedicated budget for secrets writes/test so heavy use of the AI endpoints (which
// share strictLimiter) can't lock the user out of managing keys, and vice versa.
const secretsWriteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.', code: 'rate_limited' },
});
// Activate and Move to another computer are the only calls that can reach a store: one shared budget
// (10 per 15 min) so a stuck button can't hammer Gumroad or Lemon Squeezy.
const licenseNetworkLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'rate_limited',
    code: 'rate_limited',
    message: storeErrorMessage('rate_limited'),
  },
});
// Approving or declining a proposed Javi change runs no model; it gets its own generous
// budget so a busy AI budget never blocks a confirmation.
const actionsLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.', code: 'rate_limited' },
});
// The Javi inbox (read markers and the unseen pages) runs no model: its own budget, outside the AI and global ones.
const inboxLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.', code: 'rate_limited' },
});
/** Apply `limiter` to POSTs only, unless `skip(req)` says otherwise. */
const postLimiter = (limiter, skip) => (req, res, next) =>
  req.method !== 'POST' || skip?.(req) ? next() : limiter(req, res, next);
// Actions run no model, conversation creation is a plain DB write and the inbox only reads markers: none spends the strict AI budget.
const isActionsPath = (req) => /^\/(actions|conversations|inbox)(\/|$)/i.test(req.path);
// Secrets, data-browser, export and sheets-proxy (carries statement data) responses must never be cached, including limiter/auth errors.
app.use(['/api/secrets', '/api/data', '/api/export', '/api/sheets/csv', '/api/license', '/api/dev', '/api/folders', '/api/jarvis/inbox'], (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
app.use('/api', globalLimiter);
// /api/insights/explain (cross-insights) shares the strict AI budget.
app.use('/api/insights', postLimiter(strictLimiter));
app.use('/api/jarvis/actions', actionsLimiter);
app.use('/api/jarvis/inbox', inboxLimiter);
app.use('/api/jarvis', postLimiter(strictLimiter, isActionsPath));
app.use('/api/sheets/csv', strictLimiter);

// ============================================================
// Auth gate. When APP_PASSWORD + AUTH_SECRET are set, every /api
// route requires a valid signed session cookie obtained via
// POST /api/login. When unset (the default for a single-user local install),
// the gate is disabled and the API is open to whoever can reach the port.
// ============================================================
// Desktop mode ignores both: the per-launch desktop gate above is the only gate there.
const APP_PASSWORD = DESKTOP ? '' : process.env.APP_PASSWORD || '';
const AUTH_SECRET = DESKTOP ? '' : process.env.AUTH_SECRET || '';
const AUTH_ENABLED = !!(APP_PASSWORD && AUTH_SECRET);
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const SESSION_COOKIE = 'burrow_session';
const PUBLIC_AUTH_PATHS = new Set(['/api/login', '/api/logout', '/api/auth/status']);

const signAuth = (payload) =>
  crypto.createHmac('sha256', AUTH_SECRET).update(payload).digest('base64url');

const createSessionToken = () => {
  const payload = String(Date.now() + SESSION_TTL_MS);
  return `${payload}.${signAuth(payload)}`;
};

const verifySessionToken = (token) => {
  if (!token || typeof token !== 'string') return false;
  const dot = token.lastIndexOf('.');
  if (dot < 1) return false;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = signAuth(payload);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  const exp = Number(payload);
  return Number.isFinite(exp) && Date.now() < exp;
};

const parseCookies = (req) => {
  const out = {};
  const header = req.headers.cookie;
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    try {
      out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      // Malformed percent-encoding: skip this pair rather than failing the request.
    }
  }
  return out;
};

// Secure only when the request itself is HTTPS (req.secure; honors X-Forwarded-Proto
// only when BURROW_TRUST_PROXY=1), so plain-http localhost sessions still work.
const sessionCookie = (token, maxAgeSec, secure) => {
  const attrs = [
    `${SESSION_COOKIE}=${token}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    `Max-Age=${maxAgeSec}`,
  ];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
};

const passwordMatches = (input) => {
  try {
    if (typeof input !== 'string') return false;
    const a = crypto.createHmac('sha256', AUTH_SECRET).update(input).digest();
    const b = crypto.createHmac('sha256', AUTH_SECRET).update(APP_PASSWORD).digest();
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
};

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts, please try again later.', code: 'rate_limited' },
});

app.get('/api/auth/status', (req, res) => {
  if (!AUTH_ENABLED) return res.json({ enabled: false, authenticated: true });
  res.json({ enabled: true, authenticated: verifySessionToken(parseCookies(req)[SESSION_COOKIE]) });
});

app.post('/api/login', loginLimiter, async (req, res) => {
  if (!AUTH_ENABLED) return res.status(503).json({ error: 'Auth is not configured' });
  if (!passwordMatches(req.body?.password)) {
    await recordAudit({ kind: 'auth', feature: 'sign_in', status: 'error' });
    return res.status(401).json({ error: 'Invalid password' });
  }
  await recordAudit({ kind: 'auth', feature: 'sign_in', status: 'ok' });
  res.setHeader('Set-Cookie', sessionCookie(createSessionToken(), Math.floor(SESSION_TTL_MS / 1000), req.secure));
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', sessionCookie('', 0, req.secure));
  res.json({ ok: true });
});

// Protect every other /api route. Express routing is case-insensitive (/API/x and
// /Api/x reach the same handlers as /api/x), so the prefix test and the public-path
// lookup compare the lowercased path with trailing slashes ignored.
const API_PREFIX_RE = /^\/api(\/|$)/i;
const normalizeApiPath = (p) => p.toLowerCase().replace(/\/+$/, '');
app.use((req, res, next) => {
  if (!AUTH_ENABLED) return next();
  if (!API_PREFIX_RE.test(req.path)) return next();
  if (PUBLIC_AUTH_PATHS.has(normalizeApiPath(req.path))) return next();
  if (verifySessionToken(parseCookies(req)[SESSION_COOKIE])) return next();
  return res.status(401).json({ error: 'Unauthorized' });
});

// Secrets writes (PUT/DELETE/test) get their own cap; GET (status) is read-only and
// gated, so it only counts against the global limiter. Mounted after the auth gate so
// unauthenticated (401) requests cannot exhaust the owner's write budget; the early
// no-store middleware above still covers their 401s and any 429.
const writesOnly = (limiter) => (req, res, next) =>
  req.method === 'GET' || req.method === 'HEAD' ? next() : limiter(req, res, next);
app.use('/api/secrets', writesOnly(secretsWriteLimiter));

// Warm the secrets cache (one DB read per 60s) so synchronous peekSecret() reads in
// every handler see keys saved from Settings. Mounted after the auth gate.
app.use('/api', secretsPrimer);

// While a backup restore swaps the database file, /api answers 503 db_restoring (only
// GET /api/backups/status passes). Counts in-flight requests so the restore can wait for them.
app.use('/api', restoreGateMiddleware);

// The local SQLite database is the sole data backend. registerDataRoutes serves
// transactions, todos, todo-columns, habits, journal, calendar, notes, bookmarks,
// focus, countdowns and app state. Each route 503s if the database cannot be opened,
// so a failed open never silently removes an endpoint.
// Registered before registerDataRoutes so its own 503 not_configured answers (the data-path 503
// there has no error code) and /api/transactions/import never falls through to the plain CRUD routes.
registerTransactionImportRoutes(app, { authEnabled: AUTH_ENABLED });
registerDataRoutes(app);
app.use(proSlotRouter('insights'));

// ============================================================
// Javi: the tool-calling assistant that reads + acts on the user's real
// Burrow data. SSE-streamed (thinking, delta, tool.start/tool.done, confirm.required,
// final, run.done) so the Javi panel can show tool activity live. Runs on the
// local tool model. Writes wait for confirmation and are bounded by a per-run cap.
// ============================================================
app.get('/api/jarvis/status', async (req, res) => {
  res.json(await describeAi('tools'));
});

// The Pro module registers POST /api/jarvis and POST /api/jarvis/actions/:token behind requirePro (server/proRoutes.js).
app.use(proSlotRouter('jarvis'));

// Javi conversation history (best-effort; 503s if the local database is unavailable).
app.get('/api/jarvis/conversations', async (req, res) => {
  try {
    res.json(await dataAccess.listConversations({ limit: 30 }));
  } catch (err) {
    res.status(Number.isInteger(err?.status) ? err.status : 500).json({ error: 'Failed to list conversations' });
  }
});

const CONVERSATION_TITLE_MAX_CHARS = 200;
app.post('/api/jarvis/conversations', async (req, res) => {
  const title = req.body?.title;
  if (title !== undefined && title !== null && typeof title !== 'string') {
    return res.status(400).json({ error: 'title must be a string' });
  }
  try {
    const clipped = typeof title === 'string' ? title.slice(0, CONVERSATION_TITLE_MAX_CHARS) : undefined;
    res.json(await dataAccess.createConversation({ title: clipped }));
  } catch (err) {
    res.status(Number.isInteger(err?.status) ? err.status : 500).json({ error: 'Failed to create conversation' });
  }
});

app.get('/api/jarvis/conversations/:id/messages', async (req, res) => {
  try {
    res.json(await dataAccess.getMessages(req.params.id, { limit: 100 }));
  } catch (err) {
    res.status(Number.isInteger(err?.status) ? err.status : 500).json({ error: 'Failed to load messages' });
  }
});

// ============================================================
// Global search across todos, notes, journal, bookmarks, countdowns, txns.
// ============================================================
app.get('/api/search', async (req, res) => {
  // Express parses q[a]=b into an object and q=a&q=b into an array; only a plain string is a query.
  const { q } = req.query;
  if (q !== undefined && typeof q !== 'string') {
    return res.status(400).json({ error: 'invalid_query', message: 'The search query must be text.' });
  }
  try {
    const out = await dataAccess.searchData({ query: q, limit: 6 });
    res.json(out);
  } catch (err) {
    res.status(Number.isInteger(err?.status) ? err.status : 500).json({ error: 'Search failed' });
  }
});

// ============================================================
// Daily briefing: built from the user's data + summarized by Javi, cached in
// app_state. Read by the Home card; refreshed on demand or by the in-process
// scheduler (server/scheduler.js).
// ============================================================
app.get('/api/jarvis/briefing', async (req, res) => {
  try {
    const cached = await dataAccess.getState('jarvis.briefing.latest', null);
    res.json(cached || { empty: true });
  } catch (err) {
    res.status(Number.isInteger(err?.status) ? err.status : 500).json({ error: 'Failed to load briefing' });
  }
});

// ============================================================
// Optional modules: Weather, Oura.
// Each one calls a third-party host, so each is gated by server/netPolicy.js and
// answers 403 network_opt_in_required until the user enables it in Settings → Network.
// A module also 503s if its configuration is missing; neither case crashes the server.
// ============================================================

// --- Weather (Open-Meteo, no API key) ---
app.get('/api/weather', requireNetwork('weather'), async (req, res) => {
  // Explicit coords from an API caller first, then the location saved in Settings > Network, then WEATHER_LAT/LON.
  const location = await resolveWeatherLocation({ lat: req.query.lat, lon: req.query.lon });
  if (!location) {
    return res.status(503).json({
      error: 'weather_location_missing',
      code: 'weather_location_missing',
      message: 'Set your location in Settings > Network to see the weather.',
    });
  }
  const { lat, lon } = location;
  try {
    const data = await fetchWeather({ lat, lon });
    // no-store: the URL carries no coordinates, so a browser cache could answer for a location that was since
    // changed, cleared, erased or restored. The UI keeps it for 30 minutes in React Query instead.
    res.set('Cache-Control', 'no-store');
    // Only the fields the UI reads: never the coordinates or time zone Open-Meteo echoes back.
    res.json({ current: data?.current ?? null, daily: data?.daily ?? null, locationSource: location.source });
  } catch (err) {
    if (err.status === 400) {
      return res.status(400).json({ error: 'invalid_location', code: 'invalid_location', message: INVALID_LOCATION_MESSAGE });
    }
    // Never forward an upstream status/body (a 401/403 would read as an app login failure).
    console.error('Weather error:', err?.name || 'unknown', err?.status ?? '');
    if (err?.status) return res.status(502).json({ error: 'Weather unavailable', code: 'upstream_error' });
    res.status(500).json({ error: 'Server error' });
  }
});

// --- Health (Oura Ring v2, Personal Access Token) ---
app.get('/api/oura', requireNetwork('oura'), async (req, res) => {
  try {
    const days = Math.min(90, Math.max(14, Math.trunc(Number(req.query.days)) || 14));
    const result = await fetchOura(peekSecret('OURA_TOKEN'), { days });
    res.set('Cache-Control', 'private, max-age=1800');
    res.json(result);
  } catch (err) {
    // Log the class of failure only; never the message or body (may echo upstream detail).
    console.error('Oura error:', err?.name || 'unknown', err?.status ?? '');
    res.set('Cache-Control', 'no-store');
    if (err?.code === 'not_configured') {
      return res.status(503).json({ error: 'not_configured', message: 'Add your Oura token in Settings > Connected services.' });
    }
    // Never forward upstream 401/403: the browser would read them as an app login failure.
    if (err?.status === 429) return res.status(429).json({ error: 'Oura rate limited', code: 'upstream_rate_limited' });
    if (err?.code === 'timeout' || err?.name === 'TimeoutError') {
      return res.status(504).json({ error: 'Oura unavailable', code: 'upstream_error' });
    }
    return res.status(502).json({ error: 'Oura unavailable', code: 'upstream_error' });
  }
});

// Calendar is served by server/dataRoutes.js (registered above); .ics files are imported from uploaded text, never fetched from a URL.

// --- Google Sheets (published CSV import, read-only) ---
// Proxies a published Google Sheets CSV so the browser avoids CORS and the
// SSRF allowlist lives server-side. Read-only; no credentials. Opt-in (netPolicy
// 'sheets'), and only runs when the user pastes a sheet URL and chooses Load sheet.
const SHEETS_TIMEOUT_MS = 10_000;
const SHEETS_MAX_BYTES = 5 * 1024 * 1024;
const SHEETS_MAX_HOPS = 5;
const SHEETS_DENIED = 'Only https://docs.google.com published-CSV links are allowed';

// The pasted URL must be docs.google.com. Published CSVs redirect to
// *.googleusercontent.com, so that host is accepted on redirect hops only.
const sheetsHostAllowed = (u, isHop) =>
  u.protocol === 'https:' &&
  (u.hostname === 'docs.google.com' || (isHop && u.hostname.endsWith('.googleusercontent.com')));

class SheetsTooLargeError extends Error {}

// Read the body with a hard byte cap; never buffers more than the cap plus one chunk.
async function readSheetsBody(upstream) {
  const declared = Number(upstream.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > SHEETS_MAX_BYTES) throw new SheetsTooLargeError();
  if (!upstream.body || typeof upstream.body[Symbol.asyncIterator] !== 'function') {
    const text = await upstream.text();
    if (Buffer.byteLength(text) > SHEETS_MAX_BYTES) throw new SheetsTooLargeError();
    return text;
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of upstream.body) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > SHEETS_MAX_BYTES) {
      upstream.body.destroy?.();
      throw new SheetsTooLargeError();
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

app.get('/api/sheets/csv', requireNetwork('sheets'), async (req, res) => {
  const raw = req.query.url;
  if (!raw || typeof raw !== 'string') {
    return res.status(400).json({ error: 'url query param required' });
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return res.status(400).json({ error: 'Invalid URL' });
  }
  if (!sheetsHostAllowed(parsed, false)) {
    return res.status(400).json({ error: SHEETS_DENIED });
  }
  // One entry per distinct host a request left for (the first host and each redirect hop that was
  // fetched), with the worst result seen for it. The finally below records them, host only.
  const sheetsHosts = new Map();
  let sheetsCurrentHost = null;
  const noteSheetsHost = (host, status) => {
    if (sheetsHosts.get(host) !== 'error') sheetsHosts.set(host, status);
  };
  try {
    // Follow redirects manually so the allowlist is re-checked on every hop —
    // otherwise a docs.google.com URL could 30x to localhost / 169.254.169.254
    // / an internal host. Cap the chain to avoid loops. One timeout covers all hops and the body.
    const signal = AbortSignal.timeout(SHEETS_TIMEOUT_MS);
    let current = parsed;
    let upstream;
    for (let hop = 0; hop < SHEETS_MAX_HOPS; hop++) {
      sheetsCurrentHost = current.hostname;
      upstream = await fetch(current.toString(), { redirect: 'manual', signal });
      noteSheetsHost(sheetsCurrentHost, statusFromHttp(upstream.status));
      if (upstream.status >= 300 && upstream.status < 400) {
        const location = upstream.headers.get('location');
        if (!location) break;
        let next;
        try {
          next = new URL(location, current);
        } catch {
          return res.status(400).json({ error: 'Invalid redirect target' });
        }
        if (!sheetsHostAllowed(next, true)) {
          return res.status(400).json({ error: SHEETS_DENIED });
        }
        current = next;
        continue;
      }
      break;
    }
    if (!upstream.ok) {
      return res.status(502).json({
        error: `Sheet fetch failed (HTTP ${upstream.status}). Make sure it's "Published to web" or link-shared as CSV.`,
      });
    }
    const csv = await readSheetsBody(upstream);
    res.json({ csv });
  } catch (err) {
    // A timeout or a broken connection while reading the answer makes that host's result a failure.
    if (sheetsCurrentHost && !(err instanceof SheetsTooLargeError)) noteSheetsHost(sheetsCurrentHost, 'error');
    if (err instanceof SheetsTooLargeError) {
      return res.status(413).json({ error: 'Sheet is too large to import (5 MB limit)' });
    }
    console.error('Sheets proxy error:', err?.name || 'unknown');
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      return res.status(504).json({ error: 'Sheet fetch timed out' });
    }
    res.status(502).json({ error: 'Failed to fetch sheet' });
  } finally {
    for (const [host, status] of sheetsHosts) await recordNetworkCall('sheets', host, status);
  }
});

// Javi page advisor: POST /api/jarvis/advice — strictLimiter via the /api/jarvis prefix, behind the auth gate
registerJaviAdvisorRoutes(app);
registerJaviInboxRoutes(app);
installInboxWriteObserver();
registerExportRoutes(app, { authEnabled: AUTH_ENABLED });
registerImportRoutes(app, { authEnabled: AUTH_ENABLED });
registerBackupRoutes(app, { authEnabled: AUTH_ENABLED });
// Erase all my data (two-step token, typed phrase, password re-entry when sign-in is on). Before the data browser, whose
// GET /api/data/... routes must never answer for these paths.
registerEraseRoutes(app, { authEnabled: AUTH_ENABLED, verifyPassword: passwordMatches });
// Dev channel only: one-way copy of the stable Burrow data (a stable build never registers these).
registerStableCopyRoutes(app, { authEnabled: AUTH_ENABLED });
// Store build with data in %USERPROFILE%\Burrow Data only: user-clicked import of the direct Burrow's data (other builds answer 404).
registerDirectImportRoutes(app, { authEnabled: AUTH_ENABLED });
// Version, channel and desktop flag for the UI (Dev build badge).
registerAppInfoRoutes(app);
registerSecretsRoutes(app);
registerDataBrowserRoutes(app);
// Folders (read-only file inventory, summaries, optional local question index), behind the auth and desktop gates.
registerFolderRoutes(app, { hostPolicy: HOST_POLICY });
// Access & AI audit log (GET /api/audit), behind the auth gate.
registerAuditRoutes(app);
// Network activity (GET /api/privacy/network-activity): outbound connections from the audit log, host only.
registerNetworkActivityRoutes(app);
// Profile (display name) and Settings → Network opt-ins, behind the auth gate.
registerSettingsRoutes(app);
// Click-to-install handoff (POST /api/settings/updates/install): backup first, then one authenticated line to the
// desktop shell. 409 outside the stable desktop app. Own limiter (5 per 15 min) inside the route.
registerUpdateInstallRoute(app);
registerManualDownloadRoute(app);
// Settings > AI (Ollama host, models, optional cloud provider), behind the auth gate.
registerAiSettingsRoutes(app);
// Store license keys (status, activate, deactivate, remove, trial), behind the auth gate and the desktop gate.
// The network limiter sits after the auth gate so unauthenticated requests cannot spend the budget (no-store is set earlier).
app.use(['/api/license/activate', '/api/license/deactivate'], postLimiter(licenseNetworkLimiter));
registerLicenseRoutes(app);
// Optional developer extensions install their routes into this router (empty unless startServer loaded one;
// stable bundles cannot load any).
app.use(devExtensionRouter());

// Unmatched API paths answer JSON, never the SPA shell.
app.use('/api', (req, res) => res.status(404).json({ error: 'not_found' }));

// Built UI: when dist/ exists, Burrow serves it itself (single process).
registerStaticRoutes(app, { distDir: DIST_DIR });

// Final error handler: keeps CORS rejections and any uncaught errors from
// leaking a stack trace via Express's default HTML error page.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err && err.message === 'Not allowed by CORS') {
    return res.status(403).json({ error: 'Origin not allowed' });
  }
  // A malformed percent-escape in a route param (/api/todos/%E0%A4%A): the router throws a
  // URIError with status 400 and no err.type, which would otherwise fall through to 500.
  if (err instanceof URIError && err.status === 400) {
    return res.status(400).json({ error: 'invalid_request', message: 'The request address is not valid.' });
  }
  // body-parser 4xx (malformed JSON, 413 too large, 415 unsupported encoding/charset):
  // it attaches the raw request body to err.body, which can contain a pasted API key.
  // Answer with the parser's status and a fixed message; never log the error object.
  const parserStatus = err?.status ?? err?.statusCode;
  if (parserStatus === 413 && normalizePath(req.path) === '/api/import') {
    return res.status(413).json({
      error: 'This file is too large to restore here.',
      code: 'import_too_large',
    });
  }
  if (parserStatus === 413 && normalizePath(req.path) === TRANSACTION_IMPORT_PATH) {
    return res.status(413).json({
      error: 'This import is too large. Split the file into smaller parts and try again.',
      code: 'too_large',
    });
  }
  if (typeof err?.type === 'string' && Number.isInteger(parserStatus) && parserStatus >= 400 && parserStatus < 500) {
    return res.status(parserStatus).json({ error: 'Invalid request body', code: 'invalid_body' });
  }
  console.error('Unhandled error:', err?.type || err?.code || err?.name || 'unknown');
  res.status(500).json({ error: 'Server error' });
});

/**
 * Boots the HTTP server: startup security checks, opens (and migrates) the database, listens, then
 * starts the scheduler. Rejects on a failed security check, database or listen error.
 * In desktop mode it first reads the per-launch secret from `stdin` (see server/desktop/handshake.js),
 * then prints one `BURROW_READY {json}` line once listening, and shuts down when `stdin` closes.
 * @param {{ port?: number, host?: string, handleSignals?: boolean, log?: boolean, stdin?: import('node:stream').Readable }} [opts]
 * @returns {Promise<{ server: import('node:http').Server, url: string, stop: () => Promise<void> }>}
 */
export async function startServer({ port, host, handleSignals = false, log = false, stdin = process.stdin } = {}) {
  const resolved = resolveListenConfig();
  const listenConfig = { ...resolved, ...(port !== undefined ? { port } : {}), ...(host !== undefined ? { host } : {}) };
  const security = checkStartupSecurity();
  for (const w of security.warnings) console.warn(w);
  if (!security.ok) {
    for (const e of security.errors) console.error(e);
    throw Object.assign(new Error('Startup security check failed'), { code: 'startup_security' });
  }
  // Channel isolation guards. Pure path and string checks that run before anything touches the data folder
  // (restore journal, secrets, key file, license, database).
  const shellChannel = DESKTOP ? checkShellChannel() : { ok: true };
  const dataLocationGuard = shellChannel.ok ? checkDataLocation({ dataLocation: getDataLocation(), distribution: getDistribution(), channel: getChannel() }) : shellChannel;
  const dataDirGuard = dataLocationGuard.ok ? checkDevDataDir() : dataLocationGuard;
  if (!dataDirGuard.ok) {
    console.error(dataDirGuard.message);
    throw Object.assign(new Error('Startup security check failed'), { code: 'startup_security' });
  }
  // Store build, user profile data location: the data folder must be missing, empty or carry our marker. Decided here, before the
  // desktop handshake, the import recovery, the restore journal, the database, the key file and the license touch the folder, so a
  // folder that is not ours is never written to (server/dataFolderOwnership.js). Throws `data_dir_not_ours` (exit code 5).
  try {
    ensureDataDirOwnership();
  } catch (err) {
    if (err?.code === 'data_dir_not_ours') throw err;
    throw Object.assign(new Error('Data folder check failed'), { code: 'startup_security', cause: err });
  }
  let stdinGone = false;
  let stdinMarker = null;
  if (DESKTOP) {
    if (!isLoopbackHost(listenConfig.host)) {
      console.error('Desktop mode only listens on a loopback address.');
      throw Object.assign(new Error('Startup security check failed'), { code: 'startup_security' });
    }
    initDesktopAuth(await readSecretLine(stdin));
    // From here until the real shutdown listeners attach (after the DB open and listen), remember that the
    // shell went away and swallow stream errors, so neither is lost or uncaught.
    const markGone = () => {
      stdinGone = true;
    };
    stdin.on('end', markGone);
    stdin.on('close', markGone);
    stdin.on('error', markGone);
    stdinMarker = markGone;
  }
  clearDbShutdown();
  resumeBackupWorker();
  // Store build with data in %USERPROFILE%\Burrow Data: finish an import from the direct Burrow that the user prepared before the
  // last quit (swaps the verified staged files in, moving the empty ones aside). Before the database opens; a no-op otherwise.
  let importApplied = false;
  let importCancelledReason = null;
  if (importOffered()) {
    try {
      const reconciled = await reconcileDirectImport({ log: (m) => console.warn(m) });
      importApplied = reconciled.result === 'swapped';
      if (reconciled.result === 'discarded' && CANCELLED_REASONS.includes(reconciled.reason)) importCancelledReason = reconciled.reason;
    } catch (err) {
      console.error('Import recovery failed:', err?.code || err?.name || 'unknown');
      throw Object.assign(new Error('Import recovery failed'), { code: 'import_recovery_failed', dataDir: path.dirname(resolveDbPath()), cause: err });
    }
  }
  // Finish or undo an interrupted backup restore before the database opens.
  // If recovery cannot finish, refuse to start: opening the database now could create an empty one
  // next to the half-moved real files.
  try {
    await reconcileRestoreJournal();
  } catch (err) {
    const code = err?.code || err?.name || 'unknown';
    console.error('Restore recovery failed:', code);
    throw Object.assign(new Error('Restore recovery failed'), {
      code: 'restore_recovery_failed',
      dataDir: path.dirname(resolveDbPath()),
      cause: err,
    });
  }
  if (isDevChannel()) {
    const stable = resolveStableDataDir();
    if (stable.overridden) console.log(`Burrow Dev: copy source overridden by BURROW_STABLE_DATA_DIR: ${stable.dir}`);
  }
  // Open (and migrate) the database before listening; refuse to start without it.
  getDb();
  // The audit row of the import click lives in the empty database that was moved aside; this one is in the imported database.
  if (importApplied) await recordAudit({ kind: 'auth', feature: 'data_import_applied', status: 'ok' });
  // A prepared import that was cancelled at this start (data added meanwhile, or the staged files no longer verified): an audit
  // row and a note that Home and Settings show once.
  if (importCancelledReason !== null) await recordCancelledImport(importCancelledReason);
  initLicense({ dataDir: path.dirname(resolveDbPath()), distDir: DIST_DIR });
  // Optional developer extensions (no-op in every stable bundle) install before the socket opens.
  await loadDevExtensions();
  // The optional Pro module (absent in a Free build) registers its routes, jobs and texts before the socket opens.
  await loadProExtensions();
  logDataFolderWarning(path.dirname(resolveDbPath()));
  const server = await new Promise((resolve, reject) => {
    const srv = app.listen(listenConfig.port, listenConfig.host);
    srv.once('error', reject);
    srv.once('listening', () => {
      srv.off('error', reject);
      resolve(srv);
    });
  });
  const address = server.address();
  const boundPort = address && typeof address === 'object' ? address.port : listenConfig.port;
  const url = formatListenUrl({ ...listenConfig, port: boundPort });
  if (DESKTOP) {
    // The single line the shell waits for. Never print the secret, bootstrap token or cookie.
    const dataDir = path.dirname(resolveDbPath());
    console.log(`BURROW_READY ${JSON.stringify({ port: boundPort, dataDir, version: getAppVersion(), channel: getChannel(), distribution: getDistribution(), dataLocation: getDataLocation(), commit: getCommit() })}`);
  } else {
    // Resolve the commit once now (a single git spawn) so the first /api/app/info request does not pay for it.
    setImmediate(() => getCommit());
    if (log) {
      console.log(`Burrow running at ${url}`);
      console.log(`Data: ${resolveDbPath()}`);
    }
  }
  if (isSchedulerEnabled()) {
    startScheduler();
    startBackupScheduler();
  }

  let stopping = null;
  const stop = () => {
    if (!stopping) {
      stopScheduler();
      stopBackupScheduler();
      releaseUpdateInstallLease();
      resetDialogs('shutdown');
      stopping = (async () => {
        const closed = new Promise((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections?.();
        });
        // Backup worker: let a running operation finish (up to 1.5 s), else terminate it, so no worker
        // thread holds the database or a partial file when the handle closes. Inside the 3 s hard exit.
        // Folder jobs stop at their next checkpoint and write nothing more (up to 1 s).
        cancelAllFolderJobs('shutdown');
        await Promise.all([closed, drainBackupWorker({ timeoutMs: 1500 }).catch(() => {}), drainFolderJobs({ timeoutMs: 1000 }).catch(() => {})]);
        shutdownDb();
      })();
    }
    return stopping;
  };
  if (handleSignals) {
    let shuttingDown = false;
    const shutdown = () => {
      if (shuttingDown) return;
      shuttingDown = true;
      setTimeout(() => process.exit(0), 3000).unref();
      stop().then(() => process.exit(0));
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    // Desktop shell: Windows cannot deliver SIGTERM to a console-less child, so the parent holds
    // our stdin pipe and closing it (or the parent dying) triggers the same graceful shutdown.
    // Always on in desktop mode; BURROW_EXIT_ON_STDIN_CLOSE=1 enables it for other launchers.
    if (DESKTOP || process.env.BURROW_EXIT_ON_STDIN_CLOSE === '1') {
      stdin.on('end', shutdown);
      stdin.on('close', shutdown);
      stdin.on('error', shutdown);
      if (stdinMarker) {
        stdin.off('end', stdinMarker);
        stdin.off('close', stdinMarker);
        stdin.off('error', stdinMarker);
      }
      if (stdinGone) shutdown();
      // Desktop shell replies to a dialog request (folder picker, save dialog) as one authenticated line on this pipe.
      if (DESKTOP) attachShellInbox(stdin);
      stdin.resume();
    }
  }
  return { server, url, stop };
}

// The app is exported for supertest; Vitest sets VITEST so tests never open a socket.
if (!process.env.VITEST) {
  startServer({ handleSignals: true, log: true }).then(
    ({ server }) => {
      server.on('error', (err) => {
        console.error(`Server error: ${err?.code || err?.name || 'unknown'}`);
        process.exit(1);
      });
    },
    (err) => {
      if (err?.code === 'startup_security') process.exit(1);
      if (err?.code === 'data_dir_not_ours') {
        console.error(err.message);
        process.exit(EXIT_DATA_DIR_NOT_OURS);
      }
      if (err?.code === 'restore_recovery_failed') {
        const dir = err.dataDir ?? '<data dir>';
        const details = err.cause?.details ?? {};
        const backupsPath = path.join(dir, 'backups');
        const asideDb = path.join(dir, 'restore-aside', 'burrow.db');
        const failedFiles = Array.isArray(details.restoreFailed) ? details.restoreFailed : [];
        let previous;
        if (fs.existsSync(asideDb)) {
          previous = `Your previous data is in ${asideDb} and safety copies are in ${backupsPath}.`;
        } else {
          const safety = typeof details.safetyId === 'string' ? `the safety backup ${details.safetyId} in ${backupsPath}` : `the safety copies in ${backupsPath}`;
          const failed = failedFiles.length ? ` and the restore-failed files ${failedFiles.map((n) => path.join(dir, n)).join(', ')}` : '';
          previous = `Your previous data is in ${safety}${failed}.`;
        }
        console.error(
          'Burrow could not finish recovering an interrupted backup restore, so it did not start. ' +
            `Nothing was deleted. ${previous} Close programs that may be using these files ` +
            '(antivirus, sync tools) and start Burrow again.',
        );
        process.exit(EXIT_RESTORE_RECOVERY);
      }
      if (err?.code === 'import_recovery_failed') {
        const dir = err.dataDir ?? '<data dir>';
        console.error(
          'Burrow could not finish putting your imported data in place, so it did not start. Nothing was deleted. ' +
            `Your data is in ${path.join(dir, '.import-*')} and ${path.join(dir, 'import-aside')}. ` +
            `Reason: ${err.cause?.code ?? 'unknown'}. ` +
            'Close programs that may be using these files (antivirus, sync tools) and start Burrow again.',
        );
        process.exit(EXIT_IMPORT_RECOVERY);
      }
      if (err?.code === 'desktop_handshake') {
        console.error('Desktop startup failed: invalid handshake.');
        process.exit(2);
      }
      if (isDbError(err)) console.error(`Database unavailable: ${err.code}`);
      else if (err?.code === 'EADDRINUSE') console.error(`Port ${resolveListenConfig().port} is already in use. Set BURROW_PORT to another port.`);
      else console.error(`Server error: ${err?.code || err?.name || 'unknown'}`);
      process.exit(1);
    },
  );
}

export default app;
