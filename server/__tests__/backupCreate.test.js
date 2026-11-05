// Backup creation: snapshot consistency, change detection, integrity failures, disk limits, export
// contents and the never-throwing scheduled run. Real files in the per-file temp data dir.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { strFromU8, unzipSync } from 'fflate';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb, getDb, insert, select, update } from '../db/index.js';
import { logAudit } from '../audit.js';
import { createFsOps } from '../backup/fsops.js';
import { currentOp, tryAcquire } from '../backup/lock.js';
import { listMetas, readState } from '../backup/manifest.js';
import { backupsDir } from '../backup/paths.js';
import { saveBackupSettings } from '../backup/settings.js';
import {
  DISK_FLOOR_BYTES,
  DISK_WARN_BYTES,
  createBackup,
  getBackupStatus,
  isBackupDue,
  runScheduledBackup,
} from '../backup/service.js';
import { takeSnapshot } from '../backup/snapshot.js';
import { buildExportZip } from '../exportRoutes.js';
import { childEnv } from './helpers/childEnv.js';
import {
  backupFile,
  cleanupBackupEnv,
  dataDir,
  day,
  diskNeed,
  enospc,
  integrityOf,
  names,
  noteBodies,
  readJson,
  resetBackupEnv,
  sha256Of,
  statfsFree,
  withReadOnly,
} from './helpers/backupEnv.js';

const WRITER = fileURLToPath(new URL('./fixtures/crashWriter.js', import.meta.url));
const SENTINEL = 'SENTINEL-PRIVATE-NOTE-TEXT-9931';

beforeEach(() => {
  resetBackupEnv();
});
afterEach(() => {
  vi.restoreAllMocks();
});
afterAll(() => {
  cleanupBackupEnv();
});

const auditRows = (feature) => select('audit_log').filter((r) => r.feature === feature);
const metaOf = (row) => (typeof row.meta === 'string' ? JSON.parse(row.meta) : row.meta);

describe('snapshot consistency while writes happen', () => {
  it('snapshots taken while another process commits are intact and hold a contiguous prefix', async () => {
    const child = spawn(process.execPath, [WRITER], {
      env: childEnv({ BURROW_DATA_DIR: dataDir(), BURROW_NO_DOTENV: '1' }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let committed = 0;
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d;
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        const m = /^committed (\d+)$/.exec(line);
        if (m) committed = Number(m[1]);
      }
    });
    const exited = new Promise((resolve) => child.once('exit', resolve));
    try {
      const deadline = Date.now() + 10_000;
      while (committed < 25 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
      expect(committed).toBeGreaterThanOrEqual(25);

      const ids = [];
      for (let i = 0; i < 4; i += 1) {
        const { meta } = await createBackup({ kind: 'manual', now: day(1 + i) });
        ids.push(meta.id);
        await new Promise((r) => setTimeout(r, 30));
      }
      child.kill('SIGKILL');
      await exited;

      let previous = 0;
      for (const id of ids) {
        const file = backupFile(id, '.db');
        expect(integrityOf(file)).toEqual(['ok']);
        const rows = withReadOnly(file, (db) => db.prepare('SELECT id FROM crash_probe ORDER BY id').all().map((r) => r.id));
        expect(rows.length).toBeGreaterThanOrEqual(25);
        // Committed prefix: ids 1..n with no gap, so the snapshot is one point in time.
        expect(rows).toEqual(Array.from({ length: rows.length }, (_, i) => i + 1));
        expect(rows.length).toBeGreaterThanOrEqual(previous);
        previous = rows.length;
      }
    } finally {
      child.kill('SIGKILL');
      await exited;
    }
  }, 30_000);

  it('a write committed from a second connection after the snapshot is not half included', async () => {
    insert('notes', { body: 'before' });
    const second = new DatabaseSync(path.join(dataDir(), 'burrow.db'));
    second.exec('PRAGMA busy_timeout = 5000');
    try {
      const interleaved = (db, partial) => {
        takeSnapshot(db, partial);
        second.exec("INSERT INTO notes (id, body, created_at) VALUES ('late-1', 'late', '2026-01-01T00:00:00.000Z')");
      };
      const { meta } = await createBackup({ kind: 'manual', now: day(1), snapshotFn: interleaved });
      expect(noteBodies(backupFile(meta.id, '.db'))).toEqual(['before']);
      expect(integrityOf(backupFile(meta.id, '.db'))).toEqual(['ok']);
      // The live database did get the late row.
      expect(select('notes').map((n) => n.body).sort()).toEqual(['before', 'late']);
    } finally {
      second.close();
    }
  });

  it('rows another connection has written but not committed are not in the snapshot', async () => {
    insert('notes', { body: 'committed' });
    const second = new DatabaseSync(path.join(dataDir(), 'burrow.db'));
    second.exec('PRAGMA busy_timeout = 5000');
    try {
      const during = (db, partial) => {
        second.exec('BEGIN IMMEDIATE');
        second.exec("INSERT INTO notes (id, body, created_at) VALUES ('uncommitted-1', 'nope', '2026-01-01T00:00:00.000Z')");
        try {
          takeSnapshot(db, partial);
        } finally {
          second.exec('ROLLBACK');
        }
      };
      const { meta } = await createBackup({ kind: 'manual', now: day(1), snapshotFn: during });
      expect(noteBodies(backupFile(meta.id, '.db'))).toEqual(['committed']);
    } finally {
      second.close();
    }
  });
});

describe('change detection', () => {
  it('an unchanged automatic run skips: no new files, state says unchanged, lastSuccessAt refreshed', async () => {
    insert('notes', { body: 'same' });
    const first = await createBackup({ kind: 'auto', now: day(1) });
    const before = names();
    const second = await createBackup({ kind: 'auto', now: day(2) });
    expect(second).toMatchObject({ created: false, reason: 'unchanged' });
    expect(second.meta.id).toBe(first.meta.id);
    expect(names()).toEqual(before);
    const state = await readState();
    expect(state.lastResult).toBe('unchanged');
    expect(state.lastSuccessAt).toBe(day(2).toISOString());
    expect(state.confirmedId).toBe(first.meta.id);
    expect(state.lastRunAt).toBe(day(2).toISOString());
    expect(await listMetas(backupsDir())).toHaveLength(1);
  });

  it('writes no audit row for an unchanged skip', async () => {
    insert('notes', { body: 'same' });
    await createBackup({ kind: 'auto', now: day(1) });
    const rows = auditRows('backup_create').length;
    await createBackup({ kind: 'auto', now: day(2) });
    expect(auditRows('backup_create')).toHaveLength(rows);
  });

  it('audit-only writes (including the backup audit row itself) still skip', async () => {
    insert('notes', { body: 'same' });
    await createBackup({ kind: 'auto', now: day(1) });
    await logAudit({ kind: 'llm', feature: 'chat', status: 'ok', meta: { calls: 1 } });
    await logAudit({ kind: 'export', feature: 'data_export', status: 'ok' });
    const second = await createBackup({ kind: 'auto', now: day(2) });
    expect(second.created).toBe(false);
    expect(await listMetas(backupsDir())).toHaveLength(1);
  });

  it('a data edit creates a new backup', async () => {
    const note = insert('notes', { body: 'v1' });
    await createBackup({ kind: 'auto', now: day(1) });
    update('notes', { body: 'v2' }, { where: { id: note.id } });
    const second = await createBackup({ kind: 'auto', now: day(2) });
    expect(second.created).toBe(true);
    expect(noteBodies(backupFile(second.meta.id, '.db'))).toEqual(['v2']);
    expect(await listMetas(backupsDir())).toHaveLength(2);
  });

  it('manual backups never skip, even when nothing changed', async () => {
    insert('notes', { body: 'same' });
    await createBackup({ kind: 'manual', now: day(1) });
    const second = await createBackup({ kind: 'manual', now: day(2) });
    expect(second.created).toBe(true);
  });

  it('a tampered newest .db forces a new backup and marks the old one failed (hash_mismatch)', async () => {
    insert('notes', { body: 'same' });
    const first = await createBackup({ kind: 'auto', now: day(1) });
    fs.appendFileSync(backupFile(first.meta.id, '.db'), Buffer.from('tampered'));
    const second = await createBackup({ kind: 'auto', now: day(2) });
    expect(second.created).toBe(true);
    expect(second.meta.id).not.toBe(first.meta.id);
    const metas = await listMetas(backupsDir());
    const old = metas.find((m) => m.id === first.meta.id);
    expect(old).toMatchObject({ status: 'failed', error: 'hash_mismatch' });
    expect(metas.find((m) => m.id === second.meta.id).status).toBe('verified');
    expect(noteBodies(backupFile(second.meta.id, '.db'))).toEqual(['same']);
  });

  it('a missing newest .db is treated as not intact and a new backup is made', async () => {
    insert('notes', { body: 'same' });
    const first = await createBackup({ kind: 'auto', now: day(1) });
    fs.rmSync(backupFile(first.meta.id, '.db'));
    const second = await createBackup({ kind: 'auto', now: day(2) });
    expect(second.created).toBe(true);
    expect((await listMetas(backupsDir())).find((m) => m.id === first.meta.id).status).toBe('failed');
  });

  it('is due again after 24 hours even when unchanged, and the re-run re-verifies the file', async () => {
    insert('notes', { body: 'same' });
    const first = await createBackup({ kind: 'auto', now: day(1) });
    const metas = await listMetas(backupsDir());
    const state = await readState();
    const at = (h) => new Date(day(1).getTime() + h * 3_600_000);
    expect(isBackupDue({ state, metas, now: at(23) })).toBe(false);
    expect(isBackupDue({ state, metas, now: at(24) })).toBe(true);
    expect(isBackupDue({ state, metas, now: at(30) })).toBe(true);

    const result = await runScheduledBackup({ now: at(25) });
    expect(result).toEqual({ ok: true, created: false });
    expect((await readState()).lastSuccessAt).toBe(at(25).toISOString());
    expect(isBackupDue({ state: await readState(), metas: await listMetas(backupsDir()), now: at(26) })).toBe(false);

    // Corruption between runs is caught by the next due run.
    fs.appendFileSync(backupFile(first.meta.id, '.db'), 'x');
    const repaired = await runScheduledBackup({ now: at(50) });
    expect(repaired).toEqual({ ok: true, created: true });
  });

  it('isBackupDue: no success yet is due; a failure within 6 hours holds it back', async () => {
    const now = day(10);
    expect(isBackupDue({ state: { lastSuccessAt: null, lastFailureAt: null }, metas: [], now })).toBe(true);
    const old = new Date(now.getTime() - 30 * 3_600_000).toISOString();
    const failedAgo = (h) => new Date(now.getTime() - h * 3_600_000).toISOString();
    const base = { lastSuccessAt: old };
    expect(isBackupDue({ state: { ...base, lastFailureAt: failedAgo(2) }, metas: [], now })).toBe(false);
    expect(isBackupDue({ state: { ...base, lastFailureAt: failedAgo(6) }, metas: [], now })).toBe(false);
    expect(isBackupDue({ state: { ...base, lastFailureAt: failedAgo(6.01) }, metas: [], now })).toBe(true);
  });
});

describe('integrity failure handling', () => {
  // Overwrites the root page of one index in the copy: the file still opens (normalizing works)
  // but integrity_check reports damage.
  const corrupt = (db, partial) => {
    takeSnapshot(db, partial);
    const c = new DatabaseSync(partial);
    const { rootpage } = c.prepare("SELECT rootpage FROM sqlite_master WHERE name = 'notes_created_idx'").get();
    c.close();
    const buf = fs.readFileSync(partial);
    const pageSize = buf.readUInt16BE(16) || 65536;
    buf.fill(0xff, (rootpage - 1) * pageSize + 8, (rootpage - 1) * pageSize + 60);
    fs.writeFileSync(partial, buf);
  };

  it('a corrupted snapshot produces a failed meta, leaves no .db, and the status turns failing', async () => {
    insert('notes', { body: SENTINEL });
    const good = await createBackup({ kind: 'manual', now: day(1) });
    await expect(createBackup({ kind: 'manual', now: day(2), snapshotFn: corrupt })).rejects.toMatchObject({
      code: 'backup_failed',
      status: 500,
    });
    const metas = await listMetas(backupsDir());
    const failed = metas.find((m) => m.status === 'failed');
    expect(failed).toMatchObject({ error: 'integrity_failed', db: null, fingerprint: null });
    const left = names().filter((n) => n.includes(failed.id));
    expect(left).toEqual([`burrow-${failed.id}.meta.json`]);
    expect(names().filter((n) => n.endsWith('.partial'))).toEqual([]);

    const status = await getBackupStatus({ now: day(2) });
    expect(status.health).toBe('failing');
    expect(status.lastBackupId).toBe(good.meta.id);
    expect(status.lastResult).toBe('failed');
    expect(status.lastError).toBe('integrity_failed');
    // The good backup is untouched.
    expect(integrityOf(backupFile(good.meta.id, '.db'))).toEqual(['ok']);
  });

  it('the failure audit row carries counts and codes only, never data values', async () => {
    insert('notes', { body: SENTINEL });
    await expect(createBackup({ kind: 'manual', now: day(1), snapshotFn: corrupt })).rejects.toThrow();
    const rows = auditRows('backup_create');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'export', status: 'error' });
    expect(metaOf(rows[0])).toEqual({ backup_kind: 'manual', error: 'integrity_failed' });
    expect(JSON.stringify(select('audit_log'))).not.toContain(SENTINEL);
  });

  it('the success audit row is counts only too', async () => {
    insert('notes', { body: SENTINEL });
    await createBackup({ kind: 'manual', now: day(1) });
    const [row] = auditRows('backup_create');
    expect(row.status).toBe('ok');
    const meta = metaOf(row);
    expect(Object.keys(meta).sort()).toEqual(['backup_kind', 'bytes', 'rows', 'tables']);
    expect(meta.rows).toBe(1);
    expect(JSON.stringify(select('audit_log'))).not.toContain(SENTINEL);
  });

  it('a snapshot too damaged to read is also a failed backup with no file left', async () => {
    insert('notes', { body: SENTINEL });
    const wreck = (db, partial) => {
      takeSnapshot(db, partial);
      const c = new DatabaseSync(partial);
      const { rootpage } = c.prepare("SELECT rootpage FROM sqlite_master WHERE name = 'notes'").get();
      c.close();
      const buf = fs.readFileSync(partial);
      const pageSize = buf.readUInt16BE(16) || 65536;
      buf.fill(0xff, (rootpage - 1) * pageSize + 8, (rootpage - 1) * pageSize + 60);
      fs.writeFileSync(partial, buf);
    };
    await expect(createBackup({ kind: 'manual', now: day(1), snapshotFn: wreck })).rejects.toMatchObject({ code: 'backup_failed' });
    const [failed] = await listMetas(backupsDir());
    expect(failed.status).toBe('failed');
    expect(failed.error).toBe('integrity_failed');
    expect(names().filter((n) => n.endsWith('.db') || n.endsWith('.partial') || n.endsWith('.zip'))).toEqual([]);
  });

  it('with no earlier backup a failure leaves the health at none', async () => {
    insert('notes', { body: 'x' });
    await expect(createBackup({ kind: 'manual', now: day(1), snapshotFn: corrupt })).rejects.toThrow();
    expect((await getBackupStatus({ now: day(1) })).health).toBe('none');
  });

  it('a snapshot that throws is a failed meta with snapshot_failed and no partial files', async () => {
    const boom = () => {
      throw new Error('boom with a path C:\\secret\\place');
    };
    await expect(createBackup({ kind: 'manual', now: day(1), snapshotFn: boom })).rejects.toMatchObject({ code: 'backup_failed' });
    const [failed] = await listMetas(backupsDir());
    expect(failed).toMatchObject({ status: 'failed', error: 'snapshot_failed' });
    expect(names().filter((n) => n.endsWith('.db') || n.endsWith('.partial') || n.endsWith('.zip'))).toEqual([]);
    expect(JSON.stringify(select('audit_log'))).not.toContain('secret');
  });

  it('a later good backup recovers the health', async () => {
    insert('notes', { body: 'x' });
    await createBackup({ kind: 'manual', now: day(1) });
    await expect(createBackup({ kind: 'manual', now: day(2), snapshotFn: corrupt })).rejects.toThrow();
    expect((await getBackupStatus({ now: day(2) })).health).toBe('failing');
    await createBackup({ kind: 'manual', now: day(3) });
    expect((await getBackupStatus({ now: day(3) })).health).toBe('ok');
  });
});

describe('disk limits', () => {
  const listFiles = () => names().filter((n) => !n.endsWith('.meta.json') && n !== 'state.json');

  it('free space below the floor throws disk_low (507), writes no files, and records a failed meta', async () => {
    const need = diskNeed();
    const fsOps = createFsOps({ statfs: statfsFree(need + DISK_FLOOR_BYTES - 1) });
    await expect(createBackup({ kind: 'manual', now: day(1), fsOps })).rejects.toMatchObject({ code: 'disk_low', status: 507 });
    expect(listFiles()).toEqual([]);
    const [failed] = await listMetas(backupsDir());
    expect(failed).toMatchObject({ status: 'failed', error: 'disk_low' });
    expect((await readState()).lastError).toBe('disk_low');
  });

  it('exactly the floor is allowed', async () => {
    const need = diskNeed();
    const fsOps = createFsOps({ statfs: statfsFree(need + DISK_FLOOR_BYTES) });
    const { created } = await createBackup({ kind: 'manual', now: day(1), fsOps });
    expect(created).toBe(true);
  });

  it('between the floor and the warning level the backup succeeds and diskWarning is true', async () => {
    const fsOps = createFsOps({ statfs: statfsFree(DISK_WARN_BYTES - 1) });
    const { created } = await createBackup({ kind: 'manual', now: day(1), fsOps });
    expect(created).toBe(true);
    expect((await readState()).diskWarning).toBe(true);
    expect((await getBackupStatus({ now: day(1) })).diskWarning).toBe(true);
  });

  it('at or above the warning level diskWarning is false and clears an earlier warning', async () => {
    await createBackup({ kind: 'manual', now: day(1), fsOps: createFsOps({ statfs: statfsFree(DISK_WARN_BYTES - 1) }) });
    expect((await readState()).diskWarning).toBe(true);
    await createBackup({ kind: 'manual', now: day(2), fsOps: createFsOps({ statfs: statfsFree(DISK_WARN_BYTES) }) });
    const state = await readState();
    expect(state.diskWarning).toBe(false);
    expect(state.freeBytes).toBe(DISK_WARN_BYTES);
  });

  it('a statfs failure does not block the backup', async () => {
    const fsOps = createFsOps({
      statfs: async () => {
        throw new Error('not supported');
      },
    });
    expect((await createBackup({ kind: 'manual', now: day(1), fsOps })).created).toBe(true);
  });

  it('ENOSPC while writing the snapshot is disk_full and the .partial is removed', async () => {
    const full = (_db, partial) => {
      fs.writeFileSync(partial, 'half a file');
      throw enospc();
    };
    await expect(createBackup({ kind: 'manual', now: day(1), snapshotFn: full })).rejects.toMatchObject({
      code: 'disk_full',
      status: 507,
    });
    expect(listFiles()).toEqual([]);
    expect((await listMetas(backupsDir()))[0]).toMatchObject({ status: 'failed', error: 'disk_full' });
  });

  it('SQLite "database or disk is full" is also disk_full', async () => {
    const full = () => {
      throw new Error('database or disk is full');
    };
    await expect(createBackup({ kind: 'manual', now: day(1), snapshotFn: full })).rejects.toMatchObject({ code: 'disk_full' });
  });

  it('ENOSPC while writing the export ZIP is disk_full and removes the already written snapshot copy', async () => {
    const real = createFsOps();
    const fsOps = createFsOps({
      open: async (file, ...rest) => {
        if (String(file).endsWith('.export.zip.partial')) throw enospc();
        return real.open(file, ...rest);
      },
    });
    await expect(createBackup({ kind: 'manual', now: day(1), fsOps })).rejects.toMatchObject({ code: 'disk_full' });
    expect(listFiles()).toEqual([]);
  });

  it('an export that is too large keeps the .db valid and records export.status too_large', async () => {
    insert('notes', { body: 'x' });
    const tooLarge = async () => {
      throw Object.assign(new Error('x'), { code: 'export_too_large' });
    };
    const { meta } = await createBackup({ kind: 'manual', now: day(1), exportFn: tooLarge });
    expect(meta.status).toBe('verified');
    expect(meta.export).toMatchObject({ status: 'too_large', file: null, sha256: null });
    expect(fs.existsSync(backupFile(meta.id, '.db'))).toBe(true);
    expect(fs.existsSync(backupFile(meta.id, '.export.zip'))).toBe(false);
    expect(names().filter((n) => n.endsWith('.partial'))).toEqual([]);
  });

  it('any other export failure records export.status failed and still keeps the .db', async () => {
    const { meta } = await createBackup({
      kind: 'manual',
      now: day(1),
      exportFn: async () => {
        throw new Error('zip exploded');
      },
    });
    expect(meta.status).toBe('verified');
    expect(meta.export.status).toBe('failed');
  });

  it('an incomplete export manifest is recorded as partial', async () => {
    const { meta } = await createBackup({
      kind: 'manual',
      now: day(1),
      exportFn: async (opts) => {
        const r = await buildExportZip(opts);
        return { ...r, manifest: { ...r.manifest, complete: false } };
      },
    });
    expect(meta.export.status).toBe('partial');
    expect(fs.existsSync(backupFile(meta.id, '.export.zip'))).toBe(true);
  });
});

describe('backup contents and export exclusion', () => {
  it('meta describes the files: hashes, sizes, row counts and schema version', async () => {
    insert('notes', { body: 'a' });
    insert('notes', { body: 'b' });
    const { meta } = await createBackup({ kind: 'manual', now: day(1) });
    const dbFile = backupFile(meta.id, '.db');
    const zipFile = backupFile(meta.id, '.export.zip');
    expect(meta.db).toEqual({ file: `burrow-${meta.id}.db`, bytes: fs.statSync(dbFile).size, sha256: sha256Of(dbFile) });
    expect(meta.export).toMatchObject({ file: `burrow-${meta.id}.export.zip`, bytes: fs.statSync(zipFile).size, sha256: sha256Of(zipFile), status: 'ok' });
    expect(meta.rowCounts.notes).toBe(2);
    expect(meta.totalRows).toBe(2);
    expect(meta.schemaVersion).toBe(withReadOnly(dbFile, (db) => db.prepare('SELECT MAX(version) AS v FROM schema_version').get().v));
    expect(readJson(backupFile(meta.id, '.meta.json'))).toEqual(meta);
    expect(meta.format).toBe('burrow-backup');
    expect(meta.id).toMatch(/^\d{8}T\d{6}Z-manual-[0-9a-f]{6}$/);
    expect(meta.createdAt).toBe(day(1).toISOString());
  });

  it('the snapshot is a self-contained file (no -wal or -shm) in rollback-journal mode', async () => {
    insert('notes', { body: 'a' });
    const { meta } = await createBackup({ kind: 'manual', now: day(1) });
    expect(names().filter((n) => n.endsWith('-wal') || n.endsWith('-shm'))).toEqual([]);
    expect(withReadOnly(backupFile(meta.id, '.db'), (db) => db.prepare('PRAGMA journal_mode').get().journal_mode)).toBe('delete');
  });

  it("the backup's .export.zip manifest is a burrow-export, formatVersion 2, with the data inside", async () => {
    insert('notes', { body: 'exported note' });
    const { meta } = await createBackup({ kind: 'manual', now: day(1) });
    const files = unzipSync(new Uint8Array(fs.readFileSync(backupFile(meta.id, '.export.zip'))));
    const manifest = JSON.parse(strFromU8(files['manifest.json']));
    expect(manifest).toMatchObject({ format: 'burrow-export', formatVersion: 2, complete: true });
    expect(Object.keys(files).some((f) => f.startsWith('json/'))).toBe(true);
    expect(Object.keys(files).some((f) => f.startsWith('csv/'))).toBe(true);
    expect(strFromU8(files['json/notes.json'])).toContain('exported note');
    expect(Object.keys(files).some((f) => /audit_log|app_secrets/.test(f))).toBe(false);
  });

  it('a live export ZIP never contains backups', async () => {
    insert('notes', { body: 'n' });
    const { meta } = await createBackup({ kind: 'manual', now: day(1) });
    const { zip } = await buildExportZip({ db: getDb() });
    const files = unzipSync(zip);
    const listing = Object.keys(files).join('\n');
    expect(listing).not.toMatch(/backup|burrow-|\.db\b|\.meta\.json|(^|\/)state\.json/i);
    expect(listing).not.toContain(meta.id);
    for (const [name, bytes] of Object.entries(files)) {
      if (name.endsWith('.json') || name.endsWith('.csv') || name.endsWith('.md')) {
        expect(strFromU8(bytes), name).not.toContain(meta.id);
      }
    }
    // The backups folder is never inside any export entry path.
    expect(listing).not.toContain('backups/');
  });
});

describe('locking and the scheduled run', () => {
  it('a second concurrent backup is refused with backup_busy (409) and the first completes', async () => {
    insert('notes', { body: 'x' });
    const results = await Promise.allSettled([createBackup({ kind: 'manual', now: day(1) }), createBackup({ kind: 'manual', now: day(1) })]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected[0].reason).toMatchObject({ code: 'backup_busy', status: 409 });
    expect(currentOp()).toBeNull();
    expect(await listMetas(backupsDir())).toHaveLength(1);
  });

  it('the lock is released after a failure so the next backup can run', async () => {
    await expect(
      createBackup({
        kind: 'manual',
        now: day(1),
        snapshotFn: () => {
          throw new Error('x');
        },
      }),
    ).rejects.toThrow();
    expect(currentOp()).toBeNull();
    expect((await createBackup({ kind: 'manual', now: day(2) })).created).toBe(true);
  });

  it('while a restore holds the lock a backup answers db_restoring (503)', async () => {
    const release = tryAcquire('restore');
    try {
      await expect(createBackup({ kind: 'manual', now: day(1) })).rejects.toMatchObject({ code: 'db_restoring', status: 503 });
    } finally {
      release();
    }
  });

  it('an unknown kind is rejected as invalid_request', async () => {
    await expect(createBackup({ kind: 'weekly' })).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('runScheduledBackup never throws: failures come back as {ok:false, code}', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const low = createFsOps({ statfs: statfsFree(1024) });
    expect(await runScheduledBackup({ now: day(1), fsOps: low })).toEqual({ ok: false, code: 'disk_low' });
    const release = tryAcquire('backup');
    expect(await runScheduledBackup({ now: day(2) })).toEqual({ ok: false, code: 'backup_busy' });
    release();
    expect(await runScheduledBackup({ now: day(3) })).toEqual({ ok: true, created: true });
    expect(quiet).toHaveBeenCalled();
    for (const call of quiet.mock.calls) expect(call.join(' ')).not.toContain(dataDir());
  });

  it('the scheduled run is an auto backup, and dates the id from the injected clock', async () => {
    insert('notes', { body: 'x' });
    await runScheduledBackup({ now: () => day(4) });
    const [meta] = await listMetas(backupsDir());
    expect(meta.kind).toBe('auto');
    expect(meta.id.startsWith('20260604T120000Z-auto-')).toBe(true);
  });

  it('the database stays usable after the live handle is closed and reopened between backups', async () => {
    insert('notes', { body: 'x' });
    await createBackup({ kind: 'manual', now: day(1) });
    closeDb();
    insert('notes', { body: 'y' });
    const { meta } = await createBackup({ kind: 'manual', now: day(2) });
    expect(noteBodies(backupFile(meta.id, '.db'))).toEqual(['x', 'y']);
  });

  it('a backup also applies retention with the saved settings and the injected clock', async () => {
    await saveBackupSettings({ keepDaily: 2, keepWeekly: 0, keepMonthly: 0 });
    for (let i = 1; i <= 5; i += 1) {
      insert('notes', { body: `n${i}` });
      await createBackup({ kind: 'auto', now: day(i) });
    }
    const metas = await listMetas(backupsDir());
    expect(metas).toHaveLength(2);
    expect(metas.map((m) => m.createdAt)).toEqual([day(5).toISOString(), day(4).toISOString()]);
    // Files of removed backups are gone too, not only their metas.
    expect(names().filter((n) => n.endsWith('.db')).length).toBe(2);
    expect(names().filter((n) => n.endsWith('.export.zip')).length).toBe(2);
  }, 20_000);
});
