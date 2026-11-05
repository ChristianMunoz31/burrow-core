// Backups and the Dev copy do not carry the Folders question index (chunk text and vectors derived from the user's files):
// normalizeSnapshot empties it and vacuums, the live database is untouched, an index-only change makes no new backup,
// and after a restore the folder asks for a re-scan (the Pro ask route answering 409 is tested in backupFolderIndex.pro.test.js). The direct-Burrow import keeps the index byte for byte.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { strFromU8, unzipSync } from 'fflate';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../license/index.js', async (importOriginal) => (await import('./helpers/pro.js')).mockLicenseModule(importOriginal));
vi.mock('../../loadEnv.js', () => ({}));

import { count, getDb, insert, select } from '../db/index.js';
import { createBackup } from '../backup/service.js';
import { backupsDir } from '../backup/paths.js';
import { restoreBackup } from '../backup/restore.js';
import { inspectDbFile, latestSchemaVersion, normalizeSnapshot, takeSnapshot } from '../backup/snapshot.js';
import { getFolder } from '../folders/store.js';
import { backupFile, cleanupBackupEnv, dataDir, day, resetBackupEnv } from './helpers/backupEnv.js';

const SENTINEL = 'SENTINEL-FOLDER-CHUNK-TEXT-4471';
const INDEX = { status: 'ready', files: 1, chunks: 2, skipped: null };

beforeEach(() => {
  resetBackupEnv();
});
afterAll(() => {
  cleanupBackupEnv();
});

function seedIndexedFolder() {
  const folder = insert('folders', { name: 'Notes', path: path.join(dataDir(), 'not-read'), path_key: 'k1', stats: { files: 1, index: INDEX }, summary_status: 'ok' });
  const file = insert('folder_files', {
    folder_id: folder.id,
    rel_path: 'plan.txt',
    ext: 'txt',
    kind: 'text',
    status: 'ok',
    sha256: 'a'.repeat(64),
    index_hash: 'a'.repeat(64),
    index_model: 'nomic-embed-text',
    chunk_count: 2,
  });
  for (let seq = 0; seq < 2; seq += 1) {
    insert('folder_chunks', { folder_id: folder.id, file_id: file.id, seq, start_line: 1, end_line: 2, text: `${SENTINEL} ${seq}`, embedding: 'AAAAAAAA', dims: 8 });
  }
  return { folder, file };
}

const readBytes = (file) => fs.readFileSync(file);
const withDb = (file, fn) => {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
};

describe('a backup of an indexed folder', () => {
  it('holds no chunk, no chunk text and no index state, and the live database keeps its index', async () => {
    const { folder } = seedIndexedFolder();
    // Make sure the live files do hold the sentinel, so the check below proves something.
    expect(count('folder_chunks')).toBe(2);
    const { meta } = await createBackup({ kind: 'manual', now: day(1) });
    const file = backupFile(meta.id, '.db');

    expect(readBytes(file).includes(SENTINEL)).toBe(false);
    expect(readBytes(file).includes('nomic-embed-text')).toBe(false);
    withDb(file, (db) => {
      expect(db.prepare('SELECT COUNT(*) AS n FROM folder_chunks').get().n).toBe(0);
      expect(db.prepare('SELECT COUNT(*) AS n FROM folder_files').get().n).toBe(1);
      expect(db.prepare('SELECT index_hash, index_model, chunk_count FROM folder_files').get()).toEqual({ index_hash: null, index_model: null, chunk_count: 0 });
      const stats = JSON.parse(db.prepare('SELECT stats FROM folders WHERE id = ?').get(folder.id).stats);
      expect(stats.index).toEqual({ status: 'none', files: 0, chunks: 0, skipped: null });
      expect(stats.files).toBe(1);
      expect(db.prepare('PRAGMA integrity_check').all()).toEqual([{ integrity_check: 'ok' }]);
    });
    expect(inspectDbFile(file)).toMatchObject({ integrityOk: true, shapeOk: true, schemaVersion: latestSchemaVersion() });

    // The live database is untouched.
    expect(count('folder_chunks')).toBe(2);
    expect(getFolder(folder.id).stats.index).toEqual(INDEX);
    expect(select('folder_files')[0]).toMatchObject({ index_hash: 'a'.repeat(64), chunk_count: 2 });
  });

  it('the export ZIP inside the backup carries the folder but not the chunk text', async () => {
    seedIndexedFolder();
    const { meta } = await createBackup({ kind: 'manual', now: day(1) });
    const zip = backupFile(meta.id, '.export.zip');
    const files = unzipSync(readBytes(zip));
    expect(Object.keys(files)).toContain('json/folders.json');
    expect(Object.keys(files).some((n) => n.includes('folder_chunks'))).toBe(false);
    expect(Object.values(files).map((v) => strFromU8(v)).join('\n')).not.toContain(SENTINEL);
  });

  it('an index-only change makes no new automatic backup', async () => {
    const { folder, file } = seedIndexedFolder();
    const first = await createBackup({ kind: 'auto', now: day(1) });
    expect(first.created).toBe(true);
    // Rebuilding the index changes chunks and index fields only (written without touching updated_at).
    const db = getDb();
    db.prepare("UPDATE folder_chunks SET text = 'other text'").run();
    db.prepare("UPDATE folder_files SET index_hash = ?, chunk_count = 5 WHERE id = ?").run('c'.repeat(64), file.id);
    db.prepare("UPDATE folders SET stats = json_set(stats, '$.index.chunks', 9) WHERE id = ?").run(folder.id);
    insert('folder_chunks', { folder_id: folder.id, file_id: file.id, seq: 9, start_line: 1, end_line: 1, text: 'more', embedding: 'AAAA', dims: 8 });
    const second = await createBackup({ kind: 'auto', now: day(2) });
    expect(second).toMatchObject({ created: false, reason: 'unchanged' });
  });

  it('a change to the folder itself still makes a new backup', async () => {
    const { folder } = seedIndexedFolder();
    await createBackup({ kind: 'auto', now: day(1) });
    getDb().prepare("UPDATE folders SET name = 'Renamed' WHERE id = ?").run(folder.id);
    expect((await createBackup({ kind: 'auto', now: day(2) })).created).toBe(true);
  });

  it('after a restore the folder is not indexed until the next scan', async () => {
    const { folder } = seedIndexedFolder();
    const { meta } = await createBackup({ kind: 'manual', now: day(1) });
    await restoreBackup({ id: meta.id, now: day(2) });
    expect(count('folder_chunks')).toBe(0);
    expect(getFolder(folder.id).stats.index.status).toBe('none');
    expect(count('folders')).toBe(1);
  });
});

describe('normalizeSnapshot options', () => {
  const snapshotWithIndex = () => {
    seedIndexedFolder();
    insert('app_secrets', { name: 'FAKE_TEST_KEY', ciphertext: 'ct', iv: 'iv', auth_tag: 'tag', last4: 'abcd' });
    const target = path.join(dataDir(), 'copy.db');
    takeSnapshot(getDb(), target);
    return target;
  };
  const counts = (file) =>
    withDb(file, (db) => ({
      chunks: db.prepare('SELECT COUNT(*) AS n FROM folder_chunks').get().n,
      secrets: db.prepare('SELECT COUNT(*) AS n FROM app_secrets').get().n,
    }));

  it('strips the saved keys and the index by default', () => {
    const file = snapshotWithIndex();
    normalizeSnapshot(file);
    expect(counts(file)).toEqual({ chunks: 0, secrets: 0 });
    expect(readBytes(file).includes(SENTINEL)).toBe(false);
  });

  it('keepSecrets (the direct-Burrow import) keeps both, so its fingerprint check compares the same bytes', () => {
    const file = snapshotWithIndex();
    const before = inspectDbFile(file).fingerprint;
    normalizeSnapshot(file, { keepSecrets: true });
    expect(counts(file)).toEqual({ chunks: 2, secrets: 1 });
    expect(inspectDbFile(file).fingerprint).toBe(before);
  });

  it('the two switches are independent', () => {
    const a = snapshotWithIndex();
    normalizeSnapshot(a, { keepFolderIndex: true });
    expect(counts(a)).toEqual({ chunks: 2, secrets: 0 });
    const b = path.join(dataDir(), 'copy-b.db');
    takeSnapshot(getDb(), b);
    normalizeSnapshot(b, { keepSecrets: true, keepFolderIndex: false });
    expect(counts(b)).toEqual({ chunks: 0, secrets: 1 });
  });

  it('works on a database from before the Folders tables existed', () => {
    const file = path.join(dataDir(), 'old.db');
    const db = new DatabaseSync(file);
    db.exec('CREATE TABLE app_secrets (name TEXT); CREATE TABLE notes (body TEXT); INSERT INTO notes VALUES (\'x\')');
    db.close();
    expect(() => normalizeSnapshot(file)).not.toThrow();
    withDb(file, (d) => expect(d.prepare('SELECT COUNT(*) AS n FROM notes').get().n).toBe(1));
  });

  it('works when the Folders tables hold no chunks, and leaves no journal behind', () => {
    insert('folders', { name: 'Empty', path: path.join(dataDir(), 'x'), path_key: 'k2' });
    const file = path.join(dataDir(), 'copy.db');
    takeSnapshot(getDb(), file);
    normalizeSnapshot(file);
    expect(fs.existsSync(`${file}-journal`)).toBe(false);
    expect(fs.existsSync(`${file}-wal`)).toBe(false);
    expect(withDb(file, (db) => db.prepare('PRAGMA journal_mode').get().journal_mode)).toBe('delete');
  });

  it('keeps the backups folder free of stray files', async () => {
    seedIndexedFolder();
    await createBackup({ kind: 'manual', now: day(1) });
    expect(fs.readdirSync(backupsDir()).filter((n) => /partial|journal|tmp/.test(n))).toEqual([]);
  });
});
