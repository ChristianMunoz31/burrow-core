// Forward-only SQL migrations. server/db/migrations/NNN_name.sql files are applied in order.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DbError } from './errors.js';
import { nowIso } from './codec.js';
import { chmodBestEffort } from '../paths.js';
import { envDir } from '../runtime.js';

export const MIGRATIONS_DIR = envDir('BURROW_MIGRATIONS_DIR') ?? fileURLToPath(new URL('./migrations/', import.meta.url));

const FILE_RE = /^(\d{3})_([a-z0-9_]+)\.sql$/;

const SCHEMA_VERSION_SQL = `CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL
) STRICT;`;

/**
 * Reads migration files, sorted. Versions must be contiguous from 1.
 * @param {string} [dir]
 * @returns {Array<{ version: number, name: string, sql: string }>}
 */
export function loadMigrations(dir = MIGRATIONS_DIR) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (cause) {
    throw new DbError('migration_failed', 'Cannot read migrations directory', { cause });
  }
  const found = [];
  for (const file of names) {
    const m = FILE_RE.exec(file);
    if (!m) continue;
    found.push({ version: Number(m[1]), name: m[2], file });
  }
  found.sort((a, b) => a.version - b.version);
  found.forEach((entry, i) => {
    if (entry.version !== i + 1) {
      throw new DbError('migration_failed', 'Migration versions must be contiguous starting at 1');
    }
  });
  try {
    return found.map(({ version, name, file }) => ({
      version,
      name,
      sql: fs.readFileSync(path.join(dir, file), 'utf8'),
    }));
  } catch (cause) {
    throw new DbError('migration_failed', 'Cannot read migration file', { cause });
  }
}

/**
 * Highest applied version, 0 when none. Creates schema_version if missing.
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {number}
 */
export function currentVersion(db) {
  db.exec(SCHEMA_VERSION_SQL);
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_version').get();
  return row && typeof row.v === 'number' ? row.v : 0;
}

function appliedVersion(db) {
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_version').get();
  return row && typeof row.v === 'number' ? row.v : 0;
}

/**
 * Applies pending migrations, each in its own transaction.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ migrations?: Array<{ version: number, name: string, sql: string }>, filename?: string }} [opts]
 * @returns {{ from: number, to: number, applied: number[] }}
 */
export function migrate(db, { migrations = loadMigrations(), filename } = {}) {
  const from = currentVersion(db);
  const known = migrations.length ? migrations[migrations.length - 1].version : 0;
  if (from > known) {
    throw new DbError('db_too_new', 'Database was created by a newer version of the app');
  }
  const pending = migrations.filter((m) => m.version > from);
  if (pending.length === 0) return { from, to: from, applied: [] };

  const to = pending[pending.length - 1].version;
  const isRealFile = typeof filename === 'string' && filename !== '' && filename !== ':memory:' && fs.existsSync(filename);
  if (from > 0 && isRealFile) {
    const backup = `${filename}.pre-v${to}.bak`;
    try {
      fs.rmSync(backup, { force: true });
      db.exec(`VACUUM INTO '${backup.replaceAll("'", "''")}'`);
      chmodBestEffort(backup, 0o600);
    } catch (cause) {
      throw new DbError('migration_failed', 'Could not back up the database before migrating', { cause });
    }
  }

  const applied = [];
  for (const m of pending) {
    try {
      db.exec('BEGIN IMMEDIATE');
    } catch (cause) {
      throw new DbError('migration_failed', `Migration ${m.version} could not start`, { cause });
    }
    try {
      // Another process may have applied this migration between our version read and taking the
      // write lock: re-read under the lock and skip it.
      if (appliedVersion(db) >= m.version) {
        db.exec('COMMIT');
        continue;
      }
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_version (version, name, applied_at) VALUES (?, ?, ?)').run(
        m.version,
        m.name,
        nowIso(),
      );
      db.exec('COMMIT');
      applied.push(m.version);
    } catch (cause) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // already rolled back by SQLite
      }
      throw new DbError('migration_failed', `Migration ${m.version} (${m.name}) failed`, { cause });
    }
  }
  return { from, to, applied };
}
