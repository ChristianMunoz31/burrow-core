// Local encryption key for the secrets store. When SECRETS_ENCRYPTION_KEY is unset, a
// random 32-byte key is created once as `secrets.key` in the data directory and reused.
// The key is never logged and lives outside the database, so exports (which read DB
// tables only) never include it. The env var always wins.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { getDataDir } from '../paths.js';
import { loadEncryptionKey } from './crypto.js';

export const KEY_FILE_NAME = 'secrets.key';
const KEY_BYTES = 32;

const decode = (text) => {
  const raw = String(text).trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) return null;
  const key = Buffer.from(raw, 'base64');
  return key.length === KEY_BYTES ? key : null;
};

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// A concurrent creator on a no-hard-link filesystem may still be writing: retry briefly.
function readWithRetry(read) {
  let result = read();
  for (let i = 0; i < 5 && !result.ok && result.reason === 'invalid'; i += 1) {
    sleepSync(10);
    result = read();
  }
  return result;
}

/**
 * Load the key file, creating it (mode 0o600 where supported) on first use.
 * @param {{ dir?: string }} [opts]
 * @returns {{ ok: true, key: Buffer } | { ok: false, reason: 'invalid' | 'unavailable' }}
 */
export function loadOrCreateKeyFile({ dir } = {}) {
  try {
    const file = path.join(dir ?? getDataDir(), KEY_FILE_NAME);
    const read = () => {
      const key = decode(fs.readFileSync(file, 'utf8'));
      return key ? { ok: true, key } : { ok: false, reason: 'invalid' };
    };
    try {
      return read();
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
    }
    // Write a private temp file, then hard-link it into place: link() is atomic and fails with
    // EEXIST instead of overwriting, so a reader never sees a partially written key and the race
    // loser simply reads the winner's complete file.
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    try {
      fs.writeFileSync(tmp, `${randomBytes(KEY_BYTES).toString('base64')}
`, { flag: 'wx', mode: 0o600 });
      try {
        fs.linkSync(tmp, file);
      } catch (err) {
        if (err?.code === 'EEXIST') return readWithRetry(read);
        // Filesystem without hard links: exclusive create, then reader-side retry covers a short window.
        try {
          fs.writeFileSync(file, fs.readFileSync(tmp), { flag: 'wx', mode: 0o600 });
        } catch (err2) {
          if (err2?.code !== 'EEXIST') throw err2;
          return readWithRetry(read);
        }
      }
    } finally {
      fs.rmSync(tmp, { force: true });
    }
    return read();
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
}

/**
 * Env key if set, otherwise the key file. Pass useKeyFile=false to skip the file.
 * @param {Record<string, string | undefined>} env
 * @param {{ useKeyFile?: boolean, dir?: string }} [opts]
 * @returns {ReturnType<typeof loadEncryptionKey>}
 */
export function resolveEncryptionKey(env, { useKeyFile = true, dir } = {}) {
  const fromEnv = loadEncryptionKey(env);
  if (fromEnv.ok || fromEnv.reason !== 'missing' || !useKeyFile) return fromEnv;
  const fromFile = loadOrCreateKeyFile({ dir });
  if (fromFile.ok) return fromFile;
  // A key file that exists but cannot be decoded is corrupt, which is not the same as absent.
  return { ok: false, reason: fromFile.reason === 'invalid' ? 'invalid' : 'missing' };
}
