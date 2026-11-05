// Export guarantees: no secrets anywhere in the ZIP, manifest/array/CSV count parity,
// deadline behaviour, and the empty database. Written against the contract in the design
// (buildExportZip + POST /api/export), not the collection internals.
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import Papa from 'papaparse';
import { unzipSync, strFromU8 } from 'fflate';
import { closeTestDb, createTestDb, resetDb, seedDb } from './helpers/testDb.js';

vi.mock('../auditHook.js', async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, recordAudit: vi.fn(mod.recordAudit) };
});
vi.mock('../export/csv.js', async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, toCsv: vi.fn(mod.toCsv) };
});

import { recordAudit, setAuditSink } from '../auditHook.js';
import { toCsv } from '../export/csv.js';
import { DATA_TABLES } from '../dataBrowser/tables.js';
import { buildExportZip, registerExportRoutes } from '../exportRoutes.js';
import { EXPORTABLE_DEFS } from '../export/buildArchive.js';

const binary = (r, cb) => {
  const chunks = [];
  r.on('data', (c) => chunks.push(c));
  r.on('end', () => cb(null, Buffer.concat(chunks)));
};
const unzipBytes = (buf) => unzipSync(new Uint8Array(buf));
const unzipText = (buf) => Object.fromEntries(Object.entries(unzipBytes(buf)).map(([k, v]) => [k, strFromU8(v)]));
const parseCsv = (text) => Papa.parse(text, { header: true, skipEmptyLines: true, newline: '\r\n' });
const newApp = () => {
  const app = express();
  registerExportRoutes(app);
  return app;
};

let db;
beforeAll(() => {
  db = createTestDb();
});
beforeEach(() => resetDb(db));
afterAll(() => closeTestDb(db));

// ---- no-secrets guarantees -------------------------------------------------------------

const ENV_SENTINELS = {
  GROQ_API_KEY: 'SENTINEL_GROQ_5e1d7c0a9b',
  SERVICE_ROLE_KEY: 'SENTINEL_SRK_a83f20c4de',
  DATABASE_URL: 'https://SENTINELPROJREF0123.example.invalid',
  APP_PASSWORD: 'SENTINEL_PASSWORD_77b2e9f1',
  AUTH_SECRET: 'SENTINEL_AUTHSECRET_0c4d88aa',
  CRON_SECRET: 'SENTINEL_CRON_1f9e3b6d',
  SECRETS_ENCRYPTION_KEY: 'SENTINEL_ENCKEY_c2a7714e',
  AWS_SECRET_ACCESS_KEY: 'SENTINEL_AWS_90bd5521',
};
const ROW_SENTINELS = [
  'SENTINEL_SECRETROW_NAME_41AC',
  'SENTINEL_SECRETROW_VALUE_8e0f',
  'SENTINEL_SECRETROW_CIPHER_2b6d',
  'SENTINEL_STATE_APIKEY_d41e',
  'SENTINEL_STATE_TOKEN_93aa',
  'SENTINEL_STATE_PASSWORD_07cf',
  'SENTINEL_STATE_NESTED_5d2b',
  'SENTINEL_STATE_JSONSTR_b8e3',
  'sk-SENTINELSTATESK1234567890',
  'SENTINELBEARERTOKEN99',
];
const ALL_SENTINELS = [...Object.values(ENV_SENTINELS), ...ROW_SENTINELS, 'SENTINELPROJREF0123'];

describe('no-secrets guarantee', () => {
  const saved = {};
  beforeEach(() => {
    for (const [k, v] of Object.entries(ENV_SENTINELS)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
  });
  afterEach(() => {
    for (const k of Object.keys(ENV_SENTINELS)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  const plant = () =>
    seedDb(db, {
      app_secrets: [
        { name: ROW_SENTINELS[0], ciphertext: ROW_SENTINELS[2], iv: ROW_SENTINELS[1], auth_tag: 'tag', last4: '1234' },
      ],
      app_state: [
        { key: 'openai_api_key', value: ROW_SENTINELS[3] },
        { key: 'github_token', value: ROW_SENTINELS[4] },
        { key: 'adminPassword', value: ROW_SENTINELS[5] },
        { key: 'session_cookie', value: { a: ROW_SENTINELS[6] } },
        { key: 'integrations', value: { slack: { webhookUrl: ROW_SENTINELS[6], label: 'ok' }, apiKey: ROW_SENTINELS[3] } },
        { key: 'blob', value: JSON.stringify({ client_secret: ROW_SENTINELS[7], keep: 'visible' }) },
        { key: 'theme', value: ROW_SENTINELS[8] },
        { key: 'header', value: `Bearer ${ROW_SENTINELS[9]}` },
        { key: 'sidebar', value: { collapsed: true } },
      ],
    });

  function expectNoSentinels(files) {
    for (const s of ALL_SENTINELS) {
      const needle = Buffer.from(s, 'utf8');
      for (const [name, bytes] of Object.entries(files)) {
        expect(Buffer.from(bytes).includes(needle), `${s} found in ${name}`).toBe(false);
        expect(name.includes(s)).toBe(false);
      }
    }
  }

  it('never contains env values, app_secrets rows, or secret app_state values (byte search over every entry)', async () => {
    plant();
    const { zip } = await buildExportZip({ db });
    const files = unzipBytes(zip);
    expect(files['manifest.json']).toBeDefined();
    expectNoSentinels(files);
  });

  it('keeps non-sensitive app_state content while redacting the secret ones', async () => {
    plant();
    const { zip } = await buildExportZip({ db });
    const files = unzipText(zip);
    for (const f of [files['json/app_state.json'], files['csv/app_state.csv']]) {
      expect(f).toContain('[redacted]');
      expect(f).toContain('collapsed');
    }
    expect(files['json/app_state.json']).toContain('visible');
  });

  it('holds over HTTP too, including every entry and the response headers', async () => {
    plant();
    setAuditSink(null);
    const res = await request(newApp()).post('/api/export').buffer(true).parse(binary);
    expect(res.status).toBe(200);
    expectNoSentinels(unzipBytes(res.body));
    const headerText = JSON.stringify(res.headers);
    for (const s of ALL_SENTINELS) expect(headerText).not.toContain(s);
  });

  it('manifest only carries the documented keys', async () => {
    plant();
    const { manifest } = await buildExportZip({ db });
    expect(Object.keys(manifest).sort()).toEqual(
      ['appVersion', 'complete', 'excluded', 'exportedAt', 'format', 'formatVersion', 'markdown', 'redaction', 'tables', 'totals'].sort(),
    );
    expect(manifest.excluded).toEqual(expect.arrayContaining(['app_secrets', 'audit_log']));
    for (const t of manifest.tables) {
      expect(Object.keys(t).sort()).toEqual(['files', 'id', 'label', 'rows', 'status', 'truncated']);
    }
  });

  it('does not log secret material when a table errors', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const bad = { id: `no_such_${ENV_SENTINELS.GROQ_API_KEY.toLowerCase()}`, label: 'x', primaryKey: 'id', columns: [{ name: 'id', type: 'uuid' }] };
    await buildExportZip({ db, defs: [bad] });
    expect(spy).toHaveBeenCalled();
    expect(JSON.stringify(spy.mock.calls)).not.toContain('SENTINEL_GROQ');
    spy.mockRestore();
  });

  it('audit event carries only counts', async () => {
    plant();
    recordAudit.mockClear();
    setAuditSink(null);
    await request(newApp()).post('/api/export');
    expect(recordAudit).toHaveBeenCalledTimes(1);
    const event = recordAudit.mock.calls[0][0];
    expect(JSON.stringify(event)).not.toContain('SENTINEL');
    expect(Object.values(event.meta).every((v) => Number.isFinite(v))).toBe(true);
  });
});

// ---- manifest parity ---------------------------------------------------------------------

describe('manifest parity', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  const seedMixed = () => {
    const rows = (n, mk) => Array.from({ length: n }, (_, i) => mk(i));
    seedDb(db, {
      transactions: rows(1203, (i) => ({
        id: `tx${i}`,
        date: '2026-01-01',
        merchant: `M${i}, "Inc"`,
        amount: -i,
        category: 'c',
        type: 'debit',
        source_file: null,
        created_at: '2026-01-01T00:00:00.000Z',
      })),
      todos: rows(3, (i) => ({ id: `t${i}`, title: `line1\nline2 ${i}` })),
      notes: rows(1, () => ({ id: 'n', body: 'unicode 日本語 🎉' })),
      app_state: rows(2, (i) => ({ key: `k${i}`, value: { i }, updated_at: '2026-01-01T00:00:00.000Z' })),
    });
  };

  it('every table entry equals its JSON array length and CSV data-row count', async () => {
    seedMixed();
    const { zip, manifest } = await buildExportZip({ db });
    const files = unzipText(zip);
    expect(JSON.parse(files['manifest.json'])).toEqual(manifest);
    let total = 0;
    for (const t of manifest.tables) {
      const arr = JSON.parse(files[`json/${t.id}.json`]);
      expect(Array.isArray(arr)).toBe(true);
      expect(t.rows, `${t.id} json`).toBe(arr.length);
      expect(parseCsv(files[`csv/${t.id}.csv`]).data.length, `${t.id} csv`).toBe(arr.length);
      total += arr.length;
    }
    expect(manifest.totals).toEqual({ tables: EXPORTABLE_DEFS.length, rows: total });
    expect(total).toBe(1203 + 3 + 1 + 2);
  });

  it('lists exactly the files present in the ZIP for every exportable table id, plus the Markdown set', async () => {
    seedMixed();
    const { zip, manifest } = await buildExportZip({ db });
    const names = Object.keys(unzipText(zip));
    const markdown = names.filter((n) => n.startsWith('markdown/'));
    const listed = manifest.tables.flatMap((t) => t.files);
    expect(names.filter((n) => !n.startsWith('markdown/')).sort()).toEqual(['manifest.json', ...listed].sort());
    expect(markdown).toHaveLength(manifest.markdown.journal + manifest.markdown.notes);
    expect(manifest.tables.map((t) => t.id)).toEqual(EXPORTABLE_DEFS.map((t) => t.id));
    for (const t of manifest.tables) expect(t.files).toEqual([`json/${t.id}.json`, `csv/${t.id}.csv`]);
  });

  it('an unreadable table reports 0 rows, [] and a header-only CSV', async () => {
    seedMixed();
    const bad = { id: 'no_such_table', label: 'Bad', primaryKey: 'id', columns: [{ name: 'id', type: 'uuid' }, { name: 'v', type: 'text' }] };
    const { zip, manifest } = await buildExportZip({ db, defs: [...DATA_TABLES, bad] });
    const files = unzipText(zip);
    const t = manifest.tables.find((x) => x.id === 'no_such_table');
    expect(t).toMatchObject({ rows: 0, truncated: false, status: 'error' });
    expect(files['json/no_such_table.json']).toBe('[]');
    expect(files['csv/no_such_table.csv'].split('\r\n').filter(Boolean)).toEqual(['id,v']);
    expect(manifest.complete).toBe(false);
  });

  it('round-trips exotic text through the ZIP (unicode, newlines, quotes, bidi)', async () => {
    const todos = [
      { id: 't1', title: 'multi\r\nline, "quoted" 日本語 🎉 ‮evil' },
      { id: 't2', title: '=1+1' },
    ];
    seedDb(db, { todos });
    const { zip } = await buildExportZip({ db });
    const files = unzipText(zip);
    expect(JSON.parse(files['json/todos.json']).map((r) => r.title)).toEqual(todos.map((t) => t.title));
    const csv = parseCsv(files['csv/todos.csv']).data;
    expect(csv[0].title).toBe(todos[0].title);
    expect(csv[1].title).toBe("'=1+1");
  });
});

// ---- deadline ------------------------------------------------------------------------------

describe('deadline exceeded', () => {
  it('an already-expired deadline yields a valid ZIP with every table truncated and empty', async () => {
    seedDb(db, { todos: [{ id: 't1', title: 'x' }] });
    const { zip, manifest } = await buildExportZip({ db, deadlineMs: 0 });
    expect(
      manifest.tables.every((t) => t.truncated === true && t.rows === 0 && t.status === 'skipped_deadline'),
    ).toBe(true);
    expect(manifest.complete).toBe(false);
    expect(manifest.totals).toEqual({ tables: EXPORTABLE_DEFS.length, rows: 0 });
    const files = unzipText(zip);
    expect(files['json/todos.json']).toBe('[]');
    expect(JSON.parse(files['manifest.json']).tables).toHaveLength(EXPORTABLE_DEFS.length);
  });

  it('a table collected before the deadline is not marked truncated', async () => {
    seedDb(db, { transactions: [{ id: 'a' }] });
    const { manifest } = await buildExportZip({ db, deadlineMs: 60_000 });
    expect(manifest.tables.find((t) => t.id === 'transactions')).toMatchObject({ rows: 1, truncated: false });
  });
});

// ---- empty database -------------------------------------------------------------------------

describe('empty database', () => {
  it('produces a complete ZIP of empty arrays and header-only CSVs', async () => {
    const { zip, manifest } = await buildExportZip({ db });
    const files = unzipText(zip);
    expect(manifest.totals).toEqual({ tables: EXPORTABLE_DEFS.length, rows: 0 });
    expect(manifest.markdown).toEqual({ dir: 'markdown/', journal: 0, notes: 0 });
    for (const def of EXPORTABLE_DEFS) {
      expect(files[`json/${def.id}.json`]).toBe('[]');
      expect(files[`csv/${def.id}.csv`]).toBe(`${def.columns.map((c) => c.name).join(',')}\r\n`);
    }
    expect(Object.keys(files).some((n) => n.startsWith('markdown/'))).toBe(false);
    expect(manifest.tables.every((t) => t.status === 'ok' && !t.truncated && t.rows === 0)).toBe(true);
    expect(manifest.complete).toBe(true);
  });

  it('POST /api/export still returns 200 and a valid ZIP', async () => {
    setAuditSink(null);
    const res = await request(newApp()).post('/api/export').buffer(true).parse(binary);
    expect(res.status).toBe(200);
    expect(JSON.parse(unzipText(res.body)['manifest.json']).totals.rows).toBe(0);
  });
});

// ---- failure path ---------------------------------------------------------------------------

describe('unexpected failure', () => {
  it('returns 500 server_error, audits status error, and logs only the code', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    seedDb(db, { todos: [{ id: 't1', title: 'x' }] });
    toCsv.mockImplementationOnce(() => {
      throw new Error('SENTINEL_FAIL_MSG');
    });
    recordAudit.mockClear();
    setAuditSink(null);
    const res = await request(newApp()).post('/api/export');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Export failed', code: 'server_error' });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(recordAudit).toHaveBeenCalledTimes(1);
    expect(recordAudit.mock.calls[0][0]).toMatchObject({ kind: 'export', feature: 'data_export', status: 'error' });
    expect(JSON.stringify(spy.mock.calls)).not.toContain('SENTINEL_FAIL_MSG');
    spy.mockRestore();
  });
});
