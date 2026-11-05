// The full Lemon Squeezy key, kept encrypted so "Move to another computer" can deactivate later
// (docs/LICENSING.md 5.4). LICENSE_STORE_KEY is not in SECRET_DEFS, so /api/secrets can never list,
// read, write or test it. Gumroad keys are never kept. Never logs the key.
import { getDb as defaultGetDb } from '../db/index.js';
import { decryptSecret, encryptSecret } from '../secrets/crypto.js';
import { resolveEncryptionKey } from '../secrets/keyFile.js';
import { createSqliteSecretsStore } from '../secrets/store.js';
import { LICENSE_KEY_SECRET_NAME } from './constants.js';

function resolve({ dataDir, env = process.env, getDb = defaultGetDb }) {
  const key = resolveEncryptionKey(env, { dir: dataDir });
  return { key, store: createSqliteSecretsStore({ resolveDb: getDb }) };
}

/**
 * @param {{ key: string, last4: string, dataDir: string, env?: Record<string, string | undefined>,
 *   getDb?: Function, now?: () => number }} opts
 * @returns {Promise<boolean>} false when the secret could not be saved (the activation still stands)
 */
export async function saveLicenseKey({ key, last4, now = Date.now, ...rest }) {
  try {
    const { key: enc, store } = resolve(rest);
    if (!enc.ok) return false;
    const sealed = encryptSecret(key, LICENSE_KEY_SECRET_NAME, enc.key);
    await store.upsert({
      name: LICENSE_KEY_SECRET_NAME,
      ciphertext: sealed.ciphertext,
      iv: sealed.iv,
      auth_tag: sealed.authTag,
      last4,
      updated_at: new Date(now()).toISOString(),
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {{ dataDir: string, env?: Record<string, string | undefined>, getDb?: Function }} opts
 * @returns {Promise<string | null>} the stored key, or null when absent or unreadable
 */
export async function loadLicenseKey(opts) {
  try {
    const { key: enc, store } = resolve(opts);
    if (!enc.ok) return null;
    const row = (await store.list()).find((r) => r?.name === LICENSE_KEY_SECRET_NAME);
    if (!row) return null;
    const value = decryptSecret({ ciphertext: row.ciphertext, iv: row.iv, authTag: row.auth_tag }, LICENSE_KEY_SECRET_NAME, enc.key);
    return value || null;
  } catch {
    return null;
  }
}

/**
 * @param {{ dataDir: string, env?: Record<string, string | undefined>, getDb?: Function }} opts
 * @returns {Promise<void>} never rejects
 */
export async function clearLicenseKey(opts) {
  try {
    await resolve(opts).store.remove(LICENSE_KEY_SECRET_NAME);
  } catch {
    // nothing to clear, or the database is unavailable
  }
}
