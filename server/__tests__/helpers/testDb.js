import { IMPORT_ORDER, TABLES, insertMany, openDb, select, setDbForTests, withTransaction } from '../../db/index.js';

const TABLE_ORDER = [...IMPORT_ORDER, ...Object.keys(TABLES).filter((t) => !IMPORT_ORDER.includes(t))];

/**
 * In-memory, migrated DB installed as the singleton. Optional seed.
 * @param {{ seed?: Record<string, object[]> }} [opts]
 * @returns {import('node:sqlite').DatabaseSync}
 */
export function createTestDb({ seed } = {}) {
  const db = openDb({ filename: ':memory:' });
  setDbForTests(db);
  if (seed) seedDb(db, seed);
  return db;
}

/**
 * Inserts via insertMany per table in FK order (so autofill applies). Returns decoded rows by table.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {Record<string, object[]>} data
 * @returns {Record<string, object[]>}
 */
export function seedDb(db, data) {
  const out = {};
  for (const table of TABLE_ORDER) {
    if (Object.hasOwn(data, table)) out[table] = insertMany(table, data[table], { db });
  }
  for (const table of Object.keys(data)) {
    if (!Object.hasOwn(out, table)) out[table] = insertMany(table, data[table], { db });
  }
  return out;
}

/** DELETE FROM every table, children first, in one transaction. */
export function resetDb(db) {
  withTransaction(() => {
    for (const table of [...TABLE_ORDER].reverse()) db.exec(`DELETE FROM "${table}"`);
  }, db);
}

/** setDbForTests(null) then db.close(). */
export function closeTestDb(db) {
  setDbForTests(null);
  db.close();
}

/**
 * All rows of a table, decoded, ORDER BY rowid.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} table
 * @returns {object[]}
 */
export function rowsOf(db, table) {
  return select(table, { orderBy: [{ column: 'rowid' }], db });
}
