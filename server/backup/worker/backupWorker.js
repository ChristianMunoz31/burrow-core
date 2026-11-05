// Worker-thread entry for the heavy steps of a backup (VACUUM INTO, integrity_check, the content
// fingerprint, the JSON export ZIP). Each of those is one synchronous call into SQLite or a long JS loop, so they
// run here and the server's event loop keeps serving requests. One worker serves one operation and is
// terminated by server/backup/worker/client.js afterwards. This file imports only the snapshot helpers
// and the pure export core (no getDb, no express, no audit) so the SEA bundle of it stays small.
//
// Protocol: the worker posts { type: 'ready' } once; the client then posts { op, payload }; the worker
// answers { ok: true, result } or { ok: false, stage, error: { name, code, errcode, errstr } }. Errors
// carry no message text and no paths. Every database handle is closed before the answer is posted.
import fs from 'node:fs';
import { parentPort } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { buildExportZip } from '../../export/buildArchive.js';
import { inspectDbFile, normalizeSnapshot, takeSnapshot } from '../snapshot.js';

const BUSY_TIMEOUT_MS = 5000;
const SQLITE_FULL = 13;

/** Plain, structured-clone-safe description of an error: no message text, no paths. */
function describeError(e) {
  const errcode = Number.isInteger(e?.errcode) ? e.errcode : null;
  let code = typeof e?.code === 'string' ? e.code : null;
  if (errcode !== null && (errcode & 0xff) === SQLITE_FULL) code = 'SQLITE_FULL';
  return {
    name: typeof e?.name === 'string' ? e.name : 'Error',
    code,
    errcode,
    errstr: typeof e?.errstr === 'string' ? e.errstr : null,
  };
}

const failure = (stage, e) => ({ ok: false, stage, error: describeError(e) });

/**
 * takeSnapshot + normalizeSnapshot + inspectDbFile. The source is opened read-only on this thread's
 * own connection; the stage tells the caller which error mapping applies.
 */
function snapshotInspect({ dbPath, partialPath, latestVersion, keepSecrets = false }) {
  let source;
  try {
    source = new DatabaseSync(dbPath, { readOnly: true });
    source.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    source.exec('PRAGMA trusted_schema = OFF');
    takeSnapshot(source, partialPath);
  } catch (e) {
    return failure('snapshot', e);
  } finally {
    try {
      source?.close();
    } catch {
      // already closed
    }
  }
  try {
    normalizeSnapshot(partialPath, { keepSecrets: keepSecrets === true });
    return { ok: true, result: inspectDbFile(partialPath, { latestVersion }) };
  } catch (e) {
    return failure('inspect', e);
  }
}

/**
 * Opens a private copy read-write once so SQLite recovers its WAL or hot journal there (the import from the direct Burrow:
 * recovery is synchronous and can take long on a big WAL, so it must not run on the server's main thread).
 */
function settleFile(file) {
  let db;
  try {
    db = new DatabaseSync(file);
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    db.exec('PRAGMA trusted_schema = OFF');
    db.prepare('SELECT COUNT(*) AS n FROM sqlite_master').get();
  } finally {
    try {
      db?.close();
    } catch {
      // already closed
    }
  }
}

function inspectFile({ file, latestVersion, maxBytes, settle }) {
  if (settle === true) {
    try {
      settleFile(file);
    } catch (e) {
      return failure('settle', e);
    }
  }
  try {
    return { ok: true, result: inspectDbFile(file, { latestVersion, maxBytes: Number.isFinite(maxBytes) ? maxBytes : null }) };
  } catch (e) {
    return failure('inspect', e);
  }
}

function integrityCheck({ file }) {
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    db.exec('PRAGMA trusted_schema = OFF');
    const rows = db.prepare('PRAGMA integrity_check').all();
    return { ok: true, result: { ok: rows.length === 1 && Object.values(rows[0])[0] === 'ok' } };
  } catch (e) {
    return failure('inspect', e);
  } finally {
    try {
      db?.close();
    } catch {
      // already closed
    }
  }
}

/**
 * Builds the export ZIP from a verified snapshot (opened read-only) and writes it to outPath (created
 * exclusively, fsynced). Resolves with the size and the manifest's complete flag; the caller hashes the
 * file. A failure keeps its code (export_too_large, ENOSPC) so the caller can map it.
 */
async function buildExport({ dbPath, outPath, nowIso }) {
  let db;
  let fd = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    db.exec('PRAGMA trusted_schema = OFF');
    const { zip, manifest } = await buildExportZip({ db, now: new Date(nowIso) });
    fd = fs.openSync(outPath, 'wx', 0o600);
    fs.writeFileSync(fd, zip);
    fs.fsyncSync(fd);
    return { ok: true, result: { bytes: zip.length, complete: manifest.complete !== false } };
  } catch (e) {
    return failure('export', e);
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // already closed
      }
    }
    try {
      db?.close();
    } catch {
      // already closed
    }
  }
}

const OPS = Object.freeze({ snapshotInspect, inspectFile, integrityCheck, buildExport });

if (parentPort) {
  const port = parentPort;
  port.once('message', async (msg) => {
    const run = Object.hasOwn(OPS, msg?.op) ? OPS[msg.op] : null;
    port.postMessage(run ? await run(msg.payload ?? {}) : failure('inspect', { name: 'Error', code: 'unknown_op' }));
  });
  port.postMessage({ type: 'ready' });
}
