// POST /api/import: access rules, envelope, dry run, body limit, audit. Standalone apps cover the
// route itself; one block goes through server.js for the real sign-in gate and the final error handler.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { strToU8, zipSync } from 'fflate';
import { closeTestDb, createTestDb, resetDb, rowsOf, seedDb } from './helpers/testDb.js';
import { setDbForTests } from '../db/index.js';

vi.mock('../../loadEnv.js', () => ({}));
vi.mock('../auditHook.js', async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, recordAudit: vi.fn(mod.recordAudit) };
});

import { recordAudit, setAuditSink } from '../auditHook.js';
import { buildExportZip } from '../exportRoutes.js';
import { registerImportRoutes } from '../importRoutes.js';

let db;
beforeAll(() => {
  db = createTestDb();
});
beforeEach(() => {
  resetDb(db);
  recordAudit.mockClear();
  setAuditSink(null);
});
afterAll(() => closeTestDb(db));

const newApp = (opts) => {
  const app = express();
  registerImportRoutes(app, opts);
  return app;
};
const asNonLoopback = (opts) => {
  const app = express();
  app.use((req, _res, next) => {
    Object.defineProperty(req, 'ip', { value: '203.0.113.7' });
    next();
  });
  registerImportRoutes(app, opts);
  return app;
};
const post = (app, body, { type = 'application/zip', query = '' } = {}) =>
  request(app).post(`/api/import${query}`).set('Content-Type', type).send(body);

const notesZip = (rows = [{ id: 'n1', body: 'hello' }, { id: 'n2', body: 'world' }]) =>
  Buffer.from(
    zipSync({
      'manifest.json': strToU8(JSON.stringify({ format: 'burrow-export', formatVersion: 2, tables: [{ id: 'notes' }] })),
      'json/notes.json': strToU8(JSON.stringify(rows)),
    }),
  );

describe('POST /api/import access', () => {
  it('allows loopback clients with sign-in off', async () => {
    const res = await post(newApp(), notesZip());
    expect(res.status).toBe(200);
  });

  it('fails closed with 403 for a non-loopback client when sign-in is off', async () => {
    const res = await post(asNonLoopback(), notesZip());
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Import requires sign-in to be enabled.', code: 'auth_required' });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(rowsOf(db, 'notes')).toHaveLength(0);
  });

  it('allows a non-loopback client when sign-in is enabled', async () => {
    expect((await post(asNonLoopback({ authEnabled: true }), notesZip())).status).toBe(200);
  });

  it('accepts and ignores extra options', async () => {
    expect((await post(newApp({ authEnabled: false, somethingElse: true }), notesZip())).status).toBe(200);
  });

  it('only exposes POST', async () => {
    expect((await request(newApp()).get('/api/import')).status).toBe(404);
  });
});

describe('POST /api/import behaviour', () => {
  it('imports, answers with the { data } envelope, and sends no-store', async () => {
    const res = await post(newApp(), notesZip());
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.data).toMatchObject({
      format: 'burrow-export',
      formatVersion: 2,
      dryRun: false,
      ignoredTables: [],
      totals: { received: 2, inserted: 2, updated: 0, skipped: 0 },
    });
    expect(res.body.data.tables[0]).toMatchObject({ id: 'notes', received: 2, inserted: 2 });
    expect(rowsOf(db, 'notes').map((r) => r.id)).toEqual(['n1', 'n2']);
  });

  it('round-trips a real export', async () => {
    seedDb(db, { todos: [{ id: 't1', title: 'x' }], journal: [{ body: 'j', tags: ['a'] }] });
    const { zip } = await buildExportZip({ db });
    const before = { todos: rowsOf(db, 'todos'), journal: rowsOf(db, 'journal') };
    const res = await post(newApp(), Buffer.from(zip), { type: 'application/octet-stream' });
    expect(res.status).toBe(200);
    expect(res.body.data.totals.updated).toBe(2);
    expect({ todos: rowsOf(db, 'todos'), journal: rowsOf(db, 'journal') }).toEqual(before);
  });

  it('?dryRun=1 reports counts and writes nothing', async () => {
    const res = await post(newApp(), notesZip(), { query: '?dryRun=1' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ dryRun: true, totals: { inserted: 2 } });
    expect(rowsOf(db, 'notes')).toHaveLength(0);
  });

  it('400s invalid_request for an empty body or an unsupported content type', async () => {
    const empty = await post(newApp(), Buffer.alloc(0));
    expect(empty.status).toBe(400);
    expect(empty.body).toEqual({ error: 'Send the export ZIP as the request body.', code: 'invalid_request' });
    const json = await post(newApp(), JSON.stringify({ a: 1 }), { type: 'application/json' });
    expect(json.status).toBe(400);
    expect(json.body.code).toBe('invalid_request');
  });

  it('maps archive problems to their ImportError status and code', async () => {
    const notZip = await post(newApp(), Buffer.from('not a zip at all'));
    expect(notZip.status).toBe(400);
    expect(notZip.body).toEqual({ error: 'The file is not a valid export archive.', code: 'invalid_archive' });
    const wrong = Buffer.from(
      zipSync({ 'manifest.json': strToU8(JSON.stringify({ format: 'nope', formatVersion: 9, tables: [] })) }),
    );
    const unsupported = await post(newApp(), wrong);
    expect(unsupported.status).toBe(400);
    expect(unsupported.body.code).toBe('unsupported_format');
  });

  it('503s when the local database cannot be opened', async () => {
    const saved = process.env.BURROW_TEST_DATA_DIR;
    delete process.env.BURROW_TEST_DATA_DIR;
    setDbForTests(null);
    try {
      const res = await post(newApp(), notesZip());
      expect(res.status).toBe(503);
      expect(res.body).toEqual({ error: 'Local database is unavailable.', code: 'not_configured' });
    } finally {
      process.env.BURROW_TEST_DATA_DIR = saved;
      setDbForTests(db);
    }
  });

  it('500s with a fixed message and logs only the code on an unexpected failure', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    db.exec('ALTER TABLE notes RENAME TO notes_off');
    try {
      const res = await post(newApp(), notesZip());
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'Import failed', code: 'server_error' });
      expect(JSON.stringify(spy.mock.calls)).not.toContain('notes');
    } finally {
      db.exec('ALTER TABLE notes_off RENAME TO notes');
      spy.mockRestore();
    }
  });

  it('rate limits the 11th import in a window', async () => {
    const app = newApp();
    for (let i = 0; i < 10; i += 1) expect((await post(app, notesZip(), { query: '?dryRun=1' })).status).toBe(200);
    const res = await post(app, notesZip(), { query: '?dryRun=1' });
    expect(res.status).toBe(429);
    expect(res.body.code).toBe('rate_limited');
  });
});

describe('POST /api/import audit', () => {
  it('records one data_import event carrying only counts', async () => {
    await post(newApp(), notesZip([{ id: 'n1', body: 'SENTINEL_BODY_TEXT' }]));
    expect(recordAudit).toHaveBeenCalledTimes(1);
    const event = recordAudit.mock.calls[0][0];
    expect(event).toEqual({ kind: 'export', feature: 'data_import', status: 'ok', meta: { tables: 1, rows: 1, dry_run: false } });
    expect(JSON.stringify(event)).not.toContain('SENTINEL');
  });

  it('flags dry runs and audits failures as errors', async () => {
    await post(newApp(), notesZip(), { query: '?dryRun=1' });
    expect(recordAudit.mock.calls[0][0].meta.dry_run).toBe(true);
    recordAudit.mockClear();
    await post(newApp(), Buffer.from('junk'));
    expect(recordAudit).toHaveBeenCalledTimes(1);
    expect(recordAudit.mock.calls[0][0]).toMatchObject({ feature: 'data_import', status: 'error' });
  });

  it('still answers when the audit sink throws', async () => {
    setAuditSink(() => {
      throw new Error('sink down');
    });
    expect((await post(newApp(), notesZip())).status).toBe(200);
  });
});

describe('POST /api/import through server.js', () => {
  const saved = Object.fromEntries(['SECRETS_ENCRYPTION_KEY', 'APP_PASSWORD', 'AUTH_SECRET'].map((k) => [k, process.env[k]]));
  let app;
  let cookie;
  let ipCounter = 0;
  const nextIp = () => `198.51.100.${(ipCounter += 1)}`;

  beforeAll(async () => {
    delete process.env.SECRETS_ENCRYPTION_KEY;
    process.env.APP_PASSWORD = 'import-test-pass';
    process.env.AUTH_SECRET = 'import-test-secret';
    app = (await import('../../server.js')).default;
    const login = await request(app).post('/api/login').set('X-Forwarded-For', nextIp()).send({ password: 'import-test-pass' });
    expect(login.status).toBe(200);
    cookie = login.headers['set-cookie'][0].split(';')[0];
  });
  afterAll(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  afterEach(() => vi.restoreAllMocks());

  const send = (body, { withCookie = true, type = 'application/zip', query = '' } = {}) => {
    const r = request(app).post(`/api/import${query}`).set('X-Forwarded-For', nextIp()).set('Content-Type', type);
    return (withCookie ? r.set('Cookie', cookie) : r).send(body);
  };

  it('401s without a session cookie and imports with one', async () => {
    const denied = await send(notesZip(), { withCookie: false });
    expect(denied.status).toBe(401);
    expect(rowsOf(db, 'notes')).toHaveLength(0);
    const ok = await send(notesZip());
    expect(ok.status).toBe(200);
    expect(ok.body.data.totals.inserted).toBe(2);
  });

  it.each(['/API/IMPORT', '/api/import/'])('401s for the path variant %s', async (path) => {
    const res = await request(app).post(path).set('X-Forwarded-For', nextIp()).set('Content-Type', 'application/zip').send(notesZip());
    expect(res.status).toBe(401);
  });

  it('rejects a body over 16 MB with a route-specific 413 import_too_large', async () => {
    const res = await send(Buffer.alloc(17 * 1024 * 1024, 1));
    expect(res.status).toBe(413);
    expect(res.body).toMatchObject({ code: 'import_too_large' });
    expect(res.body.error).toBe('This file is too large to restore here.');
  });

  it('keeps the 413 import_too_large contract on a case/trailing-slash path variant', async () => {
    const res = await request(app)
      .post('/API/import/')
      .set('X-Forwarded-For', nextIp())
      .set('Cookie', cookie)
      .set('Content-Type', 'application/zip')
      .send(Buffer.alloc(17 * 1024 * 1024, 1));
    expect(res.status).toBe(413);
    expect(res.body).toMatchObject({ code: 'import_too_large' });
  });

  it('accepts ?dryRun=1 behind the gate', async () => {
    const res = await send(notesZip(), { query: '?dryRun=1' });
    expect(res.status).toBe(200);
    expect(res.body.data.dryRun).toBe(true);
    expect(rowsOf(db, 'notes')).toHaveLength(0);
  });
});
