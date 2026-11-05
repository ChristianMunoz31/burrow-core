// The x64 sidecar is a Node SEA: the server bundle injected into an x64 node.exe. On an ARM64 PC the only x64 node.exe
// is one we fetch, so this module gets the official one for exactly the running Node version (the SEA blob must match
// the node it is injected into) and caches it outside the repo.
// Trust comes from a hash pinned in the repo (config/store-node.json), not from the download: a version with no pin is
// refused unless the owner passes --x64-node <file>, the download must match the pin AND nodejs.org's SHASUMS256.txt,
// redirects are not followed, and a cached copy is re-verified against the pin (and run once) every time.
// The only network use is reading two files from https://nodejs.org/dist; nothing is sent or published.
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { peMachine } from './pe.mjs';

export { peMachine };

export const NODE_DIST = 'https://nodejs.org/dist';
export const NODE_PINS_CONFIG = 'config/store-node.json';
export const MAX_NODE_BYTES = 200 * 1024 * 1024;
const MAX_SUMS_BYTES = 1024 * 1024;
const SHA256_RE = /^[0-9a-f]{64}$/;
const VERSION_RE = /^v\d+\.\d+\.\d+$/;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * @param {string} version for example v24.15.0
 * @returns {{ exe: string, sums: string }}
 */
export function nodeUrls(version) {
  if (!VERSION_RE.test(version)) throw new Error(`Unexpected Node version "${version}"`);
  return { exe: `${NODE_DIST}/${version}/win-x64/node.exe`, sums: `${NODE_DIST}/${version}/SHASUMS256.txt` };
}

/**
 * The sha256 nodejs.org lists for one file, `win-x64/node.exe` by default.
 * @param {string} text SHASUMS256.txt
 * @param {string} [entry] the file name as SHASUMS256.txt lists it
 * @returns {string} 64 hex characters
 * @throws {Error} when the line is missing
 */
export function parseShasums(text, entry = 'win-x64/node.exe') {
  for (const line of text.split(/\r?\n/)) {
    const m = /^([0-9a-f]{64})\s+(\S+)$/.exec(line.trim());
    if (m && m[2] === entry) return m[1];
  }
  throw new Error(`SHASUMS256.txt has no ${entry} line`);
}

/**
 * The official win-arm64 zip of a Node version (node.exe plus npm), which scripts/runner/install-node.sh installs per
 * job on the self-hosted runner.
 * @param {string} version for example v24.15.0
 * @returns {{ name: string, zip: string, sums: string }}
 */
export function arm64ZipUrls(version) {
  if (!VERSION_RE.test(version)) throw new Error(`Unexpected Node version "${version}"`);
  const name = `node-${version}-win-arm64.zip`;
  return { name, zip: `${NODE_DIST}/${version}/${name}`, sums: `${NODE_DIST}/${version}/SHASUMS256.txt` };
}

function readPinSection(root, key) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(root, ...NODE_PINS_CONFIG.split('/')), 'utf8'));
  } catch {
    throw new Error(`${NODE_PINS_CONFIG} is missing or is not valid JSON`);
  }
  const pins = parsed?.[key];
  if (pins === null || typeof pins !== 'object' || Array.isArray(pins)) throw new Error(`${NODE_PINS_CONFIG} needs a "${key}" object`);
  for (const [version, hash] of Object.entries(pins)) {
    if (!VERSION_RE.test(version) || typeof hash !== 'string' || !SHA256_RE.test(hash)) {
      throw new Error(`${NODE_PINS_CONFIG}: the entry for "${version}" must be a Node version mapped to a lowercase sha256`);
    }
  }
  return pins;
}

/**
 * Reads the pinned sha256 of the win-arm64 zip per Node version ("arm64ZipPins" in config/store-node.json).
 * @param {string} [root] repository root
 * @returns {Record<string, string>}
 */
export function readArm64ZipPins(root = ROOT) {
  return readPinSection(root, 'arm64ZipPins');
}

const versionParts = (v) => v.slice(1).split('.').map(Number);

/**
 * The Node version the self-hosted runner installs: the newest one pinned for BOTH the x64 node.exe and the arm64
 * zip, so the node that builds a SEA blob and the x64 node.exe it is injected into are the same version.
 * @param {string} [root]
 * @returns {string}
 * @throws {Error} when no version has both pins
 */
export function runnerNodeVersion(root = ROOT) {
  const x64 = readNodePins(root);
  const arm64 = readArm64ZipPins(root);
  const both = Object.keys(x64).filter((v) => Object.hasOwn(arm64, v));
  if (both.length === 0) throw new Error(`${NODE_PINS_CONFIG} has no Node version pinned for both win-x64 and win-arm64`);
  both.sort((a, b) => {
    const [pa, pb] = [versionParts(a), versionParts(b)];
    for (let i = 0; i < 3; i += 1) if (pa[i] !== pb[i]) return pa[i] - pb[i];
    return 0;
  });
  return both[both.length - 1];
}

/**
 * Reads the pinned hashes from config/store-node.json.
 * @param {string} [root] repository root
 * @returns {Record<string, string>} Node version to sha256 (lowercase hex)
 * @throws {Error} when the file is missing or malformed
 */
export function readNodePins(root = ROOT) {
  return readPinSection(root, 'pins');
}

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

/**
 * Checks a user-supplied x64 node.exe: it must be an x64 PE file and report the running Node version (run under
 * emulation on ARM64 Windows).
 * @param {string} file
 * @param {{ version?: string, run?: (file: string, args: string[]) => { status: number | null, stdout: string } }} [opts]
 * @throws {Error} when it is not suitable
 */
export function assertUsableX64Node(file, { version = process.version, run = (f, a) => spawnSync(f, a, { encoding: 'utf8', timeout: 30_000 }) } = {}) {
  let head;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      head = Buffer.alloc(4096);
      fs.readSync(fd, head, 0, head.length, 0);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    throw new Error(`The x64 node.exe could not be read: ${file}`);
  }
  if (peMachine(head) !== 'x64') throw new Error(`${file} is not an x64 Windows executable`);
  const res = run(file, ['--version']);
  if (res.status !== 0 || String(res.stdout).trim() !== version) {
    throw new Error(`${file} must be Node ${version} (the SEA blob has to match the node it is injected into); it answered "${String(res.stdout).trim() || 'nothing'}"`);
  }
}

/**
 * GET with redirects refused, and a final URL that must still be on nodejs.org/dist.
 * @param {typeof fetch} fetchImpl
 * @param {string} url
 */
async function getOfficial(fetchImpl, url) {
  const res = await fetchImpl(url, { redirect: 'error' });
  if (typeof res.url === 'string' && res.url !== '' && !res.url.startsWith(`${NODE_DIST}/`)) {
    throw new Error(`${url} was answered from ${res.url}, which is not ${NODE_DIST}; refusing it`);
  }
  if (!res.ok) throw new Error(`Could not read ${url} (HTTP ${res.status})`);
  return res;
}

/**
 * Returns the path of a verified x64 node.exe for `version`, downloading it into `cacheDir` when needed.
 * The version must have an entry in `pins`; a copy is accepted only when its sha256 equals that pin.
 * `allowUnpinned` (release:auto only, never the Store build) accepts a version with no pin: the expected sha256 is
 * then the win-x64/node.exe line of nodejs.org's SHASUMS256.txt, read fresh over https on every call (also for a
 * cached copy), which is the trust level of the documented manual x64 fallback. A pinned version is unchanged.
 * @param {{ cacheDir: string, version?: string, pins?: Record<string, string>, fetchImpl?: typeof fetch,
 *   run?: (file: string, args: string[]) => { status: number | null, stdout: string }, log?: (line: string) => void,
 *   allowUnpinned?: boolean }} opts
 * @returns {Promise<string>}
 */
export async function ensureX64Node({ cacheDir, version = process.version, pins = readNodePins(), fetchImpl = fetch, run, log = () => {}, allowUnpinned = false }) {
  const urls = nodeUrls(version);
  const pin = pins[version];
  const hasPin = typeof pin === 'string' && SHA256_RE.test(pin);
  if (!hasPin && !allowUnpinned) {
    throw new Error(
      `No pinned sha256 for the x64 node.exe of Node ${version} in ${NODE_PINS_CONFIG}. Add the win-x64/node.exe line from ${urls.sums} after checking it, or pass --x64-node <node.exe> (Node ${version}, x64).`,
    );
  }
  const readListed = async () => {
    const sums = await getOfficial(fetchImpl, urls.sums);
    const sumsText = await sums.text();
    if (sumsText.length > MAX_SUMS_BYTES) throw new Error('SHASUMS256.txt is unexpectedly large');
    return parseShasums(sumsText);
  };
  let listed = null;
  let pinned = pin;
  if (!hasPin) {
    listed = await readListed();
    pinned = listed;
    log(`x64 node ${version}: no pin in ${NODE_PINS_CONFIG}; using the sha256 that ${urls.sums} lists (${listed})`);
  }
  const usable = (file) => assertUsableX64Node(file, run ? { version, run } : { version });
  const file = path.join(cacheDir, `node-${version}-win-x64.exe`);
  if (fs.existsSync(file)) {
    if (sha256(fs.readFileSync(file)) === pinned) {
      usable(file);
      log(`x64 node ${version}: using the cached copy ${file} (sha256 matches ${hasPin ? 'the pin' : 'SHASUMS256.txt'})`);
      return file;
    }
    log(`x64 node ${version}: the cached copy does not match the expected sha256; downloading it again`);
  }
  log(`x64 node ${version}: downloading ${urls.exe} (read only; ${hasPin ? 'pinned sha256, cross-checked against' : 'sha256 from'} ${urls.sums})`);
  if (listed === null) listed = await readListed();
  if (listed !== pinned) throw new Error(`nodejs.org lists ${listed} for Node ${version} win-x64/node.exe but ${NODE_PINS_CONFIG} pins ${pinned}; nothing was downloaded`);
  const exe = await getOfficial(fetchImpl, urls.exe);
  const declared = Number(exe.headers?.get?.('content-length') ?? Number.NaN);
  if (Number.isFinite(declared) && (declared <= 0 || declared > MAX_NODE_BYTES)) throw new Error('The node.exe announces an unexpected size; it was not read');
  const bytes = Buffer.from(await exe.arrayBuffer());
  if (bytes.length === 0 || bytes.length > MAX_NODE_BYTES) throw new Error('The downloaded node.exe has an unexpected size');
  if (sha256(bytes) !== pinned) throw new Error(`The downloaded x64 node.exe does not match the ${hasPin ? 'pinned' : 'listed'} sha256; it was discarded`);
  if (peMachine(bytes) !== 'x64') throw new Error('The downloaded file is not an x64 Windows executable; it was discarded');
  fs.mkdirSync(cacheDir, { recursive: true });
  const partial = `${file}.partial`;
  fs.writeFileSync(partial, bytes);
  try {
    fs.renameSync(partial, file);
    usable(file);
  } catch (err) {
    fs.rmSync(partial, { force: true });
    fs.rmSync(file, { force: true });
    throw err;
  }
  return file;
}
