// The two-step erase routes on a small app (the service is stubbed here; eraseService.test.js and the
// real-app files cover the wipe itself). The clock is injected into the token store.
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ERASE_ROUTE_ERRORS, registerEraseRoutes } from '../eraseRoutes.js';
import { ERASE_TOKEN_TTL_MS, createEraseTokenStore, sessionKeyOf } from '../erase/eraseTokens.js';
import { EraseError } from '../erase/eraseService.js';
import { setAuditSink } from '../auditHook.js';
import { SAME_ORIGIN } from './helpers/eraseEnv.js';

const EXPECTED_COPY = {
  erase_token_required: 'This erase was not confirmed. Choose Erase all my data again and follow the steps.',
  erase_token_invalid: 'This erase confirmation is not valid. Choose Erase all my data again and follow the steps.',
  erase_token_used: 'This erase confirmation was already used. Choose Erase all my data again if you still want to erase.',
  erase_token_expired: 'This erase confirmation expired after 2 minutes. Choose Erase all my data again to start over.',
  erase_phrase_mismatch: 'Type ERASE in capital letters exactly, then try again.',
  erase_password_required: 'Enter your Burrow password to erase your data.',
  erase_password_invalid: 'That password is not right. Check it and try again. Nothing was erased.',
  rate_limited: 'Too many erase attempts. Wait 15 minutes, then try again. Nothing was erased.',
};

let clock;
let audits;
const ok = { counts: { tables: 17, rows: 3, secrets: 1, backups: 0 }, backupsDeleted: false };

function build({ authEnabled = false, erase = vi.fn(async () => ok) } = {}) {
  const tokenStore = createEraseTokenStore({ now: () => clock.t, mono: () => clock.t });
  const app = express();
  app.use(express.json());
  registerEraseRoutes(app, { authEnabled, verifyPassword: (p) => p === 'right-password', tokenStore, erase });
  return { app, erase, tokenStore };
}

const post = (app, path, body, headers = {}) =>
  request(app).post(path).set(SAME_ORIGIN).set(headers).send(body);
const getToken = async (app, headers = {}) => (await post(app, '/api/data/erase/request', {}, headers)).body.data.token;

beforeEach(() => {
  clock = { t: Date.parse('2026-10-05T12:00:00Z') };
  audits = [];
  setAuditSink((event) => audits.push(event));
});
afterEach(() => setAuditSink(null));

describe('POST /api/data/erase/request', () => {
  it('returns a token that lives 2 minutes, with no-store, and audits the request without the token', async () => {
    const { app } = build();
    const res = await post(app, '/api/data/erase/request', {});
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.data.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(res.body.data.expiresInSeconds).toBe(120);
    expect(Date.parse(res.body.data.expiresAt) - clock.t).toBe(ERASE_TOKEN_TTL_MS);
    expect(audits).toEqual([{ kind: 'auth', feature: 'data_erase_request', status: 'ok' }]);
    expect(JSON.stringify(audits)).not.toContain(res.body.data.token);
  });

  it('needs a JSON body type (a cross-site form post cannot send one)', async () => {
    const { app } = build();
    const res = await request(app).post('/api/data/erase/request').set(SAME_ORIGIN).type('form').send('a=b');
    expect(res.status).toBe(415);
    expect(res.body.error).toBe('unsupported_media_type');
  });

  it('is limited to 6 requests per 15 minutes', async () => {
    const { app } = build();
    for (let i = 0; i < 6; i += 1) expect((await post(app, '/api/data/erase/request', {})).status).toBe(200);
    const res = await post(app, '/api/data/erase/request', {});
    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({ error: 'rate_limited', message: EXPECTED_COPY.rate_limited });
  });
});

describe('POST /api/data/erase', () => {
  it('erases with a fresh token and the exact phrase, passing only deleteBackups, and answers no-store', async () => {
    const { app, erase } = build();
    const token = await getToken(app);
    const res = await post(app, '/api/data/erase', { token, phrase: 'ERASE', removeLicense: true, deleteBackups: false, extra: 'x' });
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.data).toMatchObject({ erased: true, counts: { rows: 3 } });
    expect(erase).toHaveBeenCalledTimes(1);
    expect(erase).toHaveBeenCalledWith({ deleteBackups: false });
  });

  it('defaults deleteBackups to off', async () => {
    const { app, erase } = build();
    await post(app, '/api/data/erase', { token: await getToken(app), phrase: 'ERASE' });
    expect(erase).toHaveBeenCalledWith({ deleteBackups: false });
  });

  it('missing token: 400 erase_token_required, nothing erased', async () => {
    const { app, erase } = build();
    const res = await post(app, '/api/data/erase', { phrase: 'ERASE' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'erase_token_required', code: 'erase_token_required', message: EXPECTED_COPY.erase_token_required });
    expect(erase).not.toHaveBeenCalled();
  });

  it('a token nobody issued, or issued to another session: 403 erase_token_invalid', async () => {
    const { app, erase } = build();
    const mine = await getToken(app, { Cookie: 'burrow_desktop=session-a' });
    const guess = await post(app, '/api/data/erase', { token: 'x'.repeat(43), phrase: 'ERASE' }, { Cookie: 'burrow_desktop=session-a' });
    expect(guess.status).toBe(403);
    expect(guess.body.message).toBe(EXPECTED_COPY.erase_token_invalid);
    const stolen = await post(app, '/api/data/erase', { token: mine, phrase: 'ERASE' }, { Cookie: 'burrow_desktop=session-b' });
    expect(stolen.status).toBe(403);
    expect(stolen.body.error).toBe('erase_token_invalid');
    expect(erase).not.toHaveBeenCalled();
    // The rightful session can still use it.
    expect((await post(app, '/api/data/erase', { token: mine, phrase: 'ERASE' }, { Cookie: 'burrow_desktop=session-a' })).status).toBe(200);
  });

  it('an expired token (clock moved past 2 minutes): 410 erase_token_expired', async () => {
    const { app, erase } = build();
    const token = await getToken(app);
    clock.t += ERASE_TOKEN_TTL_MS - 1;
        clock.t += 1;
    const res = await post(app, '/api/data/erase', { token, phrase: 'ERASE' });
    expect(res.status).toBe(410);
    expect(res.body.message).toBe(EXPECTED_COPY.erase_token_expired);
    expect(erase).not.toHaveBeenCalled();
  });

  it('a token still works one millisecond before it expires', async () => {
    const { app } = build();
    const token = await getToken(app);
    clock.t += ERASE_TOKEN_TTL_MS - 1;
    expect((await post(app, '/api/data/erase', { token, phrase: 'ERASE' })).status).toBe(200);
  });

  it('a reused token: 409 erase_token_used, and the service ran once', async () => {
    const { app, erase } = build();
    const token = await getToken(app);
    expect((await post(app, '/api/data/erase', { token, phrase: 'ERASE' })).status).toBe(200);
    const again = await post(app, '/api/data/erase', { token, phrase: 'ERASE' });
    expect(again.status).toBe(409);
    expect(again.body.message).toBe(EXPECTED_COPY.erase_token_used);
    expect(erase).toHaveBeenCalledTimes(1);
  });

  it('asking again replaces the older token', async () => {
    const { app } = build();
    const first = await getToken(app);
    const second = await getToken(app);
    expect((await post(app, '/api/data/erase', { token: first, phrase: 'ERASE' })).status).toBe(403);
    expect((await post(app, '/api/data/erase', { token: second, phrase: 'ERASE' })).status).toBe(200);
  });

  it.each(['erase', 'Erase', 'ERASE ', ' ERASE', 'ERASE.', '', 'ERAS', null, 5, ['ERASE']])(
    'wrong phrase %j: 400 erase_phrase_mismatch, and the token still works for a retry',
    async (phrase) => {
      const { app, erase } = build();
      const token = await getToken(app);
      const res = await post(app, '/api/data/erase', { token, phrase });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: 'erase_phrase_mismatch', message: EXPECTED_COPY.erase_phrase_mismatch });
      expect(erase).not.toHaveBeenCalled();
      expect((await post(app, '/api/data/erase', { token, phrase: 'ERASE' })).status).toBe(200);
    },
  );

  it.each([
    ['a non-boolean deleteBackups', { phrase: 'ERASE', deleteBackups: 1 }],
    ['an array body', []],
  ])('rejects %s with 400 invalid_request and erases nothing', async (_name, extra) => {
    const { app, erase } = build();
    const token = await getToken(app);
    const body = Array.isArray(extra) ? extra : { token, ...extra };
    const res = await post(app, '/api/data/erase', body);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_request');
    expect(erase).not.toHaveBeenCalled();
  });

  it('a missing phrase is a phrase mismatch', async () => {
    const { app } = build();
    expect((await post(app, '/api/data/erase', { token: await getToken(app) })).body.error).toBe('erase_phrase_mismatch');
  });

  it('is limited to 3 attempts per 15 minutes, failed attempts included', async () => {
    const { app, erase } = build();
    for (let i = 0; i < 3; i += 1) expect((await post(app, '/api/data/erase', { phrase: 'ERASE' })).status).toBe(400);
    const token = await getToken(app);
    const res = await post(app, '/api/data/erase', { token, phrase: 'ERASE' });
    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({ error: 'rate_limited', message: EXPECTED_COPY.rate_limited });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(erase).not.toHaveBeenCalled();
  });

  it('needs a JSON body type', async () => {
    const { app } = build();
    const res = await request(app).post('/api/data/erase').set(SAME_ORIGIN).type('text/plain').send('ERASE');
    expect(res.status).toBe(415);
  });

  it('passes a service error through with its status and fixed copy, and audits the failure without content', async () => {
    const erase = vi.fn(async () => {
      throw new EraseError('backup_busy');
    });
    const { app } = build({ erase });
    const res = await post(app, '/api/data/erase', { token: await getToken(app), phrase: 'ERASE' });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: 'backup_busy',
      code: 'backup_busy',
      message: 'A backup is running. Wait for it to finish, then try again. Nothing was erased.',
    });
    expect(audits.at(-1)).toEqual({ kind: 'auth', feature: 'data_erase_failed', status: 'error', meta: { reason: 'backup_busy' } });
  });

  it('turns an unexpected error into the fixed "nothing was erased" answer', async () => {
    const erase = vi.fn(async () => {
      throw new Error('disk exploded with SECRET_DETAIL');
    });
    const { app } = build({ erase });
    const res = await post(app, '/api/data/erase', { token: await getToken(app), phrase: 'ERASE' });
    expect(res.status).toBe(500);
    expect(res.body.message).toBe('Nothing was erased. Close and reopen Burrow, then try again.');
    expect(JSON.stringify(res.body)).not.toContain('SECRET_DETAIL');
  });
});

describe('password re-entry (web sign-in enabled)', () => {
  it('without a password: 401 erase_password_required, token kept', async () => {
    const { app, erase } = build({ authEnabled: true });
    const token = await getToken(app);
    const res = await post(app, '/api/data/erase', { token, phrase: 'ERASE' });
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ error: 'erase_password_required', message: EXPECTED_COPY.erase_password_required });
    expect((await post(app, '/api/data/erase', { token, phrase: 'ERASE', password: 42 })).body.error).toBe('erase_password_required');
    expect(erase).not.toHaveBeenCalled();
  });

  it('with a wrong password: 401 erase_password_invalid, nothing erased', async () => {
    const { app, erase } = build({ authEnabled: true });
    const res = await post(app, '/api/data/erase', { token: await getToken(app), phrase: 'ERASE', password: 'nope' });
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ error: 'erase_password_invalid', message: EXPECTED_COPY.erase_password_invalid });
    expect(erase).not.toHaveBeenCalled();
  });

  it('with the right password it erases', async () => {
    const { app, erase } = build({ authEnabled: true });
    const res = await post(app, '/api/data/erase', { token: await getToken(app), phrase: 'ERASE', password: 'right-password' });
    expect(res.status).toBe(200);
    expect(erase).toHaveBeenCalledTimes(1);
  });

  it('is not asked for when sign-in is off (desktop and open loopback use)', async () => {
    const { app, erase } = build({ authEnabled: false });
    const res = await post(app, '/api/data/erase', { token: await getToken(app), phrase: 'ERASE', password: 'ignored' });
    expect(res.status).toBe(200);
    expect(erase).toHaveBeenCalled();
  });
});

describe('never reachable by anything but POST', () => {
  it.each(['get', 'put', 'patch', 'delete', 'head'])('%s on both paths answers 405 with Allow: POST', async (method) => {
    const { app, erase } = build();
    for (const path of ['/api/data/erase', '/api/data/erase/request']) {
      const res = await request(app)[method](path);
      expect(res.status, `${method} ${path}`).toBe(405);
      expect(res.headers.allow).toBe('POST');
      expect(res.headers['cache-control']).toBe('no-store');
    }
    expect(erase).not.toHaveBeenCalled();
  });

  it('a GET with a query that looks like a confirmation does nothing', async () => {
    const { app, erase } = build();
    const res = await request(app).get('/api/data/erase').query({ phrase: 'ERASE', token: 'x' });
    expect(res.status).toBe(405);
    expect(erase).not.toHaveBeenCalled();
  });
});

describe('without sign-in, loopback only', () => {
  it('refuses a non-loopback client with 403 auth_required (fail closed)', async () => {
    const tokenStore = createEraseTokenStore({ now: () => clock.t, mono: () => clock.t });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      Object.defineProperty(req, 'ip', { value: '203.0.113.9' });
      next();
    });
    registerEraseRoutes(app, { authEnabled: false, tokenStore, erase: vi.fn() });
    const res = await request(app).post('/api/data/erase/request').set(SAME_ORIGIN).send({});
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('auth_required');
  });
});

describe('session keys', () => {
  it('derive from the desktop cookie, then the sign-in cookie, then the client address, and never hold the cookie', () => {
    const desktop = sessionKeyOf({ headers: { cookie: 'a=1; burrow_desktop=abc; burrow_session=zzz' }, ip: '10.0.0.1' });
    const session = sessionKeyOf({ headers: { cookie: 'burrow_session=zzz' }, ip: '10.0.0.1' });
    const open = sessionKeyOf({ headers: {}, ip: '10.0.0.1' });
    const openFromPage = sessionKeyOf({ headers: { origin: 'http://127.0.0.1:4321' }, ip: '10.0.0.1' });
    expect(desktop).toMatch(/^d:[0-9a-f]{64}$/);
    expect(session).toMatch(/^s:[0-9a-f]{64}$/);
    expect(open).toBe('o:10.0.0.1:');
    // Without a sign-in the key also holds the page's Origin: a token is bound to the page that asked.
    expect(openFromPage).toBe('o:10.0.0.1:http://127.0.0.1:4321');
    expect(desktop).not.toContain('abc');
  });
});

describe('every route error has fixed, actionable copy', () => {
  it('names a next step and no em dash', () => {
    for (const [code, { message }] of Object.entries(ERASE_ROUTE_ERRORS)) {
      expect(message.length, code).toBeGreaterThan(20);
      expect(message, code).not.toMatch(/—/);
    }
  });
});

describe('token lifetime runs on a monotonic clock', () => {
  it('moving the wall clock back does not extend a token, and moving it forward does not expire one', () => {
    const t = { wall: Date.parse('2026-10-05T12:00:00Z'), mono: 1000 };
    const store = createEraseTokenStore({ now: () => t.wall, mono: () => t.mono });
    const { token, expiresAt } = store.issue('k');
    expect(expiresAt).toBe(t.wall + ERASE_TOKEN_TTL_MS);
    t.wall -= 24 * 60 * 60 * 1000;
    t.mono += ERASE_TOKEN_TTL_MS - 1;
    expect(store.check('k', token)).toBe('ok');
    t.mono += 1;
    expect(store.check('k', token)).toBe('expired');

    const again = store.issue('j');
    t.wall += 24 * 60 * 60 * 1000;
    expect(store.check('j', again.token)).toBe('ok');
  });

  it('release puts a consumed token back until it expires', () => {
    const t = { wall: 0, mono: 0 };
    const store = createEraseTokenStore({ now: () => t.wall, mono: () => t.mono });
    const { token } = store.issue('k');
    expect(store.consume('k', token)).toBe(true);
    expect(store.check('k', token)).toBe('used');
    expect(store.release('k', 'wrong-token')).toBe(false);
    expect(store.release('k', token)).toBe(true);
    expect(store.check('k', token)).toBe('ok');
    expect(store.consume('k', token)).toBe(true);
    t.mono += ERASE_TOKEN_TTL_MS;
    expect(store.release('k', token)).toBe(false);
  });
});

describe('busy answers before the commit cost nothing', () => {
  const busy = (code) => new EraseError(code);

  it('answers busy before the limiter and the token: no slot, no token spent', async () => {
    const erase = vi.fn(async () => ok);
    const tokenStore = createEraseTokenStore({ now: () => clock.t, mono: () => clock.t });
    let state = busy('backup_busy');
    const app = express();
    app.use(express.json());
    registerEraseRoutes(app, { tokenStore, erase, unavailable: () => state });
    const token = await getToken(app);
    for (let i = 0; i < 5; i += 1) {
      const res = await post(app, '/api/data/erase', { token, phrase: 'ERASE' });
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('backup_busy');
    }
    expect(erase).not.toHaveBeenCalled();
    state = null;
    expect((await post(app, '/api/data/erase', { token, phrase: 'ERASE' })).status).toBe(200);
  });

  it.each(['backup_busy', 'db_restoring', 'erase_busy', 'restore_pending'])(
    'a %s from the service keeps the token and the rate-limit slot',
    async (code) => {
      let fail = true;
      const erase = vi.fn(async () => {
        if (fail) throw busy(code);
        return ok;
      });
      const { app } = build({ erase });
      const token = await getToken(app);
      // Four refused attempts in a row: the limit is 3, so a counted slot would end in 429.
      for (let i = 0; i < 4; i += 1) {
        const res = await post(app, '/api/data/erase', { token, phrase: 'ERASE' });
        expect(res.status).toBe(code === 'db_restoring' ? 503 : 409);
        expect(res.body.error).toBe(code);
      }
      fail = false;
      expect((await post(app, '/api/data/erase', { token, phrase: 'ERASE' })).status).toBe(200);
    },
  );

  it('an erase that ran (even to erase_failed) spends its token', async () => {
    const erase = vi.fn(async () => {
      throw new EraseError('erase_failed');
    });
    const { app } = build({ erase });
    const token = await getToken(app);
    expect((await post(app, '/api/data/erase', { token, phrase: 'ERASE' })).status).toBe(500);
    expect((await post(app, '/api/data/erase', { token, phrase: 'ERASE' })).body.error).toBe('erase_token_used');
  });
});

describe('the same-origin guard on a small app', () => {
  it('refuses a missing or foreign Origin before the sign-in check, with fixed copy', async () => {
    const { app, erase } = build({ authEnabled: true });
    for (const headers of [{ Host: SAME_ORIGIN.Host }, { ...SAME_ORIGIN, Origin: 'https://evil.example.com' }, { ...SAME_ORIGIN, 'Sec-Fetch-Site': 'cross-site' }]) {
      for (const path of ['/api/data/erase/request', '/api/data/erase']) {
        const res = await request(app).post(path).set(headers).send({});
        expect(res.status).toBe(403);
        expect(res.body).toMatchObject({ error: 'erase_origin_blocked', message: ERASE_ROUTE_ERRORS.erase_origin_blocked.message });
      }
    }
    expect(erase).not.toHaveBeenCalled();
  });
});
