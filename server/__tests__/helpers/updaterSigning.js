// TEST-ONLY updater signing helpers. Every key here is generated in memory for one test run and thrown away; no key
// material is ever written to the repo (npm run check:keys and gitleaks enforce that). The formats are the ones
// `tauri signer` produces: a minisign public key file and a minisign signature file, each base64 encoded as a whole.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const b64 = (value) => Buffer.from(value).toString('base64');

/**
 * @param {{ keyId?: Buffer }} [opts]
 * @returns {{ privateKey: crypto.KeyObject, publicRaw: Buffer, keyId: Buffer, pubkeyB64: string }}
 */
export function makeTestKey({ keyId = crypto.randomBytes(8) } = {}) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicRaw = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');
  const keyLine = b64(Buffer.concat([Buffer.from('Ed'), keyId, publicRaw]));
  const pubkeyB64 = b64(`untrusted comment: minisign public key: ${keyId.toString('hex').toUpperCase()}\n${keyLine}\n`);
  return { privateKey, publicRaw, keyId, pubkeyB64 };
}

/**
 * A Tauri `.sig` file body for `data`.
 * @param {{ key: ReturnType<typeof makeTestKey>, data: Buffer | string, prehash?: boolean, trusted?: string, version?: string }} input
 *   version when given, a tab and `version:<v>` are appended to the trusted comment, as `tauri build` does
 *   prehash true is the `ED` (blake2b prehashed) form that tauri writes, false is the legacy `Ed` form
 * @returns {string}
 */
export function signTestData({ key, data, prehash = true, trusted: baseTrusted = 'timestamp:1700000000\tfile:test-setup.exe', version }) {
  const trusted = version === undefined ? baseTrusted : `${baseTrusted}\tversion:${version}`;
  const bytes = Buffer.from(data);
  const message = prehash ? crypto.createHash('blake2b512').update(bytes).digest() : bytes;
  const sig = crypto.sign(null, message, key.privateKey);
  const globalSig = crypto.sign(null, Buffer.concat([sig, Buffer.from(trusted)]), key.privateKey);
  const sigLine = b64(Buffer.concat([Buffer.from(prehash ? 'ED' : 'Ed'), key.keyId, sig]));
  return b64(`untrusted comment: signature from tauri secret key\n${sigLine}\ntrusted comment: ${trusted}\n${b64(globalSig)}\n`);
}

/**
 * A temp repo root with a release overlay holding `pubkey` and a package.json with `version`, for the release scripts.
 * @param {string} pubkey
 * @param {string} [version]
 * @returns {{ root: string, cleanup: () => void }}
 */
export const OVERLAY_ROOT_VERSION = '0.2.0';

/** A stand-in for the compiled shell: the direct distribution marker src-tauri/src/channel.rs compiles in. */
export const DIRECT_SHELL_EXE = Buffer.from('MZ fixture shell burrow-distribution=direct');

/**
 * Writes a direct-marked Burrow.exe where tauri leaves it for the host build and for both Windows targets.
 * @param {string} root
 */
export function writeDirectShell(root) {
  for (const target of [[], ['x86_64-pc-windows-msvc'], ['aarch64-pc-windows-msvc']]) {
    const dir = path.join(root, 'src-tauri', 'target', ...target, 'release');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'Burrow.exe'), DIRECT_SHELL_EXE);
  }
}
export function makeOverlayRoot(pubkey, version = OVERLAY_ROOT_VERSION) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-overlay-'));
  fs.mkdirSync(path.join(root, 'src-tauri'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'src-tauri', 'tauri.release.conf.json'),
    JSON.stringify({ bundle: { createUpdaterArtifacts: true }, plugins: { updater: { pubkey, endpoints: ['https://example.invalid/latest.json'] } } }),
  );
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'burrow', version }));
  writeDirectShell(root);
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}
