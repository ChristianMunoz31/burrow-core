// Measures how long a large backup and a large backup-upload inspection block the event loop.
// Seeds synthetic data (200k transactions, 5k journal entries by default) into a throwaway data
// directory under the OS temp folder, then runs createBackup() and inspectUpload() while sampling
// perf_hooks.monitorEventLoopDelay plus a 5 ms setInterval max-gap probe.
//
// Usage: node scripts/bench/backupLag.js [--no-worker] [--tx N] [--journal N]
//   --no-worker  force the backup worker off (main-thread path), to compare against the default
// It also prints a profile of the export step on the main thread: serialization (reading tables, JSON,
// CSV, Markdown) versus compression (fflate zipSync level 6).
// Safety: the data dir is always a fresh fs.mkdtemp folder inside os.tmpdir() (checked with
// scripts/lib/sandboxSafety.js, which also refuses the real Burrow data dir); it is removed at the end.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { unzipSync, zipSync } from 'fflate';
import { assertSafeDataDir, assertUnderTmp } from '../lib/sandboxSafety.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const numFlag = (name, fallback) => {
  const i = argv.indexOf(name);
  if (i === -1) return fallback;
  const n = Number(argv[i + 1]);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} needs a non-negative integer`);
  return n;
};
const TX_COUNT = numFlag('--tx', 200_000);
const JOURNAL_COUNT = numFlag('--journal', 5_000);
const NO_WORKER = flag('--no-worker');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-bench-'));
assertSafeDataDir(dataDir);
process.env.BURROW_DATA_DIR = dataDir;
process.env.BURROW_NO_DOTENV = '1';
delete process.env.VITEST;

const srv = (rel) => import(pathToFileURL(path.join(ROOT, 'server', rel)).href);
const { getDb, closeDb, withTransaction } = await srv('db/index.js');
const { createBackup } = await srv('backup/service.js');
const { inspectUpload } = await srv('backup/restore.js');
const { buildExportZip } = await srv('exportRoutes.js');
const { __resetLockForTests } = await srv('backup/lock.js');

if (NO_WORKER) {
  let client = null;
  try {
    client = await srv('backup/worker/client.js');
  } catch {
    // the baseline run: no worker exists yet, the main-thread path is the only path
  }
  if (client) {
    client.__setWorkerFactoryForTests(() => {
      throw Object.assign(new Error('worker disabled by --no-worker'), { code: 'ERR_BENCH_NO_WORKER' });
    });
    console.error = () => {};
  }
}

function seed() {
  const db = getDb();
  const cats = ['Groceries', 'Rent', 'Transport', 'Dining', 'Utilities', 'Fun', 'Health', 'Misc'];
  const t0 = performance.now();
  withTransaction((tx) => {
    const insTx = tx.prepare(
      'INSERT INTO transactions (id, date, merchant, amount, category, type, source_file, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    for (let i = 0; i < TX_COUNT; i += 1) {
      const day = (i % 28) + 1;
      const month = ((i >> 5) % 12) + 1;
      insTx.run(
        `bench-tx-${i}`,
        `2025-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
        `Merchant ${i % 997}`,
        Math.round(((i * 37) % 50_000)) / 100,
        cats[i % cats.length],
        i % 9 === 0 ? 'income' : 'expense',
        `synthetic-${i % 40}.csv`,
        '2025-01-01T00:00:00.000Z',
      );
    }
    const insJ = tx.prepare(
      'INSERT INTO journal (id, title, date, body, mood, tags, context, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    for (let i = 0; i < JOURNAL_COUNT; i += 1) {
      insJ.run(
        `bench-j-${i}`,
        `Entry ${i}`,
        `2025-${String((i % 12) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}T08:00:00.000Z`,
        `Synthetic journal body number ${i}. `.repeat(12),
        'ok',
        '["bench"]',
        'both',
        '2025-01-01T00:00:00.000Z',
      );
    }
  }, db);
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  return performance.now() - t0;
}

/** Runs fn while sampling loop delay; returns the figures in ms. */
async function measure(label, fn) {
  const hist = monitorEventLoopDelay({ resolution: 10 });
  const PROBE_MS = 5;
  let last = performance.now();
  let maxGap = 0;
  const probe = setInterval(() => {
    const now = performance.now();
    maxGap = Math.max(maxGap, now - last);
    last = now;
  }, PROBE_MS);
  await new Promise((r) => setTimeout(r, 30)); // let the probe settle
  maxGap = 0;
  last = performance.now();
  hist.enable();
  const t0 = performance.now();
  let error = null;
  try {
    await fn();
  } catch (e) {
    error = e;
  }
  const wall = performance.now() - t0;
  hist.disable();
  clearInterval(probe);
  if (error) throw error;
  const ms = (ns) => ns / 1e6;
  return {
    label,
    p50: ms(hist.percentile(50)),
    p99: ms(hist.percentile(99)),
    max: ms(hist.max),
    probeMax: maxGap,
    wall,
  };
}

const fmt = (n) => n.toFixed(1).padStart(9);
let profile;
try {
  const seedMs = seed();
  console.log(`worker: ${NO_WORKER ? 'off (forced)' : 'default'} | node ${process.version} | ${process.platform} ${process.arch}`);
  console.log(`seeded ${TX_COUNT} transactions + ${JOURNAL_COUNT} journal entries in ${seedMs.toFixed(0)} ms (dir under os.tmpdir())`);

  // Profile of the export step on the main thread (outside the measured runs): total build time,
  // then the compression of the same files alone; the rest is serialization.
  {
    const { DatabaseSync } = await import('node:sqlite');
    const profDb = path.join(dataDir, 'profile.db');
    getDb().exec(`VACUUM INTO '${profDb.replaceAll("'", "''")}'`);
    const reader = new DatabaseSync(profDb, { readOnly: true });
    try {
      const t0 = performance.now();
      const { zip } = await buildExportZip({ db: reader });
      const total = performance.now() - t0;
      const files = unzipSync(zip);
      const t1 = performance.now();
      zipSync(files, { level: 6 });
      const compress = performance.now() - t1;
      const raw = Object.values(files).reduce((n, f) => n + f.length, 0);
      profile = { total, compress, serialize: total - compress, raw, zip: zip.length };
    } finally {
      reader.close();
      fs.rmSync(profDb, { force: true });
    }
  }

  const results = [];
  let created;
  results.push(
    await measure('createBackup (manual)', async () => {
      created = await createBackup({ kind: 'manual' });
    }),
  );
  if (!created?.created) throw new Error('backup was not created');
  const exportStatus = `${created.meta.export.status} (${created.meta.export.bytes} bytes)`;
  // Same again with the export stubbed out (a seam that keeps the export on the main thread), for a
  // comparison with the earlier runs that isolates VACUUM INTO, integrity_check and the fingerprint.
  const emptyZip = async () => ({ zip: new Uint8Array(22), manifest: { complete: true } });
  results.push(
    await measure('createBackup (export stubbed)', async () => {
      const again = await createBackup({ kind: 'manual', exportFn: emptyZip });
      if (!again.created) throw new Error('second backup was not created');
      created = again; // retention may have removed the first one
    }),
  );
  const dbFile = path.join(dataDir, 'backups', created.meta.db.file);
  const bytes = fs.statSync(dbFile).size;

  results.push(
    await measure('inspectUpload (backup .db)', async () => {
      const req = fs.createReadStream(dbFile);
      req.headers = { 'content-length': String(bytes) };
      await inspectUpload(req);
    }),
  );

  console.log(`backup .db size: ${(bytes / 1024 / 1024).toFixed(1)} MiB, verified: ${created.meta.status}, full backup export: ${exportStatus}`);
  console.log('');
  console.log(`${'op'.padEnd(28)}${'p50 ms'.padStart(9)}${'p99 ms'.padStart(9)}${'max ms'.padStart(9)}${'gap5 max'.padStart(10)}${'wall ms'.padStart(10)}`);
  for (const r of results) {
    console.log(`${r.label.padEnd(28)}${fmt(r.p50)}${fmt(r.p99)}${fmt(r.max)}${fmt(r.probeMax).padStart(10)}${fmt(r.wall).padStart(10)}`);
  }
  console.log('');
  console.log(
    `export step on the main thread: total ${profile.total.toFixed(0)} ms = serialize ${profile.serialize.toFixed(0)} ms + compress ${profile.compress.toFixed(0)} ms (raw ${(profile.raw / 1048576).toFixed(1)} MiB -> zip ${(profile.zip / 1048576).toFixed(1)} MiB)`,
  );
} finally {
  try {
    __resetLockForTests();
    closeDb();
  } catch {
    // ignore
  }
  try {
    fs.rmSync(assertUnderTmp(dataDir), { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  } catch {
    // Windows EBUSY: the OS temp cleaner takes it
  }
}
