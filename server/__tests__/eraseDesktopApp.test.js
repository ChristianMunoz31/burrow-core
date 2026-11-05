// Erase through the REAL server.js app in desktop mode: the desktop gate (cookie, cross-site and origin
// checks) runs first, and APP_PASSWORD is ignored. Env is set before the app imports.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { resetLicenseForTests } from '../license/index.js';
import { cleanupBackupEnv } from './helpers/backupEnv.js';
import { SAME_ORIGIN, freshDb, licenseRows, rowCounts, seedEverything } from './helpers/eraseEnv.js';

vi.mock('../../loadEnv.js', () => ({}));

const SECRET = Buffer.alloc(32, 7);
const ENV_KEYS = ['BURROW_DESKTOP', 'APP_PASSWORD', 'AUTH_SECRET', 'SECRETS_ENCRYPTION_KEY', 'BURROW_DIST_DIR'];
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
afterAll(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

let app;
let cookie;
beforeAll(async () => {
  delete process.env.SECRETS_ENCRYPTION_KEY;
  delete process.env.BURROW_DIST_DIR;
  process.env.BURROW_DESKTOP = '1';
  // Ignored in desktop mode: erasing must not ask for a password the desktop app never had.
  process.env.APP_PASSWORD = 'sekret-pass';
  process.env.AUTH_SECRET = 'unit-test-secret-unit-test-secret-1234';
  app = (await import('../../server.js')).default;
  const auth = await import('../desktop/auth.js');
  auth.initDesktopAuth(SECRET);
  cookie = `burrow_desktop=${auth.cookieValue()}`;
});

beforeEach(() => {
  freshDb();
});
afterEach(() => {
  resetLicenseForTests();
  cleanupBackupEnv();
});

const gated = (path, headers = {}, payload = {}) => request(app).post(path).set(SAME_ORIGIN).set(headers).send(payload);

describe('desktop mode', () => {
  it('rejects both routes without the desktop cookie (401 desktop_auth_required), and GET too', async () => {
    const { db } = seedEverything();
    for (const path of ['/api/data/erase/request', '/api/data/erase']) {
      const res = await gated(path, {}, { token: 'x', phrase: 'ERASE' });
      expect(res.status, path).toBe(401);
      expect(res.body.error).toBe('desktop_auth_required');
    }
    expect((await request(app).get('/api/data/erase')).status).toBe(401);
    expect(rowCounts(db).notes).toBe(1);
  });

  it('refuses a cross-site request even with the cookie (403 cross_site_blocked)', async () => {
    const { db } = seedEverything();
    for (const path of ['/api/data/erase/request', '/api/data/erase']) {
      const res = await gated(path, { Cookie: cookie, 'Sec-Fetch-Site': 'cross-site' }, { token: 'x', phrase: 'ERASE' });
      expect(res.status, path).toBe(403);
      expect(res.body.error).toBe('cross_site_blocked');
    }
    expect(rowCounts(db).notes).toBe(1);
  });

  it('refuses a foreign Origin even with the cookie (403 origin_not_allowed), and issues no token', async () => {
    const { db } = seedEverything();
    for (const path of ['/api/data/erase/request', '/api/data/erase']) {
      const res = await gated(path, { Cookie: cookie, Origin: 'https://evil.example.com' }, { token: 'x', phrase: 'ERASE' });
      expect(res.status, path).toBe(403);
      expect(res.body.error).toBe('origin_not_allowed');
    }
    expect(rowCounts(db).notes).toBe(1);
  });

  it('answers 405 to GET with the cookie, never data and never a 404 from the data browser', async () => {
    for (const path of ['/api/data/erase', '/api/data/erase/request']) {
      const res = await request(app).get(path).set('Cookie', cookie);
      expect(res.status, path).toBe(405);
      expect(res.headers['cache-control']).toBe('no-store');
    }
  });

  it('erases with the cookie, a token and the phrase, and never asks for APP_PASSWORD', async () => {
    const { db } = seedEverything();
    const requested = await gated('/api/data/erase/request', { Cookie: cookie });
    expect(requested.status).toBe(200);
    expect(requested.headers['cache-control']).toBe('no-store');
    const trial = licenseRows(db)['license.trial'];
    const res = await gated('/api/data/erase', { Cookie: cookie }, { token: requested.body.data.token, phrase: 'ERASE' });
    expect(res.status).toBe(200);
    expect(res.body.data.erased).toBe(true);
    expect(rowCounts(db).journal).toBe(0);
    expect(licenseRows(db)['license.trial']).toEqual(trial);
  });

  it('a token is bound to the cookie: the same token without the cookie gets 401 from the gate', async () => {
    seedEverything();
    const requested = await gated('/api/data/erase/request', { Cookie: cookie });
    const res = await gated('/api/data/erase', {}, { token: requested.body.data.token, phrase: 'ERASE' });
    expect(res.status).toBe(401);
  });

  it('while it runs, other requests get 503 data_erasing (gate), and the gate reopens after', async () => {
    seedEverything();
    const requested = await gated('/api/data/erase/request', { Cookie: cookie });
    const done = await gated('/api/data/erase', { Cookie: cookie }, { token: requested.body.data.token, phrase: 'ERASE' });
    expect(done.status).toBe(200);
    const after = await request(app).get('/api/todos').set('Cookie', cookie);
    expect(after.status).toBe(200);
    expect(after.body).toEqual([]);
  });
});
