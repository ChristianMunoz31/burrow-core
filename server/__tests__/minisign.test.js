import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { isTauriSignatureValid, parsePubkey, verifyTauriSignature } from '../../scripts/release/minisign.js';
import { makeTestKey, signTestData } from './helpers/updaterSigning.js';

const DATA = Buffer.from('MZ pretend installer bytes');
const b64 = (s) => Buffer.from(s).toString('base64');
const decode = (s) => Buffer.from(s, 'base64').toString('utf8');

describe('verifyTauriSignature', () => {
  const key = makeTestKey();

  it.each([
    ['ED (prehashed, what tauri writes)', true],
    ['Ed (legacy, unhashed)', false],
  ])('accepts a good signature: %s', (_name, prehash) => {
    const sigB64 = signTestData({ key, data: DATA, prehash });
    expect(() => verifyTauriSignature({ pubkeyB64: key.pubkeyB64, sigB64, data: DATA })).not.toThrow();
    expect(isTauriSignatureValid({ pubkeyB64: key.pubkeyB64, sigB64: `${sigB64}\n`, data: DATA })).toBe(true);
  });

  it('binds the signature to a version when asked (the downgrade guard)', () => {
    const verify = (sigB64, expectVersion) => verifyTauriSignature({ pubkeyB64: key.pubkeyB64, sigB64, data: DATA, expectVersion });
    expect(() => verify(signTestData({ key, data: DATA, version: '1.2.3' }), '1.2.3')).not.toThrow();
    expect(() => verify(signTestData({ key, data: DATA, version: '1.2.2' }), '1.2.3')).toThrow(/not bound to version 1\.2\.3.*version 1\.2\.2/);
    expect(() => verify(signTestData({ key, data: DATA }), '1.2.3')).toThrow(/no version/);
    expect(() => verify(signTestData({ key, data: DATA, trusted: 'timestamp:1	version:1.2.3	version:1.2.3' }), '1.2.3')).toThrow(/no version/);
    expect(() => verify(signTestData({ key, data: DATA, trusted: 'timestamp:1	file:version:1.2.3' }), '1.2.3')).toThrow(/no version/);
    expect(() => verify(signTestData({ key, data: DATA, trusted: 'timestamp:1	version: 1.2.3' }), '1.2.3')).toThrow(/not bound to version 1.2.3/);
    expect(() => verify(signTestData({ key, data: DATA, trusted: 'timestamp:1	version:1.2.3 ' }), '1.2.3')).toThrow(/not bound to version 1.2.3/);
    expect(() => verify(signTestData({ key, data: DATA }), undefined)).not.toThrow();
  });

  it('refuses a tampered file', () => {
    const sigB64 = signTestData({ key, data: DATA });
    const tampered = Buffer.concat([DATA, Buffer.from('x')]);
    expect(() => verifyTauriSignature({ pubkeyB64: key.pubkeyB64, sigB64, data: tampered })).toThrow(/does not match the file/);
  });

  it('refuses a tampered trusted comment', () => {
    const sigB64 = signTestData({ key, data: DATA, trusted: 'timestamp:1\tfile:a.exe' });
    const forged = b64(decode(sigB64).replace('file:a.exe', 'file:b.exe'));
    expect(() => verifyTauriSignature({ pubkeyB64: key.pubkeyB64, sigB64: forged, data: DATA })).toThrow(/trusted comment/);
  });

  it('refuses a signature made with another key (different key id)', () => {
    const other = makeTestKey();
    const sigB64 = signTestData({ key: other, data: DATA });
    expect(() => verifyTauriSignature({ pubkeyB64: key.pubkeyB64, sigB64, data: DATA })).toThrow(/key id mismatch/);
  });

  it('refuses a signature from another key even when the key id was copied', () => {
    const other = makeTestKey({ keyId: key.keyId });
    const sigB64 = signTestData({ key: other, data: DATA });
    expect(() => verifyTauriSignature({ pubkeyB64: key.pubkeyB64, sigB64, data: DATA })).toThrow(/does not match the file/);
  });

  it('refuses malformed signatures and keys without crashing', () => {
    for (const sigB64 of ['', 'not base64!', b64('untrusted comment: x\nAAAA\n'), b64('hello')]) {
      expect(isTauriSignatureValid({ pubkeyB64: key.pubkeyB64, sigB64, data: DATA }), sigB64).toBe(false);
    }
    const good = signTestData({ key, data: DATA });
    for (const pubkeyB64 of ['', 'BURROW_UPDATER_PUBKEY_PLACEHOLDER', b64('untrusted comment: x\nAAAA\n')]) {
      expect(isTauriSignatureValid({ pubkeyB64, sigB64: good, data: DATA }), pubkeyB64).toBe(false);
    }
  });

  it('refuses an unknown algorithm marker', () => {
    const lines = decode(signTestData({ key, data: DATA })).split('\n');
    const raw = Buffer.from(lines[1], 'base64');
    raw.write('XX', 0, 'latin1');
    lines[1] = raw.toString('base64');
    expect(() => verifyTauriSignature({ pubkeyB64: key.pubkeyB64, sigB64: b64(lines.join('\n')), data: DATA })).toThrow(/Unknown signature algorithm/);
  });
});

describe('parsePubkey', () => {
  it('reads the key id and the 32 key bytes', () => {
    const key = makeTestKey();
    const parsed = parsePubkey(key.pubkeyB64);
    expect(parsed.keyId.equals(key.keyId)).toBe(true);
    expect(parsed.publicKey.equals(key.publicRaw)).toBe(true);
  });

  it('rejects a key line of the wrong size or the wrong marker', () => {
    const bad = (line) => b64(`untrusted comment: minisign public key: AB\n${line}\n`);
    expect(() => parsePubkey(bad(b64(crypto.randomBytes(42))))).toThrow(/not a minisign Ed25519 public key/);
    expect(() => parsePubkey(bad(b64(Buffer.concat([Buffer.from('Ed'), crypto.randomBytes(10)]))))).toThrow(/42 bytes/);
  });
});
