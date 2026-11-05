import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import {
  DB_FILENAME,
  DbError,
  FOLDER_ARCHIVE_TABLES,
  FOREIGN_KEYS,
  IMPORT_ORDER,
  TABLES,
  closeDb,
  getDb,
  httpErrorFor,
  openDb,
  pingDb,
  resolveDbPath,
  toDbError,
} from '../db/index.js';
import { currentVersion, loadMigrations, migrate } from '../db/migrate.js';

let dir;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-mig-'));
});
afterAll(() => {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch {
    /* ignore */
  }
});

// Highest shipped migration; every fresh database ends up here.
const LATEST = loadMigrations().length;

const tableNames = (db) =>
  db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((r) => r.name);

describe('openDb and migrations', () => {
  it('creates 20 tables plus schema_version, with WAL, FK and busy_timeout', () => {
    const file = path.join(dir, 'fresh.db');
    const db = openDb({ filename: file });
    try {
      const names = tableNames(db);
      expect(names).toHaveLength(21);
      expect(names).toContain('schema_version');
      expect(db.prepare('SELECT COUNT(*) AS n FROM schema_version').get().n).toBe(LATEST);
      expect(db.prepare('PRAGMA journal_mode').get().journal_mode).toBe('wal');
      expect(db.prepare('PRAGMA foreign_keys').get().foreign_keys).toBe(1);
      expect(db.prepare('PRAGMA busy_timeout').get().timeout).toBe(5000);
      expect(pingDb(db)).toBe(true);
    } finally {
      db.close();
    }
  });

  it('is idempotent on re-open', () => {
    const file = path.join(dir, 'idem.db');
    openDb({ filename: file }).close();
    const db = openDb({ filename: file });
    try {
      expect(db.prepare('SELECT COUNT(*) AS n FROM schema_version').get().n).toBe(LATEST);
      expect(migrate(db, { filename: file })).toEqual({ from: LATEST, to: LATEST, applied: [] });
    } finally {
      db.close();
    }
  });

  it('registers burrow_icontains and rejects double-quoted string literals', () => {
    const db = openDb({ filename: ':memory:' });
    try {
      expect(db.prepare("SELECT burrow_icontains('MUÑOZ', 'muñoz') AS r").get().r).toBe(1);
      expect(db.prepare('SELECT burrow_icontains(NULL, ?) AS r').get('x').r).toBe(0);
      expect(() => db.prepare('SELECT "no_such_column_literal"').get()).toThrow();
    } finally {
      db.close();
    }
  });

  it('closes the handle and throws a DbError when open fails', () => {
    const bad = path.join(dir, 'missing-dir', 'x.db');
    try {
      openDb({ filename: bad });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(DbError);
      expect(e.code).toBe('db_unavailable');
      expect(e.status).toBe(503);
    }
  });

  it('refuses a database newer than the app and writes nothing', () => {
    const file = path.join(dir, 'newer.db');
    const db = openDb({ filename: file });
    db.prepare("INSERT INTO schema_version (version, name, applied_at) VALUES (99, 'future', 'now')").run();
    db.close();
    try {
      openDb({ filename: file });
      expect.unreachable();
    } catch (e) {
      expect(e.code).toBe('db_too_new');
    }
    const raw = new DatabaseSync(file);
    try {
      expect(raw.prepare('SELECT COUNT(*) AS n FROM schema_version').get().n).toBe(LATEST + 1);
      expect(currentVersion(raw)).toBe(99);
    } finally {
      raw.close();
    }
  });

  it('rolls back a failing migration and keeps the version', () => {
    const file = path.join(dir, 'fail.db');
    const db = openDb({ filename: file });
    try {
      const migrations = [
        ...loadMigrations(),
        { version: LATEST + 1, name: 'broken', sql: 'CREATE TABLE half_done (id TEXT); SELECT * FROM does_not_exist;' },
      ];
      try {
        migrate(db, { migrations, filename: file });
        expect.unreachable();
      } catch (e) {
        expect(e.code).toBe('migration_failed');
        expect(e.status).toBe(503);
      }
      expect(currentVersion(db)).toBe(LATEST);
      expect(tableNames(db)).not.toContain('half_done');
      // the handle is not left inside a transaction
      db.exec('BEGIN IMMEDIATE; ROLLBACK');
    } finally {
      db.close();
    }
  });

  it('applies a pending migration and backs up the existing database first', () => {
    const file = path.join(dir, 'upgrade.db');
    openDb({ filename: file }).close();
    const db = openDb({ filename: file, migrate: false });
    try {
      const migrations = [
        ...loadMigrations(),
        { version: LATEST + 1, name: 'extra', sql: 'CREATE TABLE extra_t (id TEXT PRIMARY KEY NOT NULL) STRICT;' },
      ];
      expect(migrate(db, { migrations, filename: file })).toEqual({ from: LATEST, to: LATEST + 1, applied: [LATEST + 1] });
      expect(fs.existsSync(`${file}.pre-v${LATEST + 1}.bak`)).toBe(true);
      expect(tableNames(db)).toContain('extra_t');
      expect(currentVersion(db)).toBe(LATEST + 1);
    } finally {
      db.close();
    }
    const backup = new DatabaseSync(`${file}.pre-v${LATEST + 1}.bak`);
    try {
      expect(tableNames(backup)).not.toContain('extra_t');
    } finally {
      backup.close();
    }
  });

  it('002 drops the retired cloud-provider keys and Javi provider choice, keeping everything else', () => {
    const file = path.join(dir, 'v1-to-v2.db');
    const db = openDb({ filename: file, migrate: false });
    try {
      migrate(db, { migrations: loadMigrations().slice(0, 1), filename: file });
      const secret = db.prepare(
        "INSERT INTO app_secrets (name, ciphertext, iv, auth_tag, last4) VALUES (?, 'c', 'i', 't', 'abcd')",
      );
      for (const name of ['BEDROCK_API_KEY', 'GROQ_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OURA_TOKEN']) secret.run(name);
      const state = db.prepare('INSERT INTO app_state (key, value) VALUES (?, ?)');
      state.run('jarvis.provider', '"groq"');
      state.run('jarvis.model', '"some-model"');
      state.run('network.optIn', '{"weather":true}');
      expect(migrate(db, { filename: file }).applied).toContain(2);
      expect(db.prepare('SELECT name FROM app_secrets ORDER BY name').all().map((r) => r.name)).toEqual(['OURA_TOKEN']);
      expect(db.prepare('SELECT key FROM app_state ORDER BY key').all().map((r) => r.key)).toEqual(['network.optIn']);
    } finally {
      db.close();
    }
  });

  it('003 removes the GitHub token and the github/keyTest opt-ins and Home card, keeping everything else', () => {
    const file = path.join(dir, 'v2-to-v3.db');
    const db = openDb({ filename: file, migrate: false });
    try {
      migrate(db, { migrations: loadMigrations().slice(0, 2), filename: file });
      const secret = db.prepare(
        "INSERT INTO app_secrets (name, ciphertext, iv, auth_tag, last4) VALUES (?, 'c', 'i', 't', 'abcd')",
      );
      for (const name of ['GITHUB_TOKEN', 'OURA_TOKEN']) secret.run(name);
      const state = db.prepare('INSERT INTO app_state (key, value) VALUES (?, ?)');
      state.run('network.optIn', '{"weather":true,"github":true,"keyTest":false,"oura":true}');
      state.run('pos:homeLayout', '{"order":["github","todos"],"cards":{"github":{"w":2},"todos":{"w":3}}}');
      state.run('theme', '"dark"');
      expect(migrate(db, { filename: file }).applied).toContain(3);
      expect(db.prepare('SELECT name FROM app_secrets ORDER BY name').all().map((r) => r.name)).toEqual(['OURA_TOKEN']);
      const value = (key) => JSON.parse(db.prepare('SELECT value FROM app_state WHERE key = ?').get(key).value);
      expect(value('network.optIn')).toEqual({ weather: true, oura: true });
      expect(value('pos:homeLayout')).toEqual({ order: ['github', 'todos'], cards: { todos: { w: 3 } } });
      expect(value('theme')).toBe('dark');
    } finally {
      db.close();
    }
  });

  it('003 leaves layouts without cards and non-object opt-ins untouched', () => {
    const file = path.join(dir, 'v2-to-v3-odd.db');
    const db = openDb({ filename: file, migrate: false });
    try {
      migrate(db, { migrations: loadMigrations().slice(0, 2), filename: file });
      const state = db.prepare('INSERT INTO app_state (key, value) VALUES (?, ?)');
      state.run('network.optIn', '[]');
      state.run('pos:homeLayout', '{"order":["todos"]}');
      expect(() => migrate(db, { filename: file })).not.toThrow();
      expect(db.prepare('SELECT value FROM app_state WHERE key = ?').get('network.optIn').value).toBe('[]');
      expect(db.prepare('SELECT value FROM app_state WHERE key = ?').get('pos:homeLayout').value).toBe('{"order":["todos"]}');
    } finally {
      db.close();
    }
  });

  it('004 deletes the saved Chat personas, keeping other app_state keys, and backs up first', () => {
    const file = path.join(dir, 'v3-to-v4.db');
    const db = openDb({ filename: file, migrate: false });
    try {
      migrate(db, { migrations: loadMigrations().slice(0, 3), filename: file });
      const state = db.prepare('INSERT INTO app_state (key, value) VALUES (?, ?)');
      state.run('pos:gpts', '[{"id":"p1","name":"Persona"}]');
      state.run('pos:gptsExtra', '"keep"');
      state.run('theme', '"dark"');
      expect(migrate(db, { migrations: loadMigrations().slice(0, 4), filename: file }).applied).toContain(4);
      expect(db.prepare('SELECT key FROM app_state ORDER BY key').all().map((r) => r.key)).toEqual(['pos:gptsExtra', 'theme']);
      expect(fs.existsSync(`${file}.pre-v4.bak`)).toBe(true);
    } finally {
      db.close();
    }
    const backup = new DatabaseSync(`${file}.pre-v4.bak`);
    try {
      expect(backup.prepare("SELECT COUNT(*) AS n FROM app_state WHERE key = 'pos:gpts'").get().n).toBe(1);
    } finally {
      backup.close();
    }
  });

  it('005 adds the perf indexes, drops the redundant habit index, and backs up first', () => {
    const file = path.join(dir, 'v4-to-v5.db');
    const db = openDb({ filename: file, migrate: false });
    const indexNames = () =>
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
        .all()
        .map((r) => r.name);
    try {
      migrate(db, { migrations: loadMigrations().slice(0, 4), filename: file });
      expect(indexNames()).toContain('habit_completions_habit_idx');
      expect(migrate(db, { migrations: loadMigrations().slice(0, 5), filename: file }).applied).toEqual([5]);
      const names = indexNames();
      for (const name of [
        'transactions_created_idx',
        'jarvis_messages_created_idx',
        'jarvis_conversations_updated_idx',
        'habit_completions_habit_date_idx',
      ]) {
        expect(names).toContain(name);
      }
      expect(names).not.toContain('habit_completions_habit_idx');
      expect(fs.existsSync(`${file}.pre-v5.bak`)).toBe(true);
    } finally {
      db.close();
    }
  });

  it('006 adds the folder tables, with files and chunks that go with their folder', () => {
    const db = openDb({ filename: ':memory:' });
    try {
      const stamp = '2026-10-08T00:00:00.000Z';
      db.prepare('INSERT INTO folders (id, name, path, path_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('f1', 'Notes', 'C:/Sample/Notes', 'c:/sample/notes', stamp, stamp);
      db.prepare('INSERT INTO folder_files (id, folder_id, rel_path, kind, status, created_at) VALUES (?, ?, ?, ?, ?, ?)').run('a1', 'f1', 'a.txt', 'text', 'ok', stamp);
      db.prepare('INSERT INTO folder_chunks (id, folder_id, file_id, seq, start_line, end_line, text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('c1', 'f1', 'a1', 0, 1, 2, 'sample', stamp);
      expect(() => db.prepare('INSERT INTO folders (id, name, path, path_key, stats, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('f2', 'X', 'p', 'k', 'not json', stamp, stamp)).toThrow();
      expect(() => db.prepare('INSERT INTO folder_files (id, folder_id, rel_path, kind, status, created_at) VALUES (?, ?, ?, ?, ?, ?)').run('a2', 'f1', 'a.txt', 'text', 'ok', stamp)).toThrow();
      db.prepare('DELETE FROM folders WHERE id = ?').run('f1');
      expect(db.prepare('SELECT COUNT(*) AS n FROM folder_files').get().n).toBe(0);
      expect(db.prepare('SELECT COUNT(*) AS n FROM folder_chunks').get().n).toBe(0);
    } finally {
      db.close();
    }
  });

  it('does not back up a fresh database', () => {
    const file = path.join(dir, 'nobackup.db');
    openDb({ filename: file }).close();
    expect(fs.existsSync(`${file}.pre-v1.bak`)).toBe(false);
  });
});

describe('loadMigrations', () => {
  it('loads 001 to 007 and rejects gaps', () => {
    expect(loadMigrations().map((m) => m.version)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    const gap = fs.mkdtempSync(path.join(dir, 'gap-'));
    fs.writeFileSync(path.join(gap, '001_a.sql'), 'SELECT 1;');
    fs.writeFileSync(path.join(gap, '003_c.sql'), 'SELECT 1;');
    fs.writeFileSync(path.join(gap, 'notes.txt'), 'ignored');
    try {
      loadMigrations(gap);
      expect.unreachable();
    } catch (e) {
      expect(e.code).toBe('migration_failed');
    }
  });
});

describe('TABLES consistency', () => {
  it('matches PRAGMA table_info for every table', () => {
    const db = openDb({ filename: ':memory:' });
    try {
      for (const [name, def] of Object.entries(TABLES)) {
        const cols = db.prepare(`PRAGMA table_info("${name}")`).all().map((c) => c.name);
        expect(cols, name).toEqual(Object.keys(def.columns));
        expect(cols).toContain(def.primaryKey);
        for (const col of def.autoNow) expect(cols).toContain(col);
      }
      expect(tableNames(db).filter((n) => n !== 'schema_version').sort()).toEqual(Object.keys(TABLES).sort());
      expect(IMPORT_ORDER).toHaveLength(15);
      for (const fk of FOREIGN_KEYS) {
        expect(TABLES[fk.table].columns[fk.column]).toBe('uuid');
        // The Folders tables travel through FOLDER_ARCHIVE_TABLES (folder_chunks never does); parents come first there and in TABLES.
        if (IMPORT_ORDER.includes(fk.table) && IMPORT_ORDER.includes(fk.references.table)) {
          expect(IMPORT_ORDER.indexOf(fk.references.table)).toBeLessThan(IMPORT_ORDER.indexOf(fk.table));
        } else if (FOLDER_ARCHIVE_TABLES.includes(fk.table) && FOLDER_ARCHIVE_TABLES.includes(fk.references.table)) {
          expect(FOLDER_ARCHIVE_TABLES.indexOf(fk.references.table)).toBeLessThan(FOLDER_ARCHIVE_TABLES.indexOf(fk.table));
        } else {
          const names = Object.keys(TABLES);
          expect(names.indexOf(fk.references.table)).toBeLessThan(names.indexOf(fk.table));
        }
      }
    } finally {
      db.close();
    }
  });
  it('is frozen', () => {
    expect(Object.isFrozen(TABLES)).toBe(true);
    expect(Object.isFrozen(TABLES.notes.columns)).toBe(true);
    expect(Object.isFrozen(IMPORT_ORDER)).toBe(true);
  });
});

describe('path resolution and singleton', () => {
  it('resolveDbPath uses BURROW_TEST_DATA_DIR under Vitest and throws without it', () => {
    expect(resolveDbPath()).toBe(path.join(process.env.BURROW_TEST_DATA_DIR, DB_FILENAME));
    const saved = process.env.BURROW_TEST_DATA_DIR;
    delete process.env.BURROW_TEST_DATA_DIR;
    try {
      expect(() => resolveDbPath()).toThrow(DbError);
    } finally {
      process.env.BURROW_TEST_DATA_DIR = saved;
    }
  });
  it('getDb opens a migrated singleton and closeDb is idempotent', () => {
    const a = getDb();
    expect(getDb()).toBe(a);
    expect(tableNames(a)).toContain('schema_version');
    closeDb();
    closeDb();
    expect(pingDb(a)).toBe(false);
    expect(getDb() === a).toBe(false);
    closeDb();
  });
  it('getDb failure is not cached and pingDb never throws', () => {
    const saved = process.env.BURROW_TEST_DATA_DIR;
    delete process.env.BURROW_TEST_DATA_DIR;
    try {
      expect(() => getDb()).toThrow(DbError);
      expect(pingDb()).toBe(false);
    } finally {
      process.env.BURROW_TEST_DATA_DIR = saved;
    }
    expect(pingDb()).toBe(true);
    closeDb();
  });
});

describe('errors', () => {
  it('toDbError passes DbError through and maps sqlite errors without leaking data', () => {
    const e = new DbError('not_found', 'x');
    expect(toDbError(e)).toBe(e);
    const db = openDb({ filename: ':memory:' });
    try {
      let raised;
      try {
        db.prepare('INSERT INTO notes (id, body) VALUES (?, NULL)').run('secret-id');
      } catch (err) {
        raised = err;
      }
      const mapped = toDbError(raised);
      expect(mapped.code).toBe('constraint');
      expect(mapped.message).not.toContain('secret-id');
      let other;
      try {
        db.prepare('SELECT * FROM nope').get();
      } catch (err) {
        other = err;
      }
      expect(toDbError(other).code).toBe('sqlite_error');
      expect(toDbError(new Error('plain')).code).toBe('sqlite_error');
    } finally {
      db.close();
    }
  });
  it('httpErrorFor gives fixed, leak-free responses', () => {
    expect(httpErrorFor(new DbError('db_unavailable', 'x'))).toEqual({ status: 503, error: 'Local database is unavailable.' });
    expect(httpErrorFor(new DbError('migration_failed', 'x')).status).toBe(503);
    expect(httpErrorFor(new DbError('constraint', 'x'))).toEqual({ status: 400, error: 'Invalid input' });
    expect(httpErrorFor(new DbError('invalid_value', 'x')).status).toBe(400);
    expect(httpErrorFor(new DbError('not_found', 'x'))).toEqual({ status: 404, error: 'Not found' });
    expect(httpErrorFor(new DbError('unknown_table', 'x'))).toEqual({ status: 500, error: 'Server error' });
    expect(httpErrorFor(new Error('boom'))).toEqual({ status: 500, error: 'Server error' });
  });
});
