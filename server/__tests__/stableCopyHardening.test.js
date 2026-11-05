// Hardening of "Copy my data from Burrow": torn-copy detection by WAL and wal-index headers (M1), orphan
// cleanup of private copies (L2), link-aware folder overlap (L3) and a database that vanishes mid-copy (L4).
// Real files in temp folders only; the stable folder is only ever read.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb, insertMany, openDb } from '../db/index.js';
import { backupsDir } from '../backup/paths.js';
import { cleanupOrphans, STABLE_COPY_DIR_PREFIX } from '../backup/service.js';
import { createFsOps } from '../backup/fsops.js';
import { copyFromStable } from '../backup/stableCopy.js';
import { cleanupBackupEnv, dataDir, resetBackupEnv } from './helpers/backupEnv.js';

const tmpDirs = [];
const open = [];

function tmp(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `burrow-stable-h-${label}-`));
  tmpDirs.push(dir);
  return dir;
}

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

function openStableDb(dir) {
  const db = openDb({ filename: path.join(dir, 'burrow.db') });
  open.push(db);
  return db;
}

const addNote = (db, body) => insertMany('notes', [{ body }], { db });
const stableOf = (dir) => ({ dir, overridden: true });
const fastRetry = { retryDelayMs: 1 };
const leftovers = () =>
  (fs.existsSync(backupsDir()) ? fs.readdirSync(backupsDir()) : []).filter((n) => n.startsWith(STABLE_COPY_DIR_PREFIX) || n.startsWith('.incoming-'));

function closeAll() {
  for (const db of open.splice(0)) {
    try {
      db.close();
    } catch {
      // already closed
    }
  }
}

/**
 * fsOps whose lstat answers the first stat it saw for every file under `dir`, as if size, mtime and inode
 * never changed. Content changes are then visible only through the header comparison.
 */
function frozenStatOps(dir) {
  const real = createFsOps();
  const seen = new Map();
  return createFsOps({
    lstat: async (file) => {
      const key = String(file);
      if (!key.startsWith(dir)) return real.lstat(file);
      if (!seen.has(key)) seen.set(key, await real.lstat(file));
      return seen.get(key);
    },
  });
}

/** Overwrites one byte in place. */
function flipByte(file, offset) {
  const fd = fs.openSync(file, 'r+');
  try {
    const buf = Buffer.alloc(1);
    fs.readSync(fd, buf, 0, 1, offset);
    buf[0] ^= 0xff;
    fs.writeSync(fd, buf, 0, 1, offset);
  } finally {
    fs.closeSync(fd);
  }
}

/** A crashed stable: committed rows still in the -wal, no -shm (the files are copied out from under a live connection). */
function crashedStable(notes) {
  const live = tmp('live');
  const db = openStableDb(live);
  db.exec('PRAGMA wal_autocheckpoint = 0');
  for (const n of notes) addNote(db, n);
  const dir = tmp('crashed');
  fs.copyFileSync(path.join(live, 'burrow.db'), path.join(dir, 'burrow.db'));
  fs.copyFileSync(path.join(live, 'burrow.db-wal'), path.join(dir, 'burrow.db-wal'));
  closeAll();
  return dir;
}

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

describe('M1: headers are compared before and after the copy', () => {
  it('a WAL header rewrite that keeps size, mtime and inode is still seen (stable_busy)', async () => {
    const dir = crashedStable(['wal-header']);
    const wal = path.join(dir, 'burrow.db-wal');

    // A change outside the 32-byte header with the stat values frozen is not part of the signature, but the source is read a
    // second time after the "after" signature and its hash no longer equals the copy's, so it is seen too.
    await expect(
      copyFromStable({
        stable: stableOf(dir),
        fsOps: frozenStatOps(dir),
        ...fastRetry,
        attempts: 1,
        hooks: { afterCopy: () => flipByte(wal, 100) },
      }),
    ).rejects.toMatchObject({ code: 'stable_busy' });
    resetBackupEnv();

    const dir2 = crashedStable(['wal-header-2']);
    const wal2 = path.join(dir2, 'burrow.db-wal');
    let calls = 0;
    await expect(
      copyFromStable({
        stable: stableOf(dir2),
        fsOps: frozenStatOps(dir2),
        ...fastRetry,
        attempts: 3,
        hooks: {
          afterCopy: () => {
            calls += 1;
            flipByte(wal2, 12);
          },
        },
      }),
    ).rejects.toMatchObject({ code: 'stable_busy' });
    expect(calls).toBe(3);
    expect(leftovers()).toEqual([]);
  });

  it('a wal-index header change that keeps size, mtime and inode is still seen (stable_busy)', async () => {
    const dir = crashedStable(['shm-header']);
    const shm = path.join(dir, 'burrow.db-shm');
    fs.writeFileSync(shm, crypto.randomBytes(512));

    // Control: a change after byte 136 is outside the compared header.
    await copyFromStable({
      stable: stableOf(dir),
      fsOps: frozenStatOps(dir),
      ...fastRetry,
      attempts: 1,
      hooks: { afterCopy: () => flipByte(shm, 300) },
    });
    resetBackupEnv();

    const dir2 = crashedStable(['shm-header-2']);
    const shm2 = path.join(dir2, 'burrow.db-shm');
    fs.writeFileSync(shm2, crypto.randomBytes(512));
    let calls = 0;
    await expect(
      copyFromStable({
        stable: stableOf(dir2),
        fsOps: frozenStatOps(dir2),
        ...fastRetry,
        attempts: 3,
        hooks: {
          afterCopy: () => {
            calls += 1;
            flipByte(shm2, 20);
          },
        },
      }),
    ).rejects.toMatchObject({ code: 'stable_busy' });
    expect(calls).toBe(3);
    expect(leftovers()).toEqual([]);
  });

  it('never writes to the stable folder, headers included', async () => {
    const dir = crashedStable(['readonly-check']);
    const before = listing(dir);
    await copyFromStable({ stable: stableOf(dir), ...fastRetry });
    expect(listing(dir)).toEqual(before);
  });

  it('a concurrent writer with PASSIVE checkpoints gives a valid copy or stable_busy, never a corrupt restore', async () => {
    let copies = 0;
    let busy = 0;
    for (let round = 0; round < 4; round += 1) {
      resetBackupEnv();
      const dir = tmp(`writer-${round}`);
      const db = openStableDb(dir);
      db.exec('PRAGMA wal_autocheckpoint = 0');
      for (let i = 0; i < 20; i += 1) addNote(db, `seed-${i}`);
      let n = 0;
      const writer = setInterval(() => {
        try {
          addNote(db, `live-${round}-${n}`);
          n += 1;
          if (n % 3 === 0) db.exec('PRAGMA wal_checkpoint(PASSIVE)');
        } catch {
          // a busy checkpoint is fine
        }
      }, 1);
      const deadline = Date.now() + 3000;
      try {
        // Keep copying until a copy lands or the bounded time is up; each outcome is checked.
        while (Date.now() < deadline) {
          try {
            await copyFromStable({ stable: stableOf(dir), retryDelayMs: 2 });
            copies += 1;
            const check = getDb().prepare('PRAGMA integrity_check').get();
            expect(check.integrity_check).toBe('ok');
            const bodies = getDb().prepare('SELECT body FROM notes').all().map((r) => r.body);
            expect(bodies.filter((b) => b.startsWith('seed-')).length).toBe(20);
            break;
          } catch (e) {
            expect(e.code).toBe('stable_busy');
            busy += 1;
          }
        }
      } finally {
        clearInterval(writer);
      }
      expect(leftovers()).toEqual([]);
      closeAll();
    }
    expect(copies + busy).toBeGreaterThan(0);
  }, 60000);
});

describe('L2: orphan cleanup of private copies', () => {
  const future = () => new Date(Date.now() + 3 * 60 * 60 * 1000);

  it('removes only exact private-copy directories', async () => {
    const dir = backupsDir();
    fs.mkdirSync(dir, { recursive: true });
    const good = path.join(dir, `${STABLE_COPY_DIR_PREFIX}0123456789abcdef`);
    fs.mkdirSync(good);
    fs.writeFileSync(path.join(good, 'burrow.db'), 'x');
    const badName = path.join(dir, `${STABLE_COPY_DIR_PREFIX}notahexname`);
    const upper = path.join(dir, `${STABLE_COPY_DIR_PREFIX}ABCDEF0123456789`);
    const short = path.join(dir, `${STABLE_COPY_DIR_PREFIX}0123`);
    const asFile = path.join(dir, `${STABLE_COPY_DIR_PREFIX}fedcba9876543210`);
    for (const d of [badName, upper, short]) fs.mkdirSync(d);
    fs.writeFileSync(asFile, 'plain file');

    const { removed } = await cleanupOrphans({ now: future() });
    expect(removed).toContain(path.basename(good));
    expect(fs.existsSync(good)).toBe(false);
    for (const kept of [badName, upper, short, asFile]) expect(fs.existsSync(kept), kept).toBe(true);
  });

  it('never follows a link that has a private-copy name', async () => {
    const dir = backupsDir();
    fs.mkdirSync(dir, { recursive: true });
    const outside = tmp('outside');
    fs.writeFileSync(path.join(outside, 'precious.txt'), 'keep me');
    const link = path.join(dir, `${STABLE_COPY_DIR_PREFIX}aaaaaaaaaaaaaaaa`);
    try {
      fs.symlinkSync(outside, link, 'junction');
    } catch {
      return; // links are not allowed on this machine
    }
    await cleanupOrphans({ now: future() });
    expect(fs.readFileSync(path.join(outside, 'precious.txt'), 'utf8')).toBe('keep me');
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
  });
});

describe('L3: overlap uses real locations', () => {
  it('a backups folder that is a link into the stable folder is stable_same_folder, and nothing is written there', async () => {
    const dir = tmp('stable-linked');
    const db = openStableDb(dir);
    addNote(db, 'x');
    db.close();
    open.splice(0);
    const backups = backupsDir();
    fs.rmSync(backups, { recursive: true, force: true });
    try {
      fs.symlinkSync(dir, backups, 'junction');
    } catch {
      return; // links are not allowed on this machine
    }
    const before = listing(dir);
    try {
      await expect(copyFromStable({ stable: stableOf(dir), ...fastRetry })).rejects.toMatchObject({ code: 'stable_same_folder' });
      expect(listing(dir)).toEqual(before);
    } finally {
      fs.rmSync(backups, { recursive: true, force: true });
    }
  });

  it('a stable path reached through a link to the Dev data folder is stable_same_folder', async () => {
    const holder = tmp('holder');
    const alias = path.join(holder, 'alias');
    try {
      fs.symlinkSync(dataDir(), alias, 'junction');
    } catch {
      return; // links are not allowed on this machine
    }
    await expect(copyFromStable({ stable: stableOf(path.join(alias, 'nested', 'missing')), ...fastRetry })).rejects.toMatchObject({
      code: 'stable_same_folder',
    });
  });
});

describe('L4: a database that vanishes while we copy', () => {
  it('is stable_not_found, not stable_busy', async () => {
    const dir = crashedStable(['vanishing']);
    await expect(
      copyFromStable({
        stable: stableOf(dir),
        ...fastRetry,
        hooks: { afterCopy: () => fs.rmSync(path.join(dir, 'burrow.db')) },
      }),
    ).rejects.toMatchObject({ code: 'stable_not_found', status: 404 });
    expect(leftovers()).toEqual([]);
  });
});
