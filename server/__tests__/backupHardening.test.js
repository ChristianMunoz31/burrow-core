// Regression tests for the backup/restore hardening: a failed rollback never lets an empty database
// replace the real one, a restore keeps this install's privacy settings and keys, strict schema
// shape checks, retention with a wrong clock, and the small lifecycle fixes.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb, insert, openDb, select, setDbMaintenance } from '../db/index.js';
import { getState, setState } from '../dataAccess.js';
import { createFsOps } from '../backup/fsops.js';
import { __resetLockForTests, closeGate, currentOp, isGateClosed, restoreGateMiddleware } from '../backup/lock.js';
import { readState, writeState } from '../backup/manifest.js';
import { planRetention } from '../backup/retention.js';
import {
  EXIT_RESTORE_RECOVERY,
  RESTORE_CARRY_KEYS,
  __resetUploadsForTests,
  hasPendingUpload,
  inspectUpload,
  reconcileRestoreJournal,
  restoreBackup,
} from '../backup/restore.js';
import { createBackup, flushRecoveryAudit, getBackupStatus, isBackupDue } from '../backup/service.js';
import { listMetas } from '../backup/manifest.js';
import { backupsDir } from '../backup/paths.js';
import { getBackupSettings } from '../backup/settings.js';
import { PROTECTED_APP_STATE_KEYS } from '../import/importExport.js';
import {
  backupFile,
  cleanupBackupEnv,
  crashAfter,
  dataDir,
  day,
  fakeUploadReq,
  noSleep,
  readJson,
  resetBackupEnv,
} from './helpers/backupEnv.js';

beforeEach(() => {
  resetBackupEnv();
});
afterAll(() => {
  cleanupBackupEnv();
});

const live = () => path.join(dataDir(), 'burrow.db');
const journalFile = () => path.join(dataDir(), 'restore-journal.json');
const liveNotes = () => select('notes').map((n) => n.body).sort();
const eperm = () => Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });

/** Bytes of a copy of a backup's database after `edit`, usable as an upload body. */
function editedCopy(id, edit) {
  const copy = path.join(dataDir(), `edited-${id}.db`);
  fs.copyFileSync(backupFile(id, '.db'), copy);
  const db = new DatabaseSync(copy);
  try {
    db.exec('PRAGMA journal_mode = DELETE');
    edit(db);
  } finally {
    db.close();
  }
  const bytes = fs.readFileSync(copy);
  fs.rmSync(copy, { force: true });
  return bytes;
}

describe('C1: a failed rollback never replaces the real data with an empty database', () => {
  it('keeps the gate on db_restoring, creates no file, and startup recovery brings the old data back', async () => {
    insert('notes', { body: 'saved' });
    const source = (await createBackup({ kind: 'manual', now: day(1) })).meta;
    insert('notes', { body: 'live-only' });

    const asideDb = path.join(dataDir(), 'restore-aside', 'burrow.db');
    const failing = createFsOps({
      sleep: noSleep,
      rename: async (from, to) => {
        if (from === asideDb && to === live()) throw eperm();
        return fsp.rename(from, to);
      },
    });
    const hooks = {
      sleep: noSleep,
      // Breaks the freshly swapped file so the post-swap check fails and a rollback starts.
      afterStep: (name) => {
        if (name === 'staging_swapped') fs.writeFileSync(live(), 'not a database');
      },
    };
    await expect(restoreBackup({ id: source.id, now: day(2), fsOps: failing, hooks })).rejects.toMatchObject({
      code: 'restore_failed',
    });

    // Nothing may create a new burrow.db now: maintenance stays on and the journal is still there.
    expect(() => getDb()).toThrowError(expect.objectContaining({ code: 'db_restoring' }));
    expect(fs.existsSync(live())).toBe(false);
    expect(readJson(journalFile()).phase).toBe('rolling_back');
    expect(fs.existsSync(asideDb)).toBe(true);

    // Even with the maintenance switch off, the journal alone refuses to create an empty database.
    setDbMaintenance(false);
    expect(() => getDb()).toThrowError(expect.objectContaining({ code: 'db_restoring' }));
    expect(fs.existsSync(live())).toBe(false);

    const result = await reconcileRestoreJournal({ now: day(3) });
    expect(result).toEqual({ action: 'rolled_back', recovered: true });
    expect(fs.existsSync(journalFile())).toBe(false);
    expect(fs.readdirSync(dataDir()).some((n) => /^restore-failed-.*\.db$/.test(n))).toBe(true);
    expect(liveNotes()).toEqual(['live-only', 'saved']);
  });

  it('startup recovery does not roll forward onto a live file that is not the staged one', async () => {
    insert('notes', { body: 'real' });
    closeDb();
    const aside = path.join(dataDir(), 'restore-aside');
    fs.mkdirSync(aside);
    fs.renameSync(live(), path.join(aside, 'burrow.db'));
    // An empty, healthy, migrated database at the live path (what a stray open would create).
    openDb({ filename: live() }).close();
    fs.writeFileSync(
      journalFile(),
      JSON.stringify({ v: 1, phase: 'swapping', sourceId: 'x', safetyId: 'y', stagingSha256: 'f'.repeat(64) }),
    );
    const result = await reconcileRestoreJournal({ now: day(3) });
    expect(result.action).toBe('rolled_back');
    expect(liveNotes()).toEqual(['real']);
    expect(fs.readdirSync(dataDir()).filter((n) => /^restore-failed-.*\.db$/.test(n))).toHaveLength(1);
  });

  it('a journal in phase rolling_back always restores the old data', async () => {
    insert('notes', { body: 'real' });
    closeDb();
    const aside = path.join(dataDir(), 'restore-aside');
    fs.mkdirSync(aside);
    fs.renameSync(live(), path.join(aside, 'burrow.db'));
    openDb({ filename: live() }).close();
    fs.writeFileSync(journalFile(), JSON.stringify({ v: 1, phase: 'rolling_back', sourceId: 'x' }));
    expect((await reconcileRestoreJournal({ now: day(3) })).action).toBe('rolled_back');
    expect(liveNotes()).toEqual(['real']);
  });

  it('a restore refuses to start while a journal is present', async () => {
    const source = (await createBackup({ kind: 'manual', now: day(1) })).meta;
    fs.writeFileSync(journalFile(), JSON.stringify({ v: 1, phase: 'rolling_back' }));
    await expect(restoreBackup({ id: source.id, now: day(2), hooks: { sleep: noSleep } })).rejects.toMatchObject({
      code: 'db_restoring',
    });
    expect(fs.existsSync(journalFile())).toBe(true);
  });
});

describe('H1: a restore keeps this install\'s settings and keys', () => {
  it('carries network.optIn, ai.settings, backup.settings and app_secrets from the live database', async () => {
    const liveOptIn = { weather: true };
    const liveAi = { host: 'http://127.0.0.1:11434', model: 'llama3.2:3b' };
    await setState('network.optIn', liveOptIn);
    await setState('ai.settings', liveAi);
    getDb()
      .prepare('INSERT INTO app_secrets (name, ciphertext, iv, auth_tag, last4) VALUES (?, ?, ?, ?, ?)')
      .run('LIVE_KEY', 'live-cipher', 'live-iv', 'live-tag', '1234');
    const base = (await createBackup({ kind: 'manual', now: day(1) })).meta;

    const bytes = editedCopy(base.id, (db) => {
      const put = db.prepare('INSERT OR REPLACE INTO app_state (key, value) VALUES (?, ?)');
      put.run('network.optIn', JSON.stringify({ aiLan: true }));
      put.run('ai.settings', JSON.stringify({ host: 'http://192.168.1.50:11434', model: 'evil' }));
      put.run('backup.settings', JSON.stringify({ keepDaily: 60, keepWeekly: 52, keepMonthly: 60 }));
      db.exec('DELETE FROM app_secrets');
      db.prepare('INSERT INTO app_secrets (name, ciphertext, iv, auth_tag, last4) VALUES (?, ?, ?, ?, ?)').run(
        'STALE_KEY',
        'stale-cipher',
        'stale-iv',
        'stale-tag',
        '9999',
      );
    });
    const upload = await inspectUpload(fakeUploadReq(bytes), { now: day(2) });
    await restoreBackup({ uploadToken: upload.uploadToken, now: day(2), hooks: { sleep: noSleep } });

    expect(await getState('network.optIn')).toEqual(liveOptIn);
    expect(await getState('ai.settings')).toEqual(liveAi);
    // The live install never saved backup settings, so the backup's must not appear.
    expect(await getBackupSettings()).toEqual({ keepDaily: 7, keepWeekly: 4, keepMonthly: 6 });
    const secrets = getDb().prepare('SELECT name, ciphertext FROM app_secrets ORDER BY name').all();
    expect(secrets.map((r) => ({ ...r }))).toEqual([{ name: 'LIVE_KEY', ciphertext: 'live-cipher' }]);
  });

  it('carries every key that import protects, including the license clock record', async () => {
    for (const key of PROTECTED_APP_STATE_KEYS) expect(RESTORE_CARRY_KEYS).toContain(key);
    const liveClock = { maxSeen: '2026-10-05T00:00:00.000Z' };
    await setState('license.clock', liveClock);
    const base = (await createBackup({ kind: 'manual', now: day(1) })).meta;
    const bytes = editedCopy(base.id, (db) => {
      db.prepare('INSERT OR REPLACE INTO app_state (key, value) VALUES (?, ?)').run(
        'license.clock',
        JSON.stringify({ maxSeen: '2020-01-01T00:00:00.000Z' }),
      );
    });
    const upload = await inspectUpload(fakeUploadReq(bytes), { now: day(2) });
    await restoreBackup({ uploadToken: upload.uploadToken, now: day(2), hooks: { sleep: noSleep } });
    expect(await getState('license.clock')).toEqual(liveClock);
  });
});

describe('the store license survives a restore (docs/LICENSING.md 5.4, 5.5)', () => {
  it('license.activation is protected and carried, and the live LICENSE_STORE_KEY secret is carried too', async () => {
    expect(PROTECTED_APP_STATE_KEYS).toContain('license.activation');
    expect(RESTORE_CARRY_KEYS).toContain('license.activation');
    const liveRecord = { v: 1, state: 'cleared', clearedAt: '2026-10-05T12:00:00Z', mac: 'L'.repeat(43) };
    await setState('license.activation', liveRecord);
    getDb()
      .prepare('INSERT INTO app_secrets (name, ciphertext, iv, auth_tag, last4) VALUES (?, ?, ?, ?, ?)')
      .run('LICENSE_STORE_KEY', 'live-cipher', 'live-iv', 'live-tag', '4444');
    const base = (await createBackup({ kind: 'manual', now: day(1) })).meta;

    // the backup snapshot itself holds no saved secrets
    const snapshot = new DatabaseSync(backupFile(base.id, '.db'), { readOnly: true });
    try {
      expect(snapshot.prepare('SELECT COUNT(*) AS n FROM app_secrets').get().n).toBe(0);
    } finally {
      snapshot.close();
    }

    const bytes = editedCopy(base.id, (db) => {
      db.prepare('INSERT OR REPLACE INTO app_state (key, value) VALUES (?, ?)').run(
        'license.activation',
        JSON.stringify({ v: 1, state: 'cleared', clearedAt: '2020-01-01T00:00:00Z', mac: 'O'.repeat(43) }),
      );
      db.exec('DELETE FROM app_secrets');
      db.prepare('INSERT INTO app_secrets (name, ciphertext, iv, auth_tag, last4) VALUES (?, ?, ?, ?, ?)').run(
        'LICENSE_STORE_KEY',
        'stale-cipher',
        'stale-iv',
        'stale-tag',
        '9999',
      );
    });
    const upload = await inspectUpload(fakeUploadReq(bytes), { now: day(2) });
    await restoreBackup({ uploadToken: upload.uploadToken, now: day(2), hooks: { sleep: noSleep } });
    expect(await getState('license.activation')).toEqual(liveRecord);
    const secret = getDb().prepare('SELECT ciphertext, last4 FROM app_secrets WHERE name = ?').get('LICENSE_STORE_KEY');
    expect({ ...secret }).toEqual({ ciphertext: 'live-cipher', last4: '4444' });
  });
});

describe('M1: the schema shape check compares the SQL, not just the names', () => {
  it('rejects a table with the same name but different columns', async () => {
    const base = (await createBackup({ kind: 'manual', now: day(1) })).meta;
    const bytes = editedCopy(base.id, (db) => db.exec('ALTER TABLE notes ADD COLUMN extra TEXT'));
    await expect(inspectUpload(fakeUploadReq(bytes), { now: day(2) })).rejects.toMatchObject({
      code: 'backup_invalid',
      status: 422,
    });
  });

  it('rejects an extra expression index', async () => {
    const base = (await createBackup({ kind: 'manual', now: day(1) })).meta;
    const bytes = editedCopy(base.id, (db) => db.exec('CREATE INDEX extra_idx ON notes (lower(body))'));
    await expect(inspectUpload(fakeUploadReq(bytes), { now: day(2) })).rejects.toMatchObject({
      code: 'backup_invalid',
      status: 422,
    });
  });
});

describe('M3: an unreadable previous backup is not blamed', () => {
  it('keeps the old meta and still creates the new backup when the digest cannot be computed', async () => {
    insert('notes', { body: 'a' });
    const first = (await createBackup({ kind: 'auto', now: day(1) })).meta;
    const oldDb = backupFile(first.id, '.db');
    const flaky = createFsOps({
      open: async (file, ...rest) => {
        if (file === oldDb) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
        return fsp.open(file, ...rest);
      },
    });
    const second = await createBackup({ kind: 'auto', now: day(2), fsOps: flaky });
    expect(second.created).toBe(true);
    const metas = await listMetas(backupsDir());
    expect(metas.find((m) => m.id === first.id)).toMatchObject({ status: 'verified', error: null });
  });
});

describe('M4: retention protects the new backup and ignores wrong-clock dates', () => {
  const settings = { keepDaily: 1, keepWeekly: 0, keepMonthly: 0 };
  const now = new Date(Date.UTC(2026, 5, 20, 12));
  const meta = (id, createdAt, kind = 'auto') => ({ id, kind, status: 'verified', createdAt: createdAt.toISOString() });
  const past = meta('a', new Date(now.getTime() - 86_400_000));
  const older = meta('b', new Date(now.getTime() - 5 * 86_400_000));
  const future = meta('f', new Date(now.getTime() + 30 * 86_400_000));

  it('a future-dated backup does not represent a bucket or count as the newest, and is never removed', () => {
    const { keep, remove } = planRetention([past, older, future], settings, now);
    expect(keep.map((m) => m.id).sort()).toEqual(['a', 'f']);
    expect(remove.map((m) => m.id)).toEqual(['b']);
  });

  it('protectIds are never removed', () => {
    const { keep } = planRetention([past, older, future], settings, now, { protectIds: ['f'] });
    expect(keep.map((m) => m.id).sort()).toEqual(['a', 'f']);
  });

  it('keeps a lone future-dated backup (nothing newer that is real)', () => {
    expect(planRetention([future], settings, now).keep.map((m) => m.id)).toEqual(['f']);
  });
});

describe('M5: safety copies do not count as a scheduled success', () => {
  it('a safety backup leaves lastSuccessAt alone; a restore clears it and the next run is due', async () => {
    insert('notes', { body: 'a' });
    const first = (await createBackup({ kind: 'manual', now: day(1) })).meta;
    const before = await readState();
    await createBackup({ kind: 'safety', skipIfUnchanged: false, now: day(1, 14) });
    const after = await readState();
    expect(after.lastSuccessAt).toBe(before.lastSuccessAt);
    expect(after.confirmedId).toBe(before.confirmedId);

    await restoreBackup({ id: first.id, now: day(1, 15), hooks: { sleep: noSleep } });
    const state = await readState();
    expect(state.lastSuccessAt).toBeNull();
    const metas = await listMetas(backupsDir());
    expect(isBackupDue({ state, metas, now: day(1, 16) })).toBe(true);
    // Health follows the newest verified backup (the safety copy), so it does not flip to none.
    expect((await getBackupStatus({ now: day(1, 16) })).health).toBe('ok');
  });
});

describe('lifecycle fixes', () => {
  it('L4: a wrong upload token does not discard the pending upload', async () => {
    const base = (await createBackup({ kind: 'manual', now: day(1) })).meta;
    const upload = await inspectUpload(fakeUploadReq(fs.readFileSync(backupFile(base.id, '.db'))), { now: day(1) });
    await expect(restoreBackup({ uploadToken: 'a'.repeat(32), now: day(1), hooks: { sleep: noSleep } })).rejects.toMatchObject({
      code: 'upload_expired',
    });
    expect(hasPendingUpload()).toBe(true);
    __resetUploadsForTests();
    expect(upload.uploadToken).toMatch(/^[0-9a-f]{32}$/);
  });

  it('L6: a simulated crash leaves the lock and gate as a killed process would', async () => {
    const base = (await createBackup({ kind: 'manual', now: day(1) })).meta;
    await expect(
      restoreBackup({ id: base.id, now: day(2), hooks: crashAfter('aside_moved') }),
    ).rejects.toMatchObject({ code: 'simulated_crash' });
    expect(currentOp()).toBe('restore');
    expect(isGateClosed()).toBe(true);
    __resetLockForTests();
    setDbMaintenance(false);
    expect((await reconcileRestoreJournal({ now: day(3) })).recovered).toBe(true);
  });

  it('L7: the gate answers 503 with code db_restoring', () => {
    closeGate();
    const sent = { headers: {}, status: 0, body: null };
    const res = {
      set: (k, v) => {
        sent.headers[k] = v;
        return res;
      },
      status: (s) => {
        sent.status = s;
        return res;
      },
      json: (b) => {
        sent.body = b;
        return res;
      },
    };
    restoreGateMiddleware({ method: 'GET', path: '/notes' }, res, () => {});
    expect(sent.status).toBe(503);
    expect(sent.body).toMatchObject({ error: 'db_restoring', code: 'db_restoring' });
  });
});

describe('round 2: restore carries settings into the staged file', () => {
  const liveOptIn = { weather: true };

  async function crashedRestoreWithDifferingBackup(step) {
    await setState('network.optIn', liveOptIn);
    getDb()
      .prepare('INSERT INTO app_secrets (name, ciphertext, iv, auth_tag, last4) VALUES (?, ?, ?, ?, ?)')
      .run('LIVE_KEY', 'live-cipher', 'live-iv', 'live-tag', '1234');
    const base = (await createBackup({ kind: 'manual', now: day(1) })).meta;
    const bytes = editedCopy(base.id, (db) => {
      db.prepare('INSERT OR REPLACE INTO app_state (key, value) VALUES (?, ?)').run('network.optIn', JSON.stringify({ aiLan: true }));
      db.exec('DELETE FROM app_secrets');
      db.prepare('INSERT INTO app_secrets (name, ciphertext, iv, auth_tag, last4) VALUES (?, ?, ?, ?, ?)').run('STALE', 'x', 'x', 'x', '9999');
    });
    const upload = await inspectUpload(fakeUploadReq(bytes), { now: day(2) });
    await expect(
      restoreBackup({ uploadToken: upload.uploadToken, now: day(2), hooks: crashAfter(step) }),
    ).rejects.toMatchObject({ code: 'simulated_crash' });
    __resetLockForTests();
    setDbMaintenance(false);
  }

  for (const step of ['staging_swapped', 'journal_swapped']) {
    it(`a recovery that rolls forward after a crash at ${step} keeps the live opt-ins and keys`, async () => {
      await crashedRestoreWithDifferingBackup(step);
      expect((await reconcileRestoreJournal({ now: day(3) })).action).toBe('rolled_forward');
      expect(await getState('network.optIn')).toEqual(liveOptIn);
      const secrets = getDb().prepare('SELECT name FROM app_secrets').all().map((r) => r.name);
      expect(secrets).toEqual(['LIVE_KEY']);
    });
  }

  it('the normal path still carries the live values', async () => {
    await setState('network.optIn', liveOptIn);
    const base = (await createBackup({ kind: 'manual', now: day(1) })).meta;
    const bytes = editedCopy(base.id, (db) => {
      db.prepare('INSERT OR REPLACE INTO app_state (key, value) VALUES (?, ?)').run('network.optIn', JSON.stringify({ aiLan: true }));
    });
    const upload = await inspectUpload(fakeUploadReq(bytes), { now: day(2) });
    await restoreBackup({ uploadToken: upload.uploadToken, now: day(2), hooks: { sleep: noSleep } });
    expect(await getState('network.optIn')).toEqual(liveOptIn);
  });
});

describe('round 2: failed rollback', () => {
  const asideDb = () => path.join(dataDir(), 'restore-aside', 'burrow.db');
  const breakSwapped = {
    sleep: noSleep,
    afterStep: (name) => {
      if (name === 'staging_swapped') fs.writeFileSync(live(), 'not a database');
    },
  };
  const failingMoveBack = (times) => {
    let left = times;
    return createFsOps({
      sleep: noSleep,
      rename: async (from, to) => {
        if (from === asideDb() && to === live() && left > 0) {
          left -= 1;
          throw eperm();
        }
        return fsp.rename(from, to);
      },
    });
  };

  it('recovers in-process when the first rollback fails but a retry works', async () => {
    insert('notes', { body: 'saved' });
    const source = (await createBackup({ kind: 'manual', now: day(1) })).meta;
    insert('notes', { body: 'live-only' });
    // The 7 rename attempts of the rollback fail; the recovery that follows succeeds.
    await expect(
      restoreBackup({ id: source.id, now: day(2), fsOps: failingMoveBack(7), hooks: breakSwapped }),
    ).rejects.toMatchObject({ code: 'restore_failed' });
    expect(fs.existsSync(journalFile())).toBe(false);
    expect(liveNotes()).toEqual(['live-only', 'saved']);
    expect(currentOp()).toBeNull();
    expect((await getBackupStatus({ now: day(2) })).recoveryRequired).toBe(false);
  });

  it('reports recoveryRequired (health failing) when nothing can finish it until a restart', async () => {
    insert('notes', { body: 'saved' });
    const source = (await createBackup({ kind: 'manual', now: day(1) })).meta;
    await expect(
      restoreBackup({ id: source.id, now: day(2), fsOps: failingMoveBack(1000), hooks: breakSwapped }),
    ).rejects.toMatchObject({ code: 'restore_failed' });
    const status = await getBackupStatus({ now: day(2) });
    expect(status.recoveryRequired).toBe(true);
    expect(status.health).toBe('failing');
    expect(currentOp()).toBeNull();
  });
});

describe('round 2: restore waits for requests, then gives up', () => {
  it('answers backup_busy when an in-flight request never finishes, and reopens the gate', async () => {
    insert('notes', { body: 'kept' });
    const source = (await createBackup({ kind: 'manual', now: day(1) })).meta;
    const res = new EventEmitter();
    restoreGateMiddleware({ method: 'GET', path: '/notes' }, res, () => {});
    await expect(restoreBackup({ id: source.id, now: day(2), hooks: { sleep: noSleep } })).rejects.toMatchObject({
      code: 'backup_busy',
      status: 409,
    });
    expect(isGateClosed()).toBe(false);
    expect(currentOp()).toBeNull();
    expect(fs.existsSync(journalFile())).toBe(false);
    expect(liveNotes()).toEqual(['kept']);
    res.emit('finish');
  });
});

describe('round 2: startup recovery edge cases', () => {
  const aside = () => path.join(dataDir(), 'restore-aside');

  it('exports a distinct exit code for a failed recovery', () => {
    expect(EXIT_RESTORE_RECOVERY).toBe(3);
  });

  it('moves -wal/-shm that were set aside back when the aside folder has no database', async () => {
    insert('notes', { body: 'real' });
    closeDb();
    fs.mkdirSync(aside());
    fs.writeFileSync(path.join(aside(), 'burrow.db-wal'), 'wal-bytes');
    fs.writeFileSync(path.join(aside(), 'burrow.db-shm'), 'shm-bytes');
    fs.writeFileSync(journalFile(), JSON.stringify({ v: 1, phase: 'swapping', sourceId: 'x', safetyId: 'y' }));
    expect((await reconcileRestoreJournal({ now: day(3) })).action).toBe('rolled_back');
    expect(fs.readFileSync(`${live()}-wal`, 'utf8')).toBe('wal-bytes');
    expect(fs.readFileSync(`${live()}-shm`, 'utf8')).toBe('shm-bytes');
    expect(fs.existsSync(aside())).toBe(false);
    expect(fs.existsSync(journalFile())).toBe(false);
    fs.rmSync(`${live()}-wal`, { force: true });
    fs.rmSync(`${live()}-shm`, { force: true });
  });

  it('refuses (restore_recovery_failed) when neither the live nor the aside database exists', async () => {
    closeDb();
    fs.rmSync(live(), { force: true });
    fs.rmSync(`${live()}-wal`, { force: true });
    fs.rmSync(`${live()}-shm`, { force: true });
    fs.writeFileSync(path.join(dataDir(), 'restore-failed-20260601T000000Z.db'), 'old');
    fs.writeFileSync(journalFile(), JSON.stringify({ v: 1, phase: 'swapping', sourceId: 'x', safetyId: 'safety-1' }));
    await expect(reconcileRestoreJournal({ now: day(3) })).rejects.toMatchObject({
      code: 'restore_recovery_failed',
      details: { restoreFailed: ['restore-failed-20260601T000000Z.db'], safetyId: 'safety-1' },
    });
    expect(fs.existsSync(journalFile())).toBe(true);
  });

  it("rolls forward on phase 'swapped' with no aside database and a healthy live file, and clears the success markers", async () => {
    insert('notes', { body: 'restored' });
    closeDb();
    fs.mkdirSync(backupsDir(), { recursive: true });
    await writeState({ lastSuccessAt: day(1).toISOString(), confirmedId: 'old-id' });
    fs.writeFileSync(journalFile(), JSON.stringify({ v: 1, phase: 'swapped', sourceId: 'src', safetyId: 'y' }));
    expect(await reconcileRestoreJournal({ now: day(3) })).toEqual({ action: 'rolled_forward', recovered: true });
    const state = await readState();
    expect(state.lastSuccessAt).toBeNull();
    expect(state.confirmedId).toBeNull();
    expect(liveNotes()).toEqual(['restored']);

    await flushRecoveryAudit();
    const rows = select('audit_log').filter((r) => r.feature === 'backup_restore');
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('ok');
  });

  it('keeps the aside folder while the journal could not be removed', async () => {
    insert('notes', { body: 'old' });
    const source = (await createBackup({ kind: 'manual', now: day(1) })).meta;
    const failing = createFsOps({
      sleep: noSleep,
      rm: async (target, opts) => {
        if (target === journalFile()) throw Object.assign(new Error('EIO'), { code: 'EIO' });
        return fsp.rm(target, opts);
      },
    });
    await restoreBackup({ id: source.id, now: day(2), fsOps: failing, hooks: { sleep: noSleep } });
    expect(fs.existsSync(journalFile())).toBe(true);
    expect(fs.existsSync(path.join(aside(), 'burrow.db'))).toBe(true);
  });

  it('refuses to start recovery on a journal it cannot read (not ENOENT or bad JSON)', async () => {
    insert('notes', { body: 'real' });
    closeDb();
    fs.mkdirSync(aside());
    fs.renameSync(live(), path.join(aside(), 'burrow.db'));
    fs.writeFileSync(journalFile(), JSON.stringify({ v: 1, phase: 'rolling_back' }));
    const unreadable = createFsOps({
      sleep: noSleep,
      readFile: async (file, ...rest) => {
        if (file === journalFile()) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
        return fsp.readFile(file, ...rest);
      },
    });
    await expect(reconcileRestoreJournal({ fsOps: unreadable, now: day(3) })).rejects.toMatchObject({ code: 'EACCES' });
    expect(fs.existsSync(journalFile())).toBe(true);
    expect(fs.existsSync(path.join(aside(), 'burrow.db'))).toBe(true);
  });

  it('retries a transient journal read error', async () => {
    insert('notes', { body: 'real' });
    closeDb();
    fs.mkdirSync(aside());
    fs.renameSync(live(), path.join(aside(), 'burrow.db'));
    fs.writeFileSync(journalFile(), JSON.stringify({ v: 1, phase: 'rolling_back' }));
    let failures = 2;
    const flaky = createFsOps({
      sleep: noSleep,
      readFile: async (file, ...rest) => {
        if (file === journalFile() && failures > 0) {
          failures -= 1;
          throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
        }
        return fsp.readFile(file, ...rest);
      },
    });
    expect((await reconcileRestoreJournal({ fsOps: flaky, now: day(3) })).action).toBe('rolled_back');
    expect(liveNotes()).toEqual(['real']);
  });
});
