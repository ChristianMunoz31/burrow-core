// The erase-all-data service against a real file-backed database in the temp data dir.
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listAudit } from '../audit.js';
import { __resetLockForTests, currentOp, isGateClosed, restoreGateMiddleware, tryAcquire } from '../backup/lock.js';
import { createBackup } from '../backup/service.js';
import { backupsDir } from '../backup/paths.js';
import { TABLES, select, setDbMaintenance } from '../db/index.js';
import { LICENSE_KEY_SECRET_NAME } from '../license/constants.js';
import { EraseError, eraseAllData, eraseUnavailable } from '../erase/eraseService.js';
import { registerExportRoutes } from '../exportRoutes.js';
import { createFsOps } from '../backup/fsops.js';
import { IMPORT_ASIDE_DIR } from '../backup/importConstants.js';
import { cleanupBackupEnv, dataDir } from './helpers/backupEnv.js';
import {
  SENTINEL,
  filesContaining,
  freshDb,
  LEGACY_LICENSE_FILES,
  licenseRows,
  plantSentinelEverywhere,
  rawDbBytes,
  rowCounts,
  secretNames,
  seedEverything,
  stateKeys,
} from './helpers/eraseEnv.js';

const NOW = new Date('2026-10-05T12:30:00.000Z');
const run = (opts = {}) => eraseAllData({ now: () => NOW, ...opts });

beforeEach(() => {
  freshDb();
});
afterEach(() => {
  cleanupBackupEnv();
});

describe('what the wipe deletes', () => {
  it('empties every module table, journal, notes, Javi conversations and memory, and the old audit rows', async () => {
    const { db } = seedEverything();
    const before = rowCounts(db);
    for (const [table, n] of Object.entries(before)) expect(n, table).toBeGreaterThan(0);
    await run();
    const after = rowCounts(db);
    for (const table of Object.keys(after)) {
      if (['app_state', 'app_secrets', 'audit_log'].includes(table)) continue;
      expect(after[table], table).toBe(0);
    }
    expect(select('audit_log', { columns: ['feature'], db }).map((r) => r.feature)).not.toContain('javi_chat');
  });

  it('removes consent, categories, display name, onboarding and every other setting, including the legacy license rows', async () => {
    const { db } = seedEverything();
    expect(stateKeys(db)).toEqual(expect.arrayContaining(['profile', 'ai.cloudConsent', 'ai.cloudCategories', 'theme', 'network.optIn']));
    await run();
    const keys = stateKeys(db);
    for (const gone of ['profile', 'ai.cloudConsent', 'ai.cloudCategories', 'theme', 'network.optIn']) expect(keys).not.toContain(gone);
    expect(keys.filter((k) => k.startsWith('license.'))).toEqual([]);
    expect(keys).toEqual([]);
  });

  it('empties app_secrets of saved API keys and of a legacy stored license key', async () => {
    const { db } = seedEverything();
    expect(secretNames(db)).toEqual(['GROQ_API_KEY', LICENSE_KEY_SECRET_NAME].sort());
    await run();
    expect(secretNames(db)).toEqual([]);
  });

  it('leaves secrets.key in place (no saved key remains for it to protect)', async () => {
    const { dir } = seedEverything();
    expect(fs.existsSync(path.join(dir, 'secrets.key'))).toBe(true);
    await run();
    expect(fs.existsSync(path.join(dir, 'secrets.key'))).toBe(true);
  });

  it('deletes pre-migration copies and a restore safety copy next to the database', async () => {
    const { dir } = seedEverything();
    fs.writeFileSync(path.join(dir, 'burrow.db.pre-v3.bak'), SENTINEL);
    fs.mkdirSync(path.join(dir, 'restore-aside'));
    fs.writeFileSync(path.join(dir, 'restore-aside', 'burrow.db'), SENTINEL);
    await run();
    expect(fs.existsSync(path.join(dir, 'burrow.db.pre-v3.bak'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'restore-aside'))).toBe(false);
  });

  it('only deletes pre-migration copies named after the live database file', async () => {
    const { dir } = seedEverything();
    expect(path.basename(path.join(dir, 'burrow.db'))).toBe('burrow.db');
    fs.writeFileSync(path.join(dir, 'burrow.db.pre-v4.bak'), SENTINEL);
    for (const keep of ['other.db.pre-v4.bak', 'burrow.db.pre-v4.bak.old', 'xburrow.db.pre-v4.bak', 'burrow.db.pre-vx.bak']) {
      fs.writeFileSync(path.join(dir, keep), 'not ours');
    }
    await run();
    expect(fs.existsSync(path.join(dir, 'burrow.db.pre-v4.bak'))).toBe(false);
    for (const keep of ['other.db.pre-v4.bak', 'burrow.db.pre-v4.bak.old', 'xburrow.db.pre-v4.bak', 'burrow.db.pre-vx.bak']) {
      expect(fs.existsSync(path.join(dir, keep)), keep).toBe(true);
    }
  });

  it('reports counts only', async () => {
    seedEverything();
    const result = await run();
    expect(result.counts.tables).toBeGreaterThanOrEqual(17);
    expect(result.counts.rows).toBeGreaterThan(10);
    expect(result.counts.secrets).toBe(2);
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
  });
});

describe('legacy license data', () => {
  it('erases the legacy license rows and files that older versions left behind, like everything else', async () => {
    const { db, dir } = seedEverything();
    expect(Object.keys(licenseRows(db)).sort()).toEqual(['license.activation', 'license.clock', 'license.trial', 'license.trialNotices']);
    for (const file of LEGACY_LICENSE_FILES) expect(fs.existsSync(path.join(dir, file)), file).toBe(true);
    await run();
    expect(licenseRows(db)).toEqual({});
    for (const file of LEGACY_LICENSE_FILES) expect(fs.existsSync(path.join(dir, file)), file).toBe(false);
    expect(secretNames(db)).toEqual([]);
  });

  it('also removes the temp file an older version left when it was killed mid-write, and nothing that only looks similar', async () => {
    const { dir } = seedEverything();
    const leftovers = LEGACY_LICENSE_FILES.map((f) => `.${f}.4242.0a1b2c3d.tmp`);
    const bystanders = ['.license-trial.json.tmp', `.license-trial.json.4242.nothex!!.tmp`, 'my.license-trial.json.4242.0a1b2c3d.tmp', '.notes.json.4242.0a1b2c3d.tmp'];
    for (const f of [...leftovers, ...bystanders]) fs.writeFileSync(path.join(dir, f), 'x');
    await run();
    for (const f of leftovers) expect(fs.existsSync(path.join(dir, f)), f).toBe(false);
    for (const f of bystanders) expect(fs.existsSync(path.join(dir, f)), f).toBe(true);
  });

  it('a removeLicense option is not part of the service any more: it is ignored', async () => {
    const { db } = seedEverything();
    const result = await run({ removeLicense: false });
    expect(result).not.toHaveProperty('licenseRemoved');
    expect(licenseRows(db)).toEqual({});
  });
});

describe('the audit marker', () => {
  it('writes the marker as the first audit entry: time and counts, no content', async () => {
    const { db } = seedEverything();
    await run();
    const { entries: rows } = await listAudit({ db, limit: 10 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'auth', feature: 'data_erased', status: 'ok', context: 'data erased at 2026-10-05T12:30:00.000Z' });
    expect(Object.keys(rows[0].meta).sort()).toEqual(['keys_removed', 'rows', 'tables']);
    expect(JSON.stringify(rows)).not.toContain(SENTINEL);
  });
});

describe('backups', () => {
  const makeBackup = async () => {
    const { meta } = await createBackup({ kind: 'manual' });
    return meta.id;
  };

  it('keeps every backup by default', async () => {
    seedEverything();
    const id = await makeBackup();
    await run();
    expect(fs.existsSync(path.join(backupsDir(), `burrow-${id}.db`))).toBe(true);
    expect(fs.existsSync(path.join(backupsDir(), `burrow-${id}.meta.json`))).toBe(true);
  });

  it('deletes all backups, their exports and state when asked, and counts them', async () => {
    seedEverything();
    await makeBackup();
    await makeBackup();
    fs.mkdirSync(path.join(backupsDir(), '.stable-copy-0123456789abcdef'));
    const result = await run({ deleteBackups: true });
    expect(fs.readdirSync(backupsDir())).toEqual([]);
    expect(result.counts.backups).toBeGreaterThan(0);
    expect(fs.existsSync(dataDir())).toBe(true);
  });

  it('always sweeps partial and temporary files in backups/, at any age, and keeps the real backups', async () => {
    seedEverything();
    const id = await makeBackup();
    const dir = backupsDir();
    const leftovers = [
      '.incoming-abc123',
      'burrow-20261005T120000Z-aaaa.db.partial',
      'upload.tmp',
      'something.partial',
    ];
    for (const name of leftovers) fs.writeFileSync(path.join(dir, name), SENTINEL);
    fs.mkdirSync(path.join(dir, '.stable-copy-0123456789abcdef'));
    fs.writeFileSync(path.join(dir, '.stable-copy-0123456789abcdef', 'burrow.db'), SENTINEL);
    const result = await run();
    const left = fs.readdirSync(dir);
    for (const name of [...leftovers, '.stable-copy-0123456789abcdef']) expect(left, name).not.toContain(name);
    expect(left).toContain(`burrow-${id}.db`);
    expect(left).toContain(`burrow-${id}.meta.json`);
    expect(result.backupsDeleted).toBe(false);
  });

  it('answers backup_busy at once while a backup holds the lock, and erases nothing', async () => {
    const { db } = seedEverything();
    const release = tryAcquire('backup');
    const before = rowCounts(db);
    await expect(run()).rejects.toMatchObject({ code: 'backup_busy', status: 409 });
    expect(rowCounts(db)).toEqual(before);
    expect(currentOp()).toBe('backup');
    release();
  });

  it('answers erase_busy (not backup_busy) while another erase holds the lock, and eraseUnavailable agrees', async () => {
    const { db } = seedEverything();
    expect(eraseUnavailable()).toBeNull();
    const release = tryAcquire('erase');
    const before = rowCounts(db);
    await expect(run()).rejects.toMatchObject({ code: 'erase_busy', status: 409 });
    expect(eraseUnavailable()).toMatchObject({ code: 'erase_busy' });
    expect(rowCounts(db)).toEqual(before);
    release();
    const backup = tryAcquire('backup');
    expect(eraseUnavailable()).toMatchObject({ code: 'backup_busy' });
    backup();
    const restore = tryAcquire('restore');
    expect(eraseUnavailable()).toMatchObject({ code: 'db_restoring' });
    restore();
    fs.writeFileSync(path.join(dataDir(), 'restore-journal.json'), '{}');
    expect(eraseUnavailable()).toMatchObject({ code: 'restore_pending' });
  });

  it('answers db_restoring while a restore holds the lock', async () => {
    seedEverything();
    const release = tryAcquire('restore');
    await expect(run()).rejects.toMatchObject({ code: 'db_restoring', status: 503 });
    release();
  });

  it('refuses while an interrupted restore waits for recovery', async () => {
    const { db } = seedEverything();
    fs.writeFileSync(path.join(dataDir(), 'restore-journal.json'), '{}');
    const before = rowCounts(db);
    await expect(run()).rejects.toMatchObject({ code: 'restore_pending' });
    expect(rowCounts(db)).toEqual(before);
    expect(isGateClosed()).toBe(false);
  });

  it('releases the lock and the request gate afterwards, success or failure', async () => {
    seedEverything();
    await run();
    expect(currentOp()).toBeNull();
    expect(isGateClosed()).toBe(false);
    await expect(run({ hooks: { afterWipe: () => { throw new Error('boom'); } } })).rejects.toBeInstanceOf(EraseError);
    expect(currentOp()).toBeNull();
    expect(isGateClosed()).toBe(false);
    __resetLockForTests();
  });
});

describe('request gate', () => {
  const answer = (req) =>
    new Promise((resolve) => {
      const res = { once: () => {}, set: () => res, status: (code) => ({ json: (body) => resolve({ code, body }) }) };
      restoreGateMiddleware(req, res, () => resolve('next'));
    });

  it('holds other /api requests back with 503 data_erasing while it runs, and lets the status route through', async () => {
    seedEverything();
    let during;
    let status;
    await run({
      hooks: {
        afterCommit: async () => {
          during = await answer({ method: 'GET', path: '/todos' });
          status = await answer({ method: 'GET', path: '/backups/status' });
        },
      },
    });
    expect(during).toEqual({
      code: 503,
      body: { error: 'data_erasing', code: 'data_erasing', message: 'Burrow is erasing your data. This takes a few seconds.' },
    });
    expect(status).toBe('next');
    expect(await answer({ method: 'GET', path: '/todos' })).toBe('next');
  });

  it('gives up with erase_busy when other requests do not finish, and erases nothing', async () => {
    const { db } = seedEverything();
    // A request that never finishes: counted by the gate, never released.
    restoreGateMiddleware({ method: 'GET', path: '/slow' }, { once: () => {} }, () => {});
    await expect(run({ drainTimeoutMs: 60 })).rejects.toMatchObject({ code: 'erase_busy', status: 409 });
    expect(rowCounts(db).notes).toBe(1);
    expect(isGateClosed()).toBe(false);
    __resetLockForTests();
  });
});

describe('atomicity', () => {
  it('a failure inside the transaction rolls everything back: rows, state, secrets, audit and files', async () => {
    const { db, dir } = seedEverything();
    const id = (await createBackup({ kind: 'manual' })).meta.id;
    const counts = rowCounts(db);
    const keys = stateKeys(db);
    const secrets = secretNames(db);
    const activation = fs.readFileSync(path.join(dir, 'license-activation.json'), 'utf8');
    const error = await run({
      deleteBackups: true,
      hooks: {
        afterWipe: () => {
          expect(rowCounts(db).notes).toBe(0); // the deletes really ran before the failure
          throw new Error('injected failure');
        },
      },
    }).catch((e) => e);
    expect(error).toMatchObject({ code: 'erase_failed', status: 500, message: 'Nothing was erased. Close and reopen Burrow, then try again.' });
    expect(rowCounts(db)).toEqual(counts);
    expect(stateKeys(db)).toEqual(keys);
    expect(secretNames(db)).toEqual(secrets);
    expect(fs.readFileSync(path.join(dir, 'license-activation.json'), 'utf8')).toBe(activation);
    expect(fs.existsSync(path.join(backupsDir(), `burrow-${id}.db`))).toBe(true);
    expect(select('audit_log', { columns: ['feature'], db }).map((r) => r.feature)).not.toContain('data_erased');
  });

  it('a failure after the commit says the data was erased and cleanup is unfinished; the database stays empty and consistent', async () => {
    const { db, dir } = seedEverything();
    fs.writeFileSync(path.join(dir, 'burrow.db.pre-v2.bak'), SENTINEL);
    const error = await run({
      hooks: {
        afterCommit: () => {
          throw new Error('disk went away');
        },
      },
    }).catch((e) => e);
    expect(error).toMatchObject({ code: 'erase_incomplete', status: 500 });
    expect(error.message).toMatch(/was erased/);
    expect(error.message).toMatch(/Erase all my data again/);
    expect(rowCounts(db).notes).toBe(0);
    expect(db.prepare('PRAGMA integrity_check').get().integrity_check).toBe('ok');
    // The steps are independent: the failing hook did not stop the file cleanup that follows it.
    expect(fs.existsSync(path.join(dir, 'burrow.db.pre-v2.bak'))).toBe(false);
    // Running it again finishes whatever is left.
    await run();
    for (const bytes of rawDbBytes(dir)) expect(bytes.includes(Buffer.from(SENTINEL))).toBe(false);
  });

  it('a checkpoint that reports busy is incomplete, yet the other cleanup steps still run', async () => {
    const { db, dir } = seedEverything();
    const id = (await createBackup({ kind: 'manual' })).meta.id;
    fs.writeFileSync(path.join(dir, 'burrow.db.pre-v2.bak'), SENTINEL);
    const seen = [];
    const error = await run({
      deleteBackups: true,
      checkpoint: (handle) => {
        seen.push('checkpoint');
        expect(handle).toBe(db);
        return { busy: 1, log: 10, checkpointed: 0 };
      },
    }).catch((e) => e);
    expect(error).toMatchObject({ code: 'erase_incomplete', status: 500 });
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(rowCounts(db).notes).toBe(0);
    // Leftovers and backups were still handled.
    expect(fs.existsSync(path.join(dir, 'burrow.db.pre-v2.bak'))).toBe(false);
    expect(fs.existsSync(path.join(backupsDir(), `burrow-${id}.db`))).toBe(false);
    // With a normal checkpoint the same call completes.
    await run({ deleteBackups: true });
  });

  it('runs the compaction before the file steps: a file step that fails cannot skip it', async () => {
    const { dir } = seedEverything();
    fs.mkdirSync(path.join(dir, 'restore-aside'));
    fs.writeFileSync(path.join(dir, 'restore-aside', 'burrow.db'), SENTINEL);
    const failing = createFsOps({
      rm: async (target, opts) => {
        if (String(target).includes('restore-aside')) throw Object.assign(new Error('disk error'), { code: 'EIO' });
        return createFsOps().rm(target, opts);
      },
    });
    const error = await run({ fsOps: failing }).catch((e) => e);
    expect(error).toMatchObject({ code: 'erase_incomplete' });
    // The database file itself is scrubbed even though restore-aside could not be removed.
    for (const bytes of rawDbBytes(dir)) expect(bytes.includes(Buffer.from(SENTINEL))).toBe(false);
  });

  it('one failing file step does not stop the others (the backups are still handled)', async () => {
    const { dir } = seedEverything();
    const id = (await createBackup({ kind: 'manual' })).meta.id;
    fs.mkdirSync(path.join(dir, 'restore-aside'));
    const failing = createFsOps({
      rm: async (target, opts) => {
        if (String(target).includes('restore-aside')) throw Object.assign(new Error('disk error'), { code: 'EIO' });
        return createFsOps().rm(target, opts);
      },
    });
    const error = await run({ fsOps: failing, deleteBackups: true }).catch((e) => e);
    expect(error).toMatchObject({ code: 'erase_incomplete' });
    expect(fs.existsSync(path.join(backupsDir(), `burrow-${id}.db`))).toBe(false);
  });

  it('keeps the backups moved aside by an import when their folder cannot be read (EPERM): erase_incomplete, nothing deleted', async () => {
    const { dir } = seedEverything();
    const stampDir = path.join(dir, IMPORT_ASIDE_DIR, '20260101T000000');
    fs.mkdirSync(path.join(stampDir, 'backups'), { recursive: true });
    fs.writeFileSync(path.join(stampDir, 'backups', 'burrow-20260101T000000Z-auto-aaaaaa.db'), 'kept');
    fs.writeFileSync(path.join(stampDir, 'burrow.db'), 'old data');
    const realReaddir = createFsOps().readdir;
    const failing = createFsOps({
      readdir: async (target, ...rest) => {
        if (path.resolve(String(target)) === path.resolve(stampDir)) throw Object.assign(new Error('denied'), { code: 'EPERM' });
        return realReaddir(target, ...rest);
      },
    });
    const error = await run({ fsOps: failing, deleteBackups: false }).catch((e) => e);
    expect(error).toMatchObject({ code: 'erase_incomplete' });
    expect(fs.readFileSync(path.join(stampDir, 'backups', 'burrow-20260101T000000Z-auto-aaaaaa.db'), 'utf8')).toBe('kept');
    // A second Erase, with the folder readable again, finishes: the old data goes, the backup stays.
    await run({});
    expect(fs.existsSync(path.join(stampDir, 'burrow.db'))).toBe(false);
    expect(fs.existsSync(path.join(stampDir, 'backups', 'burrow-20260101T000000Z-auto-aaaaaa.db'))).toBe(true);
  });

  it('an import-aside entry that is a plain file (ENOTDIR) is removed, and an unreadable import-aside root is reported', async () => {
    const { dir } = seedEverything();
    const aside = path.join(dir, IMPORT_ASIDE_DIR);
    fs.mkdirSync(aside, { recursive: true });
    fs.writeFileSync(path.join(aside, 'stray'), 'x');
    await run({});
    expect(fs.existsSync(path.join(aside, 'stray'))).toBe(false);
    fs.mkdirSync(path.join(aside, 'stamp'), { recursive: true });
    const realReaddir = createFsOps().readdir;
    const failing = createFsOps({
      readdir: async (target, ...rest) => {
        if (path.resolve(String(target)) === path.resolve(aside)) throw Object.assign(new Error('denied'), { code: 'EPERM' });
        return realReaddir(target, ...rest);
      },
    });
    expect(await run({ fsOps: failing }).catch((e) => e)).toMatchObject({ code: 'erase_incomplete' });
    expect(fs.existsSync(path.join(aside, 'stamp'))).toBe(true);
  });

  it('restores the connection secure_delete setting', async () => {
    const { db } = seedEverything();
    const read = () => Number(db.prepare('PRAGMA secure_delete').get().secure_delete);
    const before = read();
    await run();
    expect(read()).toBe(before);
  });

  it('survives a database that is in maintenance (restore swap): erase_failed, nothing erased', async () => {
    const { db } = seedEverything();
    setDbMaintenance(true);
    await expect(run()).rejects.toMatchObject({ code: 'erase_failed' });
    setDbMaintenance(false);
    expect(rowCounts(db).notes).toBe(1);
  });
});

describe('the sentinel is gone from every file', () => {
  const KEPT_FILES = ['secrets.key'];

  it('covers every text, json and text[] column of every table (only constraint-limited columns are skipped)', async () => {
    seedEverything();
    const { planted, skipped } = plantSentinelEverywhere();
    const texty = Object.entries(TABLES).flatMap(([table, def]) =>
      Object.entries(def.columns).filter(([, type]) => ['text', 'jsonb', 'text[]'].includes(type)).map(([column]) => `${table}.${column}`),
    );
    expect([...planted, ...skipped].sort()).toEqual(texty.sort());
    // Columns with an enum, pattern or length CHECK refuse the sentinel; everything else must take it.
    expect(skipped.sort()).toEqual(
      ['app_secrets.last4', 'app_secrets.name', 'audit_log.feature', 'audit_log.kind', 'audit_log.provider', 'audit_log.status', 'folders.confirm_state'].sort(),
    );
    for (const table of ['jarvis_messages', 'jarvis_memory', 'app_state', 'audit_log', 'transactions']) {
      expect(planted.some((p) => p.startsWith(`${table}.`)), table).toBe(true);
    }
  });

  it('leaves the sentinel in no file of the data folder except backups/ and secrets.key', async () => {
    const { dir } = seedEverything();
    plantSentinelEverywhere();
    const backupId = (await createBackup({ kind: 'manual' })).meta.id;
    fs.writeFileSync(path.join(dir, 'burrow.db.pre-v2.bak'), SENTINEL);
    fs.mkdirSync(path.join(dir, 'restore-aside'));
    fs.writeFileSync(path.join(dir, 'restore-aside', 'burrow.db'), SENTINEL);
    // Control: it really is on disk before the erase (database, WAL or copies).
    expect(filesContaining(dir, SENTINEL, { skipDirs: ['backups'], skipFiles: KEPT_FILES }).length).toBeGreaterThan(0);
    await run();
    expect(filesContaining(dir, SENTINEL, { skipDirs: ['backups'], skipFiles: KEPT_FILES })).toEqual([]);
    // The backup the user kept is untouched (that is what the dialog says).
    expect(fs.existsSync(path.join(backupsDir(), `burrow-${backupId}.db`))).toBe(true);
  });

  it('with backups deleted too, no file of the data folder holds it, backups/ included', async () => {
    const { dir } = seedEverything();
    plantSentinelEverywhere();
    await createBackup({ kind: 'manual' });
    await run({ deleteBackups: true });
    expect(filesContaining(dir, SENTINEL, { skipFiles: KEPT_FILES })).toEqual([]);
  });
});

describe('POST /api/export and the disk', () => {
  const listFiles = (dir) =>
    fs
      .readdirSync(dir, { recursive: true })
      .map(String)
      .filter((name) => !/^burrow\.db(-wal|-shm)?$/.test(name))
      .sort();

  it('builds the ZIP in memory: it leaves no temporary file anywhere in the data folder, so there is nothing to sweep', async () => {
    const { dir } = seedEverything();
    const before = listFiles(dir);
    const app = express();
    registerExportRoutes(app);
    const res = await request(app).post('/api/export').send({}).buffer(true).parse((r, cb) => {
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(100);
    expect(listFiles(dir)).toEqual(before);
  });
});

describe('secure delete and VACUUM', () => {
  it('leaves the sentinel in no byte of burrow.db, burrow.db-wal or burrow.db-shm', async () => {
    const { dir } = seedEverything();
    // Control: before the erase the sentinel really is on disk (journal entry and note).
    const control = Buffer.concat(rawDbBytes(dir));
    expect(control.includes(Buffer.from(SENTINEL))).toBe(true);
    await run();
    for (const bytes of rawDbBytes(dir)) expect(bytes.includes(Buffer.from(SENTINEL))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'burrow.db'))).toBe(true);
  });

  it('a retry after a failed cleanup scrubs the file bytes too', async () => {
    const { dir } = seedEverything();
    await run({ hooks: { afterCommit: () => { throw new Error('x'); } } }).catch(() => {});
    await run();
    for (const bytes of rawDbBytes(dir)) expect(bytes.includes(Buffer.from(SENTINEL))).toBe(false);
  });
});
