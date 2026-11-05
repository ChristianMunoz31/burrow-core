// /api/folders behind the sign-in (APP_PASSWORD) and the restore gate: no route answers an anonymous request, and
// none runs while a restore or an erase holds the gate. Nothing is read from disk by a refused request.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

vi.mock('../../loadEnv.js', () => ({}));
vi.mock('node-fetch', () => ({ default: vi.fn() }));

import fs from 'node:fs';
import path from 'node:path';
import fetch from 'node-fetch';
import { __resetAiForTests } from '../ai/index.js';
import { __resetLockForTests, closeGate, openGate } from '../backup/lock.js';
import { count } from '../db/index.js';
import { cancelAllFolderJobs, drainFolderJobs, waitForFolderJob } from '../folders/jobs.js';
import { __setPathOptionsForTests } from '../folders/pathSafety.js';
import { installFakeOllama } from './helpers/fakeOllama.js';
import { makeTmp, rmTree, useNeutralPaths, writeTree } from './helpers/foldersEnv.js';
import { closeTestDb, createTestDb, resetDb } from './helpers/testDb.js';

const SAME_ORIGIN = Object.freeze({ Host: '127.0.0.1:4321', Origin: 'http://127.0.0.1:4321' });
const NO_FOLDER = '00000000-0000-4000-8000-000000000000';
const PASSWORD = 'sekret-pass';
const IP = '198.51.100.60';
const savedEnv = {
  SECRETS_ENCRYPTION_KEY: process.env.SECRETS_ENCRYPTION_KEY,
  APP_PASSWORD: process.env.APP_PASSWORD,
  AUTH_SECRET: process.env.AUTH_SECRET,
  BURROW_AI: process.env.BURROW_AI,
};

let app;
let db;
let cookie;
let root;
let dir;

const calls = () => [
  ['GET /api/folders', request(app).get('/api/folders')],
  ['POST /api/folders', request(app).post('/api/folders').set(SAME_ORIGIN).send({ path: dir })],
  ['PATCH /api/folders/:id', request(app).patch(`/api/folders/${NO_FOLDER}`).send({ name: 'x' })],
  ['DELETE /api/folders/:id', request(app).delete(`/api/folders/${NO_FOLDER}`)],
  ['POST /api/folders/:id/scan', request(app).post(`/api/folders/${NO_FOLDER}/scan`)],
  ['POST /api/folders/:id/cancel', request(app).post(`/api/folders/${NO_FOLDER}/cancel`)],
  ['GET /api/folders/:id/job', request(app).get(`/api/folders/${NO_FOLDER}/job`)],
  ['GET /api/folders/:id/files', request(app).get(`/api/folders/${NO_FOLDER}/files`)],
  ['POST /api/folders/:id/export', request(app).post(`/api/folders/${NO_FOLDER}/export`).send({ format: 'md' })],
  ['POST /api/folders/:id/report', request(app).post(`/api/folders/${NO_FOLDER}/report`)],
  ['POST /api/folders/:id/ask', request(app).post(`/api/folders/${NO_FOLDER}/ask`).send({ question: 'hello' })],
];

beforeAll(async () => {
  db = createTestDb();
  delete process.env.SECRETS_ENCRYPTION_KEY;
  delete process.env.BURROW_AI;
  process.env.APP_PASSWORD = PASSWORD;
  process.env.AUTH_SECRET = 'unit-test-secret';
  app = (await import('../../server.js')).default;
  const res = await request(app).post('/api/login').set('X-Forwarded-For', IP).send({ password: PASSWORD });
  cookie = res.headers['set-cookie'][0].split(';')[0];
  root = makeTmp('burrow-folders-auth-');
  useNeutralPaths(root);
  dir = path.join(root, 'notes');
});
afterAll(() => {
  __setPathOptionsForTests(null);
  closeTestDb(db);
  rmTree(root);
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
beforeEach(() => {
  resetDb(db);
  __resetAiForTests();
  fetch.mockReset();
  installFakeOllama(fetch, { embedModel: true });
  rmTree(dir);
  writeTree(dir, { 'a.txt': 'alpha text\n' });
});
afterEach(async () => {
  cancelAllFolderJobs('shutdown');
  await drainFolderJobs({ timeoutMs: 2000 });
  openGate();
  __resetLockForTests();
});

describe('without a session', () => {
  it('every folder route answers 401 and nothing is added, read or requested', async () => {
    for (const [label, req] of calls()) {
      const res = await req.set('X-Forwarded-For', IP);
      expect(res.status, label).toBe(401);
      expect(res.headers['cache-control'] ?? '', label).toMatch(/no-store|no-cache|^$/);
    }
    expect(count('folders')).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('a wrong cookie is refused the same way', async () => {
    const res = await request(app).get('/api/folders').set('X-Forwarded-For', IP).set('Cookie', 'burrow_session=not-a-session');
    expect(res.status).toBe(401);
  });
});

describe('with a session', () => {
  it('lists, adds, scans and removes a folder', async () => {
    const list = await request(app).get('/api/folders').set('X-Forwarded-For', IP).set('Cookie', cookie);
    expect(list.status).toBe(200);
    expect(list.body.data.folders).toEqual([]);
    const add = await request(app).post('/api/folders').set('X-Forwarded-For', IP).set('Cookie', cookie).set(SAME_ORIGIN).send({ path: dir });
    expect(add.status).toBe(201);
    expect((await waitForFolderJob(add.body.data.job.id, { timeoutMs: 20000 })).status).toBe('done');
    const del = await request(app).delete(`/api/folders/${add.body.data.folder.id}`).set('X-Forwarded-For', IP).set('Cookie', cookie);
    expect(del.body).toEqual({ data: { removed: true } });
    expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe('alpha text\n');
  });

  it('a session does not replace the same-origin check on adding a folder', async () => {
    const res = await request(app)
      .post('/api/folders')
      .set('X-Forwarded-For', IP)
      .set('Cookie', cookie)
      .set({ Host: '127.0.0.1:4321', Origin: 'http://localhost:5174' })
      .send({ path: dir });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('folder_origin_blocked');
    expect(count('folders')).toBe(0);
  });
});

describe('while a restore or an erase holds the request gate', () => {
  it.each(['restore', 'erase'])('every folder route answers 503 db_restoring (%s) and does nothing', async (reason) => {
    closeGate(reason);
    for (const [label, req] of calls()) {
      const res = await req.set('X-Forwarded-For', IP).set('Cookie', cookie);
      expect(res.status, label).toBe(503);
      expect(res.body.error, label).toMatch(/db_restoring|data_erasing/);
    }
    openGate();
    expect(count('folders')).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });
});
