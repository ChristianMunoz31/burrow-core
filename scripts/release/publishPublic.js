// Publishes the Windows installers to the PUBLIC downloads repo (ChristianMunoz31/burrow-releases) as a GitHub
// Release with the same tag name as the private source release. Only three files may ever go there while the
// in-app updater is off: the two installers under their stable names and SHA256SUMS.txt. With the updater on
// (a real public key in src-tauri/tauri.release.conf.json, see updaterConfig.js) exactly six: those three plus
// Burrow-Setup-x64.exe.sig, Burrow-Setup-arm64.exe.sig and latest.json, and every signature is verified against the
// public key (minisign.js) before anything is uploaded. Source code never leaves the private repo.
//
// Usage: node scripts/release/publishPublic.js --tag v0.2.0 --assets-dir <dir> [--notes-from CHANGELOG.md]
//          [--draft | --prerelease] [--dry-run]
// Release notes are for users: only Features, Bug Fixes and Performance, with internal entries dropped (see
// userFacingChanges). A curated block replaces them: release-notes/<tag>.md next to the changelog. A curated text that
// already has a "## Download" section is used as the complete notes.
//   --dry-run     validate the assets, render the notes and print the plan; no token, no network, no gh call
//   --draft        publish as a draft (not visible to the public, never "latest")
//   --prerelease   publish as a pre-release (never "latest")
//   neither        publish as a full release and mark it latest, so releases/latest/download/<name> resolves to it
// Auth: GH_TOKEN must hold the RELEASES_TOKEN fine-grained PAT (Contents read/write on burrow-releases only).
// It is handed to gh through the environment only: never an argument, never printed, never used for a checkout.
import { execFile as execFileCb } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { verifyTauriSignature } from './minisign.js';
import { updaterState, withoutSigningEnv } from './updaterConfig.js';
import { assertProPresent } from '../checks/proPresent.js';

export const PUBLIC_REPO = 'ChristianMunoz31/burrow-releases';
export const INSTALLER_X64 = 'Burrow-Setup-x64.exe';
export const INSTALLER_ARM64 = 'Burrow-Setup-arm64.exe';
export const SUMS_FILE = 'SHA256SUMS.txt';
export const SIG_X64 = `${INSTALLER_X64}.sig`;
export const SIG_ARM64 = `${INSTALLER_ARM64}.sig`;
export const LATEST_JSON = 'latest.json';
/** The three assets published while the updater is off. */
export const ALLOWED_ASSETS = Object.freeze([INSTALLER_X64, INSTALLER_ARM64, SUMS_FILE]);
/** The six assets published while the updater is on. */
export const UPDATER_ASSETS = Object.freeze([INSTALLER_X64, INSTALLER_ARM64, SUMS_FILE, SIG_X64, SIG_ARM64, LATEST_JSON]);
/** SHA256SUMS.txt line order when the updater is on (the sums file does not list itself). */
export const UPDATER_SUMS_ORDER = Object.freeze([INSTALLER_X64, INSTALLER_ARM64, SIG_X64, SIG_ARM64, LATEST_JSON]);
export const MAX_ASSET_BYTES = 500 * 1024 * 1024;
export const MAX_SMALL_ASSET_BYTES = 1024 * 1024;

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TAG_RE = /^v\d+\.\d+\.\d+([-.][0-9A-Za-z.]+)?$/;
const EXE_NAMES = new Set([INSTALLER_X64, INSTALLER_ARM64]);
const SMALL_NAMES = new Set([SIG_X64, SIG_ARM64, LATEST_JSON]);
const DOWNLOAD_BASE = `https://github.com/${PUBLIC_REPO}/releases/download`;
const RELEASES_PAGE = `https://github.com/${PUBLIC_REPO}/releases`;

const execFile = promisify(execFileCb);
const EM_DASH = String.fromCharCode(0x2014);

/**
 * @typedef {{ name: string, size: number, isFile?: boolean, header?: Buffer | string }} AssetInfo
 */

/**
 * Checks the files found in the assets folder against the allowlist. Throws on the first problem.
 * Updater off: exactly the two installers and SHA256SUMS.txt. Updater on: exactly those plus the two `.sig`
 * files and latest.json. Anything else, and any other mix, is refused.
 * @param {AssetInfo[]} files name, size in bytes and (for the exes) the first bytes of each entry
 * @param {{ updater?: boolean }} [opts]
 * @returns {string[]} the allowed names, sorted
 */
export function allowlistAssets(files, { updater = false } = {}) {
  if (!Array.isArray(files)) throw new TypeError('files must be an array');
  const allowed = updater ? UPDATER_ASSETS : ALLOWED_ASSETS;
  const seen = new Set();
  for (const file of files) {
    const name = file?.name;
    if (typeof name !== 'string' || !allowed.includes(name)) {
      throw new Error(`Refusing to publish "${String(name)}": only ${allowed.join(', ')} may go to the public repo`);
    }
    if (seen.has(name)) throw new Error(`Duplicate asset ${name}`);
    seen.add(name);
    if (file.isFile === false) throw new Error(`${name} is not a regular file`);
    if (!Number.isFinite(file.size) || file.size <= 0) throw new Error(`${name} is empty`);
    const limit = SMALL_NAMES.has(name) ? MAX_SMALL_ASSET_BYTES : MAX_ASSET_BYTES;
    if (file.size > limit) {
      throw new Error(`${name} is ${file.size} bytes, over the ${limit} byte limit`);
    }
    if (EXE_NAMES.has(name)) {
      const head = file.header === undefined ? '' : Buffer.from(file.header).subarray(0, 2).toString('latin1');
      if (head !== 'MZ') throw new Error(`${name} is not a Windows executable (missing the MZ header)`);
    }
  }
  const missing = allowed.filter((name) => !seen.has(name));
  if (missing.length > 0) throw new Error(`Missing asset(s): ${missing.join(', ')}`);
  return [...seen].sort();
}

/**
 * The pinned public download URL of an installer for a tag (the shell and the server require the same URL).
 * @param {string} tag for example v0.5.0
 * @param {'x64' | 'arm64'} arch
 * @returns {string}
 */
export function pinnedInstallerUrl(tag, arch) {
  return `${DOWNLOAD_BASE}/${tag}/${arch === 'x64' ? INSTALLER_X64 : INSTALLER_ARM64}`;
}

const SIG_TEXT_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const PUB_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const sameKeys = (obj, keys) => {
  const have = Object.keys(obj ?? {}).sort();
  return have.length === keys.length && [...keys].sort().every((k, i) => k === have[i]);
};

/**
 * Validates latest.json against the Tauri v2 static schema Burrow publishes, the tag, the `.sig` files and the
 * installers. Throws on the first problem.
 * @param {{
 *   text: string, tag: string, pubkey: string,
 *   sigs: { x64: string, arm64: string },
 *   installers: { x64: Buffer, arm64: Buffer },
 * }} input sigs are the contents of the two `.sig` files, installers the installer bytes
 * @returns {{ version: string }}
 */
export function validateLatestJson({ text, tag, pubkey, sigs, installers }) {
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${LATEST_JSON} is not valid JSON`);
  }
  if (json === null || typeof json !== 'object' || Array.isArray(json) || !sameKeys(json, ['version', 'notes', 'pub_date', 'platforms'])) {
    throw new Error(`${LATEST_JSON} must have exactly version, notes, pub_date and platforms`);
  }
  if (json.version !== tag.slice(1)) throw new Error(`${LATEST_JSON} says version ${String(json.version)}, the tag is ${tag}`);
  if (typeof json.notes !== 'string') throw new Error(`${LATEST_JSON} notes must be a string`);
  if (json.notes.includes(EM_DASH) || /ChristianMunoz31\/burrow(?![-\w])/i.test(json.notes)) {
    throw new Error(`${LATEST_JSON} notes contain an em dash or a private repo reference`);
  }
  if (typeof json.pub_date !== 'string' || !PUB_DATE_RE.test(json.pub_date) || !Number.isFinite(Date.parse(json.pub_date))) {
    throw new Error(`${LATEST_JSON} pub_date must be an RFC 3339 UTC time with whole seconds`);
  }
  const platforms = json.platforms;
  if (platforms === null || typeof platforms !== 'object' || !sameKeys(platforms, ['windows-x86_64', 'windows-aarch64'])) {
    throw new Error(`${LATEST_JSON} platforms must be exactly windows-x86_64 and windows-aarch64`);
  }
  for (const [key, arch] of [['windows-x86_64', 'x64'], ['windows-aarch64', 'arm64']]) {
    const entry = platforms[key];
    if (entry === null || typeof entry !== 'object' || !sameKeys(entry, ['signature', 'url'])) {
      throw new Error(`${LATEST_JSON} ${key} must have exactly signature and url`);
    }
    if (entry.url !== pinnedInstallerUrl(tag, arch)) throw new Error(`${LATEST_JSON} ${key} url is not ${pinnedInstallerUrl(tag, arch)}`);
    const sigFile = String(sigs[arch] ?? '').trim();
    if (typeof entry.signature !== 'string' || entry.signature === '' || entry.signature.length > 4096 || !SIG_TEXT_RE.test(entry.signature)) {
      throw new Error(`${LATEST_JSON} ${key} signature is not a base64 string`);
    }
    if (entry.signature !== sigFile) throw new Error(`${LATEST_JSON} ${key} signature is not the contents of the .sig file`);
    try {
      verifyTauriSignature({ pubkeyB64: pubkey, sigB64: sigFile, data: installers[arch], expectVersion: tag.slice(1) });
    } catch (err) {
      throw new Error(`The ${arch} signature does not verify: ${err.message}`, { cause: err });
    }
  }
  return { version: json.version };
}

/**
 * The names listed in SHA256SUMS.txt must come in the documented order.
 * @param {string} sums
 * @param {readonly string[]} order
 */
export function checkSumsOrder(sums, order) {
  const names = String(sums).replace(/\r\n?/g, '\n').split('\n').filter((l) => l.trim()).map((l) => /^[0-9a-fA-F]{64} [ *](\S.*)$/.exec(l)?.[1]);
  if (names.length !== order.length || names.some((n, i) => n !== order[i])) {
    throw new Error(`${SUMS_FILE} must list ${order.join(', ')} in that order`);
  }
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The body of the `## ` section of a release-please CHANGELOG for one version (heading excluded).
 * Matches `## [0.2.0](compare-url) (date)` and `## 0.2.0 (date)`.
 * @param {string} changelog
 * @param {string} version with or without a leading v
 * @returns {string | null} trimmed body, or null when the version has no section
 */
export function extractChangelogSection(changelog, version) {
  if (typeof changelog !== 'string' || typeof version !== 'string') return null;
  const wanted = version.trim().replace(/^v/, '');
  if (!wanted) return null;
  const lines = changelog.replace(/\r\n?/g, '\n').split('\n');
  const heading = new RegExp(`^##\\s+\\[?v?${escapeRe(wanted)}\\]?(?=[\\s(]|$)`);
  const start = lines.findIndex((line) => heading.test(line));
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start + 1, end).join('\n').trim();
}

// Only these release-please sections are shown to users, under friendlier headings.
const USER_SECTIONS = new Map([
  ['features', 'New'],
  ['bug fixes', 'Fixed'],
  ['performance', 'Faster'],
]);
// Commit types and scopes that are about the project, not the product.
const INTERNAL_SCOPES = new Set([
  'ci', 'test', 'tests', 'docs', 'chore', 'refactor', 'build', 'deps', 'release', 'style', 'dev', 'seed', 'checks', 'docker', 'e2e',
]);
// Words that mean an entry talks about internals. Matched anywhere in the entry text.
const INTERNAL_TERMS =
  /\b(?:docker|ci|workflow|sidecar|smoke|signed license files?|ed25519|worker|lockfile|ssrf|hmac|csp|dependabot|sandbox|nsis|tauri|npm|vitest|eslint|bundle|lazy-load|dev keys?|developer keys?|dev channel|dev build|burrow dev|mint|hooks|artifacts?|isolation|precompute|tests?)\b|\b(?:server|src|config|scripts)\//i;

/**
 * Whether one changelog entry (already cleaned: no hashes or links) is about the product. The entry may
 * start with a release-please scope (`**scope:** text`) or a plain conventional prefix (`type(scope): text`).
 * @param {string} entry
 * @returns {boolean}
 */
export function isUserFacingEntry(entry) {
  const text = String(entry ?? '').trim();
  if (!text) return false;
  const bold = /^\*\*([^*\n]+?):\*\*/.exec(text);
  const plain = /^([a-z]+)(?:\(([^)\n]+)\))?!?:\s/i.exec(text);
  const scope = (bold?.[1] ?? plain?.[2] ?? '').toLowerCase().trim();
  const type = (plain?.[1] ?? '').toLowerCase();
  if (INTERNAL_SCOPES.has(scope) || INTERNAL_SCOPES.has(type)) return false;
  return !INTERNAL_TERMS.test(text);
}

const sentenceCase = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/**
 * User-facing changes from a release-please section: only Features, Bug Fixes and Performance, internal
 * entries (see isUserFacingEntry) dropped, no scope prefixes, friendlier headings. Breaking-change notes,
 * refactor, documentation and every other section are never shown.
 * @param {string | null} section
 * @returns {string} markdown, or '' when nothing user-facing is left
 */
export function userFacingChanges(section) {
  const cleaned = cleanChangelog(section ?? '');
  const groups = new Map();
  let current = null;
  let last = null;
  for (const line of cleaned.split('\n')) {
    const heading = /^###\s+(.+?)\s*$/.exec(line);
    if (heading) {
      current = [...USER_SECTIONS.values()].includes(heading[1]) ? heading[1] : null;
      last = null;
      continue;
    }
    if (!current) continue;
    const bullet = /^[*-]\s+(.*)$/.exec(line);
    if (bullet) {
      last = { text: bullet[1].trim() };
      if (!groups.has(current)) groups.set(current, []);
      groups.get(current).push(last);
    } else if (last && line.trim()) {
      last.text = `${last.text} ${line.trim()}`;
    }
  }
  const out = [];
  for (const title of USER_SECTIONS.values()) {
    const kept = (groups.get(title) ?? [])
      .filter((e) => isUserFacingEntry(e.text))
      .map((e) => `- ${sentenceCase(e.text.replace(/^\*\*[^*\n]+?:\*\*\s*/, '').replace(/^[a-z]+(?:\([^)\n]+\))?!?:\s/i, ''))}`);
    if (kept.length > 0) out.push(`### ${title}\n\n${kept.join('\n')}`);
  }
  return out.join('\n\n');
}

const SECTION_TITLES = new Map([
  ['features', 'New'],
  ['bug fixes', 'Fixed'],
  ['performance', 'Faster'],
  ['documentation', 'Docs'],
]);

/**
 * Turns a release-please section into consumer text: no commit hashes, no PR numbers, no links to the private
 * repo (links keep only their text), friendlier headings, no em dashes.
 * @param {string} section
 * @returns {string}
 */
export function cleanChangelog(section) {
  let text = String(section ?? '').replace(/\r\n?/g, '\n');
  // "([#12](url))" and "([abc1234](url))" reference links, then any other markdown link, then bare URLs.
  text = text.replace(/[ \t]*\(\[[^\]\n]*\]\([^)\n]*\)\)/g, '');
  text = text.replace(/\[([^\]\n]*)\]\([^)\n]*\)/g, '$1');
  text = text.replace(/https?:\/\/github\.com\/ChristianMunoz31\/burrow(?![-\w])\S*/gi, '');
  text = text.replace(/[ \t]*\(#\d+\)/g, '');
  text = text.replace(/,\s*closes\s+#\d+/gi, '');
  text = text.replace(/[ \t]*\(\b[0-9a-f]{7,40}\b\)/gi, '');
  text = text.replace(/^###\s+(.+?)\s*$/gm, (_m, title) => `### ${SECTION_TITLES.get(title.toLowerCase()) ?? title}`);
  text = text.replaceAll(EM_DASH, '-');
  text = text.replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');
  return text
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Plain-language GitHub Release notes for consumers.
 * `curated` (optional) is hand-written text used verbatim instead of the changelog list: as the "What's new"
 * block, or, when it already has its own "## Download" section, as the complete notes.
 * @param {{ version: string, section: string | null, sums: string, curated?: string | null }} input version without the leading v
 * @returns {string}
 */
export function renderReleaseNotes({ version, section, sums, curated = null }) {
  const ver = String(version).replace(/^v/, '');
  const tag = `v${ver}`;
  const custom = typeof curated === 'string' ? curated.replace(/\r\n?/g, '\n').trim() : '';
  if (custom && /^##\s+Download\b/m.test(custom)) return `${custom}\n`;
  let changes = custom;
  if (!changes) {
    changes = userFacingChanges(section);
    if (!changes) {
      changes = section === null ? 'This release has no listed changes.' : 'This release has behind-the-scenes improvements.';
    }
  }
  const sumsBlock = String(sums ?? '').replace(/\r\n?/g, '\n').trim();
  const notes = `# Burrow ${ver}

## What's new

${changes}

## Download

- Windows PCs with an Intel or AMD processor (most PCs): [${INSTALLER_X64}](${DOWNLOAD_BASE}/${tag}/${INSTALLER_X64})
- Windows PCs with an ARM processor (for example Snapdragon laptops): [${INSTALLER_ARM64}](${DOWNLOAD_BASE}/${tag}/${INSTALLER_ARM64})

Not sure which one you have? Open Settings, then System, then About, and look at "System type".

## Windows may warn you the first time

These builds are not code-signed yet. Code signing is a planned future step. Until then Windows SmartScreen shows "Windows protected your PC" when you open the installer. This is expected. To continue:

1. Click **More info**.
2. Click **Run anyway**.

Only install Burrow files that you downloaded from this page.

## Check your download (optional)

In short: run \`Get-FileHash .\\${INSTALLER_X64} -Algorithm SHA256\`, then compare it to ${SUMS_FILE}.

Open PowerShell in the folder with the file and run:

\`\`\`powershell
Get-FileHash .\\${INSTALLER_X64} -Algorithm SHA256
\`\`\`

Use \`${INSTALLER_ARM64}\` instead if you downloaded the ARM installer. The hash it prints must match the line for your file in [${SUMS_FILE}](${DOWNLOAD_BASE}/${tag}/${SUMS_FILE}), shown below. If it does not match, delete the file and download it again.

\`\`\`text
${sumsBlock}
\`\`\`

Your data stays on your computer. Updating or uninstalling Burrow keeps it. See all versions on the [releases page](${RELEASES_PAGE}).
`;
  return notes;
}

/**
 * Checks SHA256SUMS.txt (sha256sum format) against the real hashes of the installers.
 * @param {string} sums
 * @param {Record<string, string>} actual file name to lowercase hex sha256
 * @returns {void}
 */
export function verifySums(sums, actual) {
  const listed = new Map();
  for (const line of String(sums).replace(/\r\n?/g, '\n').split('\n')) {
    if (!line.trim()) continue;
    const m = /^([0-9a-fA-F]{64}) [ *](\S.*)$/.exec(line);
    if (!m) throw new Error(`Malformed line in ${SUMS_FILE}`);
    listed.set(m[2], m[1].toLowerCase());
  }
  for (const [name, hash] of Object.entries(actual)) {
    if (listed.get(name) !== hash) throw new Error(`${SUMS_FILE} does not match ${name}`);
  }
  for (const name of listed.keys()) {
    if (!(name in actual)) throw new Error(`${SUMS_FILE} lists an unexpected file: ${name}`);
  }
}

/**
 * The gh invocations (without the leading "gh") to publish the release in the public repo.
 * A new release is created and marked latest in one call; an existing one gets the files uploaded with
 * --clobber, then its notes and flags edited and, for a full release, marked latest.
 * @param {{ tag: string, assets: string[], notesFile: string, draft?: boolean, prerelease?: boolean, exists: boolean }} input
 * @returns {string[][]}
 */
export function buildGhArgs({ tag, assets, notesFile, draft = false, prerelease = false, exists }) {
  if (!TAG_RE.test(tag)) throw new Error('Unexpected tag format');
  if (/-dev/i.test(tag)) throw new Error('A -dev tag is a Burrow Dev build and is never published as a stable release');
  if (!Array.isArray(assets) || assets.length === 0) throw new Error('No assets to upload');
  if (typeof notesFile !== 'string' || !notesFile) throw new Error('notesFile is required');
  if (draft && prerelease) throw new Error('Choose draft or prerelease, not both');
  const title = `Burrow ${tag.slice(1)}`;
  const full = !draft && !prerelease;
  if (!exists) {
    return [
      [
        'release', 'create', tag, ...assets, '-R', PUBLIC_REPO, '--title', title, '--notes-file', notesFile,
        ...(draft ? ['--draft'] : []),
        ...(prerelease ? ['--prerelease'] : []),
        ...(full ? ['--latest'] : []),
      ],
    ];
  }
  return [
    ['release', 'upload', tag, ...assets, '-R', PUBLIC_REPO, '--clobber'],
    [
      'release', 'edit', tag, '-R', PUBLIC_REPO, '--title', title, '--notes-file', notesFile,
      `--draft=${draft}`, `--prerelease=${prerelease}`,
      ...(full ? ['--latest'] : []),
    ],
  ];
}

/**
 * Names missing (or empty) in the `gh release view --json assets` result.
 * @param {{ assets?: { name: string, size: number }[] }} view
 * @param {string[]} names
 * @returns {string[]}
 */
export function missingAssets(view, names) {
  const have = new Map((view?.assets ?? []).map((a) => [a.name, a.size]));
  return names.filter((name) => !(have.get(name) > 0));
}

const hashFile = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/**
 * Lists a folder as AssetInfo records (size, type and the first two bytes), without following links.
 * @param {string} dir
 * @returns {AssetInfo[]}
 */
export function describeFiles(dir) {
  return fs.readdirSync(dir).map((name) => {
    const full = path.join(dir, name);
    const st = fs.lstatSync(full);
    let header = Buffer.alloc(0);
    if (st.isFile() && st.size > 0) {
      const fd = fs.openSync(full, 'r');
      try {
        header = Buffer.alloc(2);
        fs.readSync(fd, header, 0, 2, 0);
      } finally {
        fs.closeSync(fd);
      }
    }
    return { name, size: st.size, isFile: st.isFile(), header };
  });
}

const redact = (text, secret) => (secret ? String(text).split(secret).join('***') : String(text));

/**
 * Hand-written release notes, if any: `release-notes/<tag>.md` next to the changelog (a dry-run tag falls back
 * to the base version's file).
 * @param {{ tag: string, notesFrom?: string }} input
 * @returns {string | null} the text, or null when there is none
 */
export function loadCuratedNotes({ tag, notesFrom }) {
  if (notesFrom) {
    const dir = path.join(path.dirname(notesFrom), 'release-notes');
    for (const name of new Set([tag, tag.replace(/[-+].*$/, '')])) {
      const file = path.join(dir, `${name}.md`);
      if (fs.existsSync(file)) {
        const text = fs.readFileSync(file, 'utf8').trim();
        if (text) return text;
      }
    }
  }
  return null;
}

/**
 * The tags that release links in `text` point at (`.../releases/download/<tag>/...` or `.../releases/tag/<tag>`)
 * on the public repo. A prerelease tag falls back to its base version's notes file, whose links name the
 * stable tag, so a link to any other tag must stop the publish.
 * @param {string} text
 * @returns {string[]}
 */
export function linkedReleaseTags(text) {
  const repo = PUBLIC_REPO.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('github\\.com/' + repo + '/releases/(?:download|tag)/([^/\\s)#?]+)', 'gi');
  return [...String(text).matchAll(re)].map((m) => {
    try {
      return decodeURIComponent(m[1]);
    } catch {
      return m[1];
    }
  });
}

/**
 * @param {{
 *   tag: string, assetsDir: string, notesFrom?: string, draft?: boolean, prerelease?: boolean, dryRun?: boolean,
 *   env?: Record<string, string | undefined>,
 *   root?: string,
 *   updater?: { enabled: boolean, pubkey?: string | null },
 *   exec?: (file: string, args: string[], opts: object) => Promise<{ stdout: string, stderr: string }>,
 *   log?: { info: (m: string) => void, warn: (m: string) => void },
 * }} opts
 * @returns {Promise<{ plan: string[][], notes: string }>}
 */
export async function publish({
  tag,
  assetsDir,
  notesFrom,
  draft = false,
  prerelease = false,
  dryRun = false,
  env = process.env,
  root = REPO_ROOT,
  updater = undefined,
  exec = execFile,
  log = { info: (m) => console.log(m), warn: (m) => console.log(`::warning::${m}`) },
}) {
  if (!TAG_RE.test(tag ?? '')) throw new Error('Unexpected tag format');
  if (/-dev/i.test(tag)) throw new Error('A -dev tag is a Burrow Dev build and is never published as a stable release');
  const version = tag.slice(1);
  // Updater on or off comes from the public key in src-tauri/tauri.release.conf.json unless a caller says so.
  const mode = updater ?? updaterState(root);
  const updaterOn = mode.enabled === true;
  if (updaterOn && !mode.pubkey) throw new Error('The updater is on but no public key was given to verify the signatures');
  const names = allowlistAssets(describeFiles(assetsDir), { updater: updaterOn });
  const hashed = updaterOn ? UPDATER_SUMS_ORDER : [INSTALLER_X64, INSTALLER_ARM64];
  const actual = Object.fromEntries(hashed.map((n) => [n, hashFile(path.join(assetsDir, n))]));
  const sums = fs.readFileSync(path.join(assetsDir, SUMS_FILE), 'utf8');
  verifySums(sums, actual);
  if (updaterOn) {
    checkSumsOrder(sums, UPDATER_SUMS_ORDER);
    const read = (n) => fs.readFileSync(path.join(assetsDir, n));
    validateLatestJson({
      text: read(LATEST_JSON).toString('utf8'),
      tag,
      pubkey: mode.pubkey,
      sigs: { x64: read(SIG_X64).toString('utf8'), arm64: read(SIG_ARM64).toString('utf8') },
      installers: { x64: read(INSTALLER_X64), arm64: read(INSTALLER_ARM64) },
    });
    log.info('Verified both installer signatures and latest.json against the updater public key.');
  }

  let section = null;
  if (notesFrom && fs.existsSync(notesFrom)) {
    const changelog = fs.readFileSync(notesFrom, 'utf8');
    section = extractChangelogSection(changelog, version) ?? extractChangelogSection(changelog, version.replace(/[-+].*$/, ''));
  }
  if (section === null) log.warn(`No CHANGELOG section found for ${version}; the release notes will not list changes.`);
  const curated = loadCuratedNotes({ tag, notesFrom });
  if (curated) {
    const other = linkedReleaseTags(curated).find((t) => t !== tag);
    if (other) throw new Error(`The hand-written release notes link to ${other}, not ${tag}; give this tag its own release-notes file`);
    log.info('Using the hand-written release notes instead of the changelog list.');
  }
  const notes = renderReleaseNotes({ version, section, sums, curated });
  if (notes.includes(EM_DASH) || /ChristianMunoz31\/burrow(?![-\w])/i.test(notes)) {
    throw new Error('Rendered notes contain an em dash or a private repo reference (check release-notes/)');
  }

  const notesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-notes-'));
  const notesFile = path.join(notesDir, 'notes.md');
  fs.writeFileSync(notesFile, notes, 'utf8');
  const assets = names.map((n) => path.join(assetsDir, n));

  try {
    if (dryRun) {
      const plan = buildGhArgs({ tag, assets, notesFile, draft, prerelease, exists: false });
      log.info(`DRY RUN: would publish ${tag} to ${PUBLIC_REPO} (${draft ? 'draft' : prerelease ? 'prerelease' : 'full release, latest'})`);
      for (const n of names) log.info(`  asset ${n} (${fs.statSync(path.join(assetsDir, n)).size} bytes)`);
      for (const args of plan) log.info(`  gh ${args.map((a) => (a === notesFile ? '<notes-file>' : a)).join(' ')}`);
      log.info('--- release notes ---');
      log.info(notes);
      return { plan, notes };
    }

    const token = env.GH_TOKEN;
    if (!token) throw new Error('GH_TOKEN is empty: set the RELEASES_TOKEN repository secret (see docs/RELEASING.md)');
    const ghEnv = { ...withoutSigningEnv(env), GH_TOKEN: token, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' };
    delete ghEnv.GITHUB_TOKEN;
    delete ghEnv.GH_ENTERPRISE_TOKEN;
    delete ghEnv.GH_REPO;
    const gh = async (args) => {
      try {
        return await exec('gh', args, { env: ghEnv, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
      } catch (err) {
        const detail = redact(`${err?.stderr ?? ''}${err?.message ?? ''}`.trim(), token);
        throw Object.assign(new Error(`gh ${args.slice(0, 2).join(' ')} failed: ${detail}`), { notFound: /release not found/i.test(detail) });
      }
    };

    let exists = true;
    try {
      await gh(['release', 'view', tag, '-R', PUBLIC_REPO, '--json', 'tagName']);
    } catch (err) {
      if (!err.notFound) throw err;
      exists = false;
    }
    const plan = buildGhArgs({ tag, assets, notesFile, draft, prerelease, exists });
    for (const args of plan) {
      log.info(`gh ${args.slice(0, 3).join(' ')} ...`);
      await gh(args);
    }

    const { stdout } = await gh(['release', 'view', tag, '-R', PUBLIC_REPO, '--json', 'assets,isDraft,isPrerelease,tagName']);
    const view = JSON.parse(stdout);
    const missing = missingAssets(view, names);
    if (missing.length > 0) throw new Error(`Published release is missing: ${missing.join(', ')}`);
    if (!draft && !prerelease) {
      const latest = JSON.parse((await gh(['api', `repos/${PUBLIC_REPO}/releases/latest`])).stdout);
      if (latest.tag_name !== tag) throw new Error(`Latest release is ${latest.tag_name}, expected ${tag}`);
    }
    log.info(`Published ${tag} to ${PUBLIC_REPO}`);
    return { plan, notes };
  } finally {
    fs.rmSync(notesDir, { recursive: true, force: true });
  }
}

async function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      tag: { type: 'string' },
      'assets-dir': { type: 'string' },
      'notes-from': { type: 'string' },
      draft: { type: 'boolean', default: false },
      prerelease: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
    },
    strict: true,
  });
  if (!values.tag || !values['assets-dir']) throw new Error('Usage: publishPublic.js --tag <vX.Y.Z> --assets-dir <dir> [--notes-from CHANGELOG.md] [--draft|--prerelease] [--dry-run]');
  // Official releases include the Pro module (docs/adr/0001-open-core-split.md 3.10): a checkout without the Pro module only
  // makes Free builds (BURROW_PRO=off), which are never published.
  if (!values['dry-run']) assertProPresent();
  await publish({
    tag: values.tag,
    assetsDir: path.resolve(values['assets-dir']),
    notesFrom: values['notes-from'] ? path.resolve(values['notes-from']) : undefined,
    draft: values.draft,
    prerelease: values.prerelease,
    dryRun: values['dry-run'],
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`::error::${err.message}`);
    process.exit(1);
  });
}
