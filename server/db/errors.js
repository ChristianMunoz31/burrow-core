// Database error type and mapping helpers. Messages never contain row data.

const DEFAULT_STATUS = Object.freeze({
  db_unavailable: 503,
  db_too_new: 503,
  migration_failed: 503,
  sqlite_too_old: 503,
  unknown_table: 500,
  unknown_column: 500,
  invalid_query: 400,
  db_busy: 503,
  db_restoring: 503,
  invalid_value: 400,
  constraint: 400,
  not_found: 404,
  sqlite_error: 500,
});

const UNAVAILABLE = new Set(['db_busy', 'db_restoring', 'db_unavailable', 'db_too_new', 'migration_failed', 'sqlite_too_old']);

export class DbError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {{ status?: number, cause?: unknown, column?: string }} [opts]
   */
  constructor(code, message, opts = {}) {
    super(message);
    this.name = 'DbError';
    this.code = code;
    this.status = opts.status ?? DEFAULT_STATUS[code] ?? 500;
    this.cause = opts.cause;
    this.column = opts.column;
  }
}

export function isDbError(e) {
  return e instanceof DbError;
}

// SQLite extended/primary result codes for constraint failures (SQLITE_CONSTRAINT = 19).
const CONSTRAINT_PRIMARY_CODE = 19;
const BUSY_PRIMARY_CODES = new Set([5, 6]); // SQLITE_BUSY, SQLITE_LOCKED
const CONSTRAINT_MESSAGE =
  /(FOREIGN KEY|NOT NULL|CHECK|UNIQUE|PRIMARY KEY) constraint failed|constraint failed|cannot store .* value/i;

/**
 * Maps a node:sqlite error to a DbError. A DbError passes through unchanged.
 * @param {unknown} e
 * @returns {DbError}
 */
export function toDbError(e) {
  if (e instanceof DbError) return e;
  const err = /** @type {{ code?: unknown, errcode?: unknown, message?: unknown }} */ (
    e && typeof e === 'object' ? e : {}
  );
  const message = typeof err.message === 'string' ? err.message : '';
  const isSqlite = err.code === 'ERR_SQLITE_ERROR';
  if (isSqlite) {
    const primary = typeof err.errcode === 'number' ? err.errcode & 0xff : null;
    const isConstraint = primary !== null ? primary === CONSTRAINT_PRIMARY_CODE : CONSTRAINT_MESSAGE.test(message);
    if (isConstraint || (primary !== null && /cannot store .* value/i.test(message))) {
      return new DbError('constraint', 'Constraint failed', { cause: e });
    }
    const isBusy = primary !== null ? BUSY_PRIMARY_CODES.has(primary) : /database is (locked|busy)/i.test(message);
    if (isBusy) return new DbError('db_busy', 'Database is busy', { cause: e });
    return new DbError('sqlite_error', 'Database error', { cause: e });
  }
  if (/cannot store .* value/i.test(message)) {
    return new DbError('constraint', 'Constraint failed', { cause: e });
  }
  return new DbError('sqlite_error', 'Database error', { cause: e });
}

/**
 * Fixed, leak-free HTTP mapping.
 * @param {unknown} e
 * @returns {{ status: number, error: string }}
 */
export function httpErrorFor(e) {
  const code = e instanceof DbError ? e.code : undefined;
  if (code && UNAVAILABLE.has(code)) return { status: 503, error: 'Local database is unavailable.' };
  if (code === 'invalid_value' || code === 'constraint' || code === 'invalid_query') return { status: 400, error: 'Invalid input' };
  if (code === 'not_found') return { status: 404, error: 'Not found' };
  return { status: 500, error: 'Server error' };
}
