// Ownership marker of the user profile data folder (Microsoft Store build, `userprofile` data location).
//
// %USERPROFILE%\Burrow Data is a folder in the user's own profile, not one that only Burrow can have created. Burrow
// therefore writes `.burrow-data.json` when it creates the folder and uses an existing folder only when it carries a valid
// marker (or is empty, which it adopts). Anything else is refused and left byte-for-byte unchanged: the guard never writes
// into a folder that is not ours. The Rust shell applies the same rule before it spawns the server (src-tauri/src/data_guard.rs),
// where it is the authoritative first gate; both fail closed on any reparse point (see `reparseProblem` for how this side can
// tell without a native addon, and its limits).
import fs from 'node:fs';
import path from 'node:path';

export const DATA_MARKER_FILE = '.burrow-data.json';
export const MARKER_FORMAT_VERSION = 1;
/** Server exit code for "the data folder exists and is not a Burrow data folder" (the shell shows a dialog for it). */
export const EXIT_DATA_DIR_NOT_OURS = 5;
const MAX_MARKER_BYTES = 4096;

/**
 * @typedef {'not_empty' | 'file' | 'link' | 'reparse' | 'bad_marker' | 'unreadable' | 'create_failed'} NotOursReason
 * `link`: a symbolic link or junction. `reparse`: any other Windows reparse point (a cloud-files placeholder, a
 * deduplicated or projected folder). `create_failed`: the folder was missing and Burrow could not create or mark it (not a
 * statement about whose folder it is).
 */

const REASON_TEXT = Object.freeze({
  not_empty: 'it already holds other files',
  file: 'it is a file, not a folder',
  link: 'it is a shortcut, symbolic link or junction',
  reparse: 'it is a cloud or other special folder (reparse point)',
  bad_marker: 'its Burrow marker file is not valid',
  unreadable: 'it could not be read',
});

/**
 * Plain-language message for a refused folder. The shell shows it (exit code 5) and copies it into the details.
 * @param {string} dir
 * @param {NotOursReason} reason
 * @returns {string}
 */
export function notOursMessage(dir, reason) {
  if (reason === 'create_failed') {
    return (
      `Burrow did not start because it could not create or mark its data folder ${dir}. ` +
      'Check that the folder above it exists and that you can write to it, then start Burrow again, or contact support.'
    );
  }
  return (
    `Burrow did not start because the folder ${dir} already exists and is not a Burrow data folder (${REASON_TEXT[reason] ?? REASON_TEXT.unreadable}). ` +
    'Burrow did not change anything in it. Rename or move that folder, then start Burrow again, or contact support.'
  );
}

/**
 * Error thrown when a folder is refused (or cannot be created). `code` is `data_dir_not_ours` for every reason, so the one
 * exit code (5) and the one dialog of the shell serve them all; `reason` tells them apart.
 */
export class DataDirNotOursError extends Error {
  /**
   * @param {string} dir
   * @param {NotOursReason} reason
   */
  constructor(dir, reason) {
    super(notOursMessage(dir, reason));
    this.name = 'DataDirNotOursError';
    this.code = 'data_dir_not_ours';
    this.dataDir = dir;
    this.reason = reason;
  }
}

/**
 * Body of the marker file.
 * @param {Date} [now]
 * @returns {string}
 */
export function markerContent(now = new Date()) {
  const marker = { app: 'Burrow', edition: 'store', dataLocation: 'userprofile', createdAt: now.toISOString(), formatVersion: MARKER_FORMAT_VERSION };
  return `${JSON.stringify(marker, null, 2)}\n`;
}

/**
 * True when `text` is a marker this Burrow wrote: a JSON object with app, edition and dataLocation exactly (case-sensitive),
 * a string createdAt and formatVersion written as the integer token `1` (`1.0` and `1e0` are refused, like the Rust shell).
 * Unknown extra fields are ignored; with a repeated key the last one counts (as in the Rust shell). The same rule is in
 * `src-tauri/src/data_guard.rs` and `scripts/store/sideload-test.ps1`; `fixtures/markers.json` pins all three.
 * @param {string} text
 * @returns {boolean}
 */
export function isValidMarker(text) {
  /** @type {{ holder: unknown, source: string | undefined }[]} */
  const versions = [];
  let value;
  try {
    value = JSON.parse(text, function reviver(key, parsed, context) {
      if (key === 'formatVersion') versions.push({ holder: this, source: context?.source });
      return parsed;
    });
  } catch {
    return false;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  // The raw token of the top-level formatVersion (a nested object may carry a key of the same name).
  const token = versions.find((v) => v.holder === value);
  return (
    value.app === 'Burrow' &&
    value.edition === 'store' &&
    value.dataLocation === 'userprofile' &&
    typeof value.createdAt === 'string' &&
    value.formatVersion === MARKER_FORMAT_VERSION &&
    token?.source === String(MARKER_FORMAT_VERSION)
  );
}

const strictUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/**
 * [`isValidMarker`] for the bytes of the file: a leading byte order mark and invalid UTF-8 are refused (the Rust shell reads
 * the file as strict UTF-8 too).
 * @param {Uint8Array} bytes
 * @returns {boolean}
 */
export function isValidMarkerBytes(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return false;
  let text;
  try {
    text = strictUtf8.decode(bytes);
  } catch {
    return false;
  }
  return isValidMarker(text);
}

/**
 * Reads the marker of `dir` without following a link: it must be a regular file of at most 4 KB.
 * @param {string} dir
 * @param {typeof fs} fsImpl
 * @returns {boolean}
 */
function markerIsValid(dir, fsImpl) {
  const file = path.join(dir, DATA_MARKER_FILE);
  try {
    const st = fsImpl.lstatSync(file);
    if (!st.isFile() || st.size > MAX_MARKER_BYTES) return false;
    return isValidMarkerBytes(fsImpl.readFileSync(file));
  } catch {
    return false;
  }
}

/**
 * Windows only: is `dir` a reparse point of a kind `lstat` does not call a link (OneDrive and other cloud-files placeholders,
 * deduplicated or projected folders)? The Rust shell reads FILE_ATTRIBUTE_REPARSE_POINT directly; Node has no API for the
 * attribute and this server may not use a native addon, so two indirect checks are used, both read-only:
 *  1. the entry of `dir` in a directory listing of its parent (libuv derives the `Dirent` type from the attribute of the
 *     enumeration, so any reparse point shows up as `isSymbolicLink()`), and
 *  2. the real path of `dir` must equal the real path of its parent plus its own name.
 * Limits: this relies on libuv's enumeration behaviour (verified by the tests for junctions and symbolic links; the cloud tags
 * follow the same attribute path but cannot be created in a test), it lists the parent folder once per process, and it does
 * not look at links ABOVE the parent (a profile folder that is itself a junction is normal). Anything that cannot be checked
 * counts as unreadable (fail closed). The Rust shell stays the authoritative first gate.
 * @param {string} dir
 * @param {typeof fs} fsImpl
 * @returns {'reparse' | 'unreadable' | null}
 */
function reparseProblem(dir, fsImpl) {
  const resolved = path.resolve(dir);
  const parent = path.dirname(resolved);
  const name = path.basename(resolved);
  if (parent === resolved || !name) return null;
  try {
    const entry = fsImpl.readdirSync(parent, { withFileTypes: true }).find((e) => e.name.toLowerCase() === name.toLowerCase());
    if (!entry) return 'unreadable';
    if (entry.isSymbolicLink()) return 'reparse';
    const real = fsImpl.realpathSync.native(resolved);
    const expected = path.join(fsImpl.realpathSync.native(parent), name);
    return real.toLowerCase() === expected.toLowerCase() ? null : 'reparse';
  } catch {
    return 'unreadable';
  }
}

/**
 * Looks at `dir` (lstat, so a link is never followed) and says what it is. Reads only; never creates or writes.
 * @param {string} dir
 * @param {{ fsImpl?: typeof fs, platform?: NodeJS.Platform }} [opts]
 * @returns {{ state: 'missing' | 'empty' | 'marked' } | { state: 'refused', reason: NotOursReason }}
 */
export function inspectDataFolder(dir, { fsImpl = fs, platform = process.platform } = {}) {
  let st;
  try {
    st = fsImpl.lstatSync(dir);
  } catch (err) {
    return err?.code === 'ENOENT' ? { state: 'missing' } : { state: 'refused', reason: 'unreadable' };
  }
  if (st.isSymbolicLink()) return { state: 'refused', reason: 'link' };
  if (!st.isDirectory()) return { state: 'refused', reason: 'file' };
  if (platform === 'win32') {
    const problem = reparseProblem(dir, fsImpl);
    if (problem) return { state: 'refused', reason: problem };
  }
  let entries;
  try {
    entries = fsImpl.readdirSync(dir, { withFileTypes: true });
  } catch {
    return { state: 'refused', reason: 'unreadable' };
  }
  if (entries.length === 0) return { state: 'empty' };
  const marker = entries.find((e) => e.name.toLowerCase() === DATA_MARKER_FILE);
  if (!marker) return { state: 'refused', reason: 'not_empty' };
  // On NTFS (and any case-insensitive folder) `.Burrow-Data.json` IS the marker file and is read through the canonical name,
  // which resolves to it. In a case-sensitive folder the canonical name is absent and the folder is refused as `bad_marker`.
  // A marker that is a folder or a reparse point (Dirent says link) is refused.
  if (!marker.isFile()) return { state: 'refused', reason: 'bad_marker' };
  return markerIsValid(dir, fsImpl) ? { state: 'marked' } : { state: 'refused', reason: 'bad_marker' };
}

/** @type {Set<string>} folders verified in this process (a folder is checked once, not on every path lookup) */
const verified = new Set();
const keyOf = (dir) => path.resolve(dir).toLowerCase();

/** Test seam: forget the folders verified so far. */
export function resetOwnershipCache() {
  verified.clear();
}

function writeMarker(dir, now, fsImpl) {
  fsImpl.writeFileSync(path.join(dir, DATA_MARKER_FILE), markerContent(now), { flag: 'wx', mode: 0o600 });
}

/**
 * The one decision: a folder that is missing is created with the marker, a marked one is used, an empty one is adopted
 * (marker written), everything else throws DataDirNotOursError without a single write.
 *
 * Creating is one atomic, non-recursive `mkdir`: the marker is written only into a folder this call just created, or into
 * one it saw empty (adopt). A missing parent, a denied write or a failed marker write throws `create_failed`; `EEXIST` means
 * somebody else created the folder first, so it is inspected again and treated as an existing folder. Adopting an empty folder
 * has an unavoidable window between "saw it empty" and the exclusive marker write (no lock can span both on a plain folder); a
 * file that appears inside it in that instant ends up next to the marker, and the next start sees a marked folder.
 * @param {string} dir
 * @param {{ fsImpl?: typeof fs, now?: Date, platform?: NodeJS.Platform }} [opts]
 * @returns {'created' | 'adopted' | 'marked'}
 * @throws {DataDirNotOursError}
 */
export function ensureOwnedDataFolder(dir, { fsImpl = fs, now = new Date(), platform = process.platform } = {}) {
  const key = keyOf(dir);
  if (verified.has(key)) return 'marked';
  let seen = inspectDataFolder(dir, { fsImpl, platform });
  let outcome = 'marked';
  if (seen.state === 'missing') {
    try {
      fsImpl.mkdirSync(dir, { mode: 0o700 });
      outcome = 'created';
    } catch (err) {
      if (err?.code !== 'EEXIST') throw new DataDirNotOursError(dir, 'create_failed');
      // Somebody created it between our look and our mkdir: judge what is there now, as for any existing folder.
      seen = inspectDataFolder(dir, { fsImpl, platform });
      if (seen.state === 'missing') throw new DataDirNotOursError(dir, 'create_failed');
    }
  }
  if (seen.state === 'refused') throw new DataDirNotOursError(dir, seen.reason);
  if (outcome === 'created' || seen.state === 'empty') {
    if (outcome !== 'created') outcome = 'adopted';
    try {
      writeMarker(dir, now, fsImpl);
    } catch (err) {
      if (err?.code !== 'EEXIST') throw new DataDirNotOursError(dir, 'create_failed');
      const again = inspectDataFolder(dir, { fsImpl, platform });
      if (again.state !== 'marked') throw new DataDirNotOursError(dir, again.state === 'refused' ? again.reason : 'bad_marker');
      outcome = 'marked';
    }
  }
  verified.add(key);
  return outcome;
}

/**
 * True when `dir` exists, is a real folder and carries a valid marker. Reads only. Used before writing into the folder from
 * outside the startup path (the import from the direct Burrow).
 * @param {string} dir
 * @param {{ fsImpl?: typeof fs }} [opts]
 * @returns {boolean}
 */
export function hasOwnershipMarker(dir, { fsImpl = fs } = {}) {
  return inspectDataFolder(dir, { fsImpl }).state === 'marked';
}
