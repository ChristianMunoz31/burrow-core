// Opt-in update check. The stable check has two sources, both of the PUBLIC downloads repo (burrow-releases, same
// vX.Y.Z tags as the private source repo, because an installed app cannot read a private repo anonymously):
// 'manifest' reads latest.json, the signed-update manifest (copies whose shell can install updates), and 'release'
// reads GitHub's public releases API (copies that cannot install by themselves). fetchInstallerChecksum() reads the
// pinned SHA256SUMS.txt for the manual download. Only the Burrow Dev check (no longer reachable from the routes)
// still lists the private repo through api.github.com.
// Gated by the `updates` network feature (server/netPolicy.js). Nothing about the user or their data is sent and
// this module downloads nothing: the result is a status, two version strings, a releases-page link and, for
// stable, the sanitized plain-text "what's new" notes from latest.json (shown as text, never rendered as markup).
// Installing is a separate click (server/updateInstallRoutes.js) that the Burrow app itself carries out.
// Upstream failures resolve to { status: 'unavailable' } and never throw.
import fs from 'node:fs';
import fetch from 'node-fetch';
import { DEV_TAG_RE, DEV_VERSION_RE, STABLE_VERSION_RE, getChannel } from './channel.js';
import { assertNetworkEnabled } from './netPolicy.js';
import { recordNetworkCall, statusFromHttp } from './networkCall.js';
import { BUNDLED_APP_VERSION } from './runtime.js';

const UPDATE_API_ORIGIN = 'https://api.github.com';
const UPDATE_STABLE_ORIGIN = 'https://github.com';
/** Stable updates: the public downloads repo (publishPublic.js publishes every stable release there, tag vX.Y.Z). */
export const UPDATE_REPO = 'ChristianMunoz31/burrow-releases';
export const RELEASES_PAGE = `https://github.com/${UPDATE_REPO}/releases`;
/** The signed-update manifest of the newest stable release (GitHub redirects it to the release asset). */
export const LATEST_MANIFEST_URL = `https://github.com/${UPDATE_REPO}/releases/latest/download/latest.json`;
/** Hosts a manifest request may be redirected through. The same list is in the shell (redirect_allowed) and netPolicy. */
export const UPDATE_REDIRECT_HOSTS = Object.freeze([
  'github.com',
  'release-assets.githubusercontent.com',
  'objects.githubusercontent.com',
]);
/** GitHub's public API for the newest published, non-draft, non-pre-release release of the downloads repo. */
export const RELEASE_API_URL = `https://api.github.com/repos/${UPDATE_REPO}/releases/latest`;
export const SUMS_FILE = 'SHA256SUMS.txt';
/** The only checksum file URL a version may name. */
export const sumsUrl = (version) => `${RELEASES_PAGE}/download/v${version}/${SUMS_FILE}`;
const INSTALLER_NAMES = Object.freeze(['Burrow-Setup-x64.exe', 'Burrow-Setup-arm64.exe']);
/** The only installer URL a release may name for a version and architecture (the shell pins the same URL). */
export const installerUrl = (version, arch) => `${RELEASES_PAGE}/download/v${version}/Burrow-Setup-${arch}.exe`;
/** Burrow Dev updates: dev pre-releases are published to the private source repo (see dev-build.yml). */
export const DEV_UPDATE_REPO = 'ChristianMunoz31/burrow';
export const DEV_RELEASES_PAGE = `https://github.com/${DEV_UPDATE_REPO}/releases`;

const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_RELEASE_BYTES = 256 * 1024;
const MAX_SUMS_BYTES = 4096;
const MAX_REDIRECTS = 3;
const MAX_SIGNATURE_CHARS = 4096;
const MAX_NOTES_CHARS = 2000;
const PLATFORM_ARCH = Object.freeze({ 'windows-x86_64': 'x64', 'windows-aarch64': 'arm64' });
const MAX_LIST_BYTES = 1024 * 1024;
const DEV_LIST_SIZE = 20;
const OK_TTL_MS = 6 * 60 * 60 * 1000;
const UNAVAILABLE_TTL_MS = 15 * 60 * 1000;
const REFRESH_MIN_INTERVAL_MS = 60 * 1000;

const readAppVersion = () => {
  if (BUNDLED_APP_VERSION) return BUNDLED_APP_VERSION;
  try {
    const raw = fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8');
    const version = JSON.parse(raw).version;
    return typeof version === 'string' ? version : '0.0.0';
  } catch {
    return '0.0.0';
  }
};

export const APP_VERSION = readAppVersion();

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

const parseSemver = (value) => {
  if (typeof value !== 'string') return null;
  const m = SEMVER.exec(value.trim());
  if (!m) return null;
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? null };
};

const comparePre = (a, b) => {
  const pa = a.split('.');
  const pb = b.split('.');
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    if (pa[i] === undefined) return -1;
    if (pb[i] === undefined) return 1;
    const na = /^\d+$/.test(pa[i]);
    const nb = /^\d+$/.test(pb[i]);
    if (na && nb) {
      const d = Number(pa[i]) - Number(pb[i]);
      if (d !== 0) return d < 0 ? -1 : 1;
    } else if (na !== nb) {
      return na ? -1 : 1;
    } else if (pa[i] !== pb[i]) {
      return pa[i] < pb[i] ? -1 : 1;
    }
  }
  return 0;
};

/**
 * Compare two x.y.z[-pre] versions (leading "v" allowed).
 * @param {string} a
 * @param {string} b
 * @returns {-1|0|1|null} null when either side is not a valid version
 */
export function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i += 1) {
    if (pa.core[i] !== pb.core[i]) return pa.core[i] < pb.core[i] ? -1 : 1;
  }
  if (pa.pre === pb.pre) return 0;
  if (pa.pre === null) return 1;
  if (pb.pre === null) return -1;
  return comparePre(pa.pre, pb.pre);
}

const isAbortError = (err) => err?.name === 'TimeoutError' || err?.name === 'AbortError';

let cache = null; // { key, value, until }
let inflight = null; // { key, promise }
let lastFetchAt = 0;

/** Test hook: drop the cached result and any in-flight request. */
export function __resetUpdateCacheForTests() {
  cache = null;
  inflight = null;
  lastFetchAt = 0;
}

const unavailable = (current, reason, channel = 'stable') => ({
  status: 'unavailable',
  current,
  reason,
  channel,
  checkedAt: new Date().toISOString(),
});

async function readCappedText(response, limit) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > limit) return null;
  const text = await response.text();
  return typeof text === 'string' && text.length <= limit ? text : null;
}

async function readCappedJsonArray(response) {
  const text = await readCappedText(response, MAX_LIST_BYTES);
  if (text === null) return null;
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

const releaseUrl = (release, page = RELEASES_PAGE) => {
  const htmlUrl = typeof release.html_url === 'string' ? release.html_url : '';
  return htmlUrl.startsWith(`${page}/`) ? htmlUrl : page;
};

const releaseDate = (release) =>
  typeof release.published_at === 'string' && !Number.isNaN(Date.parse(release.published_at))
    ? release.published_at
    : null;

/**
 * One dev pre-release that is internally consistent: published pre-release, tag dev-<date>-<sha7>, title
 * "Burrow Dev <version>" and a version whose date and sha equal the tag's. Anything else is ignored.
 * @returns {{ version: string, core: string, dateStamp: string, sha: string, publishedMs: number, release: object } | null}
 */
function parseDevRelease(release) {
  if (release === null || typeof release !== 'object') return null;
  if (release.draft === true || release.prerelease !== true) return null;
  const tag = DEV_TAG_RE.exec(typeof release.tag_name === 'string' ? release.tag_name : '');
  const named = /^Burrow Dev (\S+)$/.exec(typeof release.name === 'string' ? release.name : '');
  if (!tag || !named) return null;
  const v = DEV_VERSION_RE.exec(named[1]);
  if (!v || v[4] !== tag[1] || v[5] !== tag[2]) return null;
  const published = releaseDate(release);
  return {
    version: named[1],
    core: `${v[1]}.${v[2]}.${v[3]}`,
    dateStamp: v[4],
    sha: v[5],
    publishedMs: published === null ? 0 : Date.parse(published),
    release,
  };
}

const isRedirect = (status) => [301, 302, 303, 307, 308].includes(status);

/**
 * True when an upstream failure must be audited as `error` (shown as "failed"): nothing came back (timeout, network)
 * or the last answer was a 3xx that Burrow refused or could not follow (reason bad_response). Other failures carry
 * their own 4xx or 5xx status, which statusFromHttp already maps to `error`.
 */
const auditFailed = (reason, httpStatus) =>
  reason === 'timeout' || reason === 'network' || (reason === 'bad_response' && httpStatus >= 300 && httpStatus < 400);

/**
 * Plain text only: CRLF to LF; C0 controls other than newline, DEL, C1 controls, zero-width and bidi marks, the word
 * joiner and the BOM removed; trimmed; null when empty or over the cap.
 */
const sanitizeNotes = (value) => {
  if (typeof value !== 'string') return null;
  const text = value
    .replace(/\r\n/g, '\n')
    // C0 controls except \n, DEL, C1 controls, zero-width and bidi marks (RLO and friends could make the notes read
    // differently from what they say), the Arabic letter mark, line and paragraph separators, interlinear
    // annotation marks, the word joiner and the BOM.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0009\u000B-\u001F\u007F-\u009F\u061C\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060-\u2069\uFEFF\uFFF9-\uFFFB]/g, '')
    .trim();
  return text !== '' && text.length <= MAX_NOTES_CHARS ? text : null;
};

/** The manifest, or null when it does not match the Tauri static schema Burrow publishes (see docs/RELEASING.md). */
function parseManifest(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (typeof raw.version !== 'string' || !STABLE_VERSION_RE.test(raw.version)) return null;
  if (typeof raw.pub_date !== 'string' || Number.isNaN(Date.parse(raw.pub_date))) return null;
  if (raw.notes !== undefined && raw.notes !== null && typeof raw.notes !== 'string') return null;
  const platforms = raw.platforms;
  if (platforms === null || typeof platforms !== 'object' || Array.isArray(platforms)) return null;
  for (const [key, arch] of Object.entries(PLATFORM_ARCH)) {
    const entry = platforms[key];
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return null;
    if (typeof entry.signature !== 'string' || entry.signature === '' || entry.signature.length > MAX_SIGNATURE_CHARS) return null;
    if (entry.url !== installerUrl(raw.version, arch)) return null;
  }
  return { version: raw.version, pubDate: raw.pub_date, notes: sanitizeNotes(raw.notes) };
}

/**
 * GET a pinned https URL as text. Follows at most 3 redirects itself, each over https to an allowed GitHub host
 * (no userinfo, default port); anything else is a bad response. Never throws.
 * @param {string} startUrl
 * @param {{ fetchImpl?: typeof fetch, timeoutMs?: number, maxBytes: number, accept: string }} options
 * @returns {Promise<{ ok: true, text: string }
 *   | { ok: false, reason: 'timeout' | 'network' | 'not_found' | 'rate_limited' | 'bad_response' }>}
 */
export async function fetchPinnedText(startUrl, { fetchImpl = fetch, timeoutMs = 5000, maxBytes, accept }) {
  const signal = AbortSignal.timeout(timeoutMs);
  let url = startUrl;
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const response = await fetchImpl(url, {
        headers: { Accept: accept, 'User-Agent': 'Burrow' },
        redirect: 'manual',
        size: maxBytes,
        signal,
      });
      if (isRedirect(response.status)) {
        let next;
        try {
          const location = response.headers?.get?.('location');
          if (typeof location !== 'string' || location === '') return { ok: false, reason: 'bad_response' };
          next = new URL(location, url);
        } catch {
          return { ok: false, reason: 'bad_response' };
        }
        const allowed =
          next.protocol === 'https:' &&
          next.username === '' &&
          next.password === '' &&
          next.port === '' &&
          UPDATE_REDIRECT_HOSTS.includes(next.hostname);
        if (!allowed) return { ok: false, reason: 'bad_response' };
        url = next.href;
        continue;
      }
      if (response.status === 404) return { ok: false, reason: 'not_found' };
      if (response.status === 403 || response.status === 429) return { ok: false, reason: 'rate_limited' };
      if (!response.ok) return { ok: false, reason: 'bad_response' };
      const text = await readCappedText(response, maxBytes);
      return text === null ? { ok: false, reason: 'bad_response' } : { ok: true, text };
    }
    return { ok: false, reason: 'bad_response' };
  } catch (err) {
    return { ok: false, reason: isAbortError(err) ? 'timeout' : 'network' };
  }
}

/**
 * Fetch and validate latest.json. Never throws.
 * @param {{ fetchImpl?: typeof fetch, timeoutMs?: number }} [options]
 * @returns {Promise<{ ok: true, manifest: { version: string, pubDate: string, notes: string | null } }
 *   | { ok: false, reason: 'timeout' | 'network' | 'not_found' | 'rate_limited' | 'bad_response' }>}
 */
export async function fetchLatestManifest({ fetchImpl = fetch, timeoutMs = 5000 } = {}) {
  const fetched = await fetchPinnedText(LATEST_MANIFEST_URL, {
    fetchImpl,
    timeoutMs,
    maxBytes: MAX_MANIFEST_BYTES,
    accept: 'application/json',
  });
  if (!fetched.ok) return fetched;
  let parsed;
  try {
    parsed = JSON.parse(fetched.text);
  } catch {
    return { ok: false, reason: 'bad_response' };
  }
  const manifest = parseManifest(parsed);
  return manifest ? { ok: true, manifest } : { ok: false, reason: 'bad_response' };
}

/**
 * The "What's new" section of a release body as plain text, or null. Links and markup are flattened, URLs removed.
 * @param {unknown} body
 * @returns {string | null}
 */
export function releaseNotesText(body) {
  if (typeof body !== 'string') return null;
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  const from = lines.findIndex((line) => /^##\s+What['\u2019]s new\s*$/i.test(line.trim()));
  if (from === -1) return null;
  const out = [];
  for (const raw of lines.slice(from + 1)) {
    if (/^#{1,2}\s/.test(raw)) break;
    const line = raw
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1')
      .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '')
      .replace(/\bwww\.\S+/gi, '')
      .replace(/\*\*|__|`/g, '')
      .trim()
      .replace(/^###\s+(.*)$/, '$1:')
      .replace(/^[*+-]\s+/, '- ')
      .trimEnd();
    // A reference-style link definition (`[1]: https://...`) is empty once its URL is gone.
    if (line.trim() !== '' && !/^\[[^\]]*\]:$/.test(line.trim())) out.push(line);
  }
  let total = 0;
  const kept = [];
  for (const line of out) {
    total += line.length + (kept.length > 0 ? 1 : 0);
    if (total > MAX_NOTES_CHARS) break;
    kept.push(line);
  }
  return sanitizeNotes(kept.join('\n'));
}

/**
 * A usable GitHub release: published, stable tag vX.Y.Z, a valid date and both installers plus SHA256SUMS.txt among
 * its assets. Asset URLs in the response are ignored: the pinned URLs are built from the version.
 * @param {unknown} raw
 * @returns {{ version: string, pubDate: string, notes: string | null } | null}
 */
export function parseLatestRelease(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (raw.draft === true || raw.prerelease === true) return null;
  const tag = typeof raw.tag_name === 'string' ? raw.tag_name : '';
  if (!tag.startsWith('v') || !STABLE_VERSION_RE.test(tag.slice(1))) return null;
  if (typeof raw.published_at !== 'string' || Number.isNaN(Date.parse(raw.published_at))) return null;
  if (!Array.isArray(raw.assets)) return null;
  const names = new Set(raw.assets.map((a) => (a !== null && typeof a === 'object' ? a.name : null)));
  if (![...INSTALLER_NAMES, SUMS_FILE].every((name) => names.has(name))) return null;
  return { version: tag.slice(1), pubDate: raw.published_at, notes: releaseNotesText(raw.body) };
}

/**
 * Parse SHA256SUMS.txt. Exactly one line must name `fileName`.
 * @param {string} text
 * @param {string} fileName
 * @returns {string | null} lowercase hex sha-256
 */
export function parseSums(text, fileName) {
  if (typeof text !== 'string') return null;
  const hits = [];
  for (const raw of text.split('\n')) {
    const m = /^([0-9a-fA-F]{64}) [ *](.+)$/.exec(raw.replace(/\r$/, ''));
    if (m && m[2] === fileName) hits.push(m[1].toLowerCase());
  }
  return hits.length === 1 ? hits[0] : null;
}

/**
 * The expected SHA-256 of a release installer, from the pinned SHA256SUMS.txt (manual download). One audit row.
 * Throws NetworkOptInError while `updates` is off; every other failure is { ok: false, reason }.
 * @param {{ version: string, arch: string, fetchImpl?: typeof fetch, timeoutMs?: number }} options
 * @returns {Promise<{ ok: true, sha256: string } | { ok: false, reason: string }>}
 */
export async function fetchInstallerChecksum({ version, arch, fetchImpl = fetch, timeoutMs = 5000 }) {
  await assertNetworkEnabled('updates');
  if (typeof version !== 'string' || !STABLE_VERSION_RE.test(version) || (arch !== 'x64' && arch !== 'arm64')) {
    return { ok: false, reason: 'bad_request' };
  }
  let httpStatus = null;
  const trackedFetch = async (...args) => {
    const response = await fetchImpl(...args);
    httpStatus = response?.status;
    return response;
  };
  const fetched = await fetchPinnedText(sumsUrl(version), {
    fetchImpl: trackedFetch,
    timeoutMs,
    maxBytes: MAX_SUMS_BYTES,
    accept: 'text/plain',
  });
  const failed = !fetched.ok && auditFailed(fetched.reason, httpStatus);
  await recordNetworkCall('updates', UPDATE_STABLE_ORIGIN, failed ? 'error' : statusFromHttp(httpStatus));
  if (!fetched.ok) return { ok: false, reason: fetched.reason };
  const sha256 = parseSums(fetched.text, `Burrow-Setup-${arch}.exe`);
  return sha256 ? { ok: true, sha256 } : { ok: false, reason: 'bad_response' };
}

async function queryStable({ fetchImpl, currentVersion, timeoutMs }) {
  const fetched = await fetchLatestManifest({ fetchImpl, timeoutMs });
  if (!fetched.ok) return unavailable(currentVersion, fetched.reason);
  const { version: latest, pubDate, notes } = fetched.manifest;
  const order = compareSemver(latest, currentVersion);
  if (order === null) return unavailable(currentVersion, 'bad_response');

  return stableResult({ currentVersion, latest, pubDate, notes, order, source: 'manifest' });
}

function stableResult({ currentVersion, latest, pubDate, notes, order, source }) {
  const checkedAt = new Date().toISOString();
  if (order <= 0) return { status: 'current', current: currentVersion, latest, channel: 'stable', source, checkedAt };
  return {
    status: 'available',
    current: currentVersion,
    latest,
    url: `${RELEASES_PAGE}/tag/v${latest}`,
    publishedAt: pubDate,
    channel: 'stable',
    source,
    checkedAt,
    notes,
  };
}

/** The 'release' source: GitHub's public releases API (one request, no redirects). */
async function queryStableRelease({ fetchImpl, currentVersion, timeoutMs }) {
  let response;
  try {
    response = await fetchImpl(RELEASE_API_URL, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Burrow' },
      redirect: 'manual',
      size: MAX_RELEASE_BYTES,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    return unavailable(currentVersion, isAbortError(err) ? 'timeout' : 'network');
  }
  if (response.status === 404) return unavailable(currentVersion, 'not_found');
  if (response.status === 403 || response.status === 429) return unavailable(currentVersion, 'rate_limited');
  if (isRedirect(response.status) || !response.ok) return unavailable(currentVersion, 'bad_response');
  let release;
  try {
    const text = await readCappedText(response, MAX_RELEASE_BYTES);
    release = text === null ? null : parseLatestRelease(JSON.parse(text));
  } catch (err) {
    return unavailable(currentVersion, isAbortError(err) ? 'timeout' : 'bad_response');
  }
  if (!release) return unavailable(currentVersion, 'bad_response');
  const order = compareSemver(release.version, currentVersion);
  if (order === null) return unavailable(currentVersion, 'bad_response');
  return stableResult({
    currentVersion,
    latest: release.version,
    pubDate: release.pubDate,
    notes: release.notes,
    order,
    source: 'release',
  });
}

/** Newest first: published_at, then the date in the version. */
const newerFirst = (a, b) => {
  if (a.publishedMs !== b.publishedMs) return b.publishedMs - a.publishedMs;
  if (a.dateStamp === b.dateStamp) return 0;
  return a.dateStamp < b.dateStamp ? 1 : -1;
};

async function queryDev({ fetchImpl, currentVersion, timeoutMs }) {
  const fail = (reason) => unavailable(currentVersion, reason, 'dev');
  let response;
  try {
    response = await fetchImpl(`https://api.github.com/repos/${DEV_UPDATE_REPO}/releases?per_page=${DEV_LIST_SIZE}`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Burrow' },
      redirect: 'manual',
      size: MAX_LIST_BYTES,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    return fail(isAbortError(err) ? 'timeout' : 'network');
  }

  if (response.status === 404) return fail('not_found');
  if (response.status === 403 || response.status === 429) return fail('rate_limited');
  if (!response.ok) return fail('bad_response');

  let list;
  try {
    list = await readCappedJsonArray(response);
  } catch (err) {
    return fail(isAbortError(err) ? 'timeout' : 'bad_response');
  }
  if (!list) return fail('bad_response');

  const kept = list.map(parseDevRelease).filter(Boolean).sort(newerFirst);
  if (kept.length === 0) return fail('not_found');
  const newest = kept[0];

  const checkedAt = new Date().toISOString();
  const current = DEV_VERSION_RE.exec(currentVersion);
  let available = true;
  if (current) {
    if (current[5] === newest.sha) {
      available = false;
    } else {
      const order = compareSemver(newest.core, `${current[1]}.${current[2]}.${current[3]}`);
      if (order === -1 || (order === 0 && newest.dateStamp < current[4])) available = false;
    }
  }
  if (!available) {
    return { status: 'current', current: currentVersion, latest: newest.version, channel: 'dev', checkedAt };
  }
  return {
    status: 'available',
    current: currentVersion,
    latest: newest.version,
    url: releaseUrl(newest.release, DEV_RELEASES_PAGE),
    publishedAt: releaseDate(newest.release),
    channel: 'dev',
    checkedAt,
    notes: null,
  };
}

const query = (args) => {
  if (args.channel === 'dev') return queryDev(args);
  return args.source === 'release' ? queryStableRelease(args) : queryStable(args);
};

/**
 * Check GitHub for a newer release. Throws NetworkOptInError while the `updates` feature is off;
 * every upstream failure resolves to { status: 'unavailable', reason }. Concurrent calls share one
 * request, and `refresh` is ignored when the last upstream fetch was under 60 s ago.
 * @param {{ fetchImpl?: typeof fetch, currentVersion?: string, timeoutMs?: number, refresh?: boolean,
 *   channel?: 'stable' | 'dev', source?: 'manifest' | 'release' }} [options] `channel` picks the update source:
 *   stable reads latest.json (`source: 'manifest'`, default) or GitHub's releases API (`'release'`), dev lists recent
 *   releases and keeps only Burrow Dev pre-releases
 * @returns {Promise<object>} UpdateStatus
 */
export async function checkForUpdate({
  fetchImpl = fetch,
  currentVersion = APP_VERSION,
  timeoutMs = 5000,
  refresh = false,
  channel = getChannel(),
  source = 'manifest',
} = {}) {
  await assertNetworkEnabled('updates');
  const key = `${channel}:${source}:${currentVersion}`;
  const now = Date.now();
  const cached = cache && now < cache.until && cache.key === key ? cache.value : null;
  const refreshAllowed = refresh && now - lastFetchAt >= REFRESH_MIN_INTERVAL_MS;
  if (cached && !refreshAllowed) return cached;
  if (inflight && inflight.key === key) return inflight.promise;

  lastFetchAt = now;
  // Result rule (server/networkCall.js): ok only when GitHub answered 2xx or 3xx and nothing timed out.
  let httpStatus = null;
  const trackedFetch = async (...args) => {
    const response = await fetchImpl(...args);
    httpStatus = response?.status;
    return response;
  };
  const promise = query({ fetchImpl: trackedFetch, currentVersion, timeoutMs, channel, source })
    .then(async (value) => {
      const failed = value.status === 'unavailable' && auditFailed(value.reason, httpStatus);
      await recordNetworkCall('updates', channel === 'dev' || source === 'release' ? UPDATE_API_ORIGIN : UPDATE_STABLE_ORIGIN, failed ? 'error' : statusFromHttp(httpStatus));
      cache = {
        key,
        value,
        until: Date.now() + (value.status === 'unavailable' ? UNAVAILABLE_TTL_MS : OK_TTL_MS),
      };
      return value;
    })
    .finally(() => {
      if (inflight?.promise === promise) inflight = null;
    });
  inflight = { key, promise };
  return promise;
}
