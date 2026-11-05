// Restore: round trip with the safety copy, newer-schema refusal, upload handling, the journaled
// swap killed at every step, Windows file locks, and startup recovery. Real files; faults are
// injected through the FsOps seam and the restore hooks.
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { DbError, closeDb, getDb, insert, remove, select, setDbMaintenance } from '../db/index.js';
import { flushRecoveryAudit, createBackup, getBackupStatus, isBackupDue, runScheduledBackup } from '../backup/service.js';
import { createFsOps, renameWithRetry, rmWithRetry } from '../backup/fsops.js';
import { __resetLockForTests, currentOp, isGateClosed, tryAcquire } from '../backup/lock.js';
import { listMetas, readMeta, readState } from '../backup/manifest.js';
import { backupsDir } from '../backup/paths.js';
import {
  BACKUP_UPLOAD_MAX_BYTES,
  UPLOAD_TTL_MS,
  __resetUploadsForTests,
  hasPendingUpload,
  inspectUpload,
  reconcileRestoreJournal,
  restoreBackup,
  validateCandidate,
} from '../backup/restore.js';
import { getBackupSettings, saveBackupSettings } from '../backup/settings.js';
import { latestSchemaVersion } from '../backup/snapshot.js';
import {
  backupFile,
  cleanupBackupEnv,
  crashAfter,
  dataDir,
  day,
  ebusy,
  enospc,
  fakeUploadReq,
  integrityOf,
  names,
  noSleep,
  noteBodies,
  readJson,
  resetBackupEnv,
  rewriteBackupDb,
  sha256Of,
  statfsFree,
  withReadOnly,
  writeSqliteFile,
} from './helpers/backupEnv.js';

beforeEach(() => {
  resetBackupEnv();
});
afterAll(() => {
  cleanupBackupEnv();
});

const live = () => path.join(dataDir(), 'burrow.db');
const liveNotes = () => select('notes').map((n) => n.body).sort();
const leftovers = () =>
  fs.readdirSync(dataDir()).filter((n) => /^restore-/.test(n) || n.endsWith('.bak'));
const auditRows = (feature) => select('audit_log').filter((r) => r.feature === feature);
const metaOf = (row) => (typeof row.meta === 'string' ? JSON.parse(row.meta) : row.meta);
const NEWER_MESSAGE = 'This backup was made by a newer version of Burrow. Update Burrow, then try again.';

/** A manual backup of the current data; returns its meta. */
async function backUp(when = day(1)) {
  return (await createBackup({ kind: 'manual', now: when })).meta;
}
const safeties = async () => (await listMetas(backupsDir())).filter((m) => m.kind === 'safety');

describe('restore round trip', () => {
  it('brings back the saved data, keeps a verified safety copy of the pre-restore data, and carries settings over', async () => {
    insert('notes', { body: 'saved-1' });
    insert('notes', { body: 'saved-2' });
    insert('todos', { title: 'saved todo' });
    await saveBackupSettings({ keepDaily: 5, keepWeekly: 1, keepMonthly: 2 });
    const backup = await backUp();

    insert('notes', { body: 'later' });
    remove('notes', { where: { body: 'saved-1' } });
    await saveBackupSettings({ keepDaily: 3, keepWeekly: 0, keepMonthly: 0 });
    const beforeRestore = liveNotes();
    expect(beforeRestore).toEqual(['later', 'saved-2']);

    const result = await restoreBackup({ id: backup.id, now: day(2) });
    expect(result).toMatchObject({ restoredFrom: backup.id, schemaFrom: latestSchemaVersion(), schemaTo: latestSchemaVersion() });
    expect(result.totalRows).toBe(backup.totalRows);

    // Data equals the snapshot.
    expect(liveNotes()).toEqual(['saved-1', 'saved-2']);
    expect(select('todos').map((t) => t.title)).toEqual(['saved todo']);
    expect(getDb().prepare('PRAGMA integrity_check').all().map((r) => r.integrity_check)).toEqual(['ok']);
    expect(getDb().prepare('PRAGMA foreign_key_check').all()).toEqual([]);

    // The safety copy exists, is verified, and holds the pre-restore data.
    const [safety] = await safeties();
    expect(safety.id).toBe(result.safetyBackupId);
    expect(safety.status).toBe('verified');
    expect(safety.createdAt).toBe(day(2).toISOString());
    expect(noteBodies(backupFile(safety.id, '.db'))).toEqual(beforeRestore);
    expect(integrityOf(backupFile(safety.id, '.db'))).toEqual(['ok']);
    expect(safety.db.sha256).toBe(sha256Of(backupFile(safety.id, '.db')));

    // Settings belong to this install, not the backup.
    expect(await getBackupSettings()).toEqual({ keepDaily: 3, keepWeekly: 0, keepMonthly: 0 });

    // Audit row in the new database, counts only.
    const [row] = auditRows('backup_restore');
    expect(row).toMatchObject({ kind: 'export', status: 'ok' });
    expect(metaOf(row)).toMatchObject({ source: 'list', rows: backup.totalRows, from_version: latestSchemaVersion(), migrated: false });
    expect(JSON.stringify(row)).not.toContain('saved-1');

    // State and files.
    const state = await readState();
    expect(state.lastRestore).toEqual({ at: day(2).toISOString(), outcome: 'restored', sourceId: backup.id });
    expect((await getBackupStatus({ now: day(2) })).lastRestore.outcome).toBe('restored');
    expect(leftovers()).toEqual([]);
    expect(isGateClosed()).toBe(false);
    expect(currentOp()).toBeNull();

    // The source backup was not modified by being restored.
    expect(backup.db.sha256).toBe(sha256Of(backupFile(backup.id, '.db')));
  });

  it('the restored database keeps working: new writes, a new backup, and a second restore', async () => {
    insert('notes', { body: 'one' });
    const backup = await backUp();
    insert('notes', { body: 'two' });
    await restoreBackup({ id: backup.id, now: day(2) });
    insert('notes', { body: 'three' });
    expect(liveNotes()).toEqual(['one', 'three']);
    const second = await backUp(day(3));
    expect(noteBodies(backupFile(second.id, '.db'))).toEqual(['one', 'three']);
    await restoreBackup({ id: backup.id, now: day(4) });
    expect(liveNotes()).toEqual(['one']);
    expect(await safeties()).toHaveLength(2);
  });

  it('restoring when the live handle has uncheckpointed WAL data keeps that data in the safety copy', async () => {
    insert('notes', { body: 'base' });
    const backup = await backUp();
    for (let i = 0; i < 20; i += 1) insert('notes', { body: `wal-${i}` });
    const result = await restoreBackup({ id: backup.id, now: day(2) });
    expect(noteBodies(backupFile(result.safetyBackupId, '.db'))).toHaveLength(21);
    expect(liveNotes()).toEqual(['base']);
  });

  it('during the swap getDb throws db_restoring, the gate is closed, and other operations are refused', async () => {
    insert('notes', { body: 'x' });
    const backup = await backUp();
    const seen = [];
    const hooks = {
      sleep: noSleep,
      afterStep: async (name) => {
        if (name !== 'journal_written') return;
        let thrown = null;
        try {
          getDb();
        } catch (e) {
          thrown = e;
        }
        seen.push({ name, code: thrown?.code, isDbError: thrown instanceof DbError, status: thrown?.status });
        seen.push({ gate: isGateClosed(), op: currentOp() });
        const attempts = {};
        attempts.backup = await createBackup({ kind: 'manual' }).then(
          () => 'ok',
          (e) => e.code,
        );
        attempts.restore = await restoreBackup({ id: backup.id }).then(
          () => 'ok',
          (e) => e.code,
        );
        seen.push(attempts);
        seen.push({ status: await getBackupStatus() });
      },
    };
    await restoreBackup({ id: backup.id, hooks, now: day(2) });
    expect(seen[0]).toMatchObject({ code: 'db_restoring', isDbError: true });
    expect(seen[1]).toEqual({ gate: true, op: 'restore' });
    expect(seen[2]).toEqual({ backup: 'db_restoring', restore: 'db_restoring' });
    expect(seen[3].status.restoring).toBe(true);
    // Afterwards everything is open again.
    expect(() => getDb()).not.toThrow();
    expect(isGateClosed()).toBe(false);
    expect((await getBackupStatus()).restoring).toBe(false);
  });

  it('refuses to start while a backup holds the lock (backup_busy) and changes nothing', async () => {
    insert('notes', { body: 'x' });
    const backup = await backUp();
    insert('notes', { body: 'y' });
    const release = tryAcquire('backup');
    try {
      await expect(restoreBackup({ id: backup.id })).rejects.toMatchObject({ code: 'backup_busy', status: 409 });
    } finally {
      release();
    }
    expect(liveNotes()).toEqual(['x', 'y']);
    expect(await safeties()).toEqual([]);
  });

  it('a restore of a restore point taken at an older schema version still ends on the latest schema', async () => {
    insert('notes', { body: 'x' });
    const backup = await backUp();
    const result = await restoreBackup({ id: backup.id });
    expect(withReadOnly(live(), (db) => db.prepare('SELECT MAX(version) AS v FROM schema_version').get().v)).toBe(result.schemaTo);
  });
});

describe('request validation inside restoreBackup', () => {
  it.each([
    ['neither id nor token', {}],
    ['both id and token', { id: '20260101T000000Z-manual-aaaaaa', uploadToken: 'a'.repeat(32) }],
    ['a non-string id', { id: 42 }],
    ['a malformed token', { uploadToken: 'xyz' }],
    ['an uppercase token', { uploadToken: 'A'.repeat(32) }],
    ['a token with a trailing character', { uploadToken: `${'a'.repeat(32)}0` }],
    ['a non-string token', { uploadToken: 12345 }],
  ])('%s is invalid_request (400)', async (_label, args) => {
    await expect(restoreBackup(args)).rejects.toMatchObject({ code: 'invalid_request', status: 400 });
    expect(currentOp()).toBeNull();
  });

  it.each(['../x', '..\\x', 'C:\\Windows\\win.ini', '/etc/passwd', '20260101T000000Z-manual-AAAAAA', '20260101T000000Z-weekly-aaaaaa', ''])(
    'id %j is backup_not_found (404)',
    async (id) => {
      await expect(restoreBackup({ id })).rejects.toMatchObject({ code: 'backup_not_found', status: 404 });
    },
  );

  it('a well-formed id with no backup is backup_not_found, and nothing is changed', async () => {
    insert('notes', { body: 'x' });
    await expect(restoreBackup({ id: '20260101T000000Z-manual-aaaaaa' })).rejects.toMatchObject({ code: 'backup_not_found' });
    expect(liveNotes()).toEqual(['x']);
    expect(await safeties()).toEqual([]);
    expect(leftovers()).toEqual([]);
    expect(currentOp()).toBeNull();
  });

  it('a failed backup cannot be restored', async () => {
    insert('notes', { body: 'x' });
    await expect(
      createBackup({
        kind: 'manual',
        now: day(1),
        snapshotFn: () => {
          throw new Error('x');
        },
      }),
    ).rejects.toThrow();
    const [failed] = await listMetas(backupsDir());
    await expect(restoreBackup({ id: failed.id })).rejects.toMatchObject({ code: 'backup_not_found' });
  });

  it('a backup whose .db is gone is backup_not_found', async () => {
    insert('notes', { body: 'x' });
    const backup = await backUp();
    fs.rmSync(backupFile(backup.id, '.db'));
    await expect(restoreBackup({ id: backup.id })).rejects.toMatchObject({ code: 'backup_not_found' });
    expect(liveNotes()).toEqual(['x']);
  });

  it('a backup file changed after it was made fails the hash check (backup_invalid) before anything is touched', async () => {
    insert('notes', { body: 'x' });
    const backup = await backUp();
    insert('notes', { body: 'live-only' });
    fs.appendFileSync(backupFile(backup.id, '.db'), 'tamper');
    await expect(restoreBackup({ id: backup.id })).rejects.toMatchObject({ code: 'backup_invalid', status: 422 });
    expect(liveNotes()).toEqual(['live-only', 'x']);
    expect(await safeties()).toEqual([]);
    expect(leftovers()).toEqual([]);
  });

  it('a meta whose id does not match its file name is ignored', async () => {
    insert('notes', { body: 'x' });
    const backup = await backUp();
    const other = '20260102T000000Z-manual-bbbbbb';
    fs.copyFileSync(backupFile(backup.id, '.db'), backupFile(other, '.db'));
    fs.writeFileSync(backupFile(other, '.meta.json'), fs.readFileSync(backupFile(backup.id, '.meta.json')));
    expect(await readMeta(other, backupsDir())).toBeNull();
    await expect(restoreBackup({ id: other })).rejects.toMatchObject({ code: 'backup_not_found' });
  });

  it('a failed restore is recorded in state and in the audit log (code only)', async () => {
    insert('notes', { body: 'x' });
    await backUp();
    await expect(restoreBackup({ id: '20260101T000000Z-manual-aaaaaa', now: day(2) })).rejects.toThrow();
    expect((await readState()).lastRestore).toEqual({ at: day(2).toISOString(), outcome: 'failed', sourceId: '20260101T000000Z-manual-aaaaaa' });
    const [row] = auditRows('backup_restore');
    expect(row.status).toBe('error');
    expect(metaOf(row)).toEqual({ source: 'list', error: 'backup_not_found' });
  });
});

describe('newer-schema refusal', () => {
  const makeTooNew = (id) =>
    rewriteBackupDb(id, (db) => {
      db.prepare('INSERT INTO schema_version (version, name, applied_at) VALUES (?, ?, ?)').run(
        latestSchemaVersion() + 1,
        'from_the_future',
        '2030-01-01T00:00:00.000Z',
      );
    });

  it('by id: 409 backup_too_new with the plain message, live data unchanged, no safety copy', async () => {
    insert('notes', { body: 'before' });
    const backup = await backUp();
    makeTooNew(backup.id);
    insert('notes', { body: 'live-only' });
    const metasBefore = (await listMetas(backupsDir())).map((m) => m.id);

    const error = await restoreBackup({ id: backup.id, now: day(2) }).catch((e) => e);
    expect(error).toMatchObject({ code: 'backup_too_new', status: 409, message: NEWER_MESSAGE });

    expect(liveNotes()).toEqual(['before', 'live-only']);
    expect((await listMetas(backupsDir())).map((m) => m.id)).toEqual(metasBefore);
    expect(await safeties()).toEqual([]);
    expect(leftovers()).toEqual([]);
    expect(currentOp()).toBeNull();
    expect(isGateClosed()).toBe(false);
    expect(() => getDb()).not.toThrow();
  });

  it('by upload: the file is refused at upload with the same error and nothing is kept', async () => {
    insert('notes', { body: 'before' });
    const backup = await backUp();
    makeTooNew(backup.id);
    insert('notes', { body: 'live-only' });
    const bytes = fs.readFileSync(backupFile(backup.id, '.db'));

    const error = await inspectUpload(fakeUploadReq(bytes), { now: day(2) }).catch((e) => e);
    expect(error).toMatchObject({ code: 'backup_too_new', status: 409, message: NEWER_MESSAGE });
    expect(hasPendingUpload()).toBe(false);
    expect(names().filter((n) => n.startsWith('.incoming-'))).toEqual([]);
    expect(liveNotes()).toEqual(['before', 'live-only']);
    expect(await safeties()).toEqual([]);
  });

  it('a backup exactly one version newer is refused; the same version is accepted', async () => {
    insert('notes', { body: 'x' });
    const backup = await backUp();
    const bytes = fs.readFileSync(backupFile(backup.id, '.db'));
    await expect(inspectUpload(fakeUploadReq(bytes))).resolves.toMatchObject({ schemaVersion: latestSchemaVersion(), migrationNeeded: false });
  });

  it('validateCandidate reports too new before the shape check', async () => {
    insert('notes', { body: 'x' });
    const backup = await backUp();
    rewriteBackupDb(backup.id, (db) => {
      db.prepare('INSERT INTO schema_version (version, name, applied_at) VALUES (?, ?, ?)').run(latestSchemaVersion() + 1, 'f', '2030-01-01T00:00:00.000Z');
      db.exec('CREATE TABLE future_table (x)');
    });
    await expect(validateCandidate(backupFile(backup.id, '.db'))).rejects.toMatchObject({ code: 'backup_too_new' });
  });
});

describe('backups that must be refused as invalid', () => {
  const invalidate = (id, edit) => rewriteBackupDb(id, edit);

  it.each([
    ['an extra trigger', (db) => db.exec('CREATE TRIGGER evil AFTER INSERT ON notes BEGIN DELETE FROM todos; END')],
    ['an extra view', (db) => db.exec('CREATE VIEW sneaky AS SELECT body FROM notes')],
    ['an extra table', (db) => db.exec('CREATE TABLE extra_stuff (x TEXT)')],
    ['an extra index', (db) => db.exec('CREATE INDEX extra_idx ON notes (body)')],
    ['a missing table', (db) => db.exec('DROP TABLE countdowns')],
  ])('by id: %s is 422 backup_invalid with live data unchanged and no safety copy', async (_label, edit) => {
    insert('notes', { body: 'before' });
    const backup = await backUp();
    insert('notes', { body: 'live-only' });
    invalidate(backup.id, edit);
    await expect(restoreBackup({ id: backup.id, now: day(2) })).rejects.toMatchObject({ code: 'backup_invalid', status: 422 });
    expect(liveNotes()).toEqual(['before', 'live-only']);
    expect(await safeties()).toEqual([]);
    expect(leftovers()).toEqual([]);
  });

  it('by upload: a file with an extra trigger is 422 and the upload is not kept', async () => {
    insert('notes', { body: 'before' });
    const backup = await backUp();
    invalidate(backup.id, (db) => db.exec('CREATE TRIGGER evil AFTER INSERT ON notes BEGIN DELETE FROM todos; END'));
    await expect(inspectUpload(fakeUploadReq(fs.readFileSync(backupFile(backup.id, '.db'))))).rejects.toMatchObject({ code: 'backup_invalid' });
    expect(hasPendingUpload()).toBe(false);
    expect(names().filter((n) => n.startsWith('.incoming-'))).toEqual([]);
  });

  it('a plain sqlite file with no schema_version table is backup_invalid', async () => {
    const file = path.join(dataDir(), 'foreign.db');
    const bytes = writeSqliteFile(file, (db) => db.exec('CREATE TABLE things (a); INSERT INTO things VALUES (1)'));
    await expect(inspectUpload(fakeUploadReq(bytes))).rejects.toMatchObject({ code: 'backup_invalid', status: 422 });
  });

  it.each([
    ['random bytes', Buffer.from('this is definitely not a database file at all, just text '.repeat(40))],
    ['a ZIP export', Buffer.concat([Buffer.from('PK\u0003\u0004'), Buffer.alloc(300, 1)])],
    ['only the header magic', Buffer.from('SQLite format 3\0')],
    ['a header with garbage after it', Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(4096, 0xab)])],
    ['an empty body', Buffer.alloc(0)],
  ])('upload of %s is 422 backup_invalid and leaves no file behind', async (_label, bytes) => {
    const error = await inspectUpload(fakeUploadReq(bytes.length ? bytes : [Buffer.alloc(0)])).catch((e) => e);
    expect(error).toMatchObject({ code: 'backup_invalid', status: 422 });
    expect(hasPendingUpload()).toBe(false);
    expect(names().filter((n) => n.startsWith('.incoming-'))).toEqual([]);
  });

  it('a truncated backup file fails validation', async () => {
    insert('notes', { body: 'x' });
    const backup = await backUp();
    const bytes = fs.readFileSync(backupFile(backup.id, '.db'));
    await expect(inspectUpload(fakeUploadReq(bytes.subarray(0, Math.floor(bytes.length / 2))))).rejects.toMatchObject({ code: 'backup_invalid' });
  });

  it('validateCandidate checks the expected hash when given one', async () => {
    insert('notes', { body: 'x' });
    const backup = await backUp();
    const file = backupFile(backup.id, '.db');
    await expect(validateCandidate(file, { expectedSha256: backup.db.sha256 })).resolves.toMatchObject({ integrityOk: true, shapeOk: true });
    await expect(validateCandidate(file, { expectedSha256: '0'.repeat(64) })).rejects.toMatchObject({ code: 'backup_invalid' });
    await expect(validateCandidate(path.join(dataDir(), 'does-not-exist.db'))).rejects.toMatchObject({ code: 'backup_invalid' });
  });
});

describe('upload of a backup file', () => {
  async function backupBytes(body = 'uploaded') {
    insert('notes', { body });
    const backup = await backUp();
    return { backup, bytes: fs.readFileSync(backupFile(backup.id, '.db')) };
  }

  it('inspects the file and returns a token, expiry, versions and counts', async () => {
    const { backup, bytes } = await backupBytes();
    const info = await inspectUpload(fakeUploadReq(bytes), { now: day(1) });
    expect(info.uploadToken).toMatch(/^[0-9a-f]{32}$/);
    expect(info).toMatchObject({
      bytes: bytes.length,
      schemaVersion: latestSchemaVersion(),
      appSchemaVersion: latestSchemaVersion(),
      migrationNeeded: false,
      totalRows: backup.totalRows,
      expiresAt: new Date(day(1).getTime() + UPLOAD_TTL_MS).toISOString(),
    });
    expect(info.rowCounts.notes).toBe(1);
    expect(UPLOAD_TTL_MS).toBe(15 * 60 * 1000);
    expect(names().filter((n) => n.startsWith('.incoming-'))).toEqual([`.incoming-${info.uploadToken}.db`]);
    expect(hasPendingUpload()).toBe(true);
  });

  it('restore from the token swaps the data in, consumes the upload, and audits source "file"', async () => {
    const { bytes } = await backupBytes('from-file');
    insert('notes', { body: 'live-only' });
    const info = await inspectUpload(fakeUploadReq(bytes), { now: day(1) });
    const result = await restoreBackup({ uploadToken: info.uploadToken, now: day(1) });
    expect(result.restoredFrom).toBe('upload');
    expect(liveNotes()).toEqual(['from-file']);
    expect(names().filter((n) => n.startsWith('.incoming-'))).toEqual([]);
    expect(hasPendingUpload()).toBe(false);
    expect(metaOf(auditRows('backup_restore')[0]).source).toBe('file');
    expect((await readState()).lastRestore).toMatchObject({ outcome: 'restored', sourceId: 'upload' });
    expect(noteBodies(backupFile(result.safetyBackupId, '.db'))).toEqual(['from-file', 'live-only']);
    // A token works once.
    await expect(restoreBackup({ uploadToken: info.uploadToken })).rejects.toMatchObject({ code: 'upload_expired', status: 410 });
  });

  it('a token expires after 15 minutes (410 upload_expired) and the file is removed', async () => {
    const { bytes } = await backupBytes();
    const info = await inspectUpload(fakeUploadReq(bytes), { now: day(1) });
    const late = new Date(day(1).getTime() + UPLOAD_TTL_MS + 1000);
    await expect(restoreBackup({ uploadToken: info.uploadToken, now: late })).rejects.toMatchObject({ code: 'upload_expired' });
    expect(names().filter((n) => n.startsWith('.incoming-'))).toEqual([]);
    expect(hasPendingUpload()).toBe(false);
  });

  it('a token just inside the window still works', async () => {
    const { bytes } = await backupBytes();
    const info = await inspectUpload(fakeUploadReq(bytes), { now: day(1) });
    const almost = new Date(day(1).getTime() + UPLOAD_TTL_MS - 1000);
    await expect(restoreBackup({ uploadToken: info.uploadToken, now: almost })).resolves.toMatchObject({ restoredFrom: 'upload' });
  });

  it('a well-formed token that was never issued is upload_expired (410)', async () => {
    await expect(restoreBackup({ uploadToken: 'a'.repeat(32) })).rejects.toMatchObject({ code: 'upload_expired', status: 410 });
  });

  it('restoring with another well-formed token does not discard the real pending upload', async () => {
    const { bytes } = await backupBytes();
    const info = await inspectUpload(fakeUploadReq(bytes));
    await expect(restoreBackup({ uploadToken: 'b'.repeat(32) })).rejects.toMatchObject({ code: 'upload_expired' });
    expect(hasPendingUpload()).toBe(true);
    await expect(restoreBackup({ uploadToken: info.uploadToken })).resolves.toMatchObject({ restoredFrom: 'upload' });
  });

  it('only one upload is pending: a new one discards the old one and its file', async () => {
    const { bytes } = await backupBytes();
    const first = await inspectUpload(fakeUploadReq(bytes));
    const second = await inspectUpload(fakeUploadReq(bytes));
    expect(second.uploadToken).not.toBe(first.uploadToken);
    expect(names().filter((n) => n.startsWith('.incoming-'))).toEqual([`.incoming-${second.uploadToken}.db`]);
    await expect(restoreBackup({ uploadToken: first.uploadToken })).rejects.toMatchObject({ code: 'upload_expired' });
  });

  it('a new upload attempt, even one that gets rejected, replaces the pending upload', async () => {
    const { bytes } = await backupBytes();
    const good = await inspectUpload(fakeUploadReq(bytes));
    await expect(inspectUpload(fakeUploadReq(Buffer.from('garbage garbage garbage')))).rejects.toMatchObject({ code: 'backup_invalid' });
    // The replace rule applies before streaming, so the earlier token is gone; the user uploads again.
    await expect(restoreBackup({ uploadToken: good.uploadToken })).rejects.toMatchObject({ code: 'upload_expired' });
  });

  it('a Content-Length above the cap is refused before anything is written (413 too_large)', async () => {
    const req = fakeUploadReq([Buffer.from('x')], { 'content-length': String(BACKUP_UPLOAD_MAX_BYTES + 1) });
    await expect(inspectUpload(req)).rejects.toMatchObject({ code: 'too_large', status: 413 });
    expect(names().filter((n) => n.startsWith('.incoming-'))).toEqual([]);
  });

  it('a Content-Length exactly at the cap passes the early check (and then fails as not a backup)', async () => {
    const req = fakeUploadReq([Buffer.from('tiny')], { 'content-length': String(BACKUP_UPLOAD_MAX_BYTES) });
    await expect(inspectUpload(req)).rejects.toMatchObject({ code: 'backup_invalid' });
  });

  it('too little free space is disk_low (507) and nothing is written', async () => {
    const { bytes } = await backupBytes();
    const fsOps = createFsOps({ statfs: statfsFree(100 * 1024 * 1024) });
    await expect(inspectUpload(fakeUploadReq(bytes), { fsOps })).rejects.toMatchObject({ code: 'disk_low', status: 507 });
    expect(names().filter((n) => n.startsWith('.incoming-'))).toEqual([]);
  });

  it('ENOSPC while streaming is disk_full (507) and the partial file is removed', async () => {
    const { bytes } = await backupBytes();
    const real = createFsOps();
    const fsOps = createFsOps({
      open: async (file, ...rest) => {
        const handle = await real.open(file, ...rest);
        if (!String(file).includes('.incoming-')) return handle;
        return {
          write: async () => {
            throw enospc();
          },
          sync: () => handle.sync(),
          close: () => handle.close(),
        };
      },
    });
    await expect(inspectUpload(fakeUploadReq(bytes), { fsOps })).rejects.toMatchObject({ code: 'disk_full', status: 507 });
    expect(names().filter((n) => n.startsWith('.incoming-'))).toEqual([]);
  });

  it('a request stream that errors mid-way is invalid_request and removes the partial file', async () => {
    const { bytes } = await backupBytes();
    async function* broken() {
      yield bytes.subarray(0, 100);
      throw new Error('socket hang up');
    }
    const req = broken();
    req.headers = {};
    await expect(inspectUpload(req)).rejects.toMatchObject({ code: 'invalid_request', status: 400 });
    expect(names().filter((n) => n.startsWith('.incoming-'))).toEqual([]);
  });

  it('uploaded files are created owner-only where the platform supports it', async () => {
    const { bytes } = await backupBytes();
    const info = await inspectUpload(fakeUploadReq(bytes));
    if (process.platform !== 'win32') {
      expect(fs.statSync(path.join(backupsDir(), `.incoming-${info.uploadToken}.db`)).mode & 0o077).toBe(0);
    }
  });
});

describe('atomic swap killed mid-restore at every step', () => {
  const CASES = [
    { step: 'journal_written', action: 'rolled_back', data: 'pre' },
    { step: 'aside_moved', action: 'rolled_back', data: 'pre' },
    { step: 'staging_swapped', action: 'rolled_forward', data: 'backup' },
    { step: 'journal_swapped', action: 'rolled_forward', data: 'backup' },
  ];

  async function crashedRestore(step, { fromUpload = false } = {}) {
    insert('notes', { body: 'backup-note' });
    const backup = await backUp();
    insert('notes', { body: 'live-only-note' });
    let args = { id: backup.id };
    if (fromUpload) {
      const info = await inspectUpload(fakeUploadReq(fs.readFileSync(backupFile(backup.id, '.db'))), { now: day(2) });
      args = { uploadToken: info.uploadToken };
    }
    await expect(restoreBackup({ ...args, now: day(2), hooks: crashAfter(step) })).rejects.toMatchObject({ code: 'simulated_crash' });
    // A killed process takes its open handle, its lock and its in-memory switches with it: do the same.
    closeDb();
    __resetLockForTests();
    setDbMaintenance(false);
    return backup;
  }

  describe.each(CASES)('killed right after $step', ({ step, action, data }) => {
    it(`startup recovery ${action}: the database is whole, ${data === 'pre' ? 'pre-restore' : 'backup'} data, nothing left over`, async () => {
      const backup = await crashedRestore(step);
      // The journal is what tells the next start a restore was interrupted.
      expect(fs.existsSync(path.join(dataDir(), 'restore-journal.json'))).toBe(true);

      const result = await reconcileRestoreJournal({ now: day(3) });
      expect(result).toEqual({ action, recovered: true });

      expect(liveNotes()).toEqual(data === 'pre' ? ['backup-note', 'live-only-note'] : ['backup-note']);
      expect(getDb().prepare('PRAGMA integrity_check').all().map((r) => r.integrity_check)).toEqual(['ok']);
      expect(getDb().prepare('SELECT MAX(version) AS v FROM schema_version').get().v).toBe(latestSchemaVersion());

      expect(fs.existsSync(path.join(dataDir(), 'restore-journal.json'))).toBe(false);
      expect(fs.existsSync(path.join(dataDir(), 'restore-staging'))).toBe(false);
      expect(fs.existsSync(path.join(dataDir(), 'restore-aside'))).toBe(false);
      expect(leftovers()).toEqual([]);

      const state = await readState();
      expect(state.lastRestore).toEqual({ at: day(3).toISOString(), outcome: action, sourceId: backup.id });
      expect(state.pendingRecoveryAudit).toBe(action);

      // Recovery audit is written once the database is open, then cleared.
      await flushRecoveryAudit();
      const rows = auditRows('backup_restore');
      expect(rows).toHaveLength(1);
      // Finishing the restore is a success; undoing it is an error.
      expect(rows[0].status).toBe(action === 'rolled_forward' ? 'ok' : 'error');
      expect(metaOf(rows[0])).toEqual({ recovered: action });
      expect((await readState()).pendingRecoveryAudit).toBeNull();
      await flushRecoveryAudit();
      expect(auditRows('backup_restore')).toHaveLength(1);

      // The safety copy taken before the swap is there either way.
      expect(await safeties()).toHaveLength(1);
      // A second start has nothing to do.
      expect(await reconcileRestoreJournal({ now: day(4) })).toEqual({ action: 'none', recovered: false });
    });

    it('the app works after recovery: writes and a new backup', async () => {
      await crashedRestore(step);
      await reconcileRestoreJournal();
      expect(() => insert('notes', { body: 'after recovery' })).not.toThrow();
      expect(liveNotes()).toContain('after recovery');
      const next = await backUp(day(5));
      expect(next.status).toBe('verified');
    });

    it('the same holds when the restore came from an uploaded file', async () => {
      await crashedRestore(step, { fromUpload: true });
      const result = await reconcileRestoreJournal({ now: day(3) });
      expect(result.action).toBe(action);
      expect(liveNotes()).toEqual(data === 'pre' ? ['backup-note', 'live-only-note'] : ['backup-note']);
      expect(leftovers()).toEqual([]);
      expect((await readState()).lastRestore.sourceId).toBe('upload');
    });
  });

  it('rolled forward but the new file is damaged: it is kept as restore-failed-*.db and the old database comes back', async () => {
    await crashedRestore('staging_swapped');
    // Damage the swapped-in file: still starts with garbage, no longer a database.
    fs.writeFileSync(live(), Buffer.alloc(8192, 0x41));
    fs.rmSync(`${live()}-wal`, { force: true });
    fs.rmSync(`${live()}-shm`, { force: true });
    const result = await reconcileRestoreJournal({ now: day(3) });
    expect(result.action).toBe('rolled_back');
    expect(liveNotes()).toEqual(['backup-note', 'live-only-note']);
    const kept = fs.readdirSync(dataDir()).filter((n) => /^restore-failed-.*\.db$/.test(n));
    expect(kept).toHaveLength(1);
    expect(leftovers().filter((n) => !kept.includes(n))).toEqual([]);
  });

  it('with the old file moved aside, a start before recovery refuses to create an empty database', async () => {
    await crashedRestore('aside_moved');
    expect(fs.existsSync(live())).toBe(false);
    expect(() => getDb()).toThrowError(expect.objectContaining({ code: 'db_restoring' }));
    expect(fs.existsSync(live())).toBe(false);
    await reconcileRestoreJournal();
    expect(liveNotes()).toEqual(['backup-note', 'live-only-note']);
  });

  it('a journal that says swapped but a damaged live file still rolls back and keeps the damaged file', async () => {
    await crashedRestore('journal_swapped');
    fs.writeFileSync(live(), Buffer.alloc(8192, 0x42));
    const result = await reconcileRestoreJournal({ now: day(3) });
    expect(result.action).toBe('rolled_back');
    expect(liveNotes()).toEqual(['backup-note', 'live-only-note']);
    expect(fs.readdirSync(dataDir()).filter((n) => /^restore-failed-.*\.db$/.test(n))).toHaveLength(1);
  });

  it('a different healthy file at the live path (not the staged one) is not rolled forward', async () => {
    const backup = await crashedRestore('staging_swapped');
    // Something else, perfectly healthy, now sits where the restored file was.
    fs.copyFileSync(backupFile(backup.id, '.db'), live());
    const journal = path.join(dataDir(), 'restore-journal.json');
    fs.writeFileSync(journal, JSON.stringify({ ...readJson(journal), phase: 'swapping', stagingSha256: '0'.repeat(64) }));
    const result = await reconcileRestoreJournal({ now: day(3) });
    expect(result.action).toBe('rolled_back');
    expect(liveNotes()).toEqual(['backup-note', 'live-only-note']);
    const kept = fs.readdirSync(dataDir()).filter((n) => /^restore-failed-.*\.db$/.test(n));
    expect(kept).toHaveLength(1);
  });

  it('a restore that finds a journal from an earlier interrupted restore refuses (db_restoring) and touches nothing', async () => {
    insert('notes', { body: 'x' });
    const backup = await backUp();
    const journal = path.join(dataDir(), 'restore-journal.json');
    fs.writeFileSync(journal, JSON.stringify({ v: 1, phase: 'swapping', sourceId: 'abc' }));
    await expect(restoreBackup({ id: backup.id })).rejects.toMatchObject({ code: 'db_restoring', status: 503 });
    expect(fs.existsSync(journal)).toBe(true);
    expect(liveNotes()).toEqual(['x']);
    expect(await safeties()).toEqual([]);
    expect(currentOp()).toBeNull();
  });

  it('a failed rollback leaves the journal and the maintenance switch for startup recovery, which then restores the old file', async () => {
    insert('notes', { body: 'backup-note' });
    const backup = await backUp();
    insert('notes', { body: 'live-only-note' });
    const real = createFsOps();
    const fsOps = createFsOps({
      rename: async (from, to) => {
        if (/restore-aside/.test(from) && path.basename(to) === 'burrow.db') throw ebusy();
        return real.rename(from, to);
      },
      sleep: noSleep,
    });
    const hooks = {
      sleep: noSleep,
      afterStep: (name) => {
        if (name === 'journal_swapped') throw Object.assign(new Error('post swap failure'), { code: 'EIO' });
      },
    };
    await expect(restoreBackup({ id: backup.id, fsOps, hooks, now: day(2) })).rejects.toMatchObject({ code: 'restore_failed', status: 500 });
    const journal = path.join(dataDir(), 'restore-journal.json');
    expect(fs.existsSync(journal)).toBe(true);
    expect(() => getDb()).toThrowError(expect.objectContaining({ code: 'db_restoring' }));
    expect(currentOp()).toBeNull();
    expect(isGateClosed()).toBe(false);
    expect((await getBackupStatus()).recoveryRequired).toBe(true);

    // Next start.
    __resetLockForTests();
    setDbMaintenance(false);
    closeDb();
    const result = await reconcileRestoreJournal({ now: day(3) });
    expect(result.action).toBe('rolled_back');
    expect(liveNotes()).toEqual(['backup-note', 'live-only-note']);
    expect(fs.existsSync(journal)).toBe(false);
    expect((await getBackupStatus()).recoveryRequired).toBe(false);
  });

  it('a failed move-back that the in-process recovery rolls forward is a success, not restore_failed', async () => {
    insert('notes', { body: 'backup-note' });
    const backup = await backUp();
    insert('notes', { body: 'live-only-note' });
    const real = createFsOps();
    let journalWrites = 0;
    const fsOps = createFsOps({
      rename: async (from, to) => {
        // swapping, swapped, then the rolling_back marker: that one fails, so the journal still says swapped.
        if (path.basename(to) === 'restore-journal.json') {
          journalWrites += 1;
          if (journalWrites === 3) throw Object.assign(new Error('journal write failed'), { code: 'EIO' });
        }
        return real.rename(from, to);
      },
      sleep: noSleep,
    });
    const hooks = {
      sleep: noSleep,
      afterStep: (name) => {
        if (name === 'journal_swapped') throw Object.assign(new Error('post swap failure'), { code: 'EIO' });
      },
    };
    const result = await restoreBackup({ id: backup.id, fsOps, hooks, now: day(2) });
    expect(result).toMatchObject({ restoredFrom: backup.id, recovered: true });
    expect(liveNotes()).toEqual(['backup-note']);
    expect(fs.existsSync(path.join(dataDir(), 'restore-journal.json'))).toBe(false);
    expect(currentOp()).toBeNull();
    expect((await readState()).lastRestore.outcome).toBe('rolled_forward');
    await flushRecoveryAudit();
    const rows = auditRows('backup_restore');
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('ok');
  });

  it('a restore attempted while recovery is pending keeps restore-staging and lastRestore untouched', async () => {
    insert('notes', { body: 'x' });
    const backup = await backUp();
    const staging = path.join(dataDir(), 'restore-staging');
    fs.mkdirSync(staging);
    fs.writeFileSync(path.join(staging, 'burrow.db'), 'keep me');
    fs.writeFileSync(path.join(dataDir(), 'restore-journal.json'), JSON.stringify({ v: 1, phase: 'swapping', sourceId: 'abc' }));
    const before = (await readState()).lastRestore ?? null;
    await expect(restoreBackup({ id: backup.id })).rejects.toMatchObject({ code: 'db_restoring' });
    expect(fs.readFileSync(path.join(staging, 'burrow.db'), 'utf8')).toBe('keep me');
    expect((await readState()).lastRestore ?? null).toEqual(before);
    expect(currentOp()).toBeNull();
  });

  it('a journal that cannot be read still recovers to a working database', async () => {
    await crashedRestore('journal_written');
    fs.writeFileSync(path.join(dataDir(), 'restore-journal.json'), '{ this is not json');
    const result = await reconcileRestoreJournal({ now: day(3) });
    expect(result).toEqual({ action: 'rolled_back', recovered: true });
    expect(liveNotes()).toEqual(['backup-note', 'live-only-note']);
    expect((await readState()).lastRestore.sourceId).toBe('upload');
  });

  it('without a journal, leftover staging and aside folders are removed and nothing else changes', async () => {
    insert('notes', { body: 'x' });
    closeDb();
    fs.mkdirSync(path.join(dataDir(), 'restore-staging'));
    fs.writeFileSync(path.join(dataDir(), 'restore-staging', 'burrow.db'), 'junk');
    fs.mkdirSync(path.join(dataDir(), 'restore-aside'));
    fs.writeFileSync(path.join(dataDir(), 'restore-aside', 'burrow.db'), 'old junk');
    const result = await reconcileRestoreJournal();
    expect(result).toEqual({ action: 'none', recovered: false });
    expect(leftovers()).toEqual([]);
    expect(liveNotes()).toEqual(['x']);
    expect((await readState()).lastRestore).toBeNull();
  });

  it('a journal whose aside folder is already gone leaves the live file alone', async () => {
    insert('notes', { body: 'x' });
    closeDb();
    fs.writeFileSync(path.join(dataDir(), 'restore-journal.json'), JSON.stringify({ v: 1, phase: 'swapping', sourceId: 'abc', safetyId: 'def' }));
    const result = await reconcileRestoreJournal({ now: day(2) });
    expect(result).toEqual({ action: 'rolled_back', recovered: true });
    expect(liveNotes()).toEqual(['x']);
    expect(fs.existsSync(path.join(dataDir(), 'restore-journal.json'))).toBe(false);
  });

  it('recovery with a locked file (EBUSY) retries and still finishes', async () => {
    await crashedRestore('aside_moved');
    let busy = 0;
    const real = createFsOps();
    const fsOps = createFsOps({
      rename: async (from, to) => {
        if (to.endsWith('burrow.db') && busy < 2) {
          busy += 1;
          throw ebusy();
        }
        return real.rename(from, to);
      },
      sleep: noSleep,
    });
    const result = await reconcileRestoreJournal({ fsOps, now: day(3) });
    expect(busy).toBe(2);
    expect(result.action).toBe('rolled_back');
    expect(liveNotes()).toEqual(['backup-note', 'live-only-note']);
  });
});

describe('Windows file locks (EBUSY)', () => {
  const setup = async () => {
    insert('notes', { body: 'backup-note' });
    const backup = await backUp();
    insert('notes', { body: 'live-only-note' });
    return backup;
  };
  const isAsideMove = (from, to) => /restore-aside/.test(to) && path.basename(from) === 'burrow.db';
  const isSwapIn = (from, to) => /restore-staging/.test(from) && path.basename(to) === 'burrow.db' && !/restore-/.test(path.dirname(to));

  it('EBUSY twice then success: the restore works and the waits back off 50 ms then 100 ms', async () => {
    const backup = await setup();
    const real = createFsOps();
    const delays = [];
    let busy = 0;
    const fsOps = createFsOps({
      rename: async (from, to) => {
        if (isAsideMove(from, to) && busy < 2) {
          busy += 1;
          throw ebusy();
        }
        return real.rename(from, to);
      },
      sleep: async (ms) => {
        delays.push(ms);
      },
    });
    await restoreBackup({ id: backup.id, fsOps, hooks: { sleep: noSleep }, now: day(2) });
    expect(busy).toBe(2);
    expect(delays).toEqual([50, 100]);
    expect(liveNotes()).toEqual(['backup-note']);
    expect(leftovers()).toEqual([]);
  });

  it('EBUSY twice on the final move of the new file also works', async () => {
    const backup = await setup();
    const real = createFsOps();
    let busy = 0;
    const fsOps = createFsOps({
      rename: async (from, to) => {
        if (isSwapIn(from, to) && busy < 2) {
          busy += 1;
          throw ebusy();
        }
        return real.rename(from, to);
      },
      sleep: noSleep,
    });
    await restoreBackup({ id: backup.id, fsOps, hooks: { sleep: noSleep } });
    expect(busy).toBe(2);
    expect(liveNotes()).toEqual(['backup-note']);
  });

  it('EPERM and EACCES are retried like EBUSY', async () => {
    const backup = await setup();
    const real = createFsOps();
    const codes = ['EPERM', 'EACCES'];
    const fsOps = createFsOps({
      rename: async (from, to) => {
        if (isAsideMove(from, to) && codes.length) throw Object.assign(new Error('locked'), { code: codes.shift() });
        return real.rename(from, to);
      },
      sleep: noSleep,
    });
    await restoreBackup({ id: backup.id, fsOps, hooks: { sleep: noSleep } });
    expect(codes).toEqual([]);
    expect(liveNotes()).toEqual(['backup-note']);
  });

  it('a backup rename hitting EBUSY twice still completes', async () => {
    insert('notes', { body: 'x' });
    const real = createFsOps();
    let busy = 0;
    const fsOps = createFsOps({
      rename: async (from, to) => {
        if (/\.db\.partial$/.test(from) && busy < 2) {
          busy += 1;
          throw ebusy();
        }
        return real.rename(from, to);
      },
      sleep: noSleep,
    });
    const { created } = await createBackup({ kind: 'manual', now: day(1), fsOps });
    expect(created).toBe(true);
    expect(busy).toBe(2);
  });

  it('permanent EBUSY on moving the live file aside: restore_failed (500), live database intact and usable', async () => {
    const backup = await setup();
    const real = createFsOps();
    const delays = [];
    const fsOps = createFsOps({
      rename: async (from, to) => {
        if (isAsideMove(from, to)) throw ebusy();
        return real.rename(from, to);
      },
      sleep: async (ms) => {
        delays.push(ms);
      },
    });
    const error = await restoreBackup({ id: backup.id, fsOps, hooks: { sleep: noSleep }, now: day(2) }).catch((e) => e);
    expect(error).toMatchObject({ code: 'restore_failed', status: 500 });
    expect(delays).toEqual([50, 100, 200, 400, 800, 1600]); // 7 attempts, capped at 1600 ms
    expect(liveNotes()).toEqual(['backup-note', 'live-only-note']);
    expect(getDb().prepare('PRAGMA integrity_check').all().map((r) => r.integrity_check)).toEqual(['ok']);
    expect(leftovers()).toEqual([]);
    expect(currentOp()).toBeNull();
    expect(isGateClosed()).toBe(false);
    expect((await readState()).lastRestore).toMatchObject({ outcome: 'rolled_back' });
    expect(auditRows('backup_restore').pop().status).toBe('error');
    // The app carries on: writes and a new backup work.
    insert('notes', { body: 'still works' });
    expect((await backUp(day(5))).status).toBe('verified');
  });

  it('permanent EBUSY on moving the new file in: the old database is put back and nothing is lost', async () => {
    const backup = await setup();
    const real = createFsOps();
    const fsOps = createFsOps({
      rename: async (from, to) => {
        if (isSwapIn(from, to)) throw ebusy();
        return real.rename(from, to);
      },
      sleep: noSleep,
    });
    await expect(restoreBackup({ id: backup.id, fsOps, hooks: { sleep: noSleep } })).rejects.toMatchObject({ code: 'restore_failed' });
    expect(liveNotes()).toEqual(['backup-note', 'live-only-note']);
    expect(leftovers()).toEqual([]);
    expect(fs.existsSync(path.join(dataDir(), 'restore-journal.json'))).toBe(false);
  });

  it('an error that is not a lock error is not retried', async () => {
    const backup = await setup();
    const real = createFsOps();
    let calls = 0;
    const fsOps = createFsOps({
      rename: async (from, to) => {
        if (isAsideMove(from, to)) {
          calls += 1;
          throw Object.assign(new Error('input/output error'), { code: 'EIO' });
        }
        return real.rename(from, to);
      },
      sleep: noSleep,
    });
    await expect(restoreBackup({ id: backup.id, fsOps, hooks: { sleep: noSleep } })).rejects.toMatchObject({ code: 'restore_failed' });
    expect(calls).toBe(1);
    expect(liveNotes()).toEqual(['backup-note', 'live-only-note']);
  });

  it('a failure that happens after the swap rolls the new file aside as restore-failed-*.db and restores the old one', async () => {
    const backup = await setup();
    const hooks = {
      sleep: noSleep,
      afterStep: (name) => {
        if (name === 'journal_swapped') throw Object.assign(new Error('post swap failure'), { code: 'EIO' });
      },
    };
    await expect(restoreBackup({ id: backup.id, hooks, now: day(2) })).rejects.toMatchObject({ code: 'restore_failed' });
    expect(liveNotes()).toEqual(['backup-note', 'live-only-note']);
    const kept = fs.readdirSync(dataDir()).filter((n) => /^restore-failed-.*\.db$/.test(n));
    expect(kept).toHaveLength(1);
    expect(withReadOnly(path.join(dataDir(), kept[0]), (db) => db.prepare('SELECT body FROM notes').all().map((r) => r.body))).toEqual(['backup-note']);
    expect(fs.existsSync(path.join(dataDir(), 'restore-journal.json'))).toBe(false);
  });
});

describe('renameWithRetry and rmWithRetry', () => {
  const failing = (code, times) => {
    let n = 0;
    const delays = [];
    const fsOps = createFsOps({
      rename: async () => {
        n += 1;
        if (n <= times) throw Object.assign(new Error(code), { code });
      },
      rm: async () => {
        n += 1;
        if (n <= times) throw Object.assign(new Error(code), { code });
      },
      sleep: async (ms) => {
        delays.push(ms);
      },
    });
    return { fsOps, calls: () => n, delays };
  };

  it.each(['EBUSY', 'EPERM', 'EACCES'])('retries %s', async (code) => {
    const { fsOps, calls } = failing(code, 3);
    await renameWithRetry('a', 'b', { fsOps });
    expect(calls()).toBe(4);
  });

  it.each(['ENOENT', 'EIO', 'EXDEV', undefined])('does not retry %s', async (code) => {
    const { fsOps, calls } = failing(code, 99);
    await expect(renameWithRetry('a', 'b', { fsOps })).rejects.toBeInstanceOf(Error);
    expect(calls()).toBe(1);
  });

  it('gives up after the last attempt and rethrows the lock error', async () => {
    const { fsOps, calls, delays } = failing('EBUSY', 99);
    await expect(renameWithRetry('a', 'b', { fsOps })).rejects.toMatchObject({ code: 'EBUSY' });
    expect(calls()).toBe(7);
    expect(delays).toEqual([50, 100, 200, 400, 800, 1600]);
  });

  it('honors attempts and baseMs', async () => {
    const { fsOps, calls, delays } = failing('EBUSY', 99);
    await expect(renameWithRetry('a', 'b', { fsOps, attempts: 3, baseMs: 10 })).rejects.toMatchObject({ code: 'EBUSY' });
    expect(calls()).toBe(3);
    expect(delays).toEqual([10, 20]);
  });

  it('rmWithRetry retries locks and treats a missing path as success', async () => {
    const { fsOps, calls } = failing('EBUSY', 2);
    await rmWithRetry('x', { fsOps });
    expect(calls()).toBe(3);
    await expect(rmWithRetry(path.join(dataDir(), 'never-existed'))).resolves.toBeUndefined();
  });
});

describe('restore interplay with the live database handle', () => {
  it('a restore works when the live database was never opened in this process yet', async () => {
    insert('notes', { body: 'x' });
    const backup = await backUp();
    closeDb();
    insert('notes', { body: 'y' });
    closeDb();
    await restoreBackup({ id: backup.id });
    expect(liveNotes()).toEqual(['x']);
  });

  it('setDbMaintenance(true) makes getDb throw even with an open handle, and false restores access', () => {
    getDb();
    setDbMaintenance(true);
    expect(() => getDb()).toThrowError(expect.objectContaining({ code: 'db_restoring', status: 503 }));
    setDbMaintenance(false);
    expect(() => getDb()).not.toThrow();
  });

  it('__resetLockForTests clears a stuck lock', () => {
    tryAcquire('restore');
    expect(currentOp()).toBe('restore');
    __resetLockForTests();
    expect(currentOp()).toBeNull();
    __resetUploadsForTests();
  });

  it('metas of the original backups are untouched by a restore (verified, same hash)', async () => {
    insert('notes', { body: 'x' });
    const backup = await backUp();
    await restoreBackup({ id: backup.id });
    const again = readJson(backupFile(backup.id, '.meta.json'));
    expect(again).toEqual(backup);
  });
});

describe('what belongs to this install survives a restore', () => {
  const stamp = '2026-01-01T00:00:00.000Z';
  const putState = (key, value) =>
    getDb().prepare('INSERT OR REPLACE INTO app_state (key, value, updated_at) VALUES (?, ?, ?)').run(key, JSON.stringify(value), stamp);
  const putSecret = (name) =>
    getDb()
      .prepare('INSERT OR REPLACE INTO app_secrets (name, ciphertext, iv, auth_tag, last4, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(name, `ct-${name}`, 'iv', 'tag', 'abcd', stamp);
  const stateValue = (key) => {
    const row = getDb().prepare('SELECT value FROM app_state WHERE key = ?').get(key);
    return row ? JSON.parse(row.value) : undefined;
  };
  const secretNames = () => getDb().prepare('SELECT name FROM app_secrets ORDER BY name').all().map((r) => r.name);

  it('privacy opt-ins, AI settings and backup settings stay as they are now, not as the backup had them', async () => {
    putState('network.optIn', { weather: true, oura: true });
    putState('ai.settings', { provider: 'cloud' });
    await saveBackupSettings({ keepDaily: 9, keepWeekly: 9, keepMonthly: 9 });
    insert('notes', { body: 'x' });
    const backup = await backUp();

    putState('network.optIn', { weather: false });
    putState('ai.settings', { provider: 'ollama' });
    await saveBackupSettings({ keepDaily: 2, keepWeekly: 1, keepMonthly: 0 });
    await restoreBackup({ id: backup.id });

    expect(stateValue('network.optIn')).toEqual({ weather: false });
    expect(stateValue('ai.settings')).toEqual({ provider: 'ollama' });
    expect(await getBackupSettings()).toEqual({ keepDaily: 2, keepWeekly: 1, keepMonthly: 0 });
  });

  it('a backup can never switch an opt-in on: a carried key the live data did not have is removed', async () => {
    putState('network.optIn', { weather: true, oura: true });
    putState('ai.settings', { provider: 'cloud' });
    insert('notes', { body: 'x' });
    const backup = await backUp();
    getDb().prepare("DELETE FROM app_state WHERE key IN ('network.optIn', 'ai.settings')").run();
    await restoreBackup({ id: backup.id });
    expect(stateValue('network.optIn')).toBeUndefined();
    expect(stateValue('ai.settings')).toBeUndefined();
    expect(liveNotes()).toEqual(['x']);
  });

  it('other app_state rows come from the backup', async () => {
    putState('budget:targets', { Groceries: 100 });
    const backup = await backUp();
    putState('budget:targets', { Groceries: 999 });
    await restoreBackup({ id: backup.id });
    expect(stateValue('budget:targets')).toEqual({ Groceries: 100 });
  });

  it("saved keys are the live ones: the backup's keys (maybe made under another key file) do not come along", async () => {
    putSecret('BACKUP_ONLY_KEY');
    insert('notes', { body: 'x' });
    const backup = await backUp();
    getDb().prepare('DELETE FROM app_secrets').run();
    putSecret('LIVE_ONLY_KEY');
    await restoreBackup({ id: backup.id });
    expect(secretNames()).toEqual(['LIVE_ONLY_KEY']);
  });

  it('saved keys are not in the backup: app_secrets is empty and its ciphertext bytes are not in the file', async () => {
    const cipher = 'KEYSTRIP-CIPHERTEXT-9f3a61c2d84be705';
    const iv = 'KEYSTRIP-IV-52c1e0a9b7d3';
    getDb()
      .prepare('INSERT INTO app_secrets (name, ciphertext, iv, auth_tag, last4, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('STRIPPED_KEY', cipher, iv, 'KEYSTRIP-TAG-77aa', 'abcd', stamp);
    insert('notes', { body: 'kept' });
    const backup = await backUp();
    const file = backupFile(backup.id, '.db');
    const bytes = fs.readFileSync(file);
    expect(bytes.includes(Buffer.from(cipher))).toBe(false);
    expect(bytes.includes(Buffer.from(iv))).toBe(false);
    expect(bytes.includes(Buffer.from('STRIPPED_KEY'))).toBe(false);
    withReadOnly(file, (db) => {
      expect(db.prepare('SELECT COUNT(*) AS n FROM app_secrets').get().n).toBe(0);
      expect(db.prepare('SELECT COUNT(*) AS n FROM notes').get().n).toBe(1);
    });
    // The live key is untouched, and a restore of this backup keeps it.
    expect(secretNames()).toEqual(['STRIPPED_KEY']);
    await restoreBackup({ id: backup.id });
    expect(secretNames()).toEqual(['STRIPPED_KEY']);
    expect(getDb().prepare('SELECT ciphertext FROM app_secrets').get().ciphertext).toBe(cipher);
  });

  it('an older backup that still contains app_secrets restores and keeps the live keys', async () => {
    insert('notes', { body: 'old-style' });
    const backup = await backUp();
    rewriteBackupDb(backup.id, (db) => {
      db.prepare('INSERT INTO app_secrets (name, ciphertext, iv, auth_tag, last4, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(
        'OLD_BACKUP_KEY',
        'old-cipher',
        'iv',
        'tag',
        'abcd',
        stamp,
      );
    });
    putSecret('LIVE_ONLY_KEY');
    const info = await inspectUpload(fakeUploadReq(fs.readFileSync(backupFile(backup.id, '.db'))), { now: day(1) });
    await restoreBackup({ uploadToken: info.uploadToken, now: day(1) });
    expect(secretNames()).toEqual(['LIVE_ONLY_KEY']);
    expect(liveNotes()).toEqual(['old-style']);
  });

  it('secrets are not copied into the audit log or the state file', async () => {
    putSecret('LIVE_ONLY_KEY');
    insert('notes', { body: 'x' });
    const backup = await backUp();
    await restoreBackup({ id: backup.id });
    expect(JSON.stringify(select('audit_log'))).not.toContain('ct-LIVE_ONLY_KEY');
    expect(fs.readFileSync(path.join(backupsDir(), 'state.json'), 'utf8')).not.toContain('ct-LIVE_ONLY_KEY');
  });
});

describe('the next backup after a restore', () => {
  it('a restore clears the success markers, so the scheduler is due right away and backs up the restored data', async () => {
    insert('notes', { body: 'one' });
    const backup = await backUp(day(1));
    insert('notes', { body: 'two' });
    await restoreBackup({ id: backup.id, now: day(1, 13) });
    const state = await readState();
    expect(state).toMatchObject({ lastSuccessAt: null, confirmedId: null, lastFailureAt: null, lastError: null });
    const metas = await listMetas(backupsDir());
    expect(isBackupDue({ state, metas, now: day(1, 14) })).toBe(true);
    const run = await runScheduledBackup({ now: day(1, 14) });
    expect(run).toEqual({ ok: true, created: true });
    const newest = (await listMetas(backupsDir()))[0];
    expect(newest.kind).toBe('auto');
    expect(noteBodies(backupFile(newest.id, '.db'))).toEqual(['one']);
  });

  it('the status still shows a recent backup (the safety copy counts for health)', async () => {
    insert('notes', { body: 'one' });
    const backup = await backUp(day(1));
    await restoreBackup({ id: backup.id, now: day(1, 13) });
    const status = await getBackupStatus({ now: day(1, 14) });
    expect(status.health).toBe('ok');
    expect(status.lastBackupAt).toBe(day(1, 13).toISOString());
  });
});
