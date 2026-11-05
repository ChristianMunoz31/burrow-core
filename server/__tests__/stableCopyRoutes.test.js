// GET and POST /api/backups/stable-copy over HTTP. Same middleware order as server.js (JSON parser,
// restore gate, routes). A stable build registers nothing and answers 404 not_found.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb, insertMany, openDb, select } from '../db/index.js';
import { restoreGateMiddleware } from '../backup/lock.js';
import { registerStableCopyRoutes } from '../backup/stableCopyRoutes.js';
import { cleanupBackupEnv, dataDir, resetBackupEnv } from './helpers/backupEnv.js';

function makeApp({ channel = 'dev', authEnabled = false, ip } = {}) {
  const app = express();
  if (ip) {
    app.use((req, _res, next) => {
      Object.defineProperty(req, 'ip', { value: ip });
      next();
    });
  }
  app.use(express.json({ limit: '2mb' }));
  app.use('/api', restoreGateMiddleware);
  registerStableCopyRoutes(app, { authEnabled, channel });
  app.use('/api', (_req, res) => res.status(404).json({ error: 'not_found' }));
  return app;
}

const tmpDirs = [];
function fakeStable(notes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-stable-routes-'));
  tmpDirs.push(dir);
  const db = openDb({ filename: path.join(dir, 'burrow.db') });
  for (const body of notes) insertMany('notes', [{ body }], { db });
  db.close();
  return dir;
}

let app;
beforeEach(() => {
  resetBackupEnv();
  app = makeApp();
});
afterEach(() => {
  delete process.env.BURROW_STABLE_DATA_DIR;
});
afterAll(() => {
  cleanupBackupEnv();
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const post = (body, a = app) => request(a).post('/api/backups/stable-copy').set('Content-Type', 'application/json').send(body);

describe('stable channel', () => {
  it('registers nothing: both methods answer 404 not_found', async () => {
    const stable = makeApp({ channel: 'stable' });
    const get = await request(stable).get('/api/backups/stable-copy');
    expect(get.status).toBe(404);
    expect(get.body).toEqual({ error: 'not_found' });
    const res = await post({ confirm: true }, stable);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'not_found' });
  });

  it('defaults to the channel of the process, which is stable in tests', async () => {
    const defaulted = express();
    defaulted.use(express.json());
    registerStableCopyRoutes(defaulted);
    defaulted.use('/api', (_req, res) => res.status(404).json({ error: 'not_found' }));
    expect((await request(defaulted).get('/api/backups/stable-copy')).status).toBe(404);
  });
});

describe('dev channel GET', () => {
  it('answers the status shape, no-store', async () => {
    const dir = fakeStable(['a']);
    process.env.BURROW_STABLE_DATA_DIR = dir;
    const res = await request(app).get('/api/backups/stable-copy');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(Object.keys(res.body)).toEqual(['data']);
    expect(Object.keys(res.body.data).sort()).toEqual(
      ['busy', 'dataDir', 'found', 'lastChangedAt', 'overridden', 'sameFolder'].sort(),
    );
    expect(res.body.data).toMatchObject({ found: true, dataDir: dir, overridden: true, busy: false, sameFolder: false });
  });

  it('says not found when the folder is missing', async () => {
    process.env.BURROW_STABLE_DATA_DIR = path.join(os.tmpdir(), 'burrow-stable-does-not-exist-xyz');
    const res = await request(app).get('/api/backups/stable-copy');
    expect(res.body.data).toMatchObject({ found: false, lastChangedAt: null });
  });

  it('refuses a non-loopback client when sign-in is off', async () => {
    const remote = makeApp({ ip: '203.0.113.9' });
    const res = await request(remote).get('/api/backups/stable-copy');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('auth_required');
  });
});

describe('dev channel POST', () => {
  it('415 without a JSON content type', async () => {
    const res = await request(app).post('/api/backups/stable-copy').set('Content-Type', 'text/plain').send('confirm');
    expect(res.status).toBe(415);
    expect(res.body).toMatchObject({ error: 'unsupported_media_type', code: 'unsupported_media_type' });
  });

  it.each([[{}], [{ confirm: false }], [{ confirm: 'true' }], [{ confirm: true, id: 'x' }], [[]], [{ id: 'x' }]])(
    '400 invalid_request for %j',
    async (body) => {
      const res = await post(body);
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: 'invalid_request', code: 'invalid_request' });
      expect(res.headers['cache-control']).toBe('no-store');
    },
  );

  it('404 stable_not_found with the standard error envelope', async () => {
    process.env.BURROW_STABLE_DATA_DIR = path.join(os.tmpdir(), 'burrow-stable-does-not-exist-xyz');
    const res = await post({ confirm: true });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      error: 'stable_not_found',
      code: 'stable_not_found',
      message: 'No Burrow data was found on this computer to copy.',
    });
  });

  it('409 stable_same_folder', async () => {
    process.env.BURROW_STABLE_DATA_DIR = dataDir();
    const res = await post({ confirm: true });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('stable_same_folder');
  });

  it('200 with the documented shape; the data is replaced; a POST in flight does not deadlock the gate', async () => {
    getDb();
    const dir = fakeStable(['from-stable-1', 'from-stable-2']);
    process.env.BURROW_STABLE_DATA_DIR = dir;
    const started = Date.now();
    const res = await post({ confirm: true });
    expect(res.status).toBe(200);
    // The restore waits up to 10 s for other requests to drain: the copy request itself must not count.
    expect(Date.now() - started).toBeLessThan(8000);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(Object.keys(res.body.data).sort()).toEqual(
      ['copiedFrom', 'safetyBackupId', 'schemaFrom', 'schemaTo', 'totalRows'].sort(),
    );
    expect(res.body.data.copiedFrom).toBe(dir);
    expect(typeof res.body.data.safetyBackupId).toBe('string');
    expect(Number.isInteger(res.body.data.schemaFrom)).toBe(true);
    expect(Number.isInteger(res.body.data.schemaTo)).toBe(true);
    expect(res.body.data.totalRows).toBeGreaterThanOrEqual(2);
    expect(select('notes').map((n) => n.body).sort()).toEqual(['from-stable-1', 'from-stable-2']);
  });

  it('rate limits at 5 per window with 429 rate_limited', async () => {
    for (let i = 0; i < 5; i += 1) expect((await post({})).status).toBe(400);
    const res = await post({});
    expect(res.status).toBe(429);
    expect(res.body.error).toBe('rate_limited');
  });
});
