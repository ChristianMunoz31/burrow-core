// Smoke tests for the backup service: create, skip when unchanged, restore round trip.
// The exhaustive suite lives in the other backup test files.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import '../audit.js';
import { closeDb, count, getDb, insert, resolveDbPath, select } from '../db/index.js';
import { __resetLockForTests } from '../backup/lock.js';
import { listMetas } from '../backup/manifest.js';
import { backupsDir } from '../backup/paths.js';
import { restoreBackup } from '../backup/restore.js';
import { createBackup } from '../backup/service.js';

const dataDir = () => path.dirname(resolveDbPath());

function wipe() {
  closeDb();
  const dir = dataDir();
  for (const name of fs.readdirSync(dir)) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
}

beforeEach(() => {
  __resetLockForTests();
  wipe();
  getDb();
});

afterEach(() => {
  wipe();
});

describe('createBackup', () => {
  it('writes a verified snapshot, an export ZIP and a meta file', async () => {
    insert('notes', { body: 'first note' });
    const { created, meta } = await createBackup({ kind: 'manual' });
    expect(created).toBe(true);
    expect(meta.status).toBe('verified');
    expect(meta.kind).toBe('manual');
    expect(meta.export.status).toBe('ok');
    expect(meta.rowCounts.notes).toBe(1);
    const dir = backupsDir();
    expect(fs.existsSync(path.join(dir, `burrow-${meta.id}.db`))).toBe(true);
    expect(fs.existsSync(path.join(dir, `burrow-${meta.id}.export.zip`))).toBe(true);
    expect(fs.existsSync(path.join(dir, `burrow-${meta.id}.meta.json`))).toBe(true);
    expect(fs.readdirSync(dir).filter((n) => n.endsWith('.partial'))).toEqual([]);
  });

  it('skips an automatic backup when nothing changed', async () => {
    insert('notes', { body: 'same' });
    const day = (n) => new Date(Date.UTC(2026, 5, n, 12, 0, 0));
    const first = await createBackup({ kind: 'auto', now: day(1) });
    expect(first.created).toBe(true);
    const second = await createBackup({ kind: 'auto', now: day(2) });
    expect(second.created).toBe(false);
    expect(second.reason).toBe('unchanged');
    expect(await listMetas(backupsDir())).toHaveLength(1);

    insert('notes', { body: 'changed' });
    const third = await createBackup({ kind: 'auto', now: day(3) });
    expect(third.created).toBe(true);
    expect(await listMetas(backupsDir())).toHaveLength(2);
  });
});

describe('restoreBackup', () => {
  it('brings back the saved data and keeps a safety copy of the current data', async () => {
    insert('notes', { body: 'kept' });
    const { meta } = await createBackup({ kind: 'manual' });
    insert('notes', { body: 'added later' });
    expect(count('notes')).toBe(2);

    const result = await restoreBackup({ id: meta.id });
    expect(result.restoredFrom).toBe(meta.id);
    expect(result.schemaFrom).toBe(result.schemaTo);

    expect(select('notes').map((n) => n.body)).toEqual(['kept']);
    const safety = (await listMetas(backupsDir())).find((m) => m.id === result.safetyBackupId);
    expect(safety?.kind).toBe('safety');
    expect(safety?.rowCounts.notes).toBe(2);
    const leftovers = fs.readdirSync(dataDir()).filter((n) => n.startsWith('restore-'));
    expect(leftovers).toEqual([]);
  });
});
