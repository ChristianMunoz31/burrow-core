// Import from the direct Burrow (Store build, data in %USERPROFILE%\Burrow Data). Real files in temp folders only: the "direct" Burrow
// is a temp folder (never the real %APPDATA%\Burrow) and the target is the per-file test data dir.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { Worker } from 'node:worker_threads';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { registerDataRoutes } from '../dataRoutes.js';
import { closeDb, getDb, insertMany, openDb, select } from '../db/index.js';
import { __setWorkerFactoryForTests } from '../backup/worker/client.js';
import { DEFAULT_TODO_COLUMNS } from '../normalize.js';
import { createFsOps } from '../backup/fsops.js';
import { planRetention } from '../backup/retention.js';
import { AUTO_STATE_KEYS, backupsShowUserData, directSource, discardStagedImports, getDirectImportStatus, importFromDirect, importOffered, isPristineDb, reconcileDirectImport, recordCancelledImport } from '../backup/directImport.js';
import { IMPORT_ASIDE_DIR, STAGED_IMPORT_DIR_RE } from '../backup/importConstants.js';
import { latestSchemaVersion } from '../backup/snapshot.js';
import { eraseAllData } from '../erase/eraseService.js';
import { loadOrCreateKeyFile } from '../secrets/keyFile.js';
import { LEGACY_LICENSE_FILES } from './helpers/eraseEnv.js';
import { DATA_MARKER_FILE, markerContent } from '../dataFolderOwnership.js';
import { cleanupBackupEnv, dataDir, enospc, resetBackupEnv } from './helpers/backupEnv.js';

const tmpDirs = [];
const open = [];
const BACKUP_ID = '20260101T000000Z-manual-abc123';
const no = async () => 'no';
function tmp(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `burrow-import-${label}-`));
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

const addNote = (db, body) => insertMany('notes', [{ body }], { db });
const noteBodies = (db) => db.prepare('SELECT body FROM notes ORDER BY body').all().map((r) => r.body);
const stages = () => fs.readdirSync(dataDir()).filter((n) => STAGED_IMPORT_DIR_RE.test(n));
const sourceOf = (dir) => ({ dir });

/**
 * A direct Burrow folder: WAL database with the given notes, secrets.key, the legacy license files an older version left (never copied) and one backup.
 * The database is left open in `open` when `keepOpen`.
 */
function makeSource({ notes = ['n1', 'n2'], keepOpen = false, withKey = true, withBackup = true, extra } = {}) {
  const dir = tmp('direct');
  const db = openDb({ filename: path.join(dir, 'burrow.db') });
  open.push(db);
  db.exec('PRAGMA wal_autocheckpoint = 0');
  for (const n of notes) addNote(db, n);
  if (withKey) {
    loadOrCreateKeyFile({ dir });
    for (const name of LEGACY_LICENSE_FILES) fs.writeFileSync(path.join(dir, name), JSON.stringify({ v: 1, synthetic: true }));
  }
  if (withBackup) {
    fs.mkdirSync(path.join(dir, 'backups'));
    fs.writeFileSync(path.join(dir, 'backups', `burrow-${BACKUP_ID}.db`), Buffer.from('synthetic backup bytes'));
    fs.writeFileSync(path.join(dir, 'backups', `burrow-${BACKUP_ID}.meta.json`), '{"synthetic":true}\n');
    fs.writeFileSync(path.join(dir, 'backups', 'state.json'), '{"not":"copied"}\n');
  }
  extra?.(dir, db);
  if (!keepOpen) {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.close();
    open.splice(0);
  }
  return { dir, db };
}

function closeAll() {
  for (const db of open.splice(0)) {
    try {
      db.close();
    } catch {
      // already closed
    }
  }
}

const baseOpts = (src, extra = {}) => ({ source: sourceOf(src), offered: true, detectRunning: no, retryDelayMs: 1, ...extra });

beforeEach(() => {
  resetBackupEnv();
  // The data folder of a Store build in the user profile always carries the ownership marker; the import refuses one without it.
  fs.writeFileSync(path.join(dataDir(), DATA_MARKER_FILE), markerContent());
});
afterEach(() => {
  closeAll();
  vi.restoreAllMocks();
});
afterAll(() => {
  cleanupBackupEnv();
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe('happy path: stage, then the swap at the next start', () => {
  it('copies the data, leaves the source untouched, and the swap brings it in without any license file', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no network allowed'));
    const { dir: src } = makeSource({ notes: ['alpha', 'beta'] });
    const before = listing(src);
    const liveBefore = listing(dataDir());

    const result = await importFromDirect(baseOpts(src));
    expect(result).toMatchObject({ status: 'staged', needsRestart: true, copiedFrom: src, backups: 2 });
    expect(result.totalRows).toBeGreaterThanOrEqual(2);
    // Source: byte for byte the same, no new file (no -wal, no -shm created by us).
    expect(listing(src)).toEqual(before);
    // Live files: untouched until the next start; only the staging folder is new.
    expect(stages()).toHaveLength(1);
    // The live files are not swapped yet. (burrow.db itself gets the one audit row, so it is not compared byte for byte.)
    const live = listing(dataDir());
    for (const [name, hash] of Object.entries(liveBefore)) {
      if (!name.endsWith('/') && !name.startsWith('burrow.db')) expect(live[name]).toBe(hash);
    }
    expect(noteBodies(getDb())).toEqual([]);
    expect(select('audit_log').some((row) => row.feature === 'data_import_direct')).toBe(true);
    const stageDir = path.join(dataDir(), stages()[0]);
    expect(fs.existsSync(path.join(stageDir, 'import-manifest.json'))).toBe(true);
    expect(fs.existsSync(path.join(stageDir, 'src-copy'))).toBe(false);
    // The state.json run state is not copied.
    expect(fs.existsSync(path.join(stageDir, 'backups', 'state.json'))).toBe(false);
    expect((await getDirectImportStatus({ source: sourceOf(src), offered: true }))).toMatchObject({ pending: true, canOffer: false, reason: 'pending' });

    // Next start: close the database like a quit does, then reconcile before the database opens.
    closeDb();
    const swapped = await reconcileDirectImport({});
    expect(swapped).toEqual({ result: 'swapped' });
    expect(stages()).toEqual([]);
    expect(fs.existsSync(path.join(dataDir(), IMPORT_ASIDE_DIR))).toBe(true);

    const db = getDb();
    // Afterwards the status says the data came from an import, so nothing is offered or explained again.
    expect(await getDirectImportStatus({ source: sourceOf(src), offered: true })).toMatchObject({ canOffer: false, reason: 'imported', pending: false });
    expect(noteBodies(db)).toEqual(['alpha', 'beta']);
    expect(db.prepare('PRAGMA integrity_check').get().integrity_check).toBe('ok');
    expect(fs.readFileSync(path.join(dataDir(), 'secrets.key'), 'utf8')).toBe(fs.readFileSync(path.join(src, 'secrets.key'), 'utf8'));
    // The legacy license files an older version left in the source are not copied.
    for (const name of LEGACY_LICENSE_FILES) expect(fs.existsSync(path.join(dataDir(), name)), name).toBe(false);
    expect(fs.readFileSync(path.join(dataDir(), 'backups', `burrow-${BACKUP_ID}.db`))).toEqual(fs.readFileSync(path.join(src, 'backups', `burrow-${BACKUP_ID}.db`)));

    // No network at any point.
    expect(fetchSpy).not.toHaveBeenCalled();
    // Still untouched after the swap too.
    expect(listing(src)).toEqual(before);
  });

  it('works when the target has no burrow.db at all', async () => {
    const { dir: src } = makeSource({ notes: ['only'] });
    closeDb();
    for (const name of fs.readdirSync(dataDir()).filter((n) => n !== DATA_MARKER_FILE)) fs.rmSync(path.join(dataDir(), name), { recursive: true, force: true });
    const result = await importFromDirect(baseOpts(src, { getDbImpl: () => { throw new Error('no database'); } }));
    expect(result.status).toBe('staged');
    closeDb();
    expect(await reconcileDirectImport({})).toEqual({ result: 'swapped' });
    expect(noteBodies(getDb())).toEqual(['only']);
  });

  it('copies a database whose rows are only in a leftover -wal (a crashed direct Burrow), source untouched', async () => {
    const live = tmp('live');
    const wdb = openDb({ filename: path.join(live, 'burrow.db') });
    open.push(wdb);
    wdb.exec('PRAGMA wal_autocheckpoint = 0');
    addNote(wdb, 'checkpointed');
    wdb.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    addNote(wdb, 'wal-only');
    const src = tmp('crashed');
    fs.copyFileSync(path.join(live, 'burrow.db'), path.join(src, 'burrow.db'));
    fs.copyFileSync(path.join(live, 'burrow.db-wal'), path.join(src, 'burrow.db-wal'));
    closeAll();
    expect(loadOrCreateKeyFile({ dir: src }).ok).toBe(true);
    expect(fs.existsSync(path.join(src, 'burrow.db-shm'))).toBe(false);
    const before = listing(src);
    await importFromDirect(baseOpts(src));
    expect(listing(src)).toEqual(before);
    closeDb();
    await reconcileDirectImport({});
    expect(noteBodies(getDb())).toEqual(['checkpointed', 'wal-only']);
  });
});

describe('refusals leave both sides as they were', () => {
  it('refuses when this Burrow already has data (409), without touching anything', async () => {
    const { dir: src } = makeSource();
    addNote(getDb(), 'my own note');
    const before = listing(src);
    const liveBefore = noteBodies(getDb());
    await expect(importFromDirect(baseOpts(src))).rejects.toMatchObject({ code: 'import_target_not_empty', status: 409 });
    expect(listing(src)).toEqual(before);
    expect(noteBodies(getDb())).toEqual(liveBefore);
    expect(stages()).toEqual([]);
    expect(await getDirectImportStatus({ source: sourceOf(src), offered: true })).toMatchObject({ canOffer: false, reason: 'target_has_data' });
  });

  it('refuses while the direct Burrow runs, and when it cannot tell', async () => {
    const { dir: src } = makeSource();
    const before = listing(src);
    await expect(importFromDirect(baseOpts(src, { detectRunning: async () => 'yes' }))).rejects.toMatchObject({ code: 'import_direct_running', status: 409 });
    await expect(importFromDirect(baseOpts(src, { detectRunning: async () => 'unknown' }))).rejects.toMatchObject({ code: 'import_running_unknown', status: 409 });
    expect(listing(src)).toEqual(before);
    expect(stages()).toEqual([]);
  });

  it('refuses without a source, with a source that is this folder, and when an import is already waiting', async () => {
    const empty = tmp('empty');
    await expect(importFromDirect(baseOpts(empty))).rejects.toMatchObject({ code: 'import_source_not_found', status: 404 });
    await expect(importFromDirect(baseOpts(dataDir()))).rejects.toMatchObject({ code: 'import_source_not_found' });
    const { dir: src } = makeSource();
    await importFromDirect(baseOpts(src));
    await expect(importFromDirect(baseOpts(src))).rejects.toMatchObject({ code: 'import_pending', status: 409 });
    expect(stages()).toHaveLength(1);
  });

  it('refuses a source without secrets.key (the key of the saved API keys)', async () => {
    const { dir: src } = makeSource({ withKey: false, withBackup: false });
    const before = listing(src);
    await expect(importFromDirect(baseOpts(src))).rejects.toMatchObject({ code: 'import_source_invalid', status: 422 });
    expect(listing(src)).toEqual(before);
    expect(stages()).toEqual([]);
  });

  it('refuses a newer schema and a garbage database', async () => {
    const { dir: newer } = makeSource({
      extra: (dir, db) =>
        db.prepare('INSERT INTO schema_version (version, name, applied_at) VALUES (?, ?, ?)').run(latestSchemaVersion() + 1, 'future', new Date().toISOString()),
    });
    await expect(importFromDirect(baseOpts(newer))).rejects.toMatchObject({ code: 'import_source_too_new', status: 409 });
    const garbage = tmp('garbage');
    fs.writeFileSync(path.join(garbage, 'burrow.db'), Buffer.alloc(8192, 7));
    fs.writeFileSync(path.join(garbage, 'secrets.key'), `${crypto.randomBytes(32).toString('base64')}\n`);
    const before = listing(garbage);
    await expect(importFromDirect(baseOpts(garbage))).rejects.toMatchObject({ code: 'import_source_invalid' });
    expect(listing(garbage)).toEqual(before);
    expect(stages()).toEqual([]);
  });

  it('is not offered outside the Store build with the userprofile data location (this test run is a source checkout)', async () => {
    expect(importOffered()).toBe(false);
    expect(await getDirectImportStatus()).toMatchObject({ available: false, canOffer: false });
    await expect(importFromDirect({})).rejects.toMatchObject({ code: 'import_unavailable', status: 404 });
    expect(directSource({ env: { APPDATA: 'C:\\Users\\example\\AppData\\Roaming' }, platform: 'win32' }).dir).toBe('C:\\Users\\example\\AppData\\Roaming\\Burrow');
  });

  it('a failure while staging removes only its own staging folder (disk full), source untouched', async () => {
    const { dir: src } = makeSource();
    const before = listing(src);
    const realRename = createFsOps().rename;
    let calls = 0;
    const fsOps = createFsOps({
      rename: async (...args) => {
        calls += 1;
        // The manifest rename is the last step of staging.
        if (String(args[0]).endsWith('import-manifest.json.tmp')) throw enospc();
        return realRename(...args);
      },
    });
    await expect(importFromDirect(baseOpts(src, { fsOps }))).rejects.toMatchObject({ code: 'disk_full' });
    expect(calls).toBeGreaterThan(0);
    expect(stages()).toEqual([]);
    expect(listing(src)).toEqual(before);
    expect(noteBodies(getDb())).toEqual([]);
  });
});

describe('a live or leftover source stays consistent and untouched', () => {
  it('a running direct Burrow (open WAL connection) is copied consistently and its files are not changed', async () => {
    const { dir: src, db } = makeSource({ notes: ['live-1', 'live-2'], keepOpen: true });
    const before = listing(src);
    expect(fs.existsSync(path.join(src, 'burrow.db-shm'))).toBe(true);
    const result = await importFromDirect(baseOpts(src));
    expect(result.status).toBe('staged');
    expect(listing(src)).toEqual(before);
    // The writer keeps working and sees everything.
    addNote(db, 'after');
    expect(noteBodies(db)).toEqual(['after', 'live-1', 'live-2']);
    closeDb();
    await reconcileDirectImport({});
    expect(noteBodies(getDb())).toEqual(['live-1', 'live-2']);
    expect(getDb().prepare('PRAGMA integrity_check').get().integrity_check).toBe('ok');
  });

  it('a write during the copy forces a retry and the copy includes it, consistent', async () => {
    const { dir: src, db } = makeSource({ notes: ['first'], keepOpen: true });
    let calls = 0;
    await importFromDirect(
      baseOpts(src, {
        hooks: {
          afterCopy: () => {
            calls += 1;
            if (calls === 1) addNote(db, 'written-during-the-copy');
          },
        },
      }),
    );
    expect(calls).toBe(2);
    closeDb();
    await reconcileDirectImport({});
    expect(noteBodies(getDb())).toEqual(['first', 'written-during-the-copy']);
    expect(getDb().prepare('PRAGMA integrity_check').get().integrity_check).toBe('ok');
  });

  it('a source that never stops changing is refused as busy, nothing staged', async () => {
    const { dir: src, db } = makeSource({ notes: ['x'], keepOpen: true });
    let calls = 0;
    await expect(
      importFromDirect(baseOpts(src, { attempts: 3, hooks: { afterCopy: () => addNote(db, `m${(calls += 1)}`) } })),
    ).rejects.toMatchObject({ code: 'import_source_busy', status: 409 });
    expect(calls).toBe(3);
    expect(stages()).toEqual([]);
  });
});

describe('the swap at startup', () => {
  async function stagedImport(opts) {
    const made = makeSource(opts);
    await importFromDirect(baseOpts(made.dir));
    closeDb();
    return made;
  }

  it('an incomplete staging folder (no manifest) is our own leftover and is removed', async () => {
    const leftover = path.join(dataDir(), `.import-${'a'.repeat(16)}`);
    fs.mkdirSync(leftover);
    fs.writeFileSync(path.join(leftover, 'burrow.db'), 'partial');
    closeDb();
    expect(await reconcileDirectImport({})).toEqual({ result: 'discarded', reason: 'incomplete' });
    expect(stages()).toEqual([]);
  });

  it('a staged file that no longer verifies cancels the import: nothing is swapped', async () => {
    await stagedImport({ notes: ['a'] });
    const stage = path.join(dataDir(), stages()[0]);
    fs.appendFileSync(path.join(stage, 'secrets.key'), 'tampered');
    const liveBefore = listing(dataDir());
    const result = await reconcileDirectImport({});
    expect(result).toEqual({ result: 'discarded', reason: 'unverified' });
    expect(stages()).toEqual([]);
    const after = listing(dataDir());
    for (const name of Object.keys(liveBefore)) {
      if (!name.endsWith('/') && !name.startsWith('.import-')) expect(after[name]).toBe(liveBefore[name]);
    }
    expect(noteBodies(getDb())).toEqual([]);
  });

  it('data added to this Burrow after the import was prepared cancels it, and is kept', async () => {
    const made = makeSource({ notes: ['theirs'] });
    await importFromDirect(baseOpts(made.dir));
    addNote(getDb(), 'mine, added meanwhile');
    closeDb();
    expect(await reconcileDirectImport({})).toEqual({ result: 'discarded', reason: 'target_has_data' });
    expect(stages()).toEqual([]);
    expect(noteBodies(getDb())).toEqual(['mine, added meanwhile']);
  });

  it('a crash in the middle of the swap resumes at the next start and ends in the same state', async () => {
    const made = await stagedImport({ notes: ['resume-me'] });
    let moved = 0;
    await expect(
      reconcileDirectImport({
        hooks: {
          afterMove: () => {
            moved += 1;
            if (moved === 2) throw Object.assign(new Error('simulated crash'), { code: 'simulated_crash' });
          },
        },
      }),
    ).rejects.toMatchObject({ code: 'simulated_crash' });
    expect(stages()).toHaveLength(1);
    expect(await reconcileDirectImport({})).toEqual({ result: 'swapped' });
    expect(stages()).toEqual([]);
    expect(noteBodies(getDb())).toEqual(['resume-me']);
    expect(fs.readFileSync(path.join(dataDir(), 'secrets.key'), 'utf8')).toBe(fs.readFileSync(path.join(made.dir, 'secrets.key'), 'utf8'));
    // The empty files this Burrow made on its own start are kept aside, not deleted.
    const asideRoot = path.join(dataDir(), IMPORT_ASIDE_DIR);
    const [stamp] = fs.readdirSync(asideRoot);
    expect(fs.existsSync(path.join(asideRoot, stamp, 'burrow.db'))).toBe(true);
  });

  it('does nothing when there is no staged import', async () => {
    closeDb();
    expect(await reconcileDirectImport({})).toEqual({ result: 'none' });
  });

  it('waits behind an interrupted backup restore', async () => {
    await stagedImport({});
    fs.writeFileSync(path.join(dataDir(), 'restore-journal.json'), '{}');
    expect(await reconcileDirectImport({})).toEqual({ result: 'none' });
    expect(stages()).toHaveLength(1);
  });
});

describe('Erase all my data and the staged import', () => {
  it('removes a prepared import and the files moved aside, so erased data cannot come back at the next start', async () => {
    const made = makeSource({ notes: ['must-not-come-back'] });
    await importFromDirect(baseOpts(made.dir));
    expect(stages()).toHaveLength(1);
    await eraseAllData({});
    expect(stages()).toEqual([]);
    closeDb();
    expect(await reconcileDirectImport({})).toEqual({ result: 'none' });
    expect(noteBodies(getDb())).toEqual([]);
  });

  it('discardStagedImports removes every staging folder', async () => {
    const made = makeSource({});
    await importFromDirect(baseOpts(made.dir));
    await discardStagedImports({});
    expect(stages()).toEqual([]);
  });
});


// ---------------------------------------------------------------------------------------------------------------------
// Review fixes: pristine detection by content, a cancelled-by-visit import, the resumable swap, a fast startup check,
// never skipping or overwriting on the swap, the raw-copy guards.
// ---------------------------------------------------------------------------------------------------------------------

const putState = (db, key, value) =>
  db.prepare('INSERT OR REPLACE INTO app_state (key, value, updated_at) VALUES (?, ?, ?)').run(key, JSON.stringify(value), new Date().toISOString());
const dataApp = () => {
  const a = express();
  a.use(express.json());
  registerDataRoutes(a);
  return a;
};
const manifestOf = (stageDir) => JSON.parse(fs.readFileSync(path.join(stageDir, 'import-manifest.json'), 'utf8'));
const asideRoot = () => path.join(dataDir(), IMPORT_ASIDE_DIR);
const asideFiles = () => {
  if (!fs.existsSync(asideRoot())) return [];
  const out = [];
  for (const stamp of fs.readdirSync(asideRoot())) for (const name of fs.readdirSync(path.join(asideRoot(), stamp))) out.push(`${stamp}/${name}`);
  return out;
};

async function stagedImport(opts, importOpts = {}) {
  const made = makeSource(opts);
  await importFromDirect(baseOpts(made.dir, importOpts));
  closeDb();
  return made;
}

describe('isPristineDb: content, not counts (H1, H2)', () => {
  it('is true for a database nobody used, with the first-start records the app writes itself, and false after a note', () => {
    const db = getDb();
    expect(isPristineDb(db)).toBe(true);
    for (const key of ['license.trial', 'license.clock', 'license.trialNotices', 'directImport:notice', 'dataFolderWarning:seen']) putState(db, key, { synthetic: true });
    putState(db, 'profile', { displayName: null, onboardedAt: '2026-01-01T00:00:00.000Z' });
    expect(isPristineDb(db)).toBe(true);
    addNote(db, 'x');
    expect(isPristineDb(db)).toBe(false);
    expect(select('notes')).toHaveLength(1);
  });

  it.each([
    ['budget:targets', { food: 100 }],
    ['budget:payees', ['Acme']],
    ['budget:spent', { food: 12 }],
    ['budget:structure', { groups: [] }],
    ['budget:defaults', { food: 50 }],
    ['pos:focus', { work: 25 }],
    ['pos:homeLayout', ['a', 'b']],
    ['license.activation', { synthetic: true }],
    ['theme', 'dark'],
    ['network.optIn', { weather: true }],
    ['some.future.key', 1],
  ])('app_state key %s is the user\'s data: not pristine', (key, value) => {
    const db = getDb();
    expect(isPristineDb(db)).toBe(true);
    putState(db, key, value);
    expect(isPristineDb(db)).toBe(false);
  });

  it('the legacy workspace key (1.2 pre-release view state) is pristine for budget or journal, used for any other value; mode still counts as used', () => {
    const db = getDb();
    putState(db, 'workspace', 'journal');
    expect(isPristineDb(db)).toBe(true);
    putState(db, 'workspace', 'budget');
    expect(isPristineDb(db)).toBe(true);
    putState(db, 'profile', { displayName: null, onboardedAt: '2026-01-01T00:00:00.000Z' });
    expect(isPristineDb(db)).toBe(true);
    putState(db, 'workspace', 'other');
    expect(isPristineDb(db)).toBe(false);
    putState(db, 'workspace', 'journal');
    expect(isPristineDb(db)).toBe(true);
    putState(db, 'mode', 'work');
    expect(isPristineDb(db)).toBe(false);
  });

  it('the backupsShowUserData app_state allowance follows AUTO_STATE_KEYS.size', () => {
    const dir = path.join(dataDir(), 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const fresh = getDb().prepare('SELECT COUNT(*) AS n FROM app_state').get().n;
    const writeMeta = (appState) =>
      fs.writeFileSync(path.join(dir, 'burrow-20260101T000000Z-auto-abc123.meta.json'), JSON.stringify({ kind: 'auto', status: 'ok', rowCounts: { app_state: appState } }));
    writeMeta(AUTO_STATE_KEYS.size + fresh);
    expect(backupsShowUserData(dataDir())).toBe(false);
    writeMeta(AUTO_STATE_KEYS.size + fresh + 1);
    expect(backupsShowUserData(dataDir())).toBe(true);
  });

  it('a profile with a display name is the user\'s data; one with only the onboarded flag is not', () => {
    const db = getDb();
    putState(db, 'profile', { displayName: 'Sam', onboardedAt: '2026-01-01T00:00:00.000Z' });
    expect(isPristineDb(db)).toBe(false);
    putState(db, 'profile', { displayName: null, onboardedAt: '2026-01-01T00:00:00.000Z', extra: 1 });
    expect(isPristineDb(db)).toBe(false);
  });

  it('a legacy license-activation.json left by an older version is not use: nothing reads it any more', async () => {
    const db = getDb();
    fs.writeFileSync(path.join(dataDir(), 'license-activation.json'), '{}');
    expect(isPristineDb(db)).toBe(true);
    // And with no burrow.db at all the target is still empty.
    closeDb();
    fs.rmSync(path.join(dataDir(), 'burrow.db'), { force: true });
    fs.rmSync(path.join(dataDir(), 'burrow.db-wal'), { force: true });
    fs.rmSync(path.join(dataDir(), 'burrow.db-shm'), { force: true });
    const status = await getDirectImportStatus({ source: sourceOf(makeSource().dir), offered: true, getDbImpl: () => { throw new Error('none'); } });
    expect(status).toMatchObject({ canOffer: true });
  });

  it('a saved key (app_secrets) means used', () => {
    const db = getDb();
    db.prepare('INSERT INTO app_secrets (name, ciphertext, iv, auth_tag, last4, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('SYNTHETIC_KEY', 'c', 'i', 't', '1234', new Date().toISOString());
    expect(isPristineDb(db)).toBe(false);
  });

  it('the default to-do columns alone are pristine; a deleted default plus a new one, an edit or an extra column are not', () => {
    const db = getDb();
    const seed = () => insertMany('todo_columns', DEFAULT_TODO_COLUMNS.map(({ name, order, color }) => ({ name, order, color })), { db });
    seed();
    expect(isPristineDb(db)).toBe(true);
    // Swapped: one default gone, another column added (the row count is unchanged).
    db.prepare('DELETE FROM todo_columns WHERE name = ?').run('Backlog');
    insertMany('todo_columns', [{ name: 'Ideas', order: 0, color: 'gray' }], { db });
    expect(db.prepare('SELECT COUNT(*) AS n FROM todo_columns').get().n).toBe(3);
    expect(isPristineDb(db)).toBe(false);
    db.exec('DELETE FROM todo_columns');
    seed();
    db.prepare('UPDATE todo_columns SET color = ? WHERE name = ?').run('red', 'Done');
    expect(isPristineDb(db)).toBe(false);
    db.exec('DELETE FROM todo_columns');
    seed();
    insertMany('todo_columns', [{ name: 'Extra', order: 3, color: 'gray' }], { db });
    expect(isPristineDb(db)).toBe(false);
    db.exec('DELETE FROM todo_columns');
    seed();
    db.prepare('UPDATE todo_columns SET "order" = 7 WHERE name = ?').run('In Progress');
    expect(isPristineDb(db)).toBe(false);
  });

  it('budget settings written before the import was prepared refuse it (409), and after it cancel it, keeping them', async () => {
    const { dir: src } = makeSource();
    putState(getDb(), 'budget:targets', { food: 100 });
    await expect(importFromDirect(baseOpts(src))).rejects.toMatchObject({ code: 'import_target_not_empty' });
    expect(stages()).toEqual([]);

    wipeLive();
    await importFromDirect(baseOpts(src));
    putState(getDb(), 'pos:focus', { work: 25 });
    closeDb();
    expect(await reconcileDirectImport({})).toEqual({ result: 'discarded', reason: 'target_has_data' });
    expect(stages()).toEqual([]);
    expect(getDb().prepare('SELECT value FROM app_state WHERE key = ?').get('pos:focus')).toBeTruthy();
  });

  it('a legacy workspace row written after staging does not cancel the import; an invalid one does', async () => {
    await stagedImport({ notes: ['theirs'] });
    putState(getDb(), 'workspace', 'budget');
    closeDb();
    expect(await reconcileDirectImport({})).toEqual({ result: 'swapped' });
    expect(noteBodies(getDb())).toEqual(['theirs']);

    wipeLive();
    await stagedImport({ notes: ['theirs'] });
    putState(getDb(), 'workspace', 'other');
    closeDb();
    expect(await reconcileDirectImport({})).toEqual({ result: 'discarded', reason: 'target_has_data' });
    expect(stages()).toEqual([]);
  });

  it('a legacy license file added after the import was prepared does not cancel it and is left alone', async () => {
    await stagedImport({});
    fs.writeFileSync(path.join(dataDir(), 'license-activation.json'), '{}');
    expect(await reconcileDirectImport({})).toEqual({ result: 'swapped' });
    expect(fs.readFileSync(path.join(dataDir(), 'license-activation.json'), 'utf8')).toBe('{}');
  });
});

function wipeLive() {
  closeDb();
  for (const name of fs.readdirSync(dataDir()).filter((n) => n !== DATA_MARKER_FILE)) fs.rmSync(path.join(dataDir(), name), { recursive: true, force: true });
  getDb();
}

describe('visiting Todos does not cancel a pending import (H2)', () => {
  it('GET /api/todo-columns seeds the defaults; the stage is still swapped in at the next start', async () => {
    const made = makeSource({ notes: ['from-direct'] });
    await importFromDirect(baseOpts(made.dir));
    const res = await request(dataApp()).get('/api/todo-columns');
    expect(res.body.columns.map((c) => c.name)).toEqual(['Backlog', 'In Progress', 'Done']);
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM todo_columns').get().n).toBe(3);
    closeDb();
    expect(await reconcileDirectImport({})).toEqual({ result: 'swapped' });
    expect(noteBodies(getDb())).toEqual(['from-direct']);
  });

  it('visiting Todos before the import does not stop the import either (status offers it, POST stages it)', async () => {
    const made = makeSource({});
    await request(dataApp()).get('/api/todo-columns');
    expect(await getDirectImportStatus({ source: sourceOf(made.dir), offered: true })).toMatchObject({ canOffer: true });
    await expect(importFromDirect(baseOpts(made.dir))).resolves.toMatchObject({ status: 'staged' });
  });

  it('adding a column of the user\'s own does count as data', async () => {
    await request(dataApp()).get('/api/todo-columns');
    await request(dataApp()).post('/api/todo-columns').send({ name: 'Mine' });
    expect(isPristineDb(getDb())).toBe(false);
  });
});

describe('the swap never gives up on a doubt (H3)', () => {
  it('an unreadable manifest at resume refuses to start and keeps the whole stage', async () => {
    await stagedImport({ notes: ['keep-me'] });
    let moved = 0;
    await expect(
      reconcileDirectImport({
        hooks: {
          afterMove: () => {
            moved += 1;
            if (moved === 2) throw Object.assign(new Error('simulated crash'), { code: 'simulated_crash' });
          },
        },
      }),
    ).rejects.toMatchObject({ code: 'simulated_crash' });
    const stage = path.join(dataDir(), stages()[0]);
    const before = listing(stage);
    fs.writeFileSync(path.join(stage, 'import-manifest.json'), '{ not json');
    await expect(reconcileDirectImport({})).rejects.toMatchObject({ code: 'import_manifest_unreadable' });
    // A manifest that parses but is not ours is refused the same way; a deleted one too.
    fs.writeFileSync(path.join(stage, 'import-manifest.json'), '{"format":"other"}');
    await expect(reconcileDirectImport({})).rejects.toMatchObject({ code: 'import_manifest_unreadable' });
    fs.rmSync(path.join(stage, 'import-manifest.json'));
    await expect(reconcileDirectImport({})).rejects.toMatchObject({ code: 'import_manifest_unreadable' });
    expect(stages()).toHaveLength(1);
    const after = listing(stage);
    for (const name of Object.keys(before)) if (name !== 'import-manifest.json') expect(after[name]).toBe(before[name]);
    expect(fs.existsSync(path.join(stage, 'burrow.db'))).toBe(true);
  });

  it('a crash after the target burrow.db was moved aside and before the staged one was renamed in resumes to the same end', async () => {
    const made = await stagedImport({ notes: ['resume-db'] });
    const realRename = createFsOps().rename;
    let armed = true;
    const fsOps = createFsOps({
      rename: async (from, to) => {
        if (armed && String(to) === path.join(dataDir(), 'burrow.db') && String(from).includes('.import-')) {
          armed = false;
          throw Object.assign(new Error('simulated crash'), { code: 'simulated_crash' });
        }
        return realRename(from, to);
      },
    });
    await expect(reconcileDirectImport({ fsOps })).rejects.toMatchObject({ code: 'simulated_crash' });
    // The window: this Burrow's own database is aside, the imported one is still staged, nothing live.
    expect(fs.existsSync(path.join(dataDir(), 'burrow.db'))).toBe(false);
    expect(stages()).toHaveLength(1);
    expect(await reconcileDirectImport({})).toEqual({ result: 'swapped' });
    expect(stages()).toEqual([]);
    expect(noteBodies(getDb())).toEqual(['resume-db']);
    expect(getDb().prepare('PRAGMA integrity_check').get().integrity_check).toBe('ok');
    expect(fs.readFileSync(path.join(dataDir(), 'secrets.key'), 'utf8')).toBe(fs.readFileSync(path.join(made.dir, 'secrets.key'), 'utf8'));
    expect(asideFiles().some((n) => n.endsWith('/burrow.db'))).toBe(true);
  });

  it('keeps the stage and refuses when a manifest entry is not in place after the swap', async () => {
    await stagedImport({ notes: ['x'] });
    const realRename = createFsOps().rename;
    // The backups folder "moves" without effect: the check after the loop must notice and keep the stage.
    const fsOps = createFsOps({
      rename: async (from, to) => {
        if (String(to) === path.join(dataDir(), 'backups') && String(from).includes('.import-')) return undefined;
        return realRename(from, to);
      },
    });
    await expect(reconcileDirectImport({ fsOps })).rejects.toMatchObject({ code: 'import_swap_incomplete' });
    expect(stages()).toHaveLength(1);
  });

  it('a finished stage is gone, and a leftover .done folder is swept at the next start', async () => {
    await stagedImport({});
    await reconcileDirectImport({});
    expect(fs.readdirSync(dataDir()).filter((n) => n.startsWith('.import-'))).toEqual([]);
    const leftover = path.join(dataDir(), `.import-${'b'.repeat(16)}.done`);
    fs.mkdirSync(leftover);
    fs.writeFileSync(path.join(leftover, 'import-swapping'), 'x');
    closeDb();
    expect(await reconcileDirectImport({})).toEqual({ result: 'none' });
    expect(fs.existsSync(leftover)).toBe(false);
  });
});

describe('a fast startup check (H4)', () => {
  it('hashes only burrow.db and secrets.key; backups are checked by size', async () => {
    const { dir: src } = makeSource({
      extra: (dir) => {
        // A large synthetic backup (80 MB of zeros) and a few small ones.
        fs.writeFileSync(path.join(dir, 'backups', `burrow-${BACKUP_ID}.db`), Buffer.alloc(80 * 1024 * 1024, 1));
        for (const n of ['a1b2c3', 'a1b2c4']) {
          fs.writeFileSync(path.join(dir, 'backups', `burrow-20260102T000000Z-auto-${n}.export.zip`), Buffer.alloc(1024, 2));
        }
      },
    });
    await importFromDirect(baseOpts(src));
    closeDb();
    const hashed = [];
    const opened = [];
    const realOpen = createFsOps().open;
    const fsOps = createFsOps({
      open: (file, ...rest) => {
        opened.push(String(file));
        return realOpen(file, ...rest);
      },
    });
    const { sha256File } = await import('../backup/snapshot.js');
    const hashFile = (file, ops) => {
      hashed.push(path.basename(String(file)));
      return sha256File(file, ops);
    };
    expect(await reconcileDirectImport({ fsOps, hashFile })).toEqual({ result: 'swapped' });
    expect(hashed.sort()).toEqual(['burrow.db', 'secrets.key']);
    expect(opened.filter((f) => f.includes(`${path.sep}backups${path.sep}`))).toEqual([]);
    expect(fs.statSync(path.join(dataDir(), 'backups', `burrow-${BACKUP_ID}.db`)).size).toBe(80 * 1024 * 1024);
  });

  it('a backup file with the wrong size cancels the import; the manifest records the stage-time integrity check', async () => {
    await stagedImport({});
    const stage = path.join(dataDir(), stages()[0]);
    expect(manifestOf(stage).integrity).toBe('ok');
    fs.appendFileSync(path.join(stage, 'backups', `burrow-${BACKUP_ID}.db`), 'x');
    expect(await reconcileDirectImport({})).toEqual({ result: 'discarded', reason: 'unverified' });
  });
});

describe('manifest validation (L2)', () => {
  it.each([
    ['createdAt that is not a timestamp', (m) => ({ ...m, createdAt: '..\\..\\evil' })],
    ['createdAt that is not ISO', (m) => ({ ...m, createdAt: 'Tue Jan 01 2030' })],
    ['a missing createdAt', (m) => ({ ...m, createdAt: undefined })],
    ['no integrity record', (m) => ({ ...m, integrity: undefined })],
    ['a file name the importer never writes', (m) => ({ ...m, files: [...m.files, { rel: 'evil.dll', size: 1, sha256: 'a'.repeat(64) }] })],
    ['a repeated file', (m) => ({ ...m, files: [...m.files, m.files[0]] })],
    ['a hash that is not sha-256', (m) => ({ ...m, files: m.files.map((f) => ({ ...f, sha256: 'zz' })) })],
  ])('cancels the import for %s', async (_label, mutate) => {
    await stagedImport({});
    const file = path.join(dataDir(), stages()[0], 'import-manifest.json');
    fs.writeFileSync(file, JSON.stringify(mutate(JSON.parse(fs.readFileSync(file, 'utf8')))));
    expect(await reconcileDirectImport({})).toEqual({ result: 'discarded', reason: 'unverified' });
    expect(stages()).toEqual([]);
  });
});

describe('every data file of the target moves aside before the imported key goes in (M1)', () => {
  it('the targets own secrets.key goes aside, never overwritten, and the sources key is renamed in', async () => {
    const made = makeSource();
    await importFromDirect(baseOpts(made.dir));
    closeDb();
    fs.writeFileSync(path.join(dataDir(), 'secrets.key'), 'target-key');
    const order = [];
    const realRename = createFsOps().rename;
    const fsOps = createFsOps({
      rename: async (from, to) => {
        order.push(`${path.basename(String(from))}->${path.basename(path.dirname(String(to)))}`);
        return realRename(from, to);
      },
    });
    expect(await reconcileDirectImport({ fsOps })).toEqual({ result: 'swapped' });
    const keyIn = order.indexOf('secrets.key->' + path.basename(dataDir()));
    expect(keyIn).toBeGreaterThan(-1);
    const keyAside = order.findIndex((o) => o.startsWith('secrets.key->') && !o.endsWith(`->${path.basename(dataDir())}`));
    expect(keyAside).toBeGreaterThan(-1);
    expect(keyAside).toBeLessThan(keyIn);
    const aside = asideFiles().map((n) => n.split('/')[1]);
    expect(aside).toEqual(expect.arrayContaining(['secrets.key']));
    expect(fs.readFileSync(path.join(dataDir(), 'secrets.key'), 'utf8')).toBe(fs.readFileSync(path.join(made.dir, 'secrets.key'), 'utf8'));
  });
});

describe('the swap never skips or overwrites (M2)', () => {
  it('an aside name that is taken gets a numbered name instead of being skipped', async () => {
    const made = await stagedImport({});
    fs.writeFileSync(path.join(dataDir(), 'secrets.key'), 'target-key');
    const stamp = manifestOf(path.join(dataDir(), stages()[0])).createdAt.replace(/[-:.]/g, '').slice(0, 15);
    fs.mkdirSync(path.join(asideRoot(), stamp), { recursive: true });
    fs.writeFileSync(path.join(asideRoot(), stamp, 'secrets.key'), 'an earlier file');
    fs.writeFileSync(path.join(asideRoot(), stamp, 'burrow.db'), 'an earlier database');
    expect(await reconcileDirectImport({})).toEqual({ result: 'swapped' });
    const dir = path.join(asideRoot(), stamp);
    expect(fs.readFileSync(path.join(dir, 'secrets.key'), 'utf8')).toBe('an earlier file');
    expect(fs.readFileSync(path.join(dir, 'secrets.key-1'), 'utf8')).toBe('target-key');
    expect(fs.readFileSync(path.join(dir, 'burrow.db'), 'utf8')).toBe('an earlier database');
    expect(fs.existsSync(path.join(dir, 'burrow.db-1'))).toBe(true);
    expect(fs.readFileSync(path.join(dataDir(), 'secrets.key'), 'utf8')).toBe(fs.readFileSync(path.join(made.dir, 'secrets.key'), 'utf8'));
  });

  it('fails closed instead of overwriting a live file that is still there when the staged one is renamed in', async () => {
    await stagedImport({});
    const key = path.join(dataDir(), 'secrets.key');
    fs.writeFileSync(key, 'live key');
    const realRename = createFsOps().rename;
    // The move-aside of the live key "succeeds" without moving it, so the rename-in finds it there.
    const fsOps = createFsOps({
      rename: async (from, to) => {
        if (String(from) === key && String(to).includes(IMPORT_ASIDE_DIR)) return undefined;
        return realRename(from, to);
      },
    });
    await expect(reconcileDirectImport({ fsOps })).rejects.toMatchObject({ code: 'import_swap_conflict' });
    expect(fs.readFileSync(key, 'utf8')).toBe('live key');
    expect(stages()).toHaveLength(1);
    expect(fs.existsSync(path.join(dataDir(), stages()[0], 'secrets.key'))).toBe(true);
  });

  it('a started swap next to an interrupted backup restore refuses to start with a clear reason; a stage that has not started waits', async () => {
    await stagedImport({});
    let moved = 0;
    await expect(
      reconcileDirectImport({
        hooks: {
          afterMove: () => {
            moved += 1;
            if (moved === 1) throw Object.assign(new Error('simulated crash'), { code: 'simulated_crash' });
          },
        },
      }),
    ).rejects.toMatchObject({ code: 'simulated_crash' });
    fs.writeFileSync(path.join(dataDir(), 'restore-journal.json'), '{}');
    await expect(reconcileDirectImport({})).rejects.toMatchObject({ code: 'import_restore_conflict' });
    expect(stages()).toHaveLength(1);
    fs.rmSync(path.join(dataDir(), 'restore-journal.json'));
    expect(await reconcileDirectImport({})).toEqual({ result: 'swapped' });
  });
});

describe('the raw copy guards (M3, L4)', () => {
  it('refuses when the direct Burrow starts while the copy runs, and leaves nothing staged', async () => {
    const { dir: src } = makeSource();
    let started = false;
    await expect(
      importFromDirect(baseOpts(src, { detectRunning: async () => (started ? 'yes' : 'no'), hooks: { afterCopy: () => (started = true) } })),
    ).rejects.toMatchObject({ code: 'import_direct_running' });
    started = false;
    let unknown = false;
    await expect(
      importFromDirect(baseOpts(src, { detectRunning: async () => (unknown ? 'unknown' : 'no'), hooks: { afterCopy: () => (unknown = true) } })),
    ).rejects.toMatchObject({ code: 'import_running_unknown' });
    expect(stages()).toEqual([]);
  });

  it('a source change that keeps size, time and inode is caught by the second read of the source', async () => {
    const { dir: src } = makeSource({ notes: ['one', 'two'] });
    const real = createFsOps();
    const seen = new Map();
    const frozen = createFsOps({
      lstat: async (file) => {
        const key = String(file);
        if (!key.startsWith(src)) return real.lstat(file);
        if (!seen.has(key)) seen.set(key, await real.lstat(file));
        return seen.get(key);
      },
    });
    const before = listing(src);
    let calls = 0;
    await expect(
      importFromDirect(
        baseOpts(src, {
          fsOps: frozen,
          attempts: 3,
          hooks: {
            afterCopy: () => {
              calls += 1;
              const fd = fs.openSync(path.join(src, 'burrow.db'), 'r+');
              try {
                const buf = Buffer.alloc(1);
                fs.readSync(fd, buf, 0, 1, 3000);
                buf[0] ^= 0xff;
                fs.writeSync(fd, buf, 0, 1, 3000);
              } finally {
                fs.closeSync(fd);
              }
            },
          },
        }),
      ),
    ).rejects.toMatchObject({ code: 'import_source_busy' });
    expect(calls).toBe(3);
    expect(stages()).toEqual([]);
    expect(listing(src)).not.toEqual(before);
  });

  it('a symbolic link in place of burrow.db is refused (L4)', async () => {
    const { dir: src } = makeSource();
    const real = createFsOps();
    const fsOps = createFsOps({
      lstat: async (file) => {
        const st = await real.lstat(file);
        if (String(file) === path.join(src, 'burrow.db')) return Object.assign(Object.create(st), { isSymbolicLink: () => true });
        return st;
      },
    });
    await expect(importFromDirect(baseOpts(src, { fsOps }))).rejects.toMatchObject({ code: 'import_source_invalid' });
    expect(stages()).toEqual([]);
  });
});

describe('WAL recovery of the private copy runs in the backup worker (M5)', () => {
  afterEach(() => __setWorkerFactoryForTests(null));

  /** A real worker whose messages are recorded. */
  function recordingFactory(seen) {
    return ({ env }) => {
      const worker = new Worker(new URL('../backup/worker/backupWorker.js', import.meta.url), { env });
      const post = worker.postMessage.bind(worker);
      worker.postMessage = (msg, ...rest) => {
        if (msg && typeof msg === 'object' && 'op' in msg) seen.push({ op: msg.op, settle: msg.payload?.settle });
        return post(msg, ...rest);
      };
      return worker;
    };
  }

  function crashedSource() {
    const live = tmp('live');
    const wdb = openDb({ filename: path.join(live, 'burrow.db') });
    open.push(wdb);
    wdb.exec('PRAGMA wal_autocheckpoint = 0');
    addNote(wdb, 'checkpointed');
    wdb.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    addNote(wdb, 'wal-only');
    const src = tmp('crashed');
    fs.copyFileSync(path.join(live, 'burrow.db'), path.join(src, 'burrow.db'));
    fs.copyFileSync(path.join(live, 'burrow.db-wal'), path.join(src, 'burrow.db-wal'));
    closeAll();
    loadOrCreateKeyFile({ dir: src });
    return src;
  }

  it('settles and inspects in one worker operation (inspectFile with settle)', async () => {
    const seen = [];
    __setWorkerFactoryForTests(recordingFactory(seen));
    await importFromDirect(baseOpts(crashedSource()));
    expect(seen.find((m) => m.op === 'inspectFile')).toMatchObject({ settle: true });
    closeDb();
    await reconcileDirectImport({});
    expect(noteBodies(getDb())).toEqual(['checkpointed', 'wal-only']);
  });

  it('falls back to the main thread only when no worker can start', async () => {
    __setWorkerFactoryForTests(() => {
      throw new Error('no workers here');
    });
    await importFromDirect(baseOpts(crashedSource()));
    closeDb();
    await reconcileDirectImport({});
    expect(noteBodies(getDb())).toEqual(['checkpointed', 'wal-only']);
  });

  it('a copy SQLite cannot settle is refused as an unreadable source', async () => {
    const src = tmp('torn');
    fs.writeFileSync(path.join(src, 'burrow.db'), Buffer.alloc(8192, 9));
    fs.writeFileSync(path.join(src, 'secrets.key'), `${crypto.randomBytes(32).toString('base64')}\n`);
    await expect(importFromDirect(baseOpts(src))).rejects.toMatchObject({ code: 'import_source_invalid' });
  });
});

describe('checks are repeated inside the lock (L1)', () => {
  const fakeCompleteStage = () => {
    const dir = path.join(dataDir(), `.import-${'c'.repeat(16)}`);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'import-manifest.json'), '{}');
  };

  it('an import prepared by someone else while we waited for the lock is seen (import_pending)', async () => {
    const { dir: src } = makeSource();
    let calls = 0;
    await expect(
      importFromDirect(
        baseOpts(src, {
          detectRunning: async () => {
            calls += 1;
            if (calls === 1) fakeCompleteStage();
            return 'no';
          },
        }),
      ),
    ).rejects.toMatchObject({ code: 'import_pending' });
    expect(calls).toBe(1);
  });

  it('data added to this Burrow in that window is seen (import_target_not_empty)', async () => {
    const { dir: src } = makeSource();
    let calls = 0;
    await expect(
      importFromDirect(
        baseOpts(src, {
          detectRunning: async () => {
            calls += 1;
            if (calls === 1) addNote(getDb(), 'added in the window');
            return 'no';
          },
        }),
      ),
    ).rejects.toMatchObject({ code: 'import_target_not_empty' });
    expect(stages()).toEqual([]);
  });

  it('a source that disappears in that window is seen (import_source_not_found)', async () => {
    const { dir: src } = makeSource();
    let calls = 0;
    await expect(
      importFromDirect(
        baseOpts(src, {
          detectRunning: async () => {
            calls += 1;
            if (calls === 1) fs.rmSync(path.join(src, 'burrow.db'));
            return 'no';
          },
        }),
      ),
    ).rejects.toMatchObject({ code: 'import_source_not_found' });
  });
});

describe('a cancelled import is explained once (L3)', () => {
  it('recordCancelledImport writes an audit row and the note the status endpoint returns', async () => {
    const { dir: src } = makeSource();
    await recordCancelledImport('target_has_data', { now: new Date('2026-10-08T10:00:00.000Z') });
    expect(select('audit_log').some((r) => r.feature === 'data_import_cancelled' && r.status === 'error')).toBe(true);
    const status = await getDirectImportStatus({ source: sourceOf(src), offered: true });
    expect(status.cancelled).toEqual({ reason: 'target_has_data', at: '2026-10-08T10:00:00.000Z' });
    // The note is a first-start record, so it alone never makes the target "used".
    expect(isPristineDb(getDb())).toBe(true);
    await recordCancelledImport('nonsense');
    expect(select('audit_log').filter((r) => r.feature === 'data_import_cancelled')).toHaveLength(1);
  });

  it('the status carries no note when nothing was cancelled', async () => {
    const { dir: src } = makeSource();
    expect((await getDirectImportStatus({ source: sourceOf(src), offered: true })).cancelled).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Re-review fixes: a finished swap whose stage could not be closed, backups never hidden, transient verify errors.
// ---------------------------------------------------------------------------------------------------------------------

const AUTO_ID = '20260102T000000Z-auto-aaaaaa';
const fastSleep = async () => {};
const writeMeta = (id, extra = {}) =>
  fs.writeFileSync(
    path.join(dataDir(), 'backups', `burrow-${id}.meta.json`),
    JSON.stringify({ format: 'burrow-backup', id, status: 'verified', kind: 'auto', createdAt: '2026-01-02T00:00:00.000Z', rowCounts: {}, totalRows: 0, ...extra }),
  );
const targetBackup = (id, bytes, extra) => {
  fs.mkdirSync(path.join(dataDir(), 'backups'), { recursive: true });
  fs.writeFileSync(path.join(dataDir(), 'backups', `burrow-${id}.db`), bytes);
  writeMeta(id, extra);
};
const donePathFails = (realRename) =>
  createFsOps({
    sleep: fastSleep,
    rename: async (from, to) => {
      if (String(to).endsWith('.done')) throw Object.assign(new Error('locked'), { code: 'EPERM' });
      return realRename(from, to);
    },
    rm: async () => {
      throw Object.assign(new Error('locked'), { code: 'EPERM' });
    },
  });

describe('a swap that is finished but whose stage cannot be closed (M1)', () => {
  it('a failed .done rename leaves the stage; a database used since and a new legacy license file survive the next start', async () => {
    const made = await stagedImport({ notes: ['imported'] });
    expect(await reconcileDirectImport({ fsOps: donePathFails(createFsOps().rename) })).toEqual({ result: 'swapped' });
    // The stage is still there whole (marker and manifest), nothing was wiped.
    expect(stages()).toHaveLength(1);
    const stage = path.join(dataDir(), stages()[0]);
    expect(fs.existsSync(path.join(stage, 'import-swapping'))).toBe(true);
    expect(fs.existsSync(path.join(stage, 'import-manifest.json'))).toBe(true);

    // The app runs: the database is used and a new file the import did not carry appears.
    addNote(getDb(), 'added after the swap');
    closeDb();
    const activation = path.join(dataDir(), 'license-activation.json');
    fs.writeFileSync(activation, '{"v":1,"new":true}\n');

    expect(await reconcileDirectImport({})).toEqual({ result: 'swapped' });
    expect(stages()).toEqual([]);
    expect(fs.readFileSync(activation, 'utf8')).toBe('{"v":1,"new":true}\n');
    expect(noteBodies(getDb())).toEqual(['added after the swap', 'imported']);
    expect(fs.readFileSync(path.join(dataDir(), 'secrets.key'), 'utf8')).toBe(fs.readFileSync(path.join(made.dir, 'secrets.key'), 'utf8'));
    // Nothing of the new activation file went aside.
    expect(asideFiles().some((n) => n.endsWith('license-activation.json'))).toBe(false);
  });

  it('a crash after the key moved in resumes without moving a file that is not staged aside again', async () => {
    await stagedImport({ notes: ['k'] });
    await expect(
      reconcileDirectImport({
        hooks: {
          afterMove: (name) => {
            if (name === 'secrets.key') throw Object.assign(new Error('simulated crash'), { code: 'simulated_crash' });
          },
        },
      }),
    ).rejects.toMatchObject({ code: 'simulated_crash' });
    // A file the stage does not carry: after the key is in, it belongs to the imported Burrow.
    fs.writeFileSync(path.join(dataDir(), 'newer-file.txt'), 'newer');
    expect(await reconcileDirectImport({})).toEqual({ result: 'swapped' });
    expect(stages()).toEqual([]);
    expect(fs.existsSync(path.join(dataDir(), 'newer-file.txt'))).toBe(true);
  });

  it('a marker-only leftover (no manifest, nothing staged) finishes cleanly and touches nothing live', async () => {
    const leftover = path.join(dataDir(), `.import-${'c'.repeat(16)}`);
    fs.mkdirSync(leftover);
    fs.writeFileSync(path.join(leftover, 'import-swapping'), 'x');
    const liveBefore = listing(dataDir());
    closeDb();
    expect(await reconcileDirectImport({})).toEqual({ result: 'swapped' });
    expect(fs.readdirSync(dataDir()).filter((n) => n.startsWith('.import-'))).toEqual([]);
    const after = listing(dataDir());
    for (const [name, hash] of Object.entries(liveBefore)) if (!name.startsWith('.import-') && !name.startsWith('burrow.db')) expect(after[name]).toBe(hash);
  });

  it('staged data files with an unreadable manifest still refuse and keep everything', async () => {
    await stagedImport({ notes: ['x'] });
    const stage = path.join(dataDir(), stages()[0]);
    fs.writeFileSync(path.join(stage, 'import-swapping'), 'x');
    fs.rmSync(path.join(stage, 'import-manifest.json'));
    await expect(reconcileDirectImport({})).rejects.toMatchObject({ code: 'import_manifest_unreadable' });
    expect(fs.existsSync(path.join(stage, 'burrow.db'))).toBe(true);
    expect(stages()).toHaveLength(1);
  });

  it('a finished swap whose burrow.db is missing is not closed silently', async () => {
    await stagedImport({ notes: ['x'] });
    await reconcileDirectImport({ fsOps: donePathFails(createFsOps().rename) });
    fs.rmSync(path.join(dataDir(), 'burrow.db'), { force: true });
    await expect(reconcileDirectImport({})).rejects.toMatchObject({ code: 'import_swap_incomplete' });
  });
});

describe('the backups of this Burrow are never hidden (M2)', () => {
  it('manual, unreadable and non-empty backups are user data; the automatic ones of an unused database are not', () => {
    const db = getDb();
    expect(isPristineDb(db)).toBe(true);
    targetBackup(AUTO_ID, 'a');
    expect(isPristineDb(db)).toBe(true);
    // A failed backup says nothing.
    writeMeta('20260103T000000Z-auto-bbbbbb', { status: 'failed', rowCounts: { notes: 5 } });
    expect(isPristineDb(db)).toBe(true);
    // Rows above a fresh database.
    writeMeta('20260104T000000Z-auto-cccccc', { rowCounts: { notes: 3 } });
    expect(isPristineDb(db)).toBe(false);
    fs.rmSync(path.join(dataDir(), 'backups', 'burrow-20260104T000000Z-auto-cccccc.meta.json'));
    expect(isPristineDb(db)).toBe(true);
    // A manual backup (the user asked for it).
    writeMeta('20260105T000000Z-manual-dddddd', { kind: 'manual' });
    expect(isPristineDb(db)).toBe(false);
    fs.rmSync(path.join(dataDir(), 'backups', 'burrow-20260105T000000Z-manual-dddddd.meta.json'));
    // A meta that cannot be read.
    fs.writeFileSync(path.join(dataDir(), 'backups', 'burrow-20260106T000000Z-auto-eeeeee.meta.json'), '{ nope');
    expect(isPristineDb(db)).toBe(false);
  });

  it('a target that kept backups with data after Erase is not offered the import', async () => {
    const { dir: src } = makeSource({});
    targetBackup('20260110T000000Z-manual-ffffff', 'old data', { kind: 'manual', rowCounts: { notes: 9 } });
    expect(await getDirectImportStatus({ source: sourceOf(src), offered: true })).toMatchObject({ canOffer: false, reason: 'target_has_data' });
    await expect(importFromDirect(baseOpts(src))).rejects.toMatchObject({ code: 'import_target_not_empty' });
    expect(stages()).toEqual([]);
  });

  it('the staged backups land in backups/ and the target own go to import-aside; Erase keeps those unless asked', async () => {
    const made = makeSource({ notes: ['theirs'] });
    targetBackup(AUTO_ID, 'target own backup');
    // Same name as an imported backup, different bytes.
    targetBackup(BACKUP_ID, 'target file with a taken name');
    await importFromDirect(baseOpts(made.dir));
    closeDb();
    expect(await reconcileDirectImport({})).toEqual({ result: 'swapped' });
    const names = fs.readdirSync(path.join(dataDir(), 'backups'));
    expect(names.sort()).toEqual([`burrow-${BACKUP_ID}.db`, `burrow-${BACKUP_ID}.meta.json`]);
    // The imported file won the name; the target file is kept aside, not deleted.
    expect(fs.readFileSync(path.join(dataDir(), 'backups', `burrow-${BACKUP_ID}.db`))).toEqual(fs.readFileSync(path.join(made.dir, 'backups', `burrow-${BACKUP_ID}.db`)));
    const [stamp] = fs.readdirSync(asideRoot());
    expect(fs.readFileSync(path.join(asideRoot(), stamp, 'backups', `burrow-${BACKUP_ID}.db`), 'utf8')).toBe('target file with a taken name');
    expect(fs.readFileSync(path.join(asideRoot(), stamp, 'backups', `burrow-${AUTO_ID}.db`), 'utf8')).toBe('target own backup');
    expect(fs.existsSync(path.join(asideRoot(), stamp, 'backups', `burrow-${AUTO_ID}.meta.json`))).toBe(true);
    expect(stages()).toEqual([]);
    expect(noteBodies(getDb())).toEqual(['theirs']);

    await eraseAllData({});
    expect(fs.existsSync(path.join(asideRoot(), stamp, 'backups', `burrow-${BACKUP_ID}.db`))).toBe(true);
    expect(fs.existsSync(path.join(asideRoot(), stamp, 'burrow.db'))).toBe(false);
    await eraseAllData({ deleteBackups: true });
    expect(fs.existsSync(asideRoot())).toBe(false);
  });

  it('a crash in the middle of the move resumes: every staged backup ends up in backups/, none of them goes aside', async () => {
    const made = makeSource({});
    targetBackup(AUTO_ID, 'own');
    fs.writeFileSync(path.join(made.dir, 'backups', 'burrow-20260107T000000Z-manual-123456.db'), 'second');
    fs.writeFileSync(path.join(made.dir, 'backups', 'burrow-20260107T000000Z-manual-123456.meta.json'), '{"synthetic":true}\n');
    await importFromDirect(baseOpts(made.dir));
    closeDb();
    const realRename = createFsOps().rename;
    let armed = true;
    const fsOps = createFsOps({
      rename: async (from, to) => {
        if (armed && String(from).includes('.import-') && String(to).endsWith(`burrow-${BACKUP_ID}.meta.json`)) {
          armed = false;
          throw Object.assign(new Error('simulated crash'), { code: 'simulated_crash' });
        }
        return realRename(from, to);
      },
    });
    await expect(reconcileDirectImport({ fsOps })).rejects.toMatchObject({ code: 'simulated_crash' });
    expect(stages()).toHaveLength(1);
    expect(await reconcileDirectImport({})).toEqual({ result: 'swapped' });
    expect(fs.readdirSync(path.join(dataDir(), 'backups'))).toHaveLength(4);
    expect(stages()).toEqual([]);
    const [stamp] = fs.readdirSync(asideRoot());
    expect(fs.readdirSync(path.join(asideRoot(), stamp, 'backups')).sort()).toEqual([`burrow-${AUTO_ID}.db`, `burrow-${AUTO_ID}.meta.json`]);
  });
});

describe('a stage that cannot be read right now is kept (L1)', () => {
  it('a non-ENOENT stat error at startup verification answers none and keeps the stage; the next start swaps it', async () => {
    await stagedImport({ notes: ['kept'] });
    const realLstat = createFsOps().lstat;
    const broken = createFsOps({
      lstat: async (p) => {
        if (String(p).includes('.import-') && String(p).endsWith('secrets.key')) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
        return realLstat(p);
      },
    });
    const logs = [];
    expect(await reconcileDirectImport({ fsOps: broken, log: (m) => logs.push(m) })).toEqual({ result: 'none', reason: 'verify_unavailable' });
    expect(stages()).toHaveLength(1);
    expect(logs.join(' ')).toContain('checked again at the next start');
    expect(await reconcileDirectImport({})).toEqual({ result: 'swapped' });
    expect(noteBodies(getDb())).toEqual(['kept']);
  });

  it('a hash read error (not ENOENT) is transient too, a missing staged file still cancels', async () => {
    await stagedImport({ notes: ['kept'] });
    const hashFile = async () => {
      throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    };
    expect(await reconcileDirectImport({ hashFile })).toEqual({ result: 'none', reason: 'verify_unavailable' });
    expect(stages()).toHaveLength(1);
    fs.rmSync(path.join(dataDir(), stages()[0], 'secrets.key'));
    expect(await reconcileDirectImport({})).toEqual({ result: 'discarded', reason: 'unverified' });
    expect(stages()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Second review: transient errors are not "missing", the target backups go aside whole, per-id completeness.
// ---------------------------------------------------------------------------------------------------------------------

const ebusy = () => Object.assign(new Error('busy'), { code: 'EBUSY' });
const crash = () => Object.assign(new Error('simulated crash'), { code: 'simulated_crash' });
const markSwapping = () => fs.writeFileSync(path.join(dataDir(), stages()[0], 'import-swapping'), `${new Date().toISOString()}\n`);
const lstatFailing = (matches) => {
  const realLstat = createFsOps().lstat;
  return createFsOps({
    lstat: async (p) => {
      if (matches(String(p))) throw ebusy();
      return realLstat(p);
    },
  });
};
const inStage = (p, name) => p.includes('.import-') && p.endsWith(name);
const backupIdsOnDisk = () => {
  const ids = new Map();
  for (const name of fs.readdirSync(path.join(dataDir(), 'backups'))) {
    const m = /^burrow-(.+?)(\.db|\.export\.zip|\.meta\.json)$/.exec(name);
    if (!m) continue;
    ids.set(m[1], [...(ids.get(m[1]) ?? []), m[2]]);
  }
  return ids;
};
const expectEveryIdComplete = () => {
  for (const [id, exts] of backupIdsOnDisk()) {
    expect(exts.includes('.meta.json'), `${id} has data but no meta`).toBe(true);
    expect(exts.includes('.db') || exts.includes('.export.zip'), `${id} has meta but no data`).toBe(true);
  }
};

describe('a file that cannot be looked at is never read as missing (H1)', () => {
  it('burrow.db alone is left in the stage and cannot be looked at: startup refuses and keeps the stage, the next start finishes', async () => {
    const made = await stagedImport({ notes: ['must-survive'] });
    await expect(
      reconcileDirectImport({
        hooks: {
          afterMove: (name) => {
            if (name === 'backups') throw crash();
          },
        },
      }),
    ).rejects.toMatchObject({ code: 'simulated_crash' });
    const stageDir = path.join(dataDir(), stages()[0]);
    expect(fs.existsSync(path.join(stageDir, 'burrow.db'))).toBe(true);
    const error = await reconcileDirectImport({ fsOps: lstatFailing((p) => inStage(p, 'burrow.db')) }).catch((e) => e);
    expect(error).toMatchObject({ code: 'import_swap_transient' });
    expect(fs.existsSync(path.join(stageDir, 'burrow.db'))).toBe(true);
    expect(fs.existsSync(path.join(stageDir, 'import-manifest.json'))).toBe(true);
    expect(await reconcileDirectImport({})).toEqual({ result: 'swapped' });
    expect(noteBodies(getDb())).toEqual(['must-survive']);
    expect(fs.readFileSync(path.join(dataDir(), 'secrets.key'), 'utf8')).toBe(fs.readFileSync(path.join(made.dir, 'secrets.key'), 'utf8'));
  });

  it('secrets.key in the stage cannot be looked at after the marker: no step is skipped, the stage stays, nothing is swapped half way', async () => {
    const made = await stagedImport({ notes: ['with-key'] });
    markSwapping();
    const liveBefore = fs.readFileSync(path.join(dataDir(), 'burrow.db'));
    const error = await reconcileDirectImport({ fsOps: lstatFailing((p) => inStage(p, 'secrets.key')) }).catch((e) => e);
    expect(error).toMatchObject({ code: 'import_swap_transient' });
    expect(stages()).toHaveLength(1);
    const stageDir = path.join(dataDir(), stages()[0]);
    for (const name of ['secrets.key', 'burrow.db', 'import-manifest.json']) expect(fs.existsSync(path.join(stageDir, name))).toBe(true);
    expect(fs.readFileSync(path.join(dataDir(), 'burrow.db')).equals(liveBefore)).toBe(true);
    expect(await reconcileDirectImport({})).toEqual({ result: 'swapped' });
    expect(noteBodies(getDb())).toEqual(['with-key']);
    expect(fs.readFileSync(path.join(dataDir(), 'secrets.key'), 'utf8')).toBe(fs.readFileSync(path.join(made.dir, 'secrets.key'), 'utf8'));
  });

  it('a live file that cannot be looked at is not overwritten by the staged one', async () => {
    const made = await stagedImport({ notes: ['x'] });
    markSwapping();
    const live = path.join(dataDir(), 'secrets.key');
    fs.writeFileSync(live, 'live key of this Burrow');
    const error = await reconcileDirectImport({ fsOps: lstatFailing((p) => path.resolve(p) === path.resolve(live)) }).catch((e) => e);
    expect(error).toMatchObject({ code: 'import_swap_transient' });
    expect(fs.readFileSync(live, 'utf8')).toBe('live key of this Burrow');
    expect(fs.existsSync(path.join(dataDir(), stages()[0], 'secrets.key'))).toBe(true);
    expect(await reconcileDirectImport({})).toEqual({ result: 'swapped' });
    expect(fs.readFileSync(live, 'utf8')).toBe(fs.readFileSync(path.join(made.dir, 'secrets.key'), 'utf8'));
    const [stamp] = fs.readdirSync(asideRoot());
    expect(fs.readFileSync(path.join(asideRoot(), stamp, 'secrets.key'), 'utf8')).toBe('live key of this Burrow');
  });

  it('a backup name that cannot be looked at is not renamed over: the target file is safe in import-aside, the staged one stays staged', async () => {
    await stagedImport({ notes: ['x'] });
    markSwapping();
    targetBackup(BACKUP_ID, 'target bytes');
    const taken = path.join(dataDir(), 'backups', `burrow-${BACKUP_ID}.db`);
    const error = await reconcileDirectImport({ fsOps: lstatFailing((p) => path.resolve(p) === path.resolve(taken)) }).catch((e) => e);
    expect(error).toMatchObject({ code: 'import_swap_transient' });
    const [stamp] = fs.readdirSync(asideRoot());
    expect(fs.readFileSync(path.join(asideRoot(), stamp, 'backups', `burrow-${BACKUP_ID}.db`), 'utf8')).toBe('target bytes');
    expect(fs.existsSync(path.join(dataDir(), stages()[0], 'backups', `burrow-${BACKUP_ID}.db`))).toBe(true);
  });

  it('a key that does not match the manifest hash after the swap keeps the stage (size alone is not enough)', async () => {
    await stagedImport({ notes: ['x'] });
    const stageDir = path.join(dataDir(), stages()[0]);
    const keyBytes = fs.readFileSync(path.join(stageDir, 'secrets.key'));
    const realRename = createFsOps().rename;
    const fsOps = createFsOps({
      rename: async (from, to) => {
        await realRename(from, to);
        if (String(to).endsWith(`${path.sep}secrets.key`) && String(from).includes('.import-')) {
          const flipped = Buffer.from(keyBytes);
          flipped[0] ^= 0xff;
          fs.writeFileSync(to, flipped);
        }
      },
    });
    await expect(reconcileDirectImport({ fsOps })).rejects.toMatchObject({ code: 'import_swap_incomplete' });
    expect(stages()).toHaveLength(1);
  });

  it('a manifest entry still in the stage keeps it even when the live file looks right', async () => {
    await stagedImport({ notes: ['x'] });
    markSwapping();
    const stageDir = path.join(dataDir(), stages()[0]);
    const realRename = createFsOps().rename;
    // The rename of the secrets.key file "succeeds" but a copy stays behind in the stage.
    const fsOps = createFsOps({
      rename: async (from, to) => {
        if (String(from).includes('.import-') && String(from).endsWith('secrets.key')) {
          fs.copyFileSync(from, to);
          return;
        }
        return realRename(from, to);
      },
    });
    await expect(reconcileDirectImport({ fsOps })).rejects.toMatchObject({ code: 'import_swap_incomplete' });
    expect(fs.existsSync(path.join(stageDir, 'secrets.key'))).toBe(true);
  });
});

describe('the target own backups go aside whole, the imported ones land complete (M1, L1, L4)', () => {
  const importedId = (n) => `2026010${n}T000000Z-manual-00000${n}`;
  const sourceBackups = (dir) => {
    for (const n of [1, 2]) {
      fs.writeFileSync(path.join(dir, 'backups', `burrow-${importedId(n)}.db`), `imported ${n}`);
      fs.writeFileSync(path.join(dir, 'backups', `burrow-${importedId(n)}.meta.json`), JSON.stringify({ id: importedId(n), status: 'verified', kind: 'manual', createdAt: `2026-01-0${n}T00:00:00.000Z` }));
    }
  };

  it('retention after the import keeps the imported backups: the newer unused ones of the target do not take their slots', async () => {
    const made = makeSource({ extra: (dir) => sourceBackups(dir) });
    targetBackup(AUTO_ID, 'target own');
    targetBackup('20260103T000000Z-auto-bbbbbb', 'target own 2', { createdAt: '2026-01-03T00:00:00.000Z' });
    await importFromDirect(baseOpts(made.dir));
    closeDb();
    expect(await reconcileDirectImport({})).toEqual({ result: 'swapped' });
    const dir = path.join(dataDir(), 'backups');
    const metas = fs
      .readdirSync(dir)
      .filter((n) => n.endsWith('.meta.json'))
      .map((n) => JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')))
      .filter((m) => typeof m.createdAt === 'string' && m.id !== BACKUP_ID);
    expect(metas.map((m) => m.id).sort()).toEqual([importedId(1), importedId(2)]);
    const plan = planRetention(metas, { keepDaily: 7, keepWeekly: 0, keepMonthly: 0 }, new Date('2026-01-05T00:00:00.000Z'));
    expect(plan.remove).toEqual([]);
    const [stamp] = fs.readdirSync(asideRoot());
    expect(fs.readdirSync(path.join(asideRoot(), stamp, 'backups')).sort()).toEqual(
      [AUTO_ID, '20260103T000000Z-auto-bbbbbb'].flatMap((id) => [`burrow-${id}.db`, `burrow-${id}.meta.json`]).sort(),
    );
    expectEveryIdComplete();
  });

  it('half backups of the target (data without meta, meta without data) go aside together; no id in backups/ is half', async () => {
    const made = makeSource({ extra: (dir) => sourceBackups(dir) });
    fs.mkdirSync(path.join(dataDir(), 'backups'), { recursive: true });
    fs.writeFileSync(path.join(dataDir(), 'backups', `burrow-${BACKUP_ID}.db`), 'orphan data');
    writeMeta('20260105T000000Z-auto-cccccc');
    targetBackup(AUTO_ID, 'whole');
    await importFromDirect(baseOpts(made.dir));
    closeDb();
    expect(await reconcileDirectImport({})).toEqual({ result: 'swapped' });
    expectEveryIdComplete();
    expect([...backupIdsOnDisk().keys()].sort()).toEqual([BACKUP_ID, importedId(1), importedId(2)].sort());
    const [stamp] = fs.readdirSync(asideRoot());
    expect(fs.readFileSync(path.join(asideRoot(), stamp, 'backups', `burrow-${BACKUP_ID}.db`), 'utf8')).toBe('orphan data');
  });

  it('a crash between moving a target backup aside and renaming the staged one in resumes to a complete set', async () => {
    const made = makeSource({ extra: (dir) => sourceBackups(dir) });
    targetBackup(AUTO_ID, 'whole');
    await importFromDirect(baseOpts(made.dir));
    closeDb();
    const realRename = createFsOps().rename;
    let armed = true;
    const fsOps = createFsOps({
      rename: async (from, to) => {
        if (armed && String(from).includes('.import-') && String(to).includes(`${path.sep}backups${path.sep}`) && !String(to).includes(IMPORT_ASIDE_DIR)) {
          armed = false;
          throw crash();
        }
        return realRename(from, to);
      },
    });
    await expect(reconcileDirectImport({ fsOps })).rejects.toMatchObject({ code: 'simulated_crash' });
    // The target backup is aside, nothing imported is in yet, the stage is whole.
    expect(fs.readdirSync(path.join(dataDir(), 'backups')).filter((n) => n.startsWith('burrow-'))).toEqual([]);
    expect(stages()).toHaveLength(1);
    expect(await reconcileDirectImport({})).toEqual({ result: 'swapped' });
    expectEveryIdComplete();
    expect([...backupIdsOnDisk().keys()].sort()).toEqual([BACKUP_ID, importedId(1), importedId(2)].sort());
    const [stamp] = fs.readdirSync(asideRoot());
    expect(fs.readFileSync(path.join(asideRoot(), stamp, 'backups', `burrow-${AUTO_ID}.db`), 'utf8')).toBe('whole');
  });

  it('a crash between the data and the metadata of an imported backup resumes to a complete set', async () => {
    const made = makeSource({ extra: (dir) => sourceBackups(dir) });
    targetBackup(AUTO_ID, 'whole');
    await importFromDirect(baseOpts(made.dir));
    closeDb();
    const realRename = createFsOps().rename;
    let armed = true;
    const fsOps = createFsOps({
      rename: async (from, to) => {
        if (armed && String(from).includes('.import-') && String(to).endsWith(`burrow-${importedId(1)}.meta.json`)) {
          armed = false;
          throw crash();
        }
        return realRename(from, to);
      },
    });
    await expect(reconcileDirectImport({ fsOps })).rejects.toMatchObject({ code: 'simulated_crash' });
    expect(fs.existsSync(path.join(dataDir(), 'backups', `burrow-${importedId(1)}.meta.json`))).toBe(false);
    expect(await reconcileDirectImport({})).toEqual({ result: 'swapped' });
    expectEveryIdComplete();
    expect([...backupIdsOnDisk().keys()].sort()).toEqual([BACKUP_ID, importedId(1), importedId(2)].sort());
  });

  it('a backups folder that is a junction or symbolic link is refused: nothing in it or behind it moves', async () => {
    const made = makeSource({});
    await importFromDirect(baseOpts(made.dir));
    closeDb();
    const elsewhere = tmp('linked');
    fs.writeFileSync(path.join(elsewhere, `burrow-${AUTO_ID}.db`), 'behind the link');
    const backups = path.join(dataDir(), 'backups');
    fs.rmSync(backups, { recursive: true, force: true });
    fs.symlinkSync(elsewhere, backups, 'junction');
    await expect(reconcileDirectImport({})).rejects.toMatchObject({ code: 'import_swap_conflict' });
    expect(fs.readdirSync(elsewhere)).toEqual([`burrow-${AUTO_ID}.db`]);
    expect(stages()).toHaveLength(1);
    fs.unlinkSync(backups);
  });
});

describe('backupsShowUserData counts to-do columns and app_state rows beyond what the app writes itself (L3)', () => {
  const withMeta = (rowCounts) => {
    const dir = tmp('bk');
    fs.mkdirSync(path.join(dir, 'backups'));
    fs.writeFileSync(
      path.join(dir, 'backups', `burrow-${AUTO_ID}.meta.json`),
      JSON.stringify({ id: AUTO_ID, status: 'verified', kind: 'auto', createdAt: '2026-01-02T00:00:00.000Z', rowCounts }),
    );
    return dir;
  };

  it('is false for the default to-do columns and the app own keys, true for anything more', () => {
    expect(backupsShowUserData(withMeta({ todo_columns: DEFAULT_TODO_COLUMNS.length, app_state: AUTO_STATE_KEYS.size }))).toBe(false);
    expect(backupsShowUserData(withMeta({ todo_columns: 0 }))).toBe(false);
    expect(backupsShowUserData(withMeta({ todo_columns: DEFAULT_TODO_COLUMNS.length + 1 }))).toBe(true);
    expect(backupsShowUserData(withMeta({ todo_columns: DEFAULT_TODO_COLUMNS.length - 1 }))).toBe(true);
    expect(backupsShowUserData(withMeta({ app_state: AUTO_STATE_KEYS.size + 1 }))).toBe(true);
    expect(backupsShowUserData(withMeta({ todo_columns: 'many' }))).toBe(true);
  });
});

describe('the import only writes into a folder that carries our ownership marker', () => {
  it('refuses a target without the marker, and a target whose marker is corrupt, and writes nothing', async () => {
    const { dir: src } = makeSource({ notes: ['x'] });
    const marker = path.join(dataDir(), DATA_MARKER_FILE);
    for (const state of ['missing', 'corrupt']) {
      if (state === 'missing') fs.rmSync(marker);
      else fs.writeFileSync(marker, '{nope');
      const before = listing(dataDir());
      await expect(importFromDirect(baseOpts(src))).rejects.toMatchObject({ code: 'import_target_not_ours' });
      expect(listing(dataDir())).toEqual(before);
      expect(stages()).toEqual([]);
    }
  });

  it('the start-up swap does nothing in a folder without the marker, not even sweeping', async () => {
    fs.rmSync(path.join(dataDir(), DATA_MARKER_FILE));
    const leftover = path.join(dataDir(), '.import-aaaaaaaaaaaaaaaa.done');
    fs.mkdirSync(leftover);
    const before = listing(dataDir());
    expect(await reconcileDirectImport({})).toEqual({ result: 'none' });
    expect(listing(dataDir())).toEqual(before);
  });
});

// A stage written by the previous version lists the license files in its manifest. It must still verify and swap everything else.
describe('a stage with a legacy manifest (license files listed)', () => {
  const LEGACY = ['license-activation.json', 'license-trial.json', 'license-clock.json'];
  function addLegacyToStage() {
    const stage = path.join(dataDir(), stages()[0]);
    const manifest = manifestOf(stage);
    for (const name of LEGACY) {
      const body = `{"legacy":"${name}"}\n`;
      fs.writeFileSync(path.join(stage, name), body);
      manifest.files.push({ rel: name, size: Buffer.byteLength(body), sha256: crypto.createHash('sha256').update(body).digest('hex') });
    }
    fs.writeFileSync(path.join(stage, 'import-manifest.json'), JSON.stringify(manifest));
    return stage;
  }
  const expectNoLegacyLive = () => {
    for (const name of LEGACY) expect(fs.existsSync(path.join(dataDir(), name))).toBe(false);
  };

  it('not started: verifies, swaps everything else, never swaps the legacy files in', async () => {
    const made = await stagedImport({ notes: ['from-old-stage'] });
    addLegacyToStage();
    expect(await reconcileDirectImport({})).toEqual({ result: 'swapped' });
    expect(noteBodies(getDb())).toEqual(['from-old-stage']);
    expect(fs.readFileSync(path.join(dataDir(), 'secrets.key'), 'utf8')).toBe(fs.readFileSync(path.join(made.dir, 'secrets.key'), 'utf8'));
    expectNoLegacyLive();
    expect(stages()).toEqual([]);
  });

  it('a tampered legacy file does not make the stage unverified (it is never read)', async () => {
    await stagedImport({ notes: ['n'] });
    const stage = addLegacyToStage();
    fs.writeFileSync(path.join(stage, 'license-trial.json'), 'changed');
    expect(await reconcileDirectImport({})).toEqual({ result: 'swapped' });
    expectNoLegacyLive();
  });

  it('started: a crash mid-swap resumes to the same end and the legacy files are dropped', async () => {
    await stagedImport({ notes: ['resume-old-stage'] });
    addLegacyToStage();
    await expect(
      reconcileDirectImport({
        hooks: {
          afterMove: () => {
            throw crash();
          },
        },
      }),
    ).rejects.toMatchObject({ code: 'simulated_crash' });
    expect(fs.existsSync(path.join(dataDir(), stages()[0], 'import-swapping'))).toBe(true);
    expect(await reconcileDirectImport({})).toEqual({ result: 'swapped' });
    expect(noteBodies(getDb())).toEqual(['resume-old-stage']);
    expectNoLegacyLive();
    expect(stages()).toEqual([]);
  });

  it('started, every real file already in place and only legacy files left: the swap is closed', async () => {
    await stagedImport({ notes: ['all-moved'] });
    const stage = addLegacyToStage();
    await expect(
      reconcileDirectImport({
        hooks: {
          afterMove: (name) => {
            if (name === 'burrow.db') throw crash();
          },
        },
      }),
    ).rejects.toMatchObject({ code: 'simulated_crash' });
    // A leftover legacy file (the old version had not moved it) is dropped, not waited for.
    fs.writeFileSync(path.join(stage, 'license-trial.json'), '{}');
    expect(await reconcileDirectImport({})).toEqual({ result: 'swapped' });
    expect(noteBodies(getDb())).toEqual(['all-moved']);
    expect(stages()).toEqual([]);
  });
});
