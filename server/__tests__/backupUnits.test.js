// Small units of the backup code: ids and paths, error copy, snapshot helpers, fingerprint rules,
// manifest status and the state file.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb, insert, update } from '../db/index.js';
import { BACKUP_MESSAGES, BackupError, isBackupError, isNoSpaceError } from '../backup/errors.js';
import { createFsOps, readJsonOrNull, writeJsonAtomic } from '../backup/fsops.js';
import {
  STALE_AFTER_MS,
  computeStatus,
  defaultState,
  listMetas,
  readMeta,
  readState,
  toSummary,
  writeMeta,
  writeState,
} from '../backup/manifest.js';
import { ID_RE, UPLOAD_TOKEN_RE, backupsDir, ensureBackupsDir, newBackupId, resolveBackupFile } from '../backup/paths.js';
import { checkSqliteHeader, contentFingerprint, countRows, inspectDbFile, latestSchemaVersion, normalizeSnapshot, sha256File, takeSnapshot } from '../backup/snapshot.js';
import { logAudit } from '../audit.js';
import { cleanupBackupEnv, dataDir, day, resetBackupEnv } from './helpers/backupEnv.js';

beforeEach(() => {
  resetBackupEnv();
});
afterAll(() => {
  cleanupBackupEnv();
});

describe('backup ids', () => {
  it('has the documented shape and is UTC', () => {
    const id = newBackupId('manual', new Date(Date.UTC(2026, 0, 2, 3, 4, 5)), () => 'abc123');
    expect(id).toBe('20260102T030405Z-manual-abc123');
    expect(ID_RE.test(id)).toBe(true);
    for (const kind of ['auto', 'manual', 'safety']) expect(ID_RE.test(newBackupId(kind))).toBe(true);
  });

  it('random parts differ between ids made in the same second', () => {
    const ids = new Set(Array.from({ length: 50 }, () => newBackupId('auto', day(1))));
    expect(ids.size).toBe(50);
  });

  it('rejects an unknown kind', () => {
    expect(() => newBackupId('weekly')).toThrowError(expect.objectContaining({ code: 'invalid_request' }));
  });

  it.each(['', 'x', '../20260102T030405Z-manual-abc123', '20260102T030405Z-manual-abc12', '20260102T030405Z-manual-abc1234', '20260102T030405Z-manual-ABC123', '20260102T030405Z-other-abc123', '20260102T030405-manual-abc123', '20260102T030405Z-manual-abc123\n', ' 20260102T030405Z-manual-abc123'])(
    'ID_RE rejects %j',
    (id) => {
      expect(ID_RE.test(id)).toBe(false);
    },
  );

  it('upload tokens are 32 lowercase hex characters', () => {
    expect(UPLOAD_TOKEN_RE.test('0123456789abcdef0123456789abcdef')).toBe(true);
    for (const t of ['', 'a'.repeat(31), 'a'.repeat(33), 'A'.repeat(32), `${'a'.repeat(31)}g`, `${'a'.repeat(32)}\n`]) expect(UPLOAD_TOKEN_RE.test(t)).toBe(false);
  });
});

describe('resolveBackupFile', () => {
  const id = '20260102T030405Z-manual-abc123';

  it('returns the path of an existing regular file', () => {
    const dir = ensureBackupsDir();
    fs.writeFileSync(path.join(dir, `burrow-${id}.db`), 'x');
    expect(resolveBackupFile(id, '.db')).toBe(path.join(path.resolve(dir), `burrow-${id}.db`));
  });

  it.each([
    ['a malformed id', '../x', '.db'],
    ['an absolute path', path.resolve('/etc/passwd'), '.db'],
    ['an unknown extension', '20260102T030405Z-manual-abc123', '.exe'],
    ['a missing file', '20260102T030405Z-manual-abc123', '.db'],
    ['a non-string id', 42, '.db'],
  ])('%s is backup_not_found', (_label, badId, ext) => {
    ensureBackupsDir();
    expect(() => resolveBackupFile(badId, ext)).toThrowError(expect.objectContaining({ code: 'backup_not_found', status: 404 }));
  });

  it('a folder is not a regular file', () => {
    const dir = ensureBackupsDir();
    fs.mkdirSync(path.join(dir, `burrow-${id}.db`));
    expect(() => resolveBackupFile(id, '.db')).toThrowError(expect.objectContaining({ code: 'backup_not_found' }));
  });

  it('ensureBackupsDir creates the folder and refuses a file in its place', () => {
    expect(ensureBackupsDir()).toBe(backupsDir());
    expect(fs.statSync(backupsDir()).isDirectory()).toBe(true);
    fs.rmSync(backupsDir(), { recursive: true });
    fs.writeFileSync(backupsDir(), 'not a folder');
    expect(() => ensureBackupsDir()).toThrow();
  });
});

describe('error copy', () => {
  it('every code has a status and a plain message with no em dash and no technical words', () => {
    for (const [code, message] of Object.entries(BACKUP_MESSAGES)) {
      const error = new BackupError(code);
      expect(error.status, code).toBeGreaterThanOrEqual(400);
      expect(error.code).toBe(code);
      expect(message, code).not.toMatch(/—|database|sqlite|ENOSPC|EBUSY|stack|\\|\//i);
      expect(message.endsWith('.'), code).toBe(true);
    }
  });

  it.each([
    ['backup_busy', 409],
    ['db_restoring', 503],
    ['disk_low', 507],
    ['disk_full', 507],
    ['backup_not_found', 404],
    ['backup_invalid', 422],
    ['backup_too_new', 409],
    ['upload_expired', 410],
    ['too_large', 413],
    ['unsupported_media_type', 415],
    ['invalid_request', 400],
    ['invalid_settings', 400],
    ['backup_failed', 500],
    ['restore_failed', 500],
  ])('%s maps to HTTP %i', (code, status) => {
    expect(new BackupError(code).status).toBe(status);
    expect(isBackupError(new BackupError(code))).toBe(true);
  });

  it('isBackupError is false for other errors; isNoSpaceError recognises the usual forms', () => {
    expect(isBackupError(new Error('x'))).toBe(false);
    expect(isNoSpaceError(Object.assign(new Error('x'), { code: 'ENOSPC' }))).toBe(true);
    expect(isNoSpaceError(Object.assign(new Error('x'), { code: 'SQLITE_FULL' }))).toBe(true);
    expect(isNoSpaceError(new Error('database or disk is full'))).toBe(true);
    expect(isNoSpaceError(new Error('No space left on device'))).toBe(true);
    expect(isNoSpaceError(new Error('permission denied'))).toBe(false);
    expect(isNoSpaceError(null)).toBe(false);
    expect(isNoSpaceError('ENOSPC')).toBe(false);
  });
});

describe('snapshot helpers', () => {
  it('takeSnapshot copies the data and replaces an existing partial file', () => {
    insert('notes', { body: 'snap' });
    const partial = path.join(dataDir(), 'copy.db.partial');
    fs.writeFileSync(partial, 'stale leftovers');
    takeSnapshot(getDb(), partial);
    normalizeSnapshot(partial);
    const info = inspectDbFile(partial);
    expect(info).toMatchObject({ integrityOk: true, schemaVersion: latestSchemaVersion(), shapeOk: true });
    expect(info.rowCounts.notes).toBe(1);
  });

  it('takeSnapshot quotes odd file names safely', () => {
    const odd = path.join(dataDir(), "it's a copy.db");
    takeSnapshot(getDb(), odd);
    expect(fs.existsSync(odd)).toBe(true);
  });

  it('checkSqliteHeader tells a database from anything else', async () => {
    const good = path.join(dataDir(), 'good.db');
    takeSnapshot(getDb(), good);
    expect(await checkSqliteHeader(good)).toBe(true);
    const bad = path.join(dataDir(), 'bad.db');
    fs.writeFileSync(bad, 'SQLite format 4\0 and then some more text');
    expect(await checkSqliteHeader(bad)).toBe(false);
    fs.writeFileSync(bad, 'short');
    expect(await checkSqliteHeader(bad)).toBe(false);
    expect(await checkSqliteHeader(path.join(dataDir(), 'missing.db'))).toBe(false);
  });

  it('sha256File matches a known value and streams large files', async () => {
    const file = path.join(dataDir(), 'h.bin');
    fs.writeFileSync(file, 'abc');
    expect(await sha256File(file)).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    fs.writeFileSync(file, Buffer.alloc(3 * 1024 * 1024 + 17, 7));
    expect(await sha256File(file)).toMatch(/^[0-9a-f]{64}$/);
    await expect(sha256File(path.join(dataDir(), 'missing.bin'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('inspectDbFile reports a file that is not a database by throwing', () => {
    const bad = path.join(dataDir(), 'bad.db');
    fs.writeFileSync(bad, Buffer.alloc(4096, 0x41));
    expect(() => inspectDbFile(bad)).toThrow();
  });

  it('inspectDbFile does not run triggers or change the file it inspects', () => {
    const file = path.join(dataDir(), 'trigger.db');
    takeSnapshot(getDb(), file);
    const w = new DatabaseSync(file);
    w.exec('PRAGMA journal_mode = DELETE');
    w.exec("CREATE TRIGGER t AFTER INSERT ON notes BEGIN INSERT INTO todos (id, title, created_at) VALUES ('t', 't', 'now'); END");
    w.close();
    const before = fs.readFileSync(file);
    const info = inspectDbFile(file);
    expect(info.shapeOk).toBe(false);
    expect(fs.readFileSync(file).equals(before)).toBe(true);
  });
});

describe('content fingerprint', () => {
  const fp = () => contentFingerprint(getDb());

  it('is stable for unchanged data and ignores the audit log', async () => {
    insert('notes', { body: 'a' });
    const first = fp();
    expect(fp()).toBe(first);
    await logAudit({ kind: 'llm', feature: 'chat', status: 'ok' });
    await logAudit({ kind: 'export', feature: 'backup_create', status: 'ok' });
    expect(fp()).toBe(first);
  });

  it('changes when a row is added, edited or removed, in any data table', () => {
    const seen = new Set([fp()]);
    const note = insert('notes', { body: 'a' });
    seen.add(fp());
    update('notes', { body: 'b' }, { where: { id: note.id } });
    seen.add(fp());
    insert('todos', { title: 't' });
    seen.add(fp());
    getDb().prepare("INSERT INTO app_state (key, value, updated_at) VALUES ('k', '1', '2026-01-01T00:00:00.000Z')").run();
    seen.add(fp());
    getDb().prepare("DELETE FROM notes WHERE id = ?").run(note.id);
    seen.add(fp());
    expect(seen.size).toBe(6);
  });

  it('a snapshot has the same fingerprint as its source, and countRows matches', () => {
    insert('notes', { body: 'a' });
    insert('notes', { body: 'b' });
    const file = path.join(dataDir(), 'fp.db');
    takeSnapshot(getDb(), file);
    const info = inspectDbFile(file);
    expect(info.fingerprint).toBe(fp());
    expect(countRows(getDb())).toEqual({ rowCounts: info.rowCounts, totalRows: info.totalRows });
    expect(info.rowCounts).not.toHaveProperty('audit_log');
  });
});

describe('manifest, state and status', () => {
  const metaFor = (id, extra = {}) => ({
    format: 'burrow-backup',
    formatVersion: 1,
    id,
    kind: 'manual',
    createdAt: day(1).toISOString(),
    status: 'verified',
    verifiedAt: day(1).toISOString(),
    ...extra,
  });

  it('listMetas ignores unreadable, mismatched and badly named files and sorts newest first', async () => {
    const dir = ensureBackupsDir();
    const older = '20260101T120000Z-manual-aaaaaa';
    const newer = '20260102T120000Z-auto-bbbbbb';
    await writeMeta(metaFor(older, { createdAt: '2026-01-01T12:00:00.000Z' }), dir);
    await writeMeta(metaFor(newer, { kind: 'auto', createdAt: '2026-01-02T12:00:00.000Z' }), dir);
    fs.writeFileSync(path.join(dir, 'burrow-20260103T120000Z-manual-cccccc.meta.json'), '{ broken');
    fs.writeFileSync(path.join(dir, 'burrow-20260104T120000Z-manual-dddddd.meta.json'), JSON.stringify(metaFor('20260104T120000Z-manual-eeeeee')));
    fs.writeFileSync(path.join(dir, 'burrow-not-an-id.meta.json'), JSON.stringify(metaFor(older)));
    fs.writeFileSync(path.join(dir, 'burrow-20260105T120000Z-manual-ffffff.meta.json'), JSON.stringify(metaFor('20260105T120000Z-manual-ffffff', { status: 'weird' })));
    fs.writeFileSync(path.join(dir, 'burrow-20260106T120000Z-manual-111111.meta.json'), JSON.stringify(metaFor('20260106T120000Z-manual-111111', { createdAt: 'not a date' })));
    expect((await listMetas(dir)).map((m) => m.id)).toEqual([newer, older]);
    expect(await readMeta('../x', dir)).toBeNull();
    expect(await readMeta('20260109T120000Z-manual-999999', dir)).toBeNull();
  });

  it('state: defaults, merge patches, and recovery from a damaged file', async () => {
    const dir = ensureBackupsDir();
    expect(await readState(dir)).toEqual(defaultState());
    await writeState({ lastResult: 'created' }, { dir });
    await writeState({ lastError: 'x' }, { dir });
    expect(await readState(dir)).toMatchObject({ lastResult: 'created', lastError: 'x', formatVersion: 1 });
    fs.writeFileSync(path.join(dir, 'state.json'), '[1,2');
    expect(await readState(dir)).toEqual(defaultState());
    fs.writeFileSync(path.join(dir, 'state.json'), '[]');
    expect(await readState(dir)).toEqual(defaultState());
  });

  it('overlapping state writes never lose an update', async () => {
    const dir = ensureBackupsDir();
    await Promise.all(Array.from({ length: 12 }, (_, i) => writeState({ [`k${i}`]: i }, { dir })));
    const state = await readState(dir);
    for (let i = 0; i < 12; i += 1) expect(state[`k${i}`]).toBe(i);
  });

  it('writeJsonAtomic leaves no temp file, never partial content, and honors the fs seam', async () => {
    const dir = ensureBackupsDir();
    const file = path.join(dir, 'x.json');
    await writeJsonAtomic(file, { a: 1 });
    await writeJsonAtomic(file, { a: 2 });
    expect(await readJsonOrNull(file)).toEqual({ a: 2 });
    expect(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp'))).toEqual([]);
    const failing = createFsOps({
      rename: async () => {
        throw Object.assign(new Error('io'), { code: 'EIO' });
      },
    });
    await expect(writeJsonAtomic(file, { a: 3 }, failing)).rejects.toMatchObject({ code: 'EIO' });
    expect(await readJsonOrNull(file)).toEqual({ a: 2 });
    expect(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp'))).toEqual([]);
    expect(await readJsonOrNull(path.join(dir, 'missing.json'))).toBeNull();
  });

  it('toSummary defaults missing parts safely', () => {
    expect(toSummary(metaFor('20260101T120000Z-safety-aaaaaa', { kind: 'safety', db: null, export: undefined }))).toMatchObject({
      sizeBytes: 0,
      exportStatus: 'failed',
      totalRows: 0,
      pinned: true,
      schemaVersion: null,
      appVersion: null,
      error: null,
    });
    expect(toSummary(metaFor('20260101T120000Z-manual-aaaaaa', { db: { bytes: 100 }, export: { bytes: 40, status: 'ok' } })).sizeBytes).toBe(140);
  });

  describe('computeStatus', () => {
    const verified = (when) => metaFor('20260101T120000Z-manual-aaaaaa', { createdAt: when, verifiedAt: when });
    const at = (ms) => new Date(Date.parse(day(10).toISOString()) + ms);

    it('none with no verified backup (failed ones do not count)', () => {
      expect(computeStatus(defaultState(), [], day(10)).health).toBe('none');
      expect(computeStatus(defaultState(), [metaFor('20260101T120000Z-manual-aaaaaa', { status: 'failed' })], day(10)).health).toBe('none');
    });

    it('ok when recent, stale after 3 days, failing when the last attempt failed after the last success', () => {
      const m = [verified(day(10).toISOString())];
      expect(computeStatus(defaultState(), m, at(2 * 24 * 3_600_000)).health).toBe('ok');
      expect(computeStatus(defaultState(), m, at(STALE_AFTER_MS)).health).toBe('ok');
      expect(computeStatus(defaultState(), m, at(STALE_AFTER_MS + 1)).health).toBe('stale');
      const failing = { ...defaultState(), lastFailureAt: at(1000).toISOString() };
      expect(computeStatus(failing, m, at(2000)).health).toBe('failing');
      const recovered = { ...defaultState(), lastFailureAt: at(-5000).toISOString(), lastSuccessAt: at(0).toISOString() };
      expect(computeStatus(recovered, m, at(2000)).health).toBe('ok');
    });

    it('carries the flags through', () => {
      const status = computeStatus({ ...defaultState(), diskWarning: true, freeBytes: 5, lastRestore: { outcome: 'restored' } }, [], day(1), {
        restoring: true,
        autoEnabled: false,
      });
      expect(status).toMatchObject({ diskWarning: true, freeBytes: 5, restoring: true, autoEnabled: false, lastRestore: { outcome: 'restored' } });
    });
  });
});
