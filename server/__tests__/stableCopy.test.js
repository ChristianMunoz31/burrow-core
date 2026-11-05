// "Copy my data from Burrow" (Dev channel): the stable data folder must be byte-identical before and
// after every copy (recursive name + size + sha256, no new files), whether stable is closed, has a
// leftover WAL, or is running with an open WAL connection. Real files in temp folders only.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb, insertMany, openDb, select } from '../db/index.js';
import { createFsOps } from '../backup/fsops.js';
import { listMetas, readState } from '../backup/manifest.js';
import { backupsDir } from '../backup/paths.js';
import { cleanupOrphans, ORPHAN_MIN_AGE_MS, STABLE_COPY_DIR_PREFIX } from '../backup/service.js';
import {
  STABLE_COPY_ATTEMPTS,
  copyFromStable,
  getStableCopyStatus,
} from '../backup/stableCopy.js';
import { latestSchemaVersion } from '../backup/snapshot.js';
import { cleanupBackupEnv, dataDir, resetBackupEnv, statfsFree } from './helpers/backupEnv.js';

const tmpDirs = [];
const open = [];

function tmp(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `burrow-stable-${label}-`));
  tmpDirs.push(dir);
  return dir;
}

/** Recursive name + size + sha256 listing of a folder. */
function listing(dir) {
  const out = {};
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      const rel = path.relative(dir, full);
      if (entry.isDirectory()) {
        out[`${rel}/`] = 'dir';
        walk(full);
      } else {
        const bytes = fs.readFileSync(full);
        out[rel] = `${bytes.length}:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
      }
    }
  };
  walk(dir);
  return out;
}

/** A migrated WAL database like the stable Burrow keeps, left open in `open` for the caller to close. */
function openStableDb(dir) {
  const db = openDb({ filename: path.join(dir, 'burrow.db') });
  open.push(db);
  return db;
}

const addNote = (db, body) => insertMany('notes', [{ body }], { db });
const noteBodies = (db) => db.prepare('SELECT body FROM notes ORDER BY body').all().map((r) => r.body);
const liveNotes = () => select('notes').map((n) => n.body).sort();

function closeAll() {
  for (const db of open.splice(0)) {
    try {
      db.close();
    } catch {
      // already closed
    }
  }
}

/** Stable folder with a closed WAL database holding the given notes. */
function closedStable(notes) {
  const dir = tmp('closed');
  const db = openStableDb(dir);
  for (const n of notes) addNote(db, n);
  db.close();
  open.splice(0);
  return dir;
}

const leftovers = () =>
  (fs.existsSync(backupsDir()) ? fs.readdirSync(backupsDir()) : []).filter((n) => n.startsWith(STABLE_COPY_DIR_PREFIX) || n.startsWith('.incoming-'));
const stableOf = (dir) => ({ dir, overridden: true });
const fastRetry = { retryDelayMs: 1 };

beforeEach(() => {
  resetBackupEnv();
});
afterEach(() => {
  closeAll();
});
afterAll(() => {
  cleanupBackupEnv();
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe('stable folder stays byte-identical', () => {
  it('(a) a closed WAL database with no -wal or -shm', async () => {
    const dir = closedStable(['stable-a']);
    expect(Object.keys(listing(dir))).toEqual(['burrow.db']);
    const before = listing(dir);
    const result = await copyFromStable({ stable: stableOf(dir), ...fastRetry });
    expect(listing(dir)).toEqual(before);
    expect(result.copiedFrom).toBe(dir);
    expect(liveNotes()).toEqual(['stable-a']);
    expect(leftovers()).toEqual([]);
  });

  it('(b) a leftover -wal with committed rows that were never checkpointed', async () => {
    const live = tmp('live');
    const db = openStableDb(live);
    db.exec('PRAGMA wal_autocheckpoint = 0');
    addNote(db, 'checkpointed');
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    addNote(db, 'only-in-wal-1');
    addNote(db, 'only-in-wal-2');
    // Copy the files out from under the open connection (a crashed stable): no -shm.
    const dir = tmp('crashed');
    fs.copyFileSync(path.join(live, 'burrow.db'), path.join(dir, 'burrow.db'));
    fs.copyFileSync(path.join(live, 'burrow.db-wal'), path.join(dir, 'burrow.db-wal'));
    closeAll();
    expect(fs.statSync(path.join(dir, 'burrow.db-wal')).size).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(dir, 'burrow.db-shm'))).toBe(false);

    const before = listing(dir);
    await copyFromStable({ stable: stableOf(dir), ...fastRetry });
    expect(listing(dir)).toEqual(before);
    expect(liveNotes()).toEqual(['checkpointed', 'only-in-wal-1', 'only-in-wal-2']);
    expect(leftovers()).toEqual([]);
  });

  it('(c) stable running: an open WAL connection with writes before and after the copy', async () => {
    const dir = tmp('running');
    const db = openStableDb(dir);
    db.exec('PRAGMA wal_autocheckpoint = 0');
    addNote(db, 'before-1');
    addNote(db, 'before-2');
    expect(fs.existsSync(path.join(dir, 'burrow.db-shm'))).toBe(true);

    const before = listing(dir);
    const result = await copyFromStable({ stable: stableOf(dir), ...fastRetry });
    expect(listing(dir)).toEqual(before);
    expect(result.totalRows).toBeGreaterThanOrEqual(2);
    expect(liveNotes()).toEqual(['before-1', 'before-2']);

    // Stable keeps working: it can still write and read, and it sees its own rows.
    addNote(db, 'after');
    expect(noteBodies(db)).toEqual(['after', 'before-1', 'before-2']);
    db.exec('PRAGMA wal_checkpoint(PASSIVE)');
    expect(db.prepare('PRAGMA integrity_check').get().integrity_check).toBe('ok');
    // The copy did not take what stable wrote afterwards.
    expect(liveNotes()).toEqual(['before-1', 'before-2']);
    expect(leftovers()).toEqual([]);
  });

  it('(e) a restore journal in stable: stable_busy, nothing copied or changed', async () => {
    const dir = closedStable(['stable-e']);
    fs.writeFileSync(path.join(dir, 'restore-journal.json'), '{}');
    const before = listing(dir);
    await expect(copyFromStable({ stable: stableOf(dir), ...fastRetry })).rejects.toMatchObject({
      code: 'stable_busy',
      status: 409,
    });
    expect(listing(dir)).toEqual(before);
    expect(leftovers()).toEqual([]);
  });

  it('(g) a newer schema: stable_too_new, nothing restored', async () => {
    const dir = tmp('newer');
    const db = openStableDb(dir);
    addNote(db, 'stable-g');
    db.prepare('INSERT INTO schema_version (version, name, applied_at) VALUES (?, ?, ?)').run(
      latestSchemaVersion() + 1,
      'future',
      new Date().toISOString(),
    );
    db.close();
    open.splice(0);
    const before = listing(dir);
    await expect(copyFromStable({ stable: stableOf(dir), ...fastRetry })).rejects.toMatchObject({
      code: 'stable_too_new',
      status: 409,
    });
    expect(listing(dir)).toEqual(before);
    expect(liveNotes()).toEqual([]);
    expect(leftovers()).toEqual([]);
  });

  it('(h) a garbage database file: stable_invalid', async () => {
    const dir = tmp('garbage');
    fs.writeFileSync(path.join(dir, 'burrow.db'), Buffer.alloc(8192, 7));
    const before = listing(dir);
    await expect(copyFromStable({ stable: stableOf(dir), ...fastRetry })).rejects.toMatchObject({
      code: 'stable_invalid',
      status: 422,
    });
    expect(listing(dir)).toEqual(before);
    expect(liveNotes()).toEqual([]);
    expect(leftovers()).toEqual([]);
  });

  it('(h) an empty database file: stable_invalid', async () => {
    const dir = tmp('empty');
    fs.writeFileSync(path.join(dir, 'burrow.db'), '');
    await expect(copyFromStable({ stable: stableOf(dir), ...fastRetry })).rejects.toMatchObject({ code: 'stable_invalid' });
    expect(leftovers()).toEqual([]);
  });
});

describe('refusals', () => {
  it('(d) stable changes during every attempt: stable_busy after the attempts, nothing restored', async () => {
    const dir = tmp('busy');
    const db = openStableDb(dir);
    db.exec('PRAGMA wal_autocheckpoint = 0');
    addNote(db, 'stable-d');
    addNote(db, 'dev-visible-check');
    let calls = 0;
    await expect(
      copyFromStable({
        stable: stableOf(dir),
        ...fastRetry,
        hooks: {
          afterCopy: () => {
            calls += 1;
            addNote(db, `mutation-${calls}`);
          },
        },
      }),
    ).rejects.toMatchObject({ code: 'stable_busy', status: 409 });
    expect(calls).toBe(STABLE_COPY_ATTEMPTS);
    expect(liveNotes()).toEqual([]);
    expect(leftovers()).toEqual([]);
  });

  it('(d) a stable that settles on the second attempt is copied', async () => {
    const dir = tmp('settle');
    const db = openStableDb(dir);
    db.exec('PRAGMA wal_autocheckpoint = 0');
    addNote(db, 'first');
    let calls = 0;
    await copyFromStable({
      stable: stableOf(dir),
      ...fastRetry,
      hooks: {
        afterCopy: () => {
          calls += 1;
          if (calls === 1) addNote(db, 'second');
        },
      },
    });
    expect(calls).toBe(2);
    expect(liveNotes()).toEqual(['first', 'second']);
  });

  it('honours the attempts option', async () => {
    const dir = tmp('attempts');
    const db = openStableDb(dir);
    db.exec('PRAGMA wal_autocheckpoint = 0');
    addNote(db, 'x');
    let calls = 0;
    await expect(
      copyFromStable({
        stable: stableOf(dir),
        attempts: 2,
        retryDelayMs: 1,
        hooks: {
          afterCopy: () => {
            calls += 1;
            addNote(db, `m${calls}`);
          },
        },
      }),
    ).rejects.toMatchObject({ code: 'stable_busy' });
    expect(calls).toBe(2);
  });

  it('(f) a missing folder and a folder without burrow.db: stable_not_found', async () => {
    const missing = path.join(tmp('missing'), 'nope');
    await expect(copyFromStable({ stable: stableOf(missing), ...fastRetry })).rejects.toMatchObject({
      code: 'stable_not_found',
      status: 404,
    });
    const emptyDir = tmp('nodb');
    await expect(copyFromStable({ stable: stableOf(emptyDir), ...fastRetry })).rejects.toMatchObject({
      code: 'stable_not_found',
    });
    expect(fs.readdirSync(emptyDir)).toEqual([]);
  });

  it('(f) burrow.db that is a folder: stable_not_found', async () => {
    const dir = tmp('dbdir');
    fs.mkdirSync(path.join(dir, 'burrow.db'));
    await expect(copyFromStable({ stable: stableOf(dir), ...fastRetry })).rejects.toMatchObject({ code: 'stable_not_found' });
  });

  it('(i) the same folder, or a folder inside or around the Dev one: stable_same_folder', async () => {
    const here = dataDir();
    for (const dir of [here, path.join(here, 'inside'), path.dirname(here), path.join(here, '..', path.basename(here))]) {
      await expect(copyFromStable({ stable: stableOf(dir), ...fastRetry })).rejects.toMatchObject({
        code: 'stable_same_folder',
        status: 409,
      });
    }
    expect((await getStableCopyStatus({ stable: stableOf(here) })).sameFolder).toBe(true);
  });

  it('stable_same_folder is case-insensitive on Windows only', async () => {
    if (process.platform !== 'win32') return;
    await expect(copyFromStable({ stable: stableOf(dataDir().toUpperCase()), ...fastRetry })).rejects.toMatchObject({
      code: 'stable_same_folder',
    });
  });

  it('refuses while another backup or restore holds the lock', async () => {
    const dir = closedStable(['x']);
    const { tryAcquire } = await import('../backup/lock.js');
    const release = tryAcquire('backup');
    try {
      await expect(copyFromStable({ stable: stableOf(dir), ...fastRetry })).rejects.toMatchObject({ code: 'backup_busy' });
    } finally {
      release();
    }
    const releaseRestore = tryAcquire('restore');
    try {
      await expect(copyFromStable({ stable: stableOf(dir), ...fastRetry })).rejects.toMatchObject({ code: 'db_restoring' });
    } finally {
      releaseRestore();
    }
  });

  it('disk_low when the free space cannot hold the copies', async () => {
    const dir = closedStable(['x']);
    const fsOps = createFsOps({ statfs: statfsFree(1024) });
    const before = listing(dir);
    await expect(copyFromStable({ stable: stableOf(dir), fsOps, ...fastRetry })).rejects.toMatchObject({
      code: 'disk_low',
      status: 507,
    });
    expect(listing(dir)).toEqual(before);
    expect(leftovers()).toEqual([]);
  });

  it('releases the lock after a failure', async () => {
    const dir = tmp('nodb2');
    await expect(copyFromStable({ stable: stableOf(dir) })).rejects.toBeTruthy();
    const { currentOp } = await import('../backup/lock.js');
    expect(currentOp()).toBeNull();
    const { tryAcquire } = await import('../backup/lock.js');
    const release = tryAcquire('backup');
    expect(release).toBeTypeOf('function');
    release();
  });
});

describe('what the copy does to Dev data', () => {
  const secretRow = (db, name) =>
    db
      .prepare('INSERT INTO app_secrets (name, ciphertext, iv, auth_tag, last4, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(name, 'ct', 'iv', 'tag', 'abcd', '2026-01-01T00:00:00.000Z');
  const optIn = (db, value) =>
    db
      .prepare("INSERT OR REPLACE INTO app_state (key, value, updated_at) VALUES ('network.optIn', ?, '2026-01-01T00:00:00.000Z')")
      .run(JSON.stringify(value));

  it('(j) replaces the data, keeps a safety backup, carries Dev keys and settings, drops stable keys', async () => {
    const live = getDb();
    addNote(live, 'dev-only-note');
    secretRow(live, 'DEV_KEY');
    optIn(live, { updates: true });

    const dir = tmp('success');
    const stableDb = openStableDb(dir);
    addNote(stableDb, 'stable-note-1');
    addNote(stableDb, 'stable-note-2');
    secretRow(stableDb, 'STABLE_KEY');
    optIn(stableDb, { weather: true });
    stableDb.close();
    open.splice(0);
    const before = listing(dir);

    const result = await copyFromStable({ stable: stableOf(dir), ...fastRetry });
    expect(listing(dir)).toEqual(before);

    expect(Object.keys(result).sort()).toEqual(['copiedFrom', 'safetyBackupId', 'schemaFrom', 'schemaTo', 'totalRows']);
    expect(result.copiedFrom).toBe(dir);
    expect(typeof result.safetyBackupId).toBe('string');
    expect(result.schemaFrom).toBeLessThanOrEqual(result.schemaTo);
    expect(result.totalRows).toBeGreaterThanOrEqual(2);

    // Data replaced.
    expect(liveNotes()).toEqual(['stable-note-1', 'stable-note-2']);
    // Dev's own saved keys and network opt-in survive; the stable keys never arrive.
    const db = getDb();
    expect(db.prepare('SELECT name FROM app_secrets ORDER BY name').all().map((r) => r.name)).toEqual(['DEV_KEY']);
    expect(JSON.parse(db.prepare("SELECT value FROM app_state WHERE key = 'network.optIn'").get().value)).toEqual({
      updates: true,
    });

    // Safety backup of the Dev data exists and is verified.
    const safeties = (await listMetas(backupsDir())).filter((m) => m.kind === 'safety');
    expect(safeties).toHaveLength(1);
    expect(safeties[0].id).toBe(result.safetyBackupId);
    expect(safeties[0].status).toBe('verified');

    // Labelled as a stable copy in the state file and the audit log.
    expect((await readState(backupsDir())).lastRestore).toMatchObject({ outcome: 'restored', sourceId: 'stable-copy' });
    const audit = select('audit_log').filter((r) => r.feature === 'backup_restore');
    expect(audit).toHaveLength(1);
    const meta = typeof audit[0].meta === 'string' ? JSON.parse(audit[0].meta) : audit[0].meta;
    expect(meta.source).toBe('stable_copy');
    expect(leftovers()).toEqual([]);
    expect(fs.readdirSync(dataDir()).filter((n) => /^restore-/.test(n))).toEqual([]);
  });

  it('the stable saved keys are not in the snapshot even before the restore (normalized copy)', async () => {
    const dir = tmp('keys');
    const stableDb = openStableDb(dir);
    addNote(stableDb, 'n');
    secretRow(stableDb, 'STABLE_KEY');
    stableDb.close();
    open.splice(0);
    await copyFromStable({ stable: stableOf(dir), ...fastRetry });
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM app_secrets').get().n).toBe(0);
  });

  it('leaves the Dev data untouched after a failure and keeps no staging leftovers', async () => {
    const live = getDb();
    addNote(live, 'dev-only-note');
    const dir = tmp('badcopy');
    fs.writeFileSync(path.join(dir, 'burrow.db'), Buffer.alloc(4096, 1));
    await expect(copyFromStable({ stable: stableOf(dir), ...fastRetry })).rejects.toMatchObject({ code: 'stable_invalid' });
    expect(liveNotes()).toEqual(['dev-only-note']);
    expect((await listMetas(backupsDir())).filter((m) => m.kind === 'safety')).toEqual([]);
    expect(leftovers()).toEqual([]);
  });

  it('cleans the private folder when a failure comes late (restore error)', async () => {
    const dir = closedStable(['n']);
    const fsOps = createFsOps();
    const rename = fsOps.rename;
    let renames = 0;
    const failing = createFsOps({
      rename: async (...args) => {
        renames += 1;
        // The restore's own first rename moves the incoming file into staging.
        if (String(args[0]).includes('.incoming-')) throw Object.assign(new Error('boom'), { code: 'EIO' });
        return rename(...args);
      },
    });
    await expect(copyFromStable({ stable: stableOf(dir), fsOps: failing, ...fastRetry })).rejects.toBeTruthy();
    expect(renames).toBeGreaterThan(0);
    expect(leftovers()).toEqual([]);
  });
});

describe('getStableCopyStatus', () => {
  it('reports found, the folder, last change and flags, from stat alone', async () => {
    const dir = closedStable(['x']);
    const before = listing(dir);
    const status = await getStableCopyStatus({ stable: { dir, overridden: true } });
    expect(listing(dir)).toEqual(before);
    expect(status).toMatchObject({ found: true, dataDir: dir, overridden: true, busy: false, sameFolder: false });
    expect(Number.isNaN(Date.parse(status.lastChangedAt))).toBe(false);
  });

  it('uses the newest mtime of the database and its -wal', async () => {
    const dir = closedStable(['x']);
    fs.writeFileSync(path.join(dir, 'burrow.db-wal'), '');
    const later = new Date('2031-01-02T03:04:05.000Z');
    fs.utimesSync(path.join(dir, 'burrow.db-wal'), later, later);
    const status = await getStableCopyStatus({ stable: stableOf(dir) });
    expect(status.lastChangedAt).toBe(later.toISOString());
  });

  it('missing folder: not found, no date', async () => {
    const status = await getStableCopyStatus({ stable: stableOf(path.join(tmp('m'), 'x')) });
    expect(status).toMatchObject({ found: false, lastChangedAt: null, busy: false });
  });

  it('a restore journal means busy', async () => {
    const dir = closedStable(['x']);
    fs.writeFileSync(path.join(dir, 'restore-journal.json'), '{}');
    expect((await getStableCopyStatus({ stable: stableOf(dir) })).busy).toBe(true);
  });

  it('never opens a database or creates a file', async () => {
    const dir = tmp('stat');
    fs.writeFileSync(path.join(dir, 'burrow.db'), Buffer.alloc(100, 9));
    const before = listing(dir);
    expect((await getStableCopyStatus({ stable: stableOf(dir) })).found).toBe(true);
    expect(listing(dir)).toEqual(before);
  });
});

describe('orphan cleanup', () => {
  it('removes old .stable-copy-* folders and keeps young ones', async () => {
    const dir = backupsDir();
    fs.mkdirSync(dir, { recursive: true });
    const old = path.join(dir, `${STABLE_COPY_DIR_PREFIX}aaaaaaaaaaaaaaaa`);
    const young = path.join(dir, `${STABLE_COPY_DIR_PREFIX}bbbbbbbbbbbbbbbb`);
    for (const d of [old, young]) {
      fs.mkdirSync(d);
      fs.writeFileSync(path.join(d, 'burrow.db'), 'x');
    }
    const past = new Date(Date.now() - ORPHAN_MIN_AGE_MS - 60_000);
    fs.utimesSync(old, past, past);
    const { removed } = await cleanupOrphans({});
    expect(removed).toContain(path.basename(old));
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(young)).toBe(true);
  });
});

describe('stable folder is never created or modified by a path that does not exist', () => {
  it('does not create the stable folder', async () => {
    const parent = tmp('parent');
    const missing = path.join(parent, 'not-created');
    await expect(copyFromStable({ stable: stableOf(missing), ...fastRetry })).rejects.toMatchObject({ code: 'stable_not_found' });
    await getStableCopyStatus({ stable: stableOf(missing) });
    expect(fs.existsSync(missing)).toBe(false);
  });
});

describe('premise: a read-only SQLite open would write into the folder (why the copy never opens stable)', () => {
  it('creates -wal and -shm next to a closed WAL database', () => {
    const dir = closedStable(['x']);
    expect(fs.readdirSync(dir)).toEqual(['burrow.db']);
    const ro = new DatabaseSync(path.join(dir, 'burrow.db'), { readOnly: true });
    ro.prepare('SELECT 1').get();
    ro.close();
    expect(fs.readdirSync(dir).sort()).toEqual(['burrow.db', 'burrow.db-shm', 'burrow.db-wal']);
  });
});
