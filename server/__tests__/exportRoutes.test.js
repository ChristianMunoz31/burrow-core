import { createRequire } from 'node:module';
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import { unzipSync, strFromU8 } from 'fflate';
import { closeTestDb, createTestDb, resetDb, seedDb } from './helpers/testDb.js';
import { setDbForTests } from '../db/index.js';

// Real recordAudit wrapped in a spy so a throwing sink can also be exercised.
vi.mock('../auditHook.js', async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, recordAudit: vi.fn(mod.recordAudit) };
});

import { recordAudit, setAuditSink } from '../auditHook.js';
import { DATA_TABLES } from '../dataBrowser/tables.js';
import { buildExportZip, registerExportRoutes } from '../exportRoutes.js';
import { EXPORTABLE_DEFS } from '../export/buildArchive.js';

const pkgVersion = createRequire(import.meta.url)('../../package.json').version;

const unzip = (buf) => {
  const files = unzipSync(new Uint8Array(buf));
  return Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strFromU8(v)]));
};
const parseBinary = (r, cb) => {
  const chunks = [];
  r.on('data', (c) => chunks.push(c));
  r.on('end', () => cb(null, Buffer.concat(chunks)));
};

let db;
beforeAll(() => {
  db = createTestDb();
});
beforeEach(() => resetDb(db));
afterAll(() => closeTestDb(db));

// Makes getDb() throw (no test data dir, no singleton), then restores the shared handle.
async function withDbUnavailable(fn) {
  const saved = process.env.BURROW_TEST_DATA_DIR;
  delete process.env.BURROW_TEST_DATA_DIR;
  setDbForTests(null);
  try {
    return await fn();
  } finally {
    process.env.BURROW_TEST_DATA_DIR = saved;
    setDbForTests(db);
  }
}

describe('buildExportZip', () => {
  it('contains manifest + json + csv for every allowlisted table and never app_secrets', async () => {
    seedDb(db, {
      app_secrets: [{ name: 'GROQ_API_KEY', ciphertext: 'topsecret', iv: 'iv', auth_tag: 'tag', last4: '1234' }],
    });
    const { zip } = await buildExportZip({ db });
    const files = unzip(zip);
    expect(files['manifest.json']).toBeDefined();
    for (const t of DATA_TABLES) {
      expect(files[`json/${t.id}.json`]).toBe('[]');
      expect(files[`csv/${t.id}.csv`]).toContain(t.columns[0].name);
    }
    expect(Object.keys(files).some((k) => k.includes('app_secrets'))).toBe(false);
    expect(Object.values(files).join('')).not.toContain('topsecret');
    expect(Object.values(files).join('')).not.toContain('GROQ_API_KEY');
  });

  it('manifest counts match the rows exported and carry v2 version metadata', async () => {
    seedDb(db, {
      notes: [
        { id: 'n1', body: 'a', color: null, pinned: false, context: null, created_at: '2026-01-01T00:00:00Z' },
        { id: 'n2', body: 'b', color: null, pinned: true, context: null, created_at: '2026-01-02T00:00:00Z' },
      ],
      todos: [{ id: 't1', title: 'x' }],
    });
    const now = new Date('2026-03-04T05:06:07.000Z');
    const { zip, manifest } = await buildExportZip({ db, now });
    const files = unzip(zip);
    const parsed = JSON.parse(files['manifest.json']);
    expect(parsed).toEqual(manifest);
    expect(parsed.format).toBe('burrow-export');
    expect(parsed.formatVersion).toBe(2);
    expect(parsed.exportedAt).toBe(now.toISOString());
    expect(parsed.appVersion).toBe(pkgVersion);
    expect(parsed.tables.find((t) => t.id === 'notes').rows).toBe(2);
    expect(parsed.tables.find((t) => t.id === 'todos').rows).toBe(1);
    expect(parsed.totals).toEqual({ tables: EXPORTABLE_DEFS.length, rows: 3 });
    expect(parsed.markdown).toEqual({ dir: 'markdown/', journal: 0, notes: 2 });
    expect(parsed.excluded).toContain('app_secrets');
    expect(JSON.parse(files['json/notes.json'])).toHaveLength(2);
  });

  it('exports decoded values: booleans, arrays and JSON as real JSON types', async () => {
    seedDb(db, {
      notes: [{ id: 'n1', body: 'a', pinned: true }],
      journal: [{ id: 'j1', body: 'b', tags: ['x', 'y'], date: '2026-02-03T04:05:06.789Z' }],
      app_state: [{ key: 'k', value: { a: [1, 2] } }],
    });
    const files = unzip((await buildExportZip({ db })).zip);
    expect(JSON.parse(files['json/notes.json'])[0]).toMatchObject({ pinned: true });
    expect(JSON.parse(files['json/journal.json'])[0]).toMatchObject({ tags: ['x', 'y'], date: '2026-02-03T04:05:06.789Z' });
    expect(JSON.parse(files['json/app_state.json'])[0]).toMatchObject({ key: 'k', value: { a: [1, 2] } });
  });

  it('writes Markdown for journal entries and notes from the rows exported', async () => {
    seedDb(db, {
      journal: [{ id: 'abcdef12-0000-4000-8000-000000000000', title: 'Hello: World', body: 'line1\nline2', date: '2026-02-03T04:05:06.789Z', tags: ['a'] }],
      notes: [{ id: '12345678-0000-4000-8000-000000000000', body: 'Buy milk\nand eggs', created_at: '2026-04-05T00:00:00.000Z' }],
    });
    const { zip, manifest } = await buildExportZip({ db });
    const files = unzip(zip);
    expect(files['markdown/journal/2026-02-03-hello-world-abcdef12.md']).toContain('title: "Hello: World"');
    expect(files['markdown/journal/2026-02-03-hello-world-abcdef12.md']).toMatch(/\n---\n\nline1\nline2$/);
    expect(files['markdown/notes/2026-04-05-buy-milk-12345678.md']).toContain('Buy milk\nand eggs');
    expect(manifest.markdown).toEqual({ dir: 'markdown/', journal: 1, notes: 1 });
  });

  it('skips Markdown for tables outside the requested subset', async () => {
    seedDb(db, { notes: [{ body: 'n' }], journal: [{ body: 'j' }] });
    const { zip, manifest } = await buildExportZip({ db, tables: ['notes'] });
    const names = Object.keys(unzip(zip));
    expect(names.filter((n) => n.startsWith('markdown/journal/'))).toHaveLength(0);
    expect(names.filter((n) => n.startsWith('markdown/notes/'))).toHaveLength(1);
    expect(manifest.markdown).toEqual({ dir: 'markdown/', journal: 0, notes: 1 });
  });

  it('respects truncation: Markdown covers only the rows collected', async () => {
    seedDb(db, { notes: Array.from({ length: 5 }, (_, i) => ({ id: `note-${i}`, body: `body ${i}` })) });
    const { manifest, zip } = await buildExportZip({ db, maxRowsPerTable: 3 });
    expect(manifest.tables.find((t) => t.id === 'notes')).toMatchObject({ rows: 3, truncated: true });
    expect(Object.keys(unzip(zip)).filter((n) => n.startsWith('markdown/notes/'))).toHaveLength(3);
  });

  it('guards a string app_state value in the CSV and keeps numeric -5 numeric', async () => {
    seedDb(db, {
      app_state: [{ key: 'theme', value: '=1+1', updated_at: '2026-01-01T00:00:00.000Z' }],
      transactions: [{ id: 'a', date: '2026-01-01', merchant: 'm', amount: -5, type: 'debit' }],
    });
    const files = unzip((await buildExportZip({ db })).zip);
    expect(files['csv/app_state.csv']).toContain("theme,'=1+1,");
    expect(files['csv/transactions.csv']).toContain(',-5,');
    expect(files['csv/transactions.csv']).not.toContain("'-5");
  });

  it('redacts secret-like app_state rows in both JSON and CSV', async () => {
    seedDb(db, {
      app_state: [
        { key: 'openai_api_key', value: 'sk-abcdefghijklmnop' },
        { key: 'theme', value: 'sk-leakedvalue123456' },
        { key: 'sidebar', value: { collapsed: true } },
      ],
    });
    const files = unzip((await buildExportZip({ db })).zip);
    for (const f of [files['json/app_state.json'], files['csv/app_state.csv']]) {
      expect(f).not.toContain('sk-abcdefghijklmnop');
      expect(f).not.toContain('sk-leakedvalue123456');
      expect(f).toContain('[redacted]');
    }
    expect(files['json/app_state.json']).toContain('collapsed');
  });

  it('paginates beyond 1000 rows with keyset paging, in primary-key order, without duplicates', async () => {
    seedDb(db, { todos: Array.from({ length: 2500 }, (_, i) => ({ id: `id${String(i).padStart(4, '0')}`, title: `t${i}` })) });
    const { zip, manifest } = await buildExportZip({ db });
    expect(manifest.tables.find((t) => t.id === 'todos')).toMatchObject({ rows: 2500, truncated: false });
    const ids = JSON.parse(unzip(zip)['json/todos.json']).map((r) => r.id);
    expect(ids).toHaveLength(2500);
    expect(new Set(ids).size).toBe(2500);
    expect(ids).toEqual([...ids].sort());
  });

  it('marks a table truncated at the row cap', async () => {
    seedDb(db, { todos: Array.from({ length: 3000 }, (_, i) => ({ id: `id${i}`, title: `t${i}` })) });
    const { manifest } = await buildExportZip({ db, maxRowsPerTable: 2000 });
    expect(manifest.tables.find((t) => t.id === 'todos')).toMatchObject({ rows: 2000, truncated: true });
    expect(manifest.complete).toBe(false);
  });

  it('keeps going when a table cannot be read, and logs the table id with the code', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    seedDb(db, { todos: [{ id: 't1', title: 'x' }] });
    const bad = { id: 'no_such_table', label: 'Bad', primaryKey: 'id', columns: [{ name: 'id', type: 'uuid' }] };
    const todos = DATA_TABLES.find((t) => t.id === 'todos');
    const { zip, manifest } = await buildExportZip({ db, defs: [bad, todos] });
    const status = (id) => manifest.tables.find((t) => t.id === id).status;
    expect(status('no_such_table')).toBe('error');
    expect(status('todos')).toBe('ok');
    expect(unzip(zip)['json/no_such_table.json']).toBe('[]');
    expect(manifest.complete).toBe(false);
    expect(spy).toHaveBeenCalledWith('Export table error:', 'no_such_table', 'unknown_table');
    spy.mockRestore();
  });

  it('writes JSON without indentation and reports complete for a clean export', async () => {
    seedDb(db, { todos: [{ id: 't1', title: 'x', created_at: '2026-01-01T00:00:00.000Z' }] });
    const { zip, manifest } = await buildExportZip({ db });
    const text = unzip(zip)['json/todos.json'];
    expect(text).not.toContain('\n');
    expect(JSON.parse(text)).toEqual([
      {
        id: 't1',
        title: 'x',
        description: '',
        done: false,
        due: null,
        priority: 'medium',
        status: null,
        context: 'both',
        order: null,
        created_at: '2026-01-01T00:00:00.000Z',
      },
    ]);
    expect(manifest.complete).toBe(true);
  });

  it('never exports a denied table even if a def for it is injected', async () => {
    seedDb(db, {
      app_secrets: [{ name: 'SENTINEL_DENY', ciphertext: 'c', iv: 'i', auth_tag: 't', last4: '1234' }],
      audit_log: [{ kind: 'llm', feature: 'sentinel_deny' }],
    });
    const fake = (id) => ({ id, label: id, primaryKey: 'id', columns: [{ name: 'id', type: 'uuid' }] });
    const { zip, manifest } = await buildExportZip({
      db,
      defs: [...DATA_TABLES, fake('app_secrets'), fake('audit_log')],
    });
    expect(manifest.tables.map((t) => t.id)).toEqual(DATA_TABLES.map((t) => t.id));
    expect(Object.values(unzip(zip)).join('').toLowerCase()).not.toContain('sentinel_deny');
  });

  it('exports only the requested subset', async () => {
    seedDb(db, { todos: [{ id: 't1', title: 'x' }] });
    const { zip, manifest } = await buildExportZip({ db, tables: ['todos', 'notes'] });
    expect(manifest.tables.map((t) => t.id)).toEqual(
      DATA_TABLES.map((t) => t.id).filter((id) => id === 'todos' || id === 'notes'),
    );
    expect(Object.keys(unzip(zip)).sort()).toEqual([
      'csv/notes.csv',
      'csv/todos.csv',
      'json/notes.json',
      'json/todos.json',
      'manifest.json',
    ]);
  });

  it('stops early with export_too_large once the uncompressed total passes the cap', async () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({ id: `id${i}`, title: 'x'.repeat(200) }));
    seedDb(db, { todos: rows });
    await expect(buildExportZip({ db, maxRawBytes: 1000 })).rejects.toMatchObject({ code: 'export_too_large' });
  });

  it('charges Markdown bytes to the raw-bytes budget', async () => {
    seedDb(db, { notes: [{ body: 'x'.repeat(2000) }] });
    const files = unzip((await buildExportZip({ db, tables: ['notes'] })).zip);
    const withoutMarkdown = JSON.stringify(JSON.parse(files['json/notes.json'])).length + Buffer.byteLength(files['csv/notes.csv']);
    await expect(buildExportZip({ db, tables: ['notes'], maxRawBytes: withoutMarkdown + 10 })).rejects.toMatchObject({
      code: 'export_too_large',
    });
  });

  it('rejects with export_aborted when the signal is already aborted', async () => {
    seedDb(db, { todos: [{ id: 't1', title: 'x' }] });
    const controller = new AbortController();
    controller.abort();
    await expect(buildExportZip({ db, signal: controller.signal })).rejects.toMatchObject({ code: 'export_aborted' });
  });

  it('rejects with export_aborted when the signal fires between pages', async () => {
    seedDb(db, { todos: Array.from({ length: 5000 }, (_, i) => ({ id: `id${String(i).padStart(4, '0')}`, title: 'x' })) });
    const controller = new AbortController();
    // Runs before the build's first yield resumes.
    setImmediate(() => controller.abort());
    await expect(buildExportZip({ db, signal: controller.signal })).rejects.toMatchObject({ code: 'export_aborted' });
  });

  it('falls back to a version string when package.json cannot be read', async () => {
    vi.resetModules();
    vi.doMock('node:module', () => ({
      createRequire: () => () => {
        throw new Error('no package.json');
      },
    }));
    try {
      const mod = await import('../exportRoutes.js');
      const { manifest } = await mod.buildExportZip({ db });
      expect(manifest.appVersion).toBe('unknown');
    } finally {
      vi.doUnmock('node:module');
      vi.resetModules();
    }
  });

  it('rejects with export_too_large over the size cap', async () => {
    await expect(buildExportZip({ db, maxZipBytes: 10 })).rejects.toMatchObject({
      code: 'export_too_large',
    });
  });
});

describe('POST /api/export', () => {
  let app;
  beforeEach(() => {
    recordAudit.mockClear();
    setAuditSink(null);
    seedDb(db, { todos: [{ id: 't1', title: '=HYPERLINK("x")' }] });
    app = express();
    registerExportRoutes(app);
  });

  it('returns a ZIP attachment, no-store, and audits once', async () => {
    const res = await request(app).post('/api/export').buffer(true).parse(parseBinary);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/zip/);
    expect(res.headers['content-disposition']).toMatch(
      /^attachment; filename="burrow-export-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.zip"$/,
    );
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-export-complete']).toBe('1');
    expect(Number(res.headers['content-length'])).toBe(res.body.length);
    const files = unzip(res.body);
    expect(files['csv/todos.csv']).toContain("'=HYPERLINK");
    expect(recordAudit).toHaveBeenCalledTimes(1);
    expect(recordAudit.mock.calls[0][0]).toMatchObject({ kind: 'export', feature: 'data_export', status: 'ok' });
    expect(recordAudit.mock.calls[0][0].meta.rows).toBe(1);
  });

  it('still succeeds when the audit sink throws', async () => {
    setAuditSink(() => {
      throw new Error('sink down');
    });
    const res = await request(app).post('/api/export');
    expect(res.status).toBe(200);
  });

  it('503s when the local database cannot be opened', async () => {
    await withDbUnavailable(async () => {
      const res = await request(app).post('/api/export');
      expect(res.status).toBe(503);
      expect(res.body).toEqual({ error: 'Local database is unavailable.', code: 'not_configured' });
    });
    expect(recordAudit.mock.calls[0][0]).toMatchObject({ feature: 'data_export', status: 'error' });
  });

  it('404s on GET', async () => {
    expect((await request(app).get('/api/export')).status).toBe(404);
  });

  it('exports a subset from { tables } and names the file after a single table', async () => {
    const res = await request(app)
      .post('/api/export')
      .send({ tables: ['todos', 'todos'] })
      .buffer(true)
      .parse(parseBinary);
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/-todos\.zip"$/);
    expect(JSON.parse(unzip(res.body)['manifest.json']).tables.map((t) => t.id)).toEqual(['todos']);
  });

  it('names a multi-table subset -partial', async () => {
    const res = await request(app)
      .post('/api/export')
      .send({ tables: ['todos', 'notes'] })
      .buffer(true)
      .parse(parseBinary);
    expect(res.headers['content-disposition']).toMatch(/-partial\.zip"$/);
  });

  it.each([
    ['unknown id', { tables: ['nope'] }],
    ['app_secrets', { tables: ['app_secrets'] }],
    ['audit_log', { tables: ['audit_log'] }],
    ['empty list', { tables: [] }],
    ['non-array', { tables: 'todos' }],
    ['non-string id', { tables: [1] }],
    ['more than 20', { tables: Array.from({ length: 21 }, (_, i) => `t${i}`) }],
    ['more than 64 entries even if duplicates', { tables: Array.from({ length: 65 }, () => 'todos') }],
  ])('400s invalid_request for %s', async (_n, body) => {
    const res = await request(app).post('/api/export').send(body);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid request body', code: 'invalid_request' });
  });

  it('413 lists the table ids so the client can fall back per table', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const noise = () => Array.from({ length: 5000 }, () => Math.random().toString(36)).join('');
    seedDb(db, { notes: Array.from({ length: 20 }, () => ({ body: noise() })) });
    const capped = express();
    registerExportRoutes(capped, { buildOptions: { maxZipBytes: 50_000 } });
    const res = await request(capped).post('/api/export');
    expect(res.status).toBe(413);
    expect(res.body.code).toBe('export_too_large');
    expect(res.body.tables).toEqual(EXPORTABLE_DEFS.map((t) => t.id));
  }, 60_000);

  it('counts a 413 against the limiter', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const small = express();
    registerExportRoutes(small, { buildOptions: { maxRawBytes: 10 } });
    for (let i = 0; i < 30; i += 1) {
      expect((await request(small).post('/api/export')).status).toBe(413);
    }
    const res = await request(small).post('/api/export');
    expect(res.status).toBe(429);
    expect(res.body.code).toBe('rate_limited');
  });

  it('does not count failed requests against the limiter (skipFailedRequests)', async () => {
    await withDbUnavailable(async () => {
      for (let i = 0; i < 35; i += 1) {
        expect((await request(app).post('/api/export')).status).toBe(503);
      }
    });
  });

  it('rate limits the 31st call within the window', async () => {
    for (let i = 0; i < 30; i += 1) {
      expect((await request(app).post('/api/export')).status).toBe(200);
    }
    const res = await request(app).post('/api/export');
    expect(res.status).toBe(429);
    expect(res.body.code).toBe('rate_limited');
    expect(res.headers['cache-control']).toBe('no-store');
  });
});

describe('POST /api/export sign-in requirement', () => {
  const appWith = (opts) => {
    const a = express();
    registerExportRoutes(a, opts);
    return a;
  };

  it('allows the export when auth is enabled', async () => {
    expect((await request(appWith({ authEnabled: true })).post('/api/export')).status).toBe(200);
  });

  it('allows the export from loopback with auth off', async () => {
    expect((await request(appWith({ authEnabled: false })).post('/api/export')).status).toBe(200);
  });

  it('fails closed with 403 for a non-loopback client when auth is off, on any host', async () => {
    const a = express();
    a.use((req, _res, next) => {
      Object.defineProperty(req, 'ip', { value: '203.0.113.7' });
      next();
    });
    registerExportRoutes(a, { authEnabled: false });
    const res = await request(a).post('/api/export');
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Export requires sign-in to be enabled.', code: 'auth_required' });
  });

  it('allows a non-loopback client when auth is enabled', async () => {
    const a = express();
    a.use((req, _res, next) => {
      Object.defineProperty(req, 'ip', { value: '203.0.113.7' });
      next();
    });
    registerExportRoutes(a, { authEnabled: true });
    expect((await request(a).post('/api/export')).status).toBe(200);
  });
});
