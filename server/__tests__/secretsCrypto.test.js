// AES-256-GCM helpers: round-trip, tamper detection, key loading.
import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { encryptSecret, decryptSecret, loadEncryptionKey, last4 } from '../secrets/crypto.js';
import { getSecretDef, validateSecretValue, SECRET_NAMES } from '../secrets/registry.js';

const key = randomBytes(32);
const PLAINTEXT = 'gsk_SENTINELplaintext0123456789';

const flipByte = (b64) => {
  const buf = Buffer.from(b64, 'base64');
  buf[0] ^= 0x01;
  return buf.toString('base64');
};

describe('encryptSecret / decryptSecret', () => {
  it('round-trips and never stores plaintext in the output', () => {
    const enc = encryptSecret(PLAINTEXT, 'AI_CLOUD_API_KEY', key);
    expect(JSON.stringify(enc)).not.toContain(PLAINTEXT);
    expect(Buffer.from(enc.iv, 'base64')).toHaveLength(12);
    expect(Buffer.from(enc.authTag, 'base64')).toHaveLength(16);
    expect(decryptSecret(enc, 'AI_CLOUD_API_KEY', key)).toBe(PLAINTEXT);
  });

  it('uses a fresh IV for every encryption of the same text', () => {
    const a = encryptSecret(PLAINTEXT, 'AI_CLOUD_API_KEY', key);
    const b = encryptSecret(PLAINTEXT, 'AI_CLOUD_API_KEY', key);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it.each(['ciphertext', 'iv', 'authTag'])('throws when %s is tampered', (field) => {
    const enc = encryptSecret(PLAINTEXT, 'AI_CLOUD_API_KEY', key);
    const tampered = { ...enc, [field]: flipByte(enc[field]) };
    expect(() => decryptSecret(tampered, 'AI_CLOUD_API_KEY', key)).toThrow();
  });

  it('throws on truncated iv or tag', () => {
    const enc = encryptSecret(PLAINTEXT, 'AI_CLOUD_API_KEY', key);
    expect(() => decryptSecret({ ...enc, iv: 'AAAA' }, 'AI_CLOUD_API_KEY', key)).toThrow();
    expect(() => decryptSecret({ ...enc, authTag: 'AAAA' }, 'AI_CLOUD_API_KEY', key)).toThrow();
  });

  it('throws when decrypted under a different name (AAD binding)', () => {
    const enc = encryptSecret(PLAINTEXT, 'AI_CLOUD_API_KEY', key);
    expect(() => decryptSecret(enc, 'OURA_TOKEN', key)).toThrow();
  });

  it('throws with the wrong key', () => {
    const enc = encryptSecret(PLAINTEXT, 'AI_CLOUD_API_KEY', key);
    expect(() => decryptSecret(enc, 'AI_CLOUD_API_KEY', randomBytes(32))).toThrow();
  });

  it('last4 returns the final four characters', () => {
    expect(last4(PLAINTEXT)).toBe('6789');
  });
});

describe('loadEncryptionKey', () => {
  it('reports missing when unset or empty', () => {
    expect(loadEncryptionKey({})).toEqual({ ok: false, reason: 'missing' });
    expect(loadEncryptionKey({ SECRETS_ENCRYPTION_KEY: '  ' })).toEqual({ ok: false, reason: 'missing' });
  });

  it('reports invalid for 31 or 33 byte keys and garbage', () => {
    for (const n of [31, 33]) {
      const env = { SECRETS_ENCRYPTION_KEY: randomBytes(n).toString('base64') };
      expect(loadEncryptionKey(env)).toEqual({ ok: false, reason: 'invalid' });
    }
    expect(loadEncryptionKey({ SECRETS_ENCRYPTION_KEY: 'not base64 !!!' })).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });

  it('accepts base64 and base64url encodings of 32 bytes', () => {
    const raw = Buffer.from(Array.from({ length: 32 }, (_, i) => 251 - i));
    const b64 = raw.toString('base64');
    const url = raw.toString('base64url');
    expect(b64 + url).toMatch(/[+/_-]/); // exercise the alphabet differences
    for (const v of [b64, url]) {
      const res = loadEncryptionKey({ SECRETS_ENCRYPTION_KEY: v });
      expect(res.ok).toBe(true);
      expect(res.key.equals(raw)).toBe(true);
    }
  });
});

describe('registry', () => {
  it('lists exactly the two allowlisted names, case-sensitively', () => {
    expect([...SECRET_NAMES]).toEqual(['AI_CLOUD_API_KEY', 'OURA_TOKEN']);
    expect(getSecretDef('ai_cloud_api_key')).toBeUndefined();
    // The retired cloud provider keys are gone from the allowlist.
    for (const gone of ['BEDROCK_API_KEY', 'GROQ_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY']) {
      expect(getSecretDef(gone)).toBeUndefined();
    }
    expect(getSecretDef('DATABASE_URL')).toBeUndefined();
    expect(getSecretDef('__proto__')).toBeUndefined();
  });

  it('trims and validates values without echoing them', () => {
    expect(validateSecretValue('AI_CLOUD_API_KEY', `  gsk_${'a'.repeat(30)}\n`)).toEqual({
      ok: true,
      value: `gsk_${'a'.repeat(30)}`,
    });
    expect(validateSecretValue('AI_CLOUD_API_KEY', 'gsk_sh7')).toEqual({ ok: false });
    expect(validateSecretValue('AI_CLOUD_API_KEY', 'gsk has space')).toEqual({ ok: false });
    expect(validateSecretValue('OURA_TOKEN', 'gsk_short')).toEqual({ ok: false });
    expect(validateSecretValue('AI_CLOUD_API_KEY', 42)).toEqual({ ok: false });
    expect(validateSecretValue('NOPE', 'x')).toEqual({ ok: false });
  });
});
