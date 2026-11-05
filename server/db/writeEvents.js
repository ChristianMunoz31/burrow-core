// Neutral table-write events (imports nothing, so there is no import cycle). query.js emits after a
// successful write; withTransaction buffers the events of its handle and delivers them only after
// COMMIT, so a rolled-back transaction (a dry-run import, a failed write) emits nothing. A write made
// outside any transaction is already committed and is delivered at once. Listeners run synchronously
// and a listener that throws is ignored.

/** @type {Set<(table: string, key: string | null) => void>} */
const listeners = new Set();
/** @type {WeakMap<object, Array<[string, string | null]>>} */
const buffers = new WeakMap();

function deliver(table, key) {
  for (const fn of listeners) {
    try {
      fn(table, key);
    } catch {
      // a listener never breaks a write
    }
  }
}

/** @param {(table: string, key: string | null) => void} listener @returns {() => void} unregister */
export function onTableWrite(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Called by query.js after a successful write. Buffers while `db` has an open write buffer, else delivers at once. Never throws. */
export function emitTableWrite(table, key = null, db) {
  if (listeners.size === 0) return;
  const buf = db ? buffers.get(db) : undefined;
  if (buf) buf.push([table, key]);
  else deliver(table, key);
}

/** withTransaction, depth 0, before BEGIN IMMEDIATE. */
export function openWriteBuffer(db) {
  buffers.set(db, []);
}

/** withTransaction, depth 0, after a successful COMMIT: deliver in order, then drop. */
export function releaseWriteBuffer(db) {
  const buf = buffers.get(db);
  buffers.delete(db);
  if (buf) for (const [table, key] of buf) deliver(table, key);
}

/** withTransaction, depth 0, on ROLLBACK. */
export function dropWriteBuffer(db) {
  buffers.delete(db);
}

/** Nested savepoint entry. @returns {number} */
export function writeBufferMark(db) {
  return buffers.get(db)?.length ?? 0;
}

/** ROLLBACK TO the savepoint taken at `mark`. */
export function truncateWriteBuffer(db, mark) {
  const buf = buffers.get(db);
  if (buf && buf.length > mark) buf.length = mark;
}
