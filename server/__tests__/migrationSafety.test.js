// Migration safety: a database created at ANY older schema version must upgrade to the latest
// without losing a single row, leave a restorable pre-migration backup, and a failing migration
// must leave the live database untouched. Shipped migration files are immutable (hash lock).
//
// No binary fixture databases are committed: while the lock holds, "migrations 1..v applied, then
// a synthetic fixture inserted" is exactly what a user on version v has on disk.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import { FOREIGN_KEYS, IMPORT_ORDER, TABLES, closeDb, getDb, openDb, resolveDbPath } from '../db/index.js';
import { __resetLockForTests } from '../backup/lock.js';
import { backupsDir } from '../backup/paths.js';
import { __resetUploadsForTests, inspectUpload, restoreBackup } from '../backup/restore.js';
import { sha256File } from '../backup/snapshot.js';
import { MIGRATIONS_DIR, currentVersion, loadMigrations, migrate } from '../db/migrate.js';

const ALL = loadMigrations();
const LATEST = ALL.length;
const LOCK_FILE = new URL('../db/migrations.lock.json', import.meta.url);

let root;
beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-migsafe-'));
});
afterAll(() => {
  try {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch {
    /* Windows EBUSY: leak tmp */
  }
});

const columnsAt = (db, table) => db.prepare(`PRAGMA table_info("${table}")`).all().map((c) => c.name);
const plain = (rows) => JSON.parse(JSON.stringify(rows));

// Generic synthetic value per column type. Only tables with constraints beyond the type need a
// hand-written row (app_state, app_secrets, audit_log).
const FK_PARENT = new Map(FOREIGN_KEYS.map((f) => [`${f.table}.${f.column}`, f.references.table]));
function valueFor(table, column, type) {
  const parent = FK_PARENT.get(`${table}.${column}`);
  if (parent) return `${parent}-id-1`;
  switch (type) {
    case 'uuid':
      return `${table}-id-1`;
    case 'date':
      return '2026-01-15';
    case 'timestamptz':
      return '2026-01-15T10:00:00.000Z';
    case 'numeric':
    case 'real':
      return 12.5;
    case 'integer':
      return 3;
    case 'boolean':
      return 1;
    case 'jsonb':
      return '{"sample":1}';
    case 'text[]':
      return '["sample"]';
    default:
      return `sample ${table} ${column}`;
  }
}
const OVERRIDES = {
  audit_log: { kind: 'llm', status: 'ok', feature: 'chat', page: 'todos', provider: 'ollama', model: 'm', context: 'ctx', meta: '{}' },
};

function insertRow(db, table, row) {
  const cols = Object.keys(row);
  db.prepare(`INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(
    ...cols.map((c) => row[c]),
  );
}

/** One synthetic row in every table that exists at the DB's current version (FK order). */
function insertFixture(db) {
  const order = [...IMPORT_ORDER, ...Object.keys(TABLES).filter((t) => !IMPORT_ORDER.includes(t))];
  for (const table of order) {
    if (table === 'app_state' || table === 'app_secrets') continue;
    const have = columnsAt(db, table);
    // A table added by a later migration does not exist at this version.
    if (have.length === 0) continue;
    const row = {};
    for (const [column, type] of Object.entries(TABLES[table].columns)) {
      if (!have.includes(column)) continue;
      row[column] = OVERRIDES[table]?.[column] ?? valueFor(table, column, type);
    }
    insertRow(db, table, row);
  }
  const stamp = '2026-01-15T10:00:00.000Z';
  for (const [key, value] of [
    ['network.optIn', { weather: true }],
    ['ai.settings', { provider: 'ollama' }],
    ['budget:targets', { Groceries: 300, Dining: 120.5 }],
  ]) {
    insertRow(db, 'app_state', { key, value: JSON.stringify(value), updated_at: stamp });
  }
  insertRow(db, 'app_secrets', { name: 'FAKE_TEST_KEY', ciphertext: 'ct', iv: 'iv', auth_tag: 'tag', last4: 'abcd', updated_at: stamp });
}

/** Column lists captured once (at the starting version) so later column adds do not count as change. */
function captureColumns(db) {
  return Object.fromEntries(Object.keys(TABLES).map((t) => [t, columnsAt(db, t)]));
}

/** Every table's rows, ordered by primary key. */
function snapshot(db, cols) {
  const out = {};
  for (const [table, def] of Object.entries(TABLES)) {
    // Tables that did not exist at the starting version are not part of what the upgrade must preserve.
    if (cols[table].length === 0) continue;
    const list = cols[table].map((c) => `"${c}"`).join(', ');
    out[table] = plain(db.prepare(`SELECT ${list} FROM "${table}" ORDER BY "${def.primaryKey}"`).all());
  }
  return out;
}

const rowCount = (snap) => Object.values(snap).reduce((n, rows) => n + rows.length, 0);

const versions = Array.from({ length: Math.max(LATEST - 1, 0) }, (_, i) => i + 1);

describe('migration safety', () => {
  it('has migrations to protect', () => {
    expect(LATEST).toBeGreaterThanOrEqual(1);
  });

  describe.each(versions)('upgrading from schema version %i to the latest', (v) => {
    it('keeps every row, leaves a restorable backup, and round-trips', () => {
      const dir = fs.mkdtempSync(path.join(root, `v${v}-`));
      const filename = path.join(dir, 'burrow.db');
      const bak = `${filename}.pre-v${LATEST}.bak`;

      // 1-2. Build a database as a user on version v would have it, with data in every table.
      const old = openDb({ filename, migrate: false });
      migrate(old, { migrations: ALL.slice(0, v), filename });
      expect(currentVersion(old)).toBe(v);
      insertFixture(old);
      const cols = captureColumns(old);
      const before = snapshot(old, cols);
      old.close();
      for (const table of Object.keys(before)) {
        // Fixture is not vacuous: every table that exists at this version has data (app_state holds the three settings).
        expect(before[table].length, table).toBeGreaterThan(0);
      }
      expect(before.app_state).toHaveLength(3);
      expect(before.app_secrets).toHaveLength(1);

      // 3. Reopen with migrations: nothing lost, schema valid, backup written.
      const upgraded = openDb({ filename });
      try {
        expect(currentVersion(upgraded)).toBe(LATEST);
        expect(fs.existsSync(bak)).toBe(true);
        expect(snapshot(upgraded, cols)).toEqual(before);
        expect(upgraded.prepare('PRAGMA integrity_check').all().map((r) => r.integrity_check)).toEqual(['ok']);
        expect(upgraded.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      } finally {
        upgraded.close();
      }

      // 4. The backup is the pre-migration database, byte-for-byte in content.
      const backup = new DatabaseSync(bak, { readOnly: true });
      try {
        expect(backup.prepare('SELECT MAX(version) AS v FROM schema_version').get().v).toBe(v);
        expect(snapshot(backup, cols)).toEqual(before);
      } finally {
        backup.close();
      }

      // 5. Restore the backup over the live file; the app can use it and upgrades again.
      for (const f of [filename, `${filename}-wal`, `${filename}-shm`]) fs.rmSync(f, { force: true });
      fs.copyFileSync(bak, filename);
      const restored = openDb({ filename, migrate: false });
      try {
        expect(currentVersion(restored)).toBe(v);
        expect(snapshot(restored, cols)).toEqual(before);
      } finally {
        restored.close();
      }
      const again = openDb({ filename });
      try {
        expect(currentVersion(again)).toBe(LATEST);
        expect(snapshot(again, cols)).toEqual(before);
        expect(rowCount(snapshot(again, cols))).toBe(rowCount(before));
      } finally {
        again.close();
      }
    });

    it('a failing migration rolls back and leaves the live database untouched', () => {
      const dir = fs.mkdtempSync(path.join(root, `fail-v${v}-`));
      const filename = path.join(dir, 'burrow.db');
      const old = openDb({ filename, migrate: false });
      migrate(old, { migrations: ALL.slice(0, v), filename });
      insertFixture(old);
      const cols = captureColumns(old);
      old.close();

      const db = openDb({ filename });
      try {
        const before = snapshot(db, cols);
        const broken = [...ALL, { version: LATEST + 1, name: 'broken', sql: 'SELECT * FROM nope;' }];
        expect(() => migrate(db, { migrations: broken, filename })).toThrowError(expect.objectContaining({ code: 'migration_failed' }));
        expect(fs.existsSync(`${filename}.pre-v${LATEST + 1}.bak`)).toBe(true);
        expect(currentVersion(db)).toBe(LATEST);
        expect(snapshot(db, cols)).toEqual(before);
        expect(db.prepare('PRAGMA integrity_check').all().map((r) => r.integrity_check)).toEqual(['ok']);
      } finally {
        db.close();
      }
    });
  });

  describe('shipped migrations are immutable', () => {
    const hashOf = (file) =>
      crypto
        .createHash('sha256')
        .update(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8').replace(/\r\n/g, '\n'))
        .digest('hex');
    const onDisk = fs.readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{3}_[a-z0-9_]+\.sql$/.test(f)).sort();
    const lock = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
    const RULE = 'shipped migrations are immutable; add a new NNN file';

    it('every migration file is listed in the lock', () => {
      const missing = onDisk.filter((f) => !Object.hasOwn(lock, f));
      expect(missing, `${RULE} (and record it in server/db/migrations.lock.json)`).toEqual([]);
    });

    it('every locked file still exists', () => {
      const gone = Object.keys(lock).filter((f) => !onDisk.includes(f));
      expect(gone, RULE).toEqual([]);
    });

    it.each(Object.keys(lock))('%s is unchanged', (file) => {
      expect(hashOf(file), `${file} changed: ${RULE}`).toBe(lock[file]);
    });
  });
});

// A backup made on an older Burrow must restore onto the current schema: the live database ends on
// the latest version, no row of the backup is lost, and the backup file itself is never modified.
describe('restore across a schema upgrade', () => {
  const dataDir = () => path.dirname(resolveDbPath());
  const stamp = '2026-02-02T00:00:00.000Z';

  beforeEach(() => {
    closeDb();
    __resetLockForTests();
    __resetUploadsForTests();
    for (const name of fs.readdirSync(dataDir())) {
      fs.rmSync(path.join(dataDir(), name), { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
    }
    // The live database is at the latest version, holds its own data, and has its own install settings.
    const live = getDb();
    live.prepare("INSERT INTO notes (id, body, created_at) VALUES ('live-note-1', 'live only', ?)").run(stamp);
    for (const [key, value] of [
      ['network.optIn', { weather: false }],
      ['ai.settings', { provider: 'live-provider' }],
    ]) {
      live.prepare('INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?)').run(key, JSON.stringify(value), stamp);
    }
    live
      .prepare('INSERT INTO app_secrets (name, ciphertext, iv, auth_tag, last4, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('LIVE_KEY', 'ct', 'iv', 'tag', 'wxyz', stamp);
  });

  /** A vN database file with a row in every table, as a self-contained file. */
  function buildOldBackup(v) {
    const dir = fs.mkdtempSync(path.join(root, `restore-v${v}-`));
    const file = path.join(dir, 'old.db');
    const old = openDb({ filename: file, migrate: false });
    migrate(old, { migrations: ALL.slice(0, v), filename: file });
    insertFixture(old);
    const cols = captureColumns(old);
    const before = snapshot(old, cols);
    old.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    old.exec('PRAGMA journal_mode = DELETE');
    old.close();
    return { file, cols, before };
  }

  /** Places the file in the backups folder with a verified meta, as a backup made at version v. */
  async function placeAsBackup(file, v, total) {
    const id = `2026010${v}T100000Z-manual-0000a${v}`;
    fs.mkdirSync(backupsDir(), { recursive: true });
    const target = path.join(backupsDir(), `burrow-${id}.db`);
    fs.copyFileSync(file, target);
    const sha = await sha256File(target);
    const meta = {
      format: 'burrow-backup',
      formatVersion: 1,
      id,
      kind: 'manual',
      createdAt: `2026-01-0${v}T10:00:00.000Z`,
      appVersion: '0.0.0',
      schemaVersion: v,
      status: 'verified',
      error: null,
      db: { file: `burrow-${id}.db`, bytes: fs.statSync(target).size, sha256: sha },
      export: { file: null, bytes: 0, sha256: null, status: 'failed' },
      rowCounts: {},
      totalRows: total,
      fingerprint: null,
      verifiedAt: `2026-01-0${v}T10:00:01.000Z`,
    };
    const metaFile = path.join(backupsDir(), `burrow-${id}.meta.json`);
    fs.writeFileSync(metaFile, JSON.stringify(meta));
    return { id, target, sha, metaFile };
  }

  /** The restored live database against the old backup's rows. */
  function expectRestored(before, cols) {
    const live = getDb();
    expect(currentVersion(live)).toBe(LATEST);
    expect(live.prepare('PRAGMA integrity_check').all().map((r) => r.integrity_check)).toEqual(['ok']);
    expect(live.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    const after = snapshot(live, cols);
    for (const table of Object.keys(TABLES)) {
      if (table === 'app_state' || table === 'app_secrets') continue;
      // No row of the backup is lost, and the live-only note is gone with the data it belonged to.
      expect(after[table], table).toEqual(before[table]);
    }
    // Install-specific rows stay as they are on this computer; everything else comes from the backup.
    const state = Object.fromEntries(after.app_state.map((r) => [r.key, JSON.parse(r.value)]));
    expect(state).toEqual({
      'budget:targets': { Groceries: 300, Dining: 120.5 },
      'network.optIn': { weather: false },
      'ai.settings': { provider: 'live-provider' },
    });
    expect(after.app_secrets.map((r) => r.name)).toEqual(['LIVE_KEY']);
    expect(after.notes.map((n) => n.body)).not.toContain('live only');
    expect(fs.readdirSync(dataDir()).filter((n) => /^restore-/.test(n) || n.endsWith('.bak'))).toEqual([]);
  }

  describe.each(versions)('from schema version %i to the latest', (v) => {
    it('restores a listed backup: latest version, no rows lost, the backup file untouched', async () => {
      const { file, cols, before } = buildOldBackup(v);
      const placed = await placeAsBackup(file, v, rowCount(before));
      const metaBefore = fs.readFileSync(placed.metaFile, 'utf8');

      const result = await restoreBackup({ id: placed.id, now: new Date('2026-03-01T12:00:00.000Z') });

      expect(result).toMatchObject({ restoredFrom: placed.id, schemaFrom: v, schemaTo: LATEST });
      expectRestored(before, cols);

      // The source backup is exactly as it was: same bytes, same meta, still at version v, no .bak next to it.
      expect(await sha256File(placed.target)).toBe(placed.sha);
      expect(fs.readFileSync(placed.metaFile, 'utf8')).toBe(metaBefore);
      const source = new DatabaseSync(placed.target, { readOnly: true });
      try {
        expect(currentVersion(source)).toBe(v);
      } finally {
        source.close();
      }
      expect(fs.readdirSync(backupsDir()).filter((n) => n.endsWith('.bak') || n.includes('-wal') || n.includes('-shm'))).toEqual([]);

      // A safety copy of the live data (latest version, with the live-only note) was taken first.
      const safetyMeta = fs.readdirSync(backupsDir()).find((n) => /-safety-.*\.meta\.json$/.test(n));
      expect(safetyMeta).toBeTruthy();
      const safety = JSON.parse(fs.readFileSync(path.join(backupsDir(), safetyMeta), 'utf8'));
      expect(safety).toMatchObject({ kind: 'safety', status: 'verified', schemaVersion: LATEST });
      const safetyDb = new DatabaseSync(path.join(backupsDir(), safety.db.file), { readOnly: true });
      try {
        expect(safetyDb.prepare('SELECT body FROM notes').all().map((r) => r.body)).toEqual(['live only']);
      } finally {
        safetyDb.close();
      }
    });

    it('restores the same file chosen from disk (upload): latest version, no rows lost', async () => {
      const { file, cols, before } = buildOldBackup(v);
      const bytes = fs.readFileSync(file);
      const req = Readable.from([bytes]);
      req.headers = { 'content-length': String(bytes.length) };

      const info = await inspectUpload(req);
      expect(info).toMatchObject({ schemaVersion: v, appSchemaVersion: LATEST, migrationNeeded: true, totalRows: expect.any(Number) });

      const result = await restoreBackup({ uploadToken: info.uploadToken });
      expect(result).toMatchObject({ restoredFrom: 'upload', schemaFrom: v, schemaTo: LATEST });
      expectRestored(before, cols);
      // The original file the user chose is not touched by the restore.
      expect(fs.readFileSync(file).equals(bytes)).toBe(true);
    });

    it('the restored database upgrades only once: reopening does not migrate again or add backup files', async () => {
      const { file, before } = buildOldBackup(v);
      const placed = await placeAsBackup(file, v, rowCount(before));
      await restoreBackup({ id: placed.id });
      closeDb();
      const reopened = getDb();
      expect(currentVersion(reopened)).toBe(LATEST);
      expect(fs.readdirSync(dataDir()).filter((n) => n.endsWith('.bak'))).toEqual([]);
    });
  });
});
