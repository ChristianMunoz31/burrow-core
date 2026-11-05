// One backup or restore at a time, plus the request gate that holds back /api traffic while a
// restore swaps the database file.
import { BackupError } from './errors.js';

/** @type {'backup' | 'restore' | 'erase' | null} */
let current = null;
let gateClosed = false;
/** @type {'restore' | 'erase'} */
let gateReason = 'restore';
let inFlight = 0;

/**
 * @param {'backup' | 'restore' | 'erase'} op
 * @returns {(() => void) | null} release function, or null when another operation holds the lock
 */
export function tryAcquire(op) {
  if (current !== null) return null;
  current = op;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    current = null;
  };
}

/** @returns {'backup' | 'restore' | 'erase' | null} */
export const currentOp = () => current;

/** Error to throw when tryAcquire returned null. */
export const busyError = () => new BackupError(current === 'restore' ? 'db_restoring' : 'backup_busy');

/** @param {'restore' | 'erase'} [reason] which operation holds /api back (changes only the 503 copy) */
export function closeGate(reason = 'restore') {
  gateClosed = true;
  gateReason = reason;
}
export function openGate() {
  gateClosed = false;
  gateReason = 'restore';
}
export const isGateClosed = () => gateClosed;
export const inFlightCount = () => inFlight;

const normalize = (p) => String(p).toLowerCase().replace(/\/+$/, '');

/**
 * Mounted at /api. While the gate is closed every request gets 503 db_restoring except
 * GET /api/backups/status. Open-gate requests are counted until they finish, except the restore
 * request itself and POST /api/backups/stable-copy, so a restore can wait for the others to drain.
 * @type {import('express').RequestHandler}
 */
export function restoreGateMiddleware(req, res, next) {
  const path = normalize(req.path);
  if (gateClosed) {
    if (req.method === 'GET' && path === '/backups/status') return next();
    res.set('Cache-Control', 'no-store');
    res.set('Retry-After', '5');
    if (gateReason === 'erase') {
      return res
        .status(503)
        .json({ error: 'data_erasing', code: 'data_erasing', message: 'Burrow is erasing your data. This takes a few seconds.' });
    }
    return res
      .status(503)
      .json({ error: 'db_restoring', code: 'db_restoring', message: 'Burrow is restoring a backup. This takes a few seconds.' });
  }
  // The restore request itself, and the copy from the stable Burrow (it ends in a restore): counting
  // either would make the restore wait for its own request.
  // The erase request is the same kind of request: it waits for the others, not for itself.
  if (req.method === 'POST' && (path === '/backups/restore' || path === '/backups/stable-copy' || path === '/data/erase')) {
    return next();
  }
  inFlight += 1;
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    inFlight = Math.max(0, inFlight - 1);
  };
  res.once('finish', finish);
  res.once('close', finish);
  return next();
}

/**
 * Waits until no counted request is in flight, or the timeout passes.
 * @param {{ timeoutMs?: number, sleep?: (ms: number) => Promise<void>, pollMs?: number }} [opts]
 * @returns {Promise<boolean>} true when drained, false on timeout
 */
export async function waitForDrain({
  timeoutMs = 10_000,
  pollMs = 25,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  let waited = 0;
  while (inFlight > 0) {
    if (waited >= timeoutMs) return false;
    await sleep(pollMs);
    waited += pollMs;
  }
  return true;
}

/** Test hook: forget all lock and gate state. */
export function __resetLockForTests() {
  current = null;
  gateClosed = false;
  gateReason = 'restore';
  inFlight = 0;
}
