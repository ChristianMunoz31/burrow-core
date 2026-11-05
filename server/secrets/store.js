// SQLite access for the app_secrets table. Errors are re-thrown as tagged errors that
// never carry the original database error (it can echo row data).
import { getDb, remove, select, upsert } from '../db/index.js';

const COLUMNS = ['name', 'ciphertext', 'iv', 'auth_tag', 'last4', 'updated_at'];

const unavailable = () => {
  const e = new Error('secrets store error');
  e.code = 'unavailable';
  return e;
};

/**
 * @param {{ resolveDb?: () => import('node:sqlite').DatabaseSync }} [opts]
 */
export function createSqliteSecretsStore({ resolveDb = getDb } = {}) {
  return {
    /** @returns {Promise<Array<{ name: string, ciphertext: string, iv: string, auth_tag: string, last4: string, updated_at: string }>>} */
    async list() {
      try {
        return select('app_secrets', { columns: COLUMNS, db: resolveDb() });
      } catch {
        throw unavailable();
      }
    },
    async upsert(row) {
      try {
        upsert('app_secrets', row, { conflict: ['name'], db: resolveDb() });
      } catch {
        throw unavailable();
      }
    },
    async remove(name) {
      try {
        remove('app_secrets', { where: { name }, db: resolveDb() });
      } catch {
        throw unavailable();
      }
    },
  };
}
