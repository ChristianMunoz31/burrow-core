// /api/backups behind the login gate. Env is set before importing the app because server.js reads
// APP_PASSWORD/AUTH_SECRET at module-evaluation time.
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../loadEnv.js', () => ({}));

import { listMetas } from '../backup/manifest.js';
import { backupsDir } from '../backup/paths.js';
import { cleanupBackupEnv, resetBackupEnv } from './helpers/backupEnv.js';

const PASSWORD = 'backup-auth-pass-4471';
const saved = {
  SECRETS_ENCRYPTION_KEY: process.env.SECRETS_ENCRYPTION_KEY,
  APP_PASSWORD: process.env.APP_PASSWORD,
  AUTH_SECRET: process.env.AUTH_SECRET,
};

let app;
let cookie;
const REMOTE = '203.0.113.77';

beforeAll(async () => {
  delete process.env.SECRETS_ENCRYPTION_KEY;
  process.env.APP_PASSWORD = PASSWORD;
  process.env.AUTH_SECRET = 'backup-auth-test-secret-0123456789abcdef';
  app = (await import('../../server.js')).default;
  const login = await request(app).post('/api/login').set('X-Forwarded-For', '198.51.100.250').send({ password: PASSWORD });
  expect(login.status).toBe(200);
  cookie = login.headers['set-cookie'][0].split(';')[0];
});
beforeEach(() => {
  resetBackupEnv();
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  cleanupBackupEnv();
});

const routes = [
  ['get', '/api/backups'],
  ['get', '/api/backups/status'],
  ['post', '/api/backups'],
  ['put', '/api/backups/settings'],
  ['post', '/api/backups/upload'],
  ['post', '/api/backups/restore'],
];

describe('backups behind the login gate', () => {
  it.each(routes)('%s %s without a session is 401', async (method, url) => {
    const res = await request(app)[method](url).set('X-Forwarded-For', REMOTE).set('Content-Type', 'application/json').send({});
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Unauthorized' });
    expect(await listMetas(backupsDir())).toEqual([]);
  });

  it.each(['/API/BACKUPS', '/api/backups/', '/Api/Backups/Status'])('path variant %s is 401 without a session', async (url) => {
    const res = await request(app).get(url).set('X-Forwarded-For', REMOTE);
    expect(res.status).toBe(401);
  });

  it('a signed-in session can list, create and read status from a non-loopback address', async () => {
    const list = await request(app).get('/api/backups').set('X-Forwarded-For', REMOTE).set('Cookie', cookie);
    expect(list.status).toBe(200);
    expect(list.headers['cache-control']).toMatch(/no-store/);
    const created = await request(app).post('/api/backups').set('X-Forwarded-For', REMOTE).set('Cookie', cookie).set('Content-Type', 'application/json').send({});
    expect(created.status).toBe(201);
    const status = await request(app).get('/api/backups/status').set('X-Forwarded-For', REMOTE).set('Cookie', cookie);
    expect(status.body.data.lastBackupId).toBe(created.body.data.backup.id);
  });

  it('a signed-in restore without confirm is still refused', async () => {
    const res = await request(app)
      .post('/api/backups/restore')
      .set('X-Forwarded-For', REMOTE)
      .set('Cookie', cookie)
      .set('Content-Type', 'application/json')
      .send({ id: '20260101T000000Z-manual-aaaaaa' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_request');
  });

  it('a forged cookie is 401', async () => {
    const res = await request(app).get('/api/backups').set('X-Forwarded-For', REMOTE).set('Cookie', 'burrow_session=forged.value');
    expect(res.status).toBe(401);
  });
});
