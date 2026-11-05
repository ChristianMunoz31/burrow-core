// The only query surface for app code. Identifiers come from the TABLES allowlist and are always
// double-quoted; every value is bound as a positional parameter.
import { getDb, withTransaction } from './index.js';
import { DbError, toDbError } from './errors.js';
import { encodeRow, decodeRow, encodeValue } from './codec.js';
import { getTable } from './tables.js';
import { prepareCached } from './stmtCache.js';
import { emitTableWrite } from './writeEvents.js';

const OPS = Object.freeze({ eq: '=', ne: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' });

const q = (ident) => `"${ident}"`;

function colType(def, table, column) {
  if (typeof column !== 'string' || !Object.hasOwn(def.columns, column)) {
    throw new DbError('unknown_column', `Unknown column for ${table}`, { column: String(column) });
  }
  return def.columns[column];
}

// The app_state key of a write, for the write observer (writeEvents.js); null for other tables.
const stateKeyOf = (table, row) => (table === 'app_state' && typeof row?.key === 'string' ? row.key : null);

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date);

// Operator conditions can only be built through `op`. A plain object from a request body, query string
// (Express parses `?a[gte]=x` into an object) or LLM tool args is never an operator map: it is rejected.
const OP_BRAND = Symbol('burrow.op');

function makeOp(ops) {
  return Object.freeze({ [OP_BRAND]: true, ops: Object.freeze({ ...ops }) });
}

const isOp = (v) => v !== null && typeof v === 'object' && v[OP_BRAND] === true;

export const op = Object.freeze({
  eq: (v) => makeOp({ eq: v }),
  ne: (v) => makeOp({ ne: v }),
  gt: (v) => makeOp({ gt: v }),
  gte: (v) => makeOp({ gte: v }),
  lt: (v) => makeOp({ lt: v }),
  lte: (v) => makeOp({ lte: v }),
  in: (values) => makeOp({ in: values }),
  nin: (values) => makeOp({ nin: values }),
  /** Combines several operators on one column, e.g. op.and(op.gte(a), op.lt(b)). */
  and: (...conds) => {
    const merged = {};
    for (const c of conds) {
      if (!isOp(c)) throw new DbError('invalid_query', 'op.and requires operator conditions');
      for (const key of Object.keys(c.ops)) {
        if (Object.hasOwn(merged, key)) throw new DbError('invalid_query', 'op.and received a duplicate operator');
      }
      Object.assign(merged, c.ops);
    }
    return makeOp(merged);
  },
});

/** Ids must be strings or finite numbers: never objects/arrays. */
export function assertId(id, what = 'id') {
  if (typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id))) return id;
  throw new DbError('invalid_query', `${what} must be a string or number`);
}

function assertScalar(v, column) {
  if (v !== null && typeof v === 'object' && !(v instanceof Date)) {
    throw new DbError('invalid_query', 'Condition values must be scalars', { column });
  }
  return v;
}

function buildCond(def, table, column, cond, params) {
  const type = colType(def, table, column);
  const col = q(column);
  if (cond === undefined) throw new DbError('invalid_query', 'Undefined condition value', { column });
  if (!isOp(cond)) {
    if (cond === null) return `${col} IS NULL`;
    assertScalar(cond, column);
    params.push(encodeValue(type, cond, column));
    return `${col} = ?`;
  }
  const parts = [];
  for (const [name, operand] of Object.entries(cond.ops)) {
    if (name === 'in') {
      if (!Array.isArray(operand)) throw new DbError('invalid_query', 'in requires an array', { column });
      if (operand.length === 0) {
        parts.push('0');
        continue;
      }
      parts.push(`${col} IN (${operand.map(() => '?').join(', ')})`);
      for (const v of operand) params.push(encodeValue(type, assertScalar(v, column), column));
      continue;
    }
    if (name === 'nin') {
      if (!Array.isArray(operand)) throw new DbError('invalid_query', 'nin requires an array', { column });
      if (operand.length === 0) {
        parts.push('1');
        continue;
      }
      parts.push(`${col} NOT IN (${operand.map(() => '?').join(', ')})`);
      for (const v of operand) params.push(encodeValue(type, assertScalar(v, column), column));
      continue;
    }
    if (!Object.hasOwn(OPS, name)) throw new DbError('invalid_query', 'Unknown operator', { column });
    if (operand === undefined) throw new DbError('invalid_query', 'Undefined condition value', { column });
    if (operand === null) {
      if (name === 'eq') parts.push(`${col} IS NULL`);
      else if (name === 'ne') parts.push(`${col} IS NOT NULL`);
      else throw new DbError('invalid_query', 'Null is only valid with eq/ne', { column });
      continue;
    }
    params.push(encodeValue(type, assertScalar(operand, column), column));
    parts.push(`${col} ${OPS[name]} ?`);
  }
  if (parts.length === 0) throw new DbError('invalid_query', 'Empty condition', { column });
  return parts.length === 1 ? parts[0] : `(${parts.join(' AND ')})`;
}

/** Returns a SQL fragment ('' when where is empty) and pushes bound values onto params. */
function buildWhere(def, table, where, params) {
  if (where === undefined || where === null) return '';
  if (!isPlainObject(where)) throw new DbError('invalid_query', 'where must be an object');
  const parts = [];
  for (const [key, cond] of Object.entries(where)) {
    if (key === '$or') {
      if (!Array.isArray(cond)) throw new DbError('invalid_query', '$or requires an array');
      if (cond.length === 0) {
        parts.push('0');
        continue;
      }
      const alts = cond.map((w) => {
        const sql = buildWhere(def, table, w, params);
        return sql === '' ? '1' : `(${sql})`;
      });
      parts.push(`( ${alts.join(' OR ')} )`);
      continue;
    }
    parts.push(buildCond(def, table, key, cond, params));
  }
  return parts.join(' AND ');
}

function buildSearch(def, table, search, params) {
  if (!search || !Array.isArray(search.columns)) return '';
  const term = typeof search.term === 'string' ? search.term : '';
  if (term.trim() === '' || search.columns.length === 0) return '';
  const parts = search.columns.map((c) => {
    colType(def, table, c);
    params.push(term);
    return `burrow_icontains(${q(c)}, ?)`;
  });
  return `(${parts.join(' OR ')})`;
}

function whereClause(def, table, where, search, params) {
  const parts = [buildWhere(def, table, where, params), buildSearch(def, table, search, params)].filter(Boolean);
  return parts.length ? ` WHERE ${parts.join(' AND ')}` : '';
}

function buildOrder(def, table, orderBy) {
  if (orderBy === undefined || orderBy === null) return '';
  if (!Array.isArray(orderBy)) throw new DbError('invalid_query', 'orderBy must be an array');
  if (orderBy.length === 0) return '';
  const parts = orderBy.map((o) => {
    if (!isPlainObject(o)) throw new DbError('invalid_query', 'Invalid orderBy entry');
    const dir = o.dir === undefined ? 'asc' : o.dir;
    if (dir !== 'asc' && dir !== 'desc') throw new DbError('invalid_query', 'Invalid order direction');
    if (o.column === 'rowid') return `rowid ${dir === 'asc' ? 'ASC' : 'DESC'}`;
    colType(def, table, o.column);
    const nulls = o.nulls === undefined ? (dir === 'asc' ? 'last' : 'first') : o.nulls;
    if (nulls !== 'first' && nulls !== 'last') throw new DbError('invalid_query', 'Invalid nulls placement');
    const collate = o.nocase ? ' COLLATE NOCASE' : '';
    return `${q(o.column)}${collate} ${dir === 'asc' ? 'ASC' : 'DESC'} NULLS ${nulls === 'first' ? 'FIRST' : 'LAST'}`;
  });
  return ` ORDER BY ${parts.join(', ')}`;
}

function nonNegInt(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new DbError('invalid_query', `${name} must be a non-negative integer`);
  return value;
}

function buildLimit(limit, offset, params) {
  const hasLimit = limit !== undefined && limit !== null;
  const hasOffset = offset !== undefined && offset !== null && offset !== 0;
  if (!hasLimit && !hasOffset) return '';
  if (hasLimit) {
    params.push(nonNegInt(limit, 'limit'));
    if (!hasOffset) return ' LIMIT ?';
    params.push(nonNegInt(offset, 'offset'));
    return ' LIMIT ? OFFSET ?';
  }
  params.push(nonNegInt(offset, 'offset'));
  return ' LIMIT -1 OFFSET ?';
}

function selectList(def, table, columns) {
  if (columns === '*' || columns === undefined) return Object.keys(def.columns).map(q).join(', ');
  if (!Array.isArray(columns) || columns.length === 0) throw new DbError('invalid_query', 'columns must be a non-empty array');
  for (const c of columns) colType(def, table, c);
  return columns.map(q).join(', ');
}

const allColumns = (def) => Object.keys(def.columns).map(q).join(', ');

function run(fn) {
  try {
    return fn();
  } catch (e) {
    throw toDbError(e);
  }
}

/** @returns {object[]} */
export function select(table, { columns = '*', where, search, orderBy = [], limit, offset = 0, db } = {}) {
  const def = getTable(table);
  const params = [];
  const list = selectList(def, table, columns);
  const w = whereClause(def, table, where, search, params);
  const order = buildOrder(def, table, orderBy);
  const lim = buildLimit(limit, offset, params);
  const sql = `SELECT ${list} FROM ${q(table)}${w}${order}${lim}`;
  return run(() =>
    prepareCached(db ?? getDb(), sql)
      .all(...params)
      .map((r) => decodeRow(table, r)),
  );
}

/** @returns {object | null} */
export function selectOne(table, { columns, where, orderBy, db } = {}) {
  return select(table, { columns, where, orderBy, limit: 1, db })[0] ?? null;
}

/** @returns {number} */
export function count(table, { where, search, db } = {}) {
  const def = getTable(table);
  const params = [];
  const w = whereClause(def, table, where, search, params);
  const sql = `SELECT COUNT(*) AS n FROM ${q(table)}${w}`;
  return run(() => Number(prepareCached(db ?? getDb(), sql).get(...params).n));
}

/** @returns {object} */
export function insert(table, row, { db } = {}) {
  const def = getTable(table);
  const { columns, values } = encodeRow(table, row, { forInsert: true });
  const sql = `INSERT INTO ${q(table)} (${columns.map(q).join(', ')}) VALUES (${columns.map(() => '?').join(', ')}) RETURNING ${allColumns(def)}`;
  const handle = db ?? getDb();
  const out = run(() => decodeRow(table, prepareCached(handle, sql).get(...values)));
  emitTableWrite(table, stateKeyOf(table, row), handle);
  return out;
}

/** @returns {object[]} */
export function insertMany(table, rows, { db } = {}) {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  const handle = db ?? getDb();
  return withTransaction(() => rows.map((r) => insert(table, r, { db: handle })), handle);
}

/** @returns {object[]} */
export function update(table, patch, { where, db } = {}) {
  const def = getTable(table);
  if (!isPlainObject(where) || Object.keys(where).length === 0) {
    throw new DbError('invalid_query', 'update requires a non-empty where');
  }
  const { columns, values } = encodeRow(table, patch);
  if (columns.length === 0) {
    // Validate the where clause shape, then return the unchanged rows (an empty PATCH is a no-op).
    return select(table, { where, db });
  }
  const params = [...values];
  const w = whereClause(def, table, where, undefined, params);
  const sql = `UPDATE ${q(table)} SET ${columns.map((c) => `${q(c)} = ?`).join(', ')}${w} RETURNING ${allColumns(def)}`;
  const handle = db ?? getDb();
  const rows = run(() =>
    prepareCached(handle, sql)
      .all(...params)
      .map((r) => decodeRow(table, r)),
  );
  if (rows.length > 0) emitTableWrite(table, null, handle);
  return rows;
}

/** @returns {object | null} */
export function updateById(table, id, patch, { db } = {}) {
  const def = getTable(table);
  assertId(id);
  return update(table, patch, { where: { [def.primaryKey]: id }, db })[0] ?? null;
}

/** @returns {object} */
export function upsert(table, row, { conflict, preserve = [], db } = {}) {
  const def = getTable(table);
  const target = conflict ?? [def.primaryKey];
  if (!Array.isArray(target) || target.length === 0) throw new DbError('invalid_query', 'conflict must be a non-empty array');
  for (const c of target) colType(def, table, c);
  const { columns, values } = encodeRow(table, row, { forInsert: true });
  const updateCols = columns.filter((c) => row[c] !== undefined && !target.includes(c) && !preserve.includes(c));
  const setSql = updateCols.length
    ? updateCols.map((c) => `${q(c)} = excluded.${q(c)}`).join(', ')
    : `${q(def.primaryKey)} = excluded.${q(def.primaryKey)}`;
  const sql =
    `INSERT INTO ${q(table)} (${columns.map(q).join(', ')}) VALUES (${columns.map(() => '?').join(', ')}) ` +
    `ON CONFLICT (${target.map(q).join(', ')}) DO UPDATE SET ${setSql} RETURNING ${allColumns(def)}`;
  const handle = db ?? getDb();
  const out = run(() => decodeRow(table, prepareCached(handle, sql).get(...values)));
  emitTableWrite(table, stateKeyOf(table, row), handle);
  return out;
}

/** @returns {number} rows deleted */
export function remove(table, { where, db } = {}) {
  const def = getTable(table);
  if (!isPlainObject(where) || Object.keys(where).length === 0) {
    throw new DbError('invalid_query', 'remove requires a non-empty where');
  }
  const params = [];
  const w = whereClause(def, table, where, undefined, params);
  const sql = `DELETE FROM ${q(table)}${w}`;
  const handle = db ?? getDb();
  const changes = run(() => Number(prepareCached(handle, sql).run(...params).changes));
  if (changes > 0) emitTableWrite(table, null, handle);
  return changes;
}

/**
 * Deletes every row of a table, except rows whose primary key is listed in `keep`. The only way to
 * delete without a `where`; used by the erase-all-data service. Table name is allowlisted.
 * @param {string} table
 * @param {{ keep?: string[], db?: import('node:sqlite').DatabaseSync }} [opts]
 * @returns {number} rows deleted
 */
export function removeAll(table, { keep = [], db } = {}) {
  const def = getTable(table);
  if (!Array.isArray(keep) || !keep.every((k) => typeof k === 'string')) {
    throw new DbError('invalid_query', 'keep must be a list of strings');
  }
  const where = keep.length ? ` WHERE ${q(def.primaryKey)} NOT IN (${keep.map(() => '?').join(', ')})` : '';
  return run(() => Number(prepareCached(db ?? getDb(), `DELETE FROM ${q(table)}${where}`).run(...keep).changes));
}
