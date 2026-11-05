// Per-handle prepared-statement cache. Keyed by the DatabaseSync object, so a swapped or reopened
// handle (restore, erase, openDb) starts empty. A StatementSync holds a strong reference to its
// DatabaseSync, so the WeakMap entry is never collected on its own: whoever closes a handle that may
// have been used through prepareCached must call clearStmtCache(db) first (closeDb and openDb do).
// Only for statements run to completion with all()/get()/run(): never use it with iterate(), because
// a statement serving an active iterator must not be shared.
const MAX_PER_HANDLE = 200;
// Longer SQL (for example big IN (...) lists from the calendar import) is prepared directly.
const MAX_SQL_LENGTH = 2048;

/** @type {WeakMap<import('node:sqlite').DatabaseSync, Map<string, import('node:sqlite').StatementSync>>} */
const caches = new WeakMap();

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} sql
 * @returns {import('node:sqlite').StatementSync}
 */
export function prepareCached(db, sql) {
  if (sql.length > MAX_SQL_LENGTH) return db.prepare(sql);
  let cache = caches.get(db);
  if (!cache) {
    cache = new Map();
    caches.set(db, cache);
  }
  const hit = cache.get(sql);
  if (hit) {
    // Re-insert so the Map's insertion order is least-recently-used first.
    cache.delete(sql);
    cache.set(sql, hit);
    return hit;
  }
  const stmt = db.prepare(sql);
  if (cache.size >= MAX_PER_HANDLE) cache.delete(cache.keys().next().value);
  cache.set(sql, stmt);
  return stmt;
}

/**
 * Drops every cached statement of a handle. Call before db.close() so the statements (which reference
 * the handle) are released and the database file is not kept locked.
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function clearStmtCache(db) {
  caches.delete(db);
}
