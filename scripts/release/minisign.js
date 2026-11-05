// Node verifier for the minisign signatures that `tauri build` writes next to an updater artifact
// (`<installer>.sig`, the base64 of a minisign signature file) against the updater public key from
// src-tauri/tauri.release.conf.json (the base64 of a minisign public key file). It mirrors what the Tauri updater
// plugin checks on the user's PC, so a release is verified here before anything is uploaded. Verification only: this
// file never reads, writes or generates a private key.
import crypto from 'node:crypto';

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
// DER prefix of an Ed25519 SubjectPublicKeyInfo; the 32 raw key bytes follow.
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const UNTRUSTED = 'untrusted comment:';
const TRUSTED = 'trusted comment: ';

function decodeBase64(text, what) {
  const s = String(text ?? '').trim();
  if (s === '' || !BASE64_RE.test(s) || s.length % 4 !== 0) throw new Error(`${what} is not valid base64`);
  return Buffer.from(s, 'base64');
}

function decodeLines(text, what) {
  const decoded = decodeBase64(text, what).toString('utf8');
  return decoded.replace(/\r\n?/g, '\n').split('\n');
}

/**
 * Parses the updater public key (the base64 text Tauri stores in `plugins.updater.pubkey`).
 * @param {string} pubkeyB64
 * @returns {{ keyId: Buffer, publicKey: Buffer }}
 * @throws {Error} when it is not a minisign Ed25519 public key
 */
export function parsePubkey(pubkeyB64) {
  const lines = decodeLines(pubkeyB64, 'The updater public key');
  if (!lines[0]?.startsWith(UNTRUSTED)) throw new Error('The updater public key has no "untrusted comment" line');
  const raw = decodeBase64(lines[1], 'The updater public key line');
  if (raw.length !== 42 || raw.subarray(0, 2).toString('latin1') !== 'Ed') {
    throw new Error('The updater public key is not a minisign Ed25519 public key (expected 42 bytes starting with "Ed")');
  }
  return { keyId: raw.subarray(2, 10), publicKey: raw.subarray(10, 42) };
}

const toKey = (publicKey) => crypto.createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, publicKey]), format: 'der', type: 'spki' });

/**
 * Verifies a Tauri updater signature.
 * @param {{ pubkeyB64: string, sigB64: string, data: Buffer | Uint8Array, expectVersion?: string }} input
 *   pubkeyB64 the `pubkey` value of the updater config; sigB64 the contents of the `.sig` file; data the installer bytes;
 *   expectVersion when given, the signed trusted comment must carry exactly `version:<expectVersion>` (the Tauri CLI
 *   writes it; the app enforces it with `requireSignedVersion`), so a signature of an older release is refused
 * @returns {void}
 * @throws {Error} with the reason when the signature does not verify
 */
export function verifyTauriSignature({ pubkeyB64, sigB64, data, expectVersion }) {
  const { keyId, publicKey } = parsePubkey(pubkeyB64);
  const lines = decodeLines(sigB64, 'The signature');
  if (lines.length < 4 || !lines[0].startsWith(UNTRUSTED)) throw new Error('The signature file is malformed (missing the untrusted comment)');
  const sigLine = decodeBase64(lines[1], 'The signature line');
  if (sigLine.length !== 74) throw new Error('The signature line is not 74 bytes');
  if (!lines[2].startsWith(TRUSTED)) throw new Error('The signature file is malformed (missing the trusted comment)');
  const trusted = lines[2].slice(TRUSTED.length);
  const globalSig = decodeBase64(lines[3], 'The global signature');
  if (globalSig.length !== 64) throw new Error('The global signature is not 64 bytes');

  const alg = sigLine.subarray(0, 2).toString('latin1');
  if (alg !== 'ED' && alg !== 'Ed') throw new Error(`Unknown signature algorithm "${alg}"`);
  if (!sigLine.subarray(2, 10).equals(keyId)) throw new Error('The signature was made with a different key (key id mismatch)');
  const sig = sigLine.subarray(10, 74);

  const key = toKey(publicKey);
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const message = alg === 'ED' ? crypto.createHash('blake2b512').update(bytes).digest() : bytes;
  if (!crypto.verify(null, message, key, sig)) throw new Error('The signature does not match the file (the file or the signature was changed, or another key signed it)');
  const globalMessage = Buffer.concat([sig, Buffer.from(trusted, 'utf8')]);
  if (!crypto.verify(null, globalMessage, key, globalSig)) throw new Error('The signature comment does not verify (the trusted comment was changed)');
  if (expectVersion !== undefined) {
    const signed = signedVersionOfComment(trusted);
    if (signed !== expectVersion) {
      throw new Error(`The signature is not bound to version ${expectVersion} (its signed comment says ${signed === null ? 'no version' : `version ${signed}`}). Rebuild the installer with a Tauri CLI that signs the app version.`);
    }
  }
}

/**
 * The version a trusted comment is bound to: the single `version:<v>` field of the tab-separated comment
 * (`timestamp:<n>	file:<name>	version:<v>`).
 * @param {string} trusted
 * @returns {string | null} null when there is no such field, or more than one
 */
export function signedVersionOfComment(trusted) {
  const found = String(trusted).split('	').filter((field) => field.startsWith('version:'));
  return found.length === 1 ? found[0].slice('version:'.length) : null;
}

/**
 * @param {{ pubkeyB64: string, sigB64: string, data: Buffer | Uint8Array }} input
 * @returns {boolean} true when the signature verifies
 */
export function isTauriSignatureValid(input) {
  try {
    verifyTauriSignature(input);
    return true;
  } catch {
    return false;
  }
}
