// CSRF protection of the erase routes through the REAL server.js app in web mode WITHOUT a sign-in password.
// The default CORS allowlist trusts the Vite dev port (5174) and the Burrow port (4321) on both loopback
// names, so ALLOWED_ORIGINS cannot be the protection: the erase routes need the same-origin guard.
// The limiter is per app instance, so this file has its own app import.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { resetLicenseForTests } from '../license/index.js';
import { cleanupBackupEnv } from './helpers/backupEnv.js';
import { freshDb, rowCounts, seedEverything } from './helpers/eraseEnv.js';

vi.mock('../../loadEnv.js', () => ({}));

const ENV_KEYS = ['BURROW_DESKTOP', 'APP_PASSWORD', 'AUTH_SECRET', 'SECRETS_ENCRYPTION_KEY', 'BURROW_DIST_DIR', 'ALLOWED_ORIGINS'];
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
afterAll(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

let app;
beforeAll(async () => {
  for (const k of ENV_KEYS) delete process.env[k];
  app = (await import('../../server.js')).default;
});
beforeEach(() => {
  freshDb();
});
afterEach(() => {
  resetLicenseForTests();
  cleanupBackupEnv();
});

const PATHS = ['/api/data/erase/request', '/api/data/erase'];
const BURROW = { Host: '127.0.0.1:4321', Origin: 'http://127.0.0.1:4321' };
const attempt = (path, headers) => request(app).post(path).set(headers).send({ token: 'x', phrase: 'ERASE' });

describe('erase routes in web-open mode: the same-origin guard', () => {
  it('refuses the default-allowlisted dev origin http://localhost:5174 when Host is 127.0.0.1:4321', async () => {
    const { db } = seedEverything();
    for (const path of PATHS) {
      const res = await attempt(path, { Host: '127.0.0.1:4321', Origin: 'http://localhost:5174' });
      expect(res.status, path).toBe(403);
      expect(res.body.error, path).toBe('erase_origin_blocked');
      expect(res.headers['access-control-allow-origin'], path).toBeUndefined();
    }
    expect(rowCounts(db).notes).toBe(1);
  });

  it('refuses http://127.0.0.1:5174 and the other loopback name on the Burrow port', async () => {
    seedEverything();
    for (const origin of ['http://127.0.0.1:5174', 'http://localhost:4321', 'http://localhost:5174']) {
      for (const path of PATHS) {
        const res = await attempt(path, { Host: '127.0.0.1:4321', Origin: origin });
        expect(res.status, `${origin} ${path}`).toBe(403);
        expect(res.body.error).toBe('erase_origin_blocked');
      }
    }
  });

  it('refuses a request with no Origin header, and a foreign Origin', async () => {
    seedEverything();
    for (const path of PATHS) {
      const none = await attempt(path, { Host: '127.0.0.1:4321' });
      expect(none.status, path).toBe(403);
      expect(none.body.error).toBe('erase_origin_blocked');
      const foreign = await attempt(path, { ...BURROW, Origin: 'https://evil.example.com' });
      expect(foreign.status, path).toBe(403);
      expect(foreign.body.error).toBe('erase_origin_blocked');
    }
  });

  it('refuses Sec-Fetch-Site values other than same-origin and none', async () => {
    seedEverything();
    for (const site of ['cross-site', 'same-site']) {
      for (const path of PATHS) {
        const res = await attempt(path, { ...BURROW, 'Sec-Fetch-Site': site });
        expect(res.status, `${site} ${path}`).toBe(403);
        expect(res.body.error).toBe('erase_origin_blocked');
      }
    }
  });

  it('sends no CORS headers on the erase routes, not even for a preflight from an allowlisted origin', async () => {
    for (const path of PATHS) {
      const pre = await request(app)
        .options(path)
        .set({ Host: '127.0.0.1:4321', Origin: 'http://localhost:5174', 'Access-Control-Request-Method': 'POST' });
      expect(pre.headers['access-control-allow-origin'], path).toBeUndefined();
      const same = await attempt(path, BURROW);
      expect(same.headers['access-control-allow-origin'], path).toBeUndefined();
    }
  });

  it('other API routes keep their CORS behaviour for the allowlisted dev origin', async () => {
    const res = await request(app).get('/api/todos').set({ Host: '127.0.0.1:4321', Origin: 'http://localhost:5174' });
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5174');
  });

  it('works same-origin, and through the Vite dev proxy (Host stays localhost:5174, no changeOrigin)', async () => {
    const { db } = seedEverything();
    const dev = { Host: 'localhost:5174', Origin: 'http://localhost:5174', 'Sec-Fetch-Site': 'same-origin' };
    const requested = await request(app).post(PATHS[0]).set(dev).send({});
    expect(requested.status).toBe(200);
    const done = await request(app).post(PATHS[1]).set(dev).send({ token: requested.body.data.token, phrase: 'ERASE' });
    expect(done.status).toBe(200);
    expect(rowCounts(db).notes).toBe(0);
  });

  it('binds an open-mode token to the page that asked: another origin cannot use it', async () => {
    const { db } = seedEverything();
    const dev = { Host: 'localhost:5174', Origin: 'http://localhost:5174' };
    const requested = await request(app).post(PATHS[0]).set(dev).send({});
    expect(requested.status).toBe(200);
    const other = await request(app).post(PATHS[1]).set(BURROW).send({ token: requested.body.data.token, phrase: 'ERASE' });
    expect(other.status).toBe(403);
    expect(other.body.error).toBe('erase_token_invalid');
    expect(rowCounts(db).notes).toBe(1);
  });
});
