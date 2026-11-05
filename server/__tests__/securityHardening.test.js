// Regression tests for the security-review findings: operator injection, id/date validation,
// import hardening, migration race, key-file atomicity, error mapping, tool limits.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
// Pro is on for this file (the Pro gate itself is covered in proGating.test.js).
vi.mock('../license/index.js', async (importOriginal) => (await import('./helpers/pro.js')).mockLicenseModule(importOriginal));
import { DatabaseSync } from 'node:sqlite';
import request from 'supertest';
import { strToU8, zipSync } from 'fflate';
import {
  DbError,
  assertId,
  count,
  httpErrorFor,
  op,
  openDb,
  remove,
  select,
  selectOne,
  toDbError,
  update,
  updateById,
} from '../db/index.js';
import { loadMigrations, migrate } from '../db/migrate.js';
import { getDataDir } from '../paths.js';
import { KEY_FILE_NAME, loadOrCreateKeyFile, resolveEncryptionKey } from '../secrets/keyFile.js';
import { IMPORT_API_MAX_TOTAL_BYTES, ImportError, importZipBuffer, parseExportZip } from '../import/importExport.js';
import { closeTestDb, createTestDb, resetDb, rowsOf, seedDb } from './helpers/testDb.js';

vi.mock('../../loadEnv.js', () => ({}));

let db;
let app;
let ipCounter = 0;
const nextIp = () => `198.51.100.${(ipCounter += 1)}`;
const savedEnv = {};

beforeAll(async () => {
  for (const k of ['SECRETS_ENCRYPTION_KEY', 'APP_PASSWORD', 'AUTH_SECRET']) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  db = createTestDb();
  app = (await import('../../server.js')).default;
});
afterAll(() => {
  closeTestDb(db);
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
beforeEach(() => resetDb(db));
afterEach(() => vi.restoreAllMocks());

const codeOf = (fn) => {
  try {
    fn();
  } catch (e) {
    return e.code;
  }
  return null;
};

describe('1. operator injection', () => {
  beforeEach(() => {
    seedDb(db, { notes: [{ id: 'a', body: 'one' }, { id: 'b', body: 'two' }] });
  });

  it('rejects plain-object and array where values everywhere', () => {
    expect(codeOf(() => select('notes', { where: { body: { ne: '' } } }))).toBe('invalid_query');
    expect(codeOf(() => select('notes', { where: { id: { gte: 'a' } } }))).toBe('invalid_query');
    expect(codeOf(() => selectOne('notes', { where: { id: { ne: '' } } }))).toBe('invalid_query');
    expect(codeOf(() => count('notes', { where: { id: ['a'] } }))).toBe('invalid_query');
    expect(codeOf(() => remove('notes', { where: { id: { ne: '' } } }))).toBe('invalid_query');
    expect(codeOf(() => update('notes', { body: 'x' }, { where: { id: { ne: '' } } }))).toBe('invalid_query');
    expect(codeOf(() => select('notes', { where: { id: op.in([{ ne: '' }]) } }))).toBe('invalid_query');
    expect(codeOf(() => select('notes', { where: { id: op.gt({ a: 1 }) } }))).toBe('invalid_query');
    expect(codeOf(() => select('notes', { where: { id: JSON.parse('{"ne":""}') } }))).toBe('invalid_query');
    expect(rowsOf(db, 'notes')).toHaveLength(2);
  });

  it('operator maps cannot be forged with look-alike objects', () => {
    expect(codeOf(() => select('notes', { where: { id: { ops: { ne: '' } } } }))).toBe('invalid_query');
    expect(Object.isFrozen(op.gte('a'))).toBe(true);
    expect(codeOf(() => op.and({ ne: '' }))).toBe('invalid_query');
  });

  it('keeps legitimate operator queries working', () => {
    expect(select('notes', { where: { id: op.ne('a') } }).map((r) => r.id)).toEqual(['b']);
    expect(select('notes', { where: { id: op.in(['a', 'b']) } })).toHaveLength(2);
    expect(count('notes', { where: { id: op.and(op.gte('a'), op.lt('b')) } })).toBe(1);
  });

  it('updateById / assertId reject non-string ids and change nothing', () => {
    expect(codeOf(() => updateById('notes', { ne: '' }, { body: 'pwned' }))).toBe('invalid_query');
    expect(codeOf(() => updateById('notes', ['a'], { body: 'pwned' }))).toBe('invalid_query');
    expect(codeOf(() => assertId(null))).toBe('invalid_query');
    expect(assertId('a')).toBe('a');
    expect(rowsOf(db, 'notes').map((r) => r.body)).toEqual(['one', 'two']);
  });

  it('maps invalid_query to HTTP 400', () => {
    expect(httpErrorFor(new DbError('invalid_query', 'x')).status).toBe(400);
    expect(new DbError('invalid_query', 'x').status).toBe(400);
  });

  it('DELETE /api/habits/:id/completions rejects ?date[gte]= and deletes nothing', async () => {
    const [h] = seedDb(db, { habits: [{ title: 'Read' }] }).habits;
    seedDb(db, { habit_completions: [{ habit_id: h.id, date: '2026-01-01' }, { habit_id: h.id, date: '2026-01-02' }] });
    const res = await request(app)
      .delete(`/api/habits/${h.id}/completions?date[gte]=2000-01-01`)
      .set('X-Forwarded-For', nextIp());
    expect(res.status).toBe(400);
    expect(rowsOf(db, 'habit_completions')).toHaveLength(2);
    const ok = await request(app)
      .delete(`/api/habits/${h.id}/completions?date=2026-01-01`)
      .set('X-Forwarded-For', nextIp());
    expect(ok.status).toBe(200);
    expect(rowsOf(db, 'habit_completions')).toHaveLength(1);
  });

  it('PATCH /api/todos/reorder rejects an object id and changes nothing', async () => {
    const { todos } = seedDb(db, { todos: [{ title: 'A', status: 'To Do' }, { title: 'B', status: 'To Do' }] });
    const res = await request(app)
      .patch('/api/todos/reorder')
      .set('X-Forwarded-For', nextIp())
      .send({ items: [{ id: todos[0].id, status: 'Done', order: 1 }, { id: { ne: '' }, status: 'Done', order: 2 }] });
    expect(res.status).toBe(400);
    expect(rowsOf(db, 'todos').map((t) => t.status)).toEqual(['To Do', 'To Do']);
  });

  it('DELETE /api/transactions rejects object record ids', async () => {
    seedDb(db, { transactions: [{ date: '2026-01-01', merchant: 'M', amount: -1, type: 'debit' }] });
    const res = await request(app)
      .delete('/api/transactions')
      .set('X-Forwarded-For', nextIp())
      .send({ recordIds: [{ ne: '' }] });
    expect(res.status).toBe(400);
    expect(rowsOf(db, 'transactions')).toHaveLength(1);
  });

});

describe('2. POSIX permissions', () => {
  it.skipIf(process.platform === 'win32')('creates the data dir 0700 and tightens an existing one', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-perm-'));
    try {
      const fresh = path.join(base, 'fresh');
      getDataDir({ env: { BURROW_DATA_DIR: fresh } });
      expect(fs.statSync(fresh).mode & 0o777).toBe(0o700);
      const existing = path.join(base, 'existing');
      fs.mkdirSync(existing, { mode: 0o755 });
      getDataDir({ env: { BURROW_DATA_DIR: existing } });
      expect(fs.statSync(existing).mode & 0o777).toBe(0o700);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('db file and pre-migration backup are 0600', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-perm-'));
    try {
      const file = path.join(dir, 'burrow.db');
      openDb({ filename: file }).close();
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      const conn = new DatabaseSync(file);
      const known = loadMigrations();
      const next = { version: known.length + 1, name: 'extra', sql: 'CREATE TABLE extra_t (id INTEGER)' };
      migrate(conn, { filename: file, migrations: [...known, next] });
      expect(fs.statSync(`${file}.pre-v${next.version}.bak`).mode & 0o777).toBe(0o600);
      conn.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('3. import caps and batched FK lookups', () => {
  const zipOf = (tables) =>
    zipSync({
      'manifest.json': strToU8(
        JSON.stringify({ format: 'burrow-export', formatVersion: 2, tables: Object.keys(tables).map((id) => ({ id })) }),
      ),
      ...Object.fromEntries(Object.entries(tables).map(([id, rows]) => [`json/${id}.json`, strToU8(JSON.stringify(rows))])),
    });

  it('API cap is 64 MB and an explicit smaller cap is enforced', () => {
    expect(IMPORT_API_MAX_TOTAL_BYTES).toBe(64 * 1024 * 1024);
    const zip = zipOf({ notes: [{ id: 'n', body: 'x'.repeat(5000) }] });
    expect(() => parseExportZip(zip, { maxTotalBytes: 1000 })).toThrow(ImportError);
    expect(parseExportZip(zip).tables.get('notes')).toHaveLength(1);
  });

  it('looks parents up once per table, not once per row', () => {
    const dest = openDb({ filename: ':memory:' });
    try {
      seedDb(dest, { habits: [{ id: 'h1', title: 'H' }] });
      const rows = Array.from({ length: 40 }, (_, i) => ({ id: `c${i}`, habit_id: 'h1', date: '2026-01-01' }));
      rows.push({ id: 'orphan', habit_id: 'missing', date: '2026-01-01' });
      const spy = vi.spyOn(dest, 'prepare');
      const result = importZipBuffer(zipOf({ habit_completions: rows }), { db: dest });
      const parentLookups = spy.mock.calls.filter(([sql]) => /FROM "habits"/.test(sql)).length;
      expect(parentLookups).toBe(1);
      expect(result.tables[0]).toMatchObject({ inserted: 40, skipped: 1 });
      expect(result.tables[0].skippedReasons.orphan).toBe(1);
    } finally {
      dest.close();
    }
  });
});

describe('4. migration race', () => {
  it('re-reads the version under the lock and skips migrations another connection applied', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-race-'));
    const file = path.join(dir, 'race.db');
    const migrations = [
      { version: 1, name: 'a', sql: 'CREATE TABLE race_a (id INTEGER)' },
      { version: 2, name: 'b', sql: 'CREATE TABLE race_b (id INTEGER)' },
    ];
    const a = new DatabaseSync(file);
    const real = new DatabaseSync(file);
    let raced = false;
    // Connection B computes its pending list, then A wins the race right before B takes the lock.
    const b = new Proxy(real, {
      get(target, prop) {
        const v = target[prop];
        if (prop === 'exec') {
          return (sql) => {
            if (!raced && sql === 'BEGIN IMMEDIATE') {
              raced = true;
              migrate(a, { migrations });
            }
            return target.exec(sql);
          };
        }
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    try {
      const out = migrate(b, { migrations });
      expect(raced).toBe(true);
      expect(out.applied).toEqual([]);
      const versions = a.prepare('SELECT version FROM schema_version ORDER BY version').all().map((r) => r.version);
      expect(versions).toEqual([1, 2]);
    } finally {
      a.close();
      real.close();
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});

describe('5/10. import data safety', () => {
  const zipOf = (tables) =>
    zipSync({
      'manifest.json': strToU8(
        JSON.stringify({ format: 'burrow-export', formatVersion: 2, tables: Object.keys(tables).map((id) => ({ id })) }),
      ),
      ...Object.fromEntries(Object.entries(tables).map(([id, rows]) => [`json/${id}.json`, strToU8(JSON.stringify(rows))])),
    });

  it('an invalid nullable value keeps the existing column on update and is null on insert', () => {
    seedDb(db, { notes: [{ id: 'n1', body: 'old', color: 'blue' }] });
    const result = importZipBuffer(
      zipOf({
        notes: [
          { id: 'n1', body: 'new', color: { bad: true } },
          { id: 'n2', body: 'fresh', color: { bad: true } },
        ],
      }),
      { db },
    );
    const rows = Object.fromEntries(rowsOf(db, 'notes').map((r) => [r.id, r]));
    expect(rows.n1).toMatchObject({ body: 'new', color: 'blue' });
    expect(rows.n2).toMatchObject({ body: 'fresh', color: null });
    expect(result.tables[0]).toMatchObject({ inserted: 1, updated: 1, invalidValues: 2 });
  });

  it('never imports app_state network.optIn and reports it skipped', () => {
    const result = importZipBuffer(
      zipOf({
        app_state: [
          { key: 'network.optIn', value: { weather: true } },
          { key: 'profile', value: { displayName: 'Sam' } },
        ],
      }),
      { db },
    );
    expect(rowsOf(db, 'app_state').map((r) => r.key)).toEqual(['profile']);
    expect(result.tables[0].skippedReasons.protected).toBe(1);
    expect(result.tables[0].skipped).toBe(1);
  });
});

describe('7. export route JSON limit', () => {
  it('the per-route 10kb limit is effective (not pre-empted by the global 2mb parser)', async () => {
    const big = { tables: ['notes'], pad: 'x'.repeat(20 * 1024) };
    const res = await request(app).post('/api/export').send(big);
    expect(res.status).toBe(413);
  });
});

describe('8. key file', () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-key-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('creates atomically (no temp files left) and a second load reuses the key', () => {
    const first = loadOrCreateKeyFile({ dir });
    expect(first.ok).toBe(true);
    expect(fs.readdirSync(dir)).toEqual([KEY_FILE_NAME]);
    const second = loadOrCreateKeyFile({ dir });
    expect(second.ok && second.key.equals(first.key)).toBe(true);
  });

  it('a corrupt key file is reported as invalid, not missing, and is not overwritten', () => {
    fs.writeFileSync(path.join(dir, KEY_FILE_NAME), 'garbage');
    expect(resolveEncryptionKey({}, { dir })).toEqual({ ok: false, reason: 'invalid' });
    expect(fs.readFileSync(path.join(dir, KEY_FILE_NAME), 'utf8')).toBe('garbage');
  });

  it('an unwritable directory is still reported as missing', () => {
    expect(resolveEncryptionKey({}, { dir: path.join(dir, 'nope', 'deeper') })).toEqual({ ok: false, reason: 'missing' });
  });
});

describe('9. SQLITE_BUSY mapping', () => {
  it('maps a busy database to db_busy / 503', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-busy-'));
    const file = path.join(dir, 'busy.db');
    const holder = new DatabaseSync(file);
    const waiter = new DatabaseSync(file);
    try {
      holder.exec('CREATE TABLE t (id INTEGER); BEGIN IMMEDIATE');
      waiter.exec('PRAGMA busy_timeout = 0');
      let caught;
      try {
        waiter.exec('BEGIN IMMEDIATE');
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeDefined();
      const mapped = toDbError(caught);
      expect(mapped.code).toBe('db_busy');
      expect(mapped.status).toBe(503);
      expect(httpErrorFor(mapped).status).toBe(503);
    } finally {
      holder.close();
      waiter.close();
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});

