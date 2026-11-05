// AES-256-GCM helpers for secrets stored in app_secrets. Plaintext never leaves
// this module except as the return value of decryptSecret.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const ALGORITHM = 'aes-256-gcm';

const aad = (name) => Buffer.from(`burrow:app_secrets:v1:${name}`, 'utf8');

/**
 * Reads SECRETS_ENCRYPTION_KEY at call time (never at import time).
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ ok: true, key: Buffer } | { ok: false, reason: 'missing' | 'invalid' }}
 */
export function loadEncryptionKey(env = process.env) {
  const raw = typeof env.SECRETS_ENCRYPTION_KEY === 'string' ? env.SECRETS_ENCRYPTION_KEY.trim() : '';
  if (!raw) return { ok: false, reason: 'missing' };
  // Accept base64 and base64url only; Buffer.from silently skips other characters.
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(raw)) return { ok: false, reason: 'invalid' };
  const key = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  if (key.length !== KEY_BYTES) return { ok: false, reason: 'invalid' };
  return { ok: true, key };
}

/**
 * @param {string} plaintext
 * @param {string} name secret name, bound into the AAD
 * @param {Buffer} key 32-byte key
 * @returns {{ ciphertext: string, iv: string, authTag: string }} base64 strings
 */
export function encryptSecret(plaintext, name, key) {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad(name));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
  };
}

/**
 * Throws on any tamper, wrong key, or wrong name.
 * @param {{ ciphertext: string, iv: string, authTag: string }} parts
 * @param {string} name
 * @param {Buffer} key
 * @returns {string}
 */
export function decryptSecret({ ciphertext, iv, authTag }, name, key) {
  const ivBuf = Buffer.from(String(iv), 'base64');
  const tagBuf = Buffer.from(String(authTag), 'base64');
  if (ivBuf.length !== IV_BYTES || tagBuf.length !== TAG_BYTES) {
    throw new Error('decrypt failed');
  }
  const decipher = createDecipheriv(ALGORITHM, key, ivBuf, { authTagLength: TAG_BYTES });
  decipher.setAAD(aad(name));
  decipher.setAuthTag(tagBuf);
  const out = Buffer.concat([
    decipher.update(Buffer.from(String(ciphertext), 'base64')),
    decipher.final(),
  ]);
  return out.toString('utf8');
}

/** @param {string} plaintext */
export const last4 = (plaintext) => String(plaintext).slice(-4);
