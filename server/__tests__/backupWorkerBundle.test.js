// The desktop sidecar has no worker file on disk: scripts/desktop/workerBundle.js bundles the backup
// worker into one CJS source string that client.js starts with new Worker(src, { eval: true }). This
// runs the real esbuild pass and the bundled source in a real worker, and checks it behaves like the
// main thread.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { unzipSync, strFromU8 } from 'fflate';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildBackupWorkerSource } from '../../scripts/desktop/workerBundle.js';
import { MIGRATIONS_DIR } from '../db/migrate.js';
import { buildExportZip } from '../export/buildArchive.js';
import { getDb, insert, resolveDbPath } from '../db/index.js';
import { inspectDbFile, latestSchemaVersion } from '../backup/snapshot.js';
import { __setWorkerFactoryForTests, isWorkerUnavailable, runBackupOp } from '../backup/worker/client.js';
import { cleanupBackupEnv, dataDir, resetBackupEnv } from './helpers/backupEnv.js';

const REPO_MIGRATIONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');

// Both variants: the release sidecar is built with --minify, so the minified source is tested too.
describe.each([{ minify: false }, { minify: true }])('backup worker bundle (minify: $minify)', ({ minify }) => {
  let src;

  beforeAll(async () => {
    src = await buildBackupWorkerSource({ minify });
    resetBackupEnv();
    for (let i = 0; i < 25; i += 1) {
      insert('notes', { body: `synthetic note ${i}` });
      insert('transactions', { date: '2025-03-01', merchant: `Merchant ${i}`, amount: i + 0.5, category: 'Misc', type: 'expense' });
    }
    getDb().exec('PRAGMA wal_checkpoint(TRUNCATE)');
  }, 60_000);
  afterEach(() => {
    __setWorkerFactoryForTests(null);
  });
  afterAll(() => {
    cleanupBackupEnv();
  });

  const useBundle = () =>
    __setWorkerFactoryForTests(({ env }) => new Worker(src, { eval: true, env }));

  it('is one source string that requires only node: built-ins', () => {
    expect(typeof src).toBe('string');
    expect(src.length).toBeGreaterThan(1000);
    const required = [...src.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);
    expect(required.length).toBeGreaterThan(0);
    for (const name of required) expect(name.startsWith('node:'), name).toBe(true);
    expect(src).not.toMatch(/\bimport\.meta\b/);
  });

  it('snapshotInspect matches a main-thread inspection of the copy it wrote', async () => {
    useBundle();
    const partialPath = path.join(dataDir(), 'bundle-check.db.partial');
    const latestVersion = latestSchemaVersion();
    const result = await runBackupOp('snapshotInspect', { dbPath: resolveDbPath(), partialPath, latestVersion });
    expect(isWorkerUnavailable()).toBe(false);
    expect(result.integrityOk).toBe(true);
    expect(result.rowCounts.notes).toBe(25);
    expect(result.rowCounts.transactions).toBe(25);
    expect(result).toEqual(inspectDbFile(partialPath, { latestVersion }));
    expect(fs.existsSync(`${partialPath}-wal`)).toBe(false);
    fs.rmSync(partialPath, { force: true });
  });

  it('inspectFile and integrityCheck match the main thread', async () => {
    useBundle();
    const file = path.join(dataDir(), 'bundle-inspect.db');
    fs.rmSync(file, { force: true });
    getDb().exec(`VACUUM INTO '${file.replaceAll("'", "''")}'`);
    const latestVersion = latestSchemaVersion();
    await expect(runBackupOp('inspectFile', { file, latestVersion })).resolves.toEqual(inspectDbFile(file, { latestVersion }));
    await expect(runBackupOp('integrityCheck', { file })).resolves.toEqual({ ok: true });
    fs.rmSync(file, { force: true });
  });

  it('finds the migrations through BURROW_MIGRATIONS_DIR, which the client passes along', async () => {
    let passed;
    __setWorkerFactoryForTests(({ env }) => {
      passed = env.BURROW_MIGRATIONS_DIR;
      return new Worker(src, { eval: true, env });
    });
    const file = path.join(dataDir(), 'bundle-shape.db');
    fs.rmSync(file, { force: true });
    getDb().exec(`VACUUM INTO '${file.replaceAll("'", "''")}'`);
    // shapeOk needs the migrations inside the worker.
    const result = await runBackupOp('inspectFile', { file, latestVersion: latestSchemaVersion() });
    expect(result.shapeOk).toBe(true);
    expect(path.resolve(passed)).toBe(path.resolve(MIGRATIONS_DIR));
    expect(path.resolve(passed)).toBe(REPO_MIGRATIONS);
    fs.rmSync(file, { force: true });
  });

  it('buildExport writes the same archive the main thread builds, and keeps the secrets out of it', async () => {
    useBundle();
    const dbPath = path.join(dataDir(), 'bundle-export.db');
    const outPath = path.join(dataDir(), 'bundle-export.zip.partial');
    fs.rmSync(dbPath, { force: true });
    fs.rmSync(outPath, { force: true });
    getDb().exec(`VACUUM INTO '${dbPath.replaceAll("'", "''")}'`);
    const nowIso = '2026-06-01T12:00:00.000Z';
    const result = await runBackupOp('buildExport', { dbPath, outPath, nowIso });
    expect(isWorkerUnavailable()).toBe(false);
    const reader = new DatabaseSync(dbPath, { readOnly: true });
    let expected;
    try {
      expected = await buildExportZip({ db: reader, now: new Date(nowIso) });
    } finally {
      reader.close();
    }
    const written = fs.readFileSync(outPath);
    expect(result).toEqual({ bytes: written.length, complete: true });
    const got = unzipSync(new Uint8Array(written));
    const want = unzipSync(expected.zip);
    expect(Object.keys(got).sort()).toEqual(Object.keys(want).sort());
    for (const name of Object.keys(want)) expect(strFromU8(got[name]), name).toBe(strFromU8(want[name]));
    expect(JSON.parse(strFromU8(got['manifest.json']))).toEqual(expected.manifest);
    expect(Object.keys(got).some((f) => /app_secrets|audit_log/.test(f))).toBe(false);
    fs.rmSync(dbPath, { force: true });
    fs.rmSync(outPath, { force: true });
  });

  it('buildExport reports a missing snapshot as a failure with stage export and no path', async () => {
    useBundle();
    const dbPath = path.join(dataDir(), 'nope', 'missing.db');
    const e = await runBackupOp('buildExport', { dbPath, outPath: `${dbPath}.zip`, nowIso: '2026-06-01T12:00:00.000Z' }).catch((x) => x);
    expect(e).toMatchObject({ workerOpFailed: true, stage: 'export' });
    expect(JSON.stringify([e.message, e.errstr, e.code])).not.toContain('missing.db');
  });
});
