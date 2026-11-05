// Native dialogs for the desktop app: the folder picker and the save dialog. The server never opens a window itself; it
// asks the Burrow shell with one authenticated stdout line (shellChannel.js `requestShellDialog`) and the shell answers
// with one authenticated stdin line (shellInbox.js -> handleDialogReplyPayload). This module owns all the state of those
// requests and knows nothing about folders beyond the callbacks it is given.
//
// Rules: one request at a time (`dialog_busy`); each request id is single use and expires `ttl` + a grace period after it
// was issued, on a monotonic clock; a reply is parsed strictly and its MAC checked in constant time before anything
// changes; the bytes of a save are served to the shell once, over loopback, only with a valid proof header, and are freed
// on fetch, cancel, expiry or reset. No path or file name is ever logged or audited here.
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { captureDataGeneration, onDataReset } from '../dataGeneration.js';
import { FOLDER_MESSAGES, FolderError } from '../folders/constants.js';
import { dialogCommitProofOk, dialogFetchProofOk, dialogReplyMacOk } from './auth.js';
import { DIALOG_MAX_SAVE_BYTES, requestShellDialog } from './shellChannel.js';

export const DIALOG_TTL_SECONDS = 900;
export const REPLY_GRACE_MS = 60_000;
export const KEEP_FINISHED_MS = 5 * 60_000;
export const MAX_SAVE_BYTES = DIALOG_MAX_SAVE_BYTES;
export const PROOF_HEADER = 'x-burrow-dialog-proof';

const ID_RE = /^[0-9a-f]{32}$/;
const MAC_RE = /^[0-9a-f]{64}$/;
const MAX_PATH_UNITS = 1024;
const REPLY_KEYS = ['id', 'mac', 'path', 'status', 'v'];
const REPLY_STATUSES = Object.freeze({
  pick_folder: ['picked', 'cancelled', 'unusable', 'busy', 'expired', 'failed'],
  save_file: ['saved', 'cancelled', 'exists', 'too_large', 'fetch_failed', 'write_failed', 'busy', 'expired'],
});
const WORKING = new Set(['waiting', 'checking']);

/** An error carrying one of the dialog codes (`dialog_busy`, `dialog_failed`, `save_too_large`). The message is fixed copy. */
export class DialogError extends Error {
  /** @param {'dialog_busy' | 'dialog_failed' | 'save_too_large'} code */
  constructor(code) {
    super(FOLDER_MESSAGES[code] ?? FOLDER_MESSAGES.dialog_failed);
    this.name = 'DialogError';
    this.code = Object.hasOwn(FOLDER_MESSAGES, code) ? code : 'dialog_failed';
  }
}

/**
 * @typedef {{ id: string, kind: 'pick_folder' | 'save_file', status: string, folderId: string | null,
 *   error: { code: string, message: string } | null }} DialogView
 */

/** @type {Map<string, object>} */
const records = new Map();
/** @type {string | null} id of the request that is waiting or being checked */
let activeId = null;
let clock = () => performance.now();
let writeRequest = (request) => requestShellDialog(request);

/**
 * Test seam: receives each request object instead of the stdout line (call `requestShellDialog(request, { out, desktop: true })`
 * to capture the real line). Pass null to restore the real writer.
 * @param {((request: object) => void) | null} fn
 */
export function __setDialogWriterForTests(fn) {
  if (!process.env.VITEST) throw new Error('__setDialogWriterForTests is a test seam');
  writeRequest = fn ?? ((request) => requestShellDialog(request));
}

/**
 * Test seam: the monotonic clock in ms. Pass null to restore the real one.
 * @param {(() => number) | null} fn
 */
export function __setDialogClockForTests(fn) {
  if (!process.env.VITEST) throw new Error('__setDialogClockForTests is a test seam');
  clock = fn ?? (() => performance.now());
}

/** Test seam: forget every request. */
export function __clearDialogsForTests() {
  if (!process.env.VITEST) throw new Error('__clearDialogsForTests is a test seam');
  records.clear();
  activeId = null;
}

const errorOf = (code) => ({ code, message: FOLDER_MESSAGES[code] ?? FOLDER_MESSAGES.folder_failed });

/** @returns {DialogView} */
const viewOf = (rec) => ({
  id: rec.id,
  kind: rec.kind,
  status: rec.status,
  folderId: rec.folderId,
  error: rec.error,
});

/** End a request: status, optional error, free the bytes and the active slot, report a save once. */
function finish(rec, status, errorCode = null, extra = {}) {
  if (!WORKING.has(rec.status)) return;
  rec.status = status;
  rec.error = errorCode ? errorOf(errorCode) : null;
  rec.finishedAt = clock();
  rec.bytes = null;
  rec.onPicked = null;
  Object.assign(rec, extra);
  if (activeId === rec.id) activeId = null;
  const onResult = rec.onResult;
  rec.onResult = null;
  if (onResult) {
    try {
      Promise.resolve(onResult(status, errorCode)).catch(() => {});
    } catch {
      // An audit callback must never break the dialog flow.
    }
  }
}

/** Lazy housekeeping: expire what ran out of time, forget what finished long ago. */
function sweep() {
  const now = clock();
  for (const rec of records.values()) {
    if (WORKING.has(rec.status)) {
      if (now >= rec.deadline) finish(rec, 'expired', 'dialog_expired');
    } else if (rec.finishedAt !== null && now - rec.finishedAt >= KEEP_FINISHED_MS) {
      records.delete(rec.id);
    }
  }
}

function openRequest(kind, extra) {
  sweep();
  if (activeId !== null) throw new DialogError('dialog_busy');
  const id = crypto.randomBytes(16).toString('hex');
  const rec = {
    id,
    kind,
    status: 'waiting',
    deadline: clock() + DIALOG_TTL_SECONDS * 1000 + REPLY_GRACE_MS,
    finishedAt: null,
    dataGen: captureDataGeneration(),
    bytes: null,
    fetched: false,
    commitGranted: false,
    onPicked: null,
    onResult: null,
    folderId: null,
    error: null,
    ...extra,
  };
  records.set(id, rec);
  activeId = id;
  return rec;
}

function abandon(rec) {
  records.delete(rec.id);
  if (activeId === rec.id) activeId = null;
}

/**
 * Ask the shell to open the folder picker. `onPicked(path)` runs once the shell reports a chosen folder; it should
 * validate and add it and resolve `{ folderId, job }`, or throw a FolderError for a refusal. It gets a second argument,
 * `{ dataGen, stillChecking }`, to ask right before it writes whether the data was erased or restored since the request
 * opened (`dataGen.isStale()`) and whether the request is still being checked and has not expired (`stillChecking()`);
 * if not it must throw FolderError `data_reset` / `dialog_expired` instead of writing.
 * @param {{ onPicked: (path: string, guard: { dataGen: { isStale: () => boolean }, stillChecking: () => boolean }) => Promise<{ folderId: string, job?: object | null }> }} opts
 * @returns {DialogView}
 */
export function createPickRequest({ onPicked }) {
  const rec = openRequest('pick_folder', { onPicked });
  try {
    writeRequest({ kind: 'pick_folder', id: rec.id, ttl: DIALOG_TTL_SECONDS, name: '', ext: '', bytes: 0 });
  } catch {
    abandon(rec);
    throw new DialogError('dialog_failed');
  }
  return viewOf(rec);
}

/**
 * Ask the shell to open the save dialog for `bytes`. The shell fetches the bytes once over loopback (serveDialogFile)
 * and writes the file the user chose; the server writes nothing to disk. `onResult(status, errorCode)` runs exactly once
 * when the request ends (saved, cancelled, failed, busy or expired), for the audit row.
 * @param {{ name: string, ext: 'md' | 'json' | 'csv', bytes: Buffer, onResult?: (status: string, errorCode: string | null) => unknown }} opts
 * @returns {DialogView}
 */
export function createSaveRequest({ name, ext, bytes, onResult }) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 1) throw new DialogError('dialog_failed');
  if (bytes.length > MAX_SAVE_BYTES) throw new DialogError('save_too_large');
  const rec = openRequest('save_file', { bytes, onResult: typeof onResult === 'function' ? onResult : null });
  try {
    writeRequest({ kind: 'save_file', id: rec.id, ttl: DIALOG_TTL_SECONDS, name, ext, bytes: bytes.length });
  } catch {
    rec.onResult = null;
    abandon(rec);
    throw new DialogError('dialog_failed');
  }
  return viewOf(rec);
}

/** @param {string} id @returns {DialogView | null} */
export function getDialog(id) {
  sweep();
  const rec = typeof id === 'string' ? records.get(id) : undefined;
  return rec ? viewOf(rec) : null;
}

/**
 * Stop waiting. A request that is still waiting ends as cancelled and its bytes are freed; the window the shell opened
 * stays until the user closes it, and a later reply is ignored. Any other request is returned unchanged.
 * @param {string} id
 * @returns {DialogView | null}
 */
export function cancelDialog(id) {
  sweep();
  const rec = typeof id === 'string' ? records.get(id) : undefined;
  if (!rec) return null;
  // Once the shell has been told it may write (commit check), the file is going to exist: the shell's reply decides.
  if (rec.status === 'waiting' && !rec.commitGranted) finish(rec, 'cancelled');
  return viewOf(rec);
}

/**
 * End every request that is waiting or being checked with `code` (a data erase or restore, or shutdown).
 * @param {'data_reset' | 'shutdown'} code
 */
export function resetDialogs(code) {
  for (const rec of records.values()) {
    if (WORKING.has(rec.status)) finish(rec, 'failed', code);
  }
}

onDataReset(() => resetDialogs('data_reset'));

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Strict parse of the reply payload (the text after the prefix). @returns {{ id: string, status: string, path: string, mac: string } | null} */
function parseReply(json) {
  if (typeof json !== 'string' || json.length > 16384) return null;
  let v;
  try {
    v = JSON.parse(json);
  } catch {
    return null;
  }
  if (!isPlain(v)) return null;
  const keys = Object.keys(v).sort();
  if (keys.length !== REPLY_KEYS.length || keys.some((k, i) => k !== REPLY_KEYS[i])) return null;
  const { id, status, path, mac } = v;
  if (v.v !== 1 || typeof id !== 'string' || !ID_RE.test(id) || typeof mac !== 'string' || !MAC_RE.test(mac)) return null;
  if (typeof status !== 'string' || typeof path !== 'string') return null;
  if (!path.isWellFormed() || path.length > MAX_PATH_UNITS) return null;
  if ((path !== '') !== (status === 'picked')) return null;
  return { id, status, path, mac };
}

const PICK_OUTCOMES = Object.freeze({
  unusable: ['refused', 'folder_path_invalid'],
  cancelled: ['cancelled', null],
  busy: ['busy', 'dialog_busy'],
  expired: ['expired', 'dialog_expired'],
  failed: ['failed', 'pick_failed'],
});

const SAVE_OUTCOMES = Object.freeze({
  saved: ['saved', null],
  cancelled: ['cancelled', null],
  exists: ['failed', 'save_exists'],
  too_large: ['failed', 'save_too_large'],
  fetch_failed: ['failed', 'save_failed'],
  write_failed: ['failed', 'save_failed'],
  busy: ['busy', 'dialog_busy'],
  expired: ['expired', 'dialog_expired'],
});

async function checkPickedPath(rec, path) {
  rec.status = 'checking';
  try {
    if (rec.dataGen.isStale()) return finish(rec, 'failed', 'data_reset');
    const stillChecking = () => {
      sweep();
      return rec.status === 'checking';
    };
    const result = await rec.onPicked(path, { dataGen: rec.dataGen, stillChecking });
    if (rec.status !== 'checking') return undefined;
    if (rec.dataGen.isStale()) return finish(rec, 'failed', 'data_reset');
    return finish(rec, 'added', null, { folderId: result?.folderId ?? null });
  } catch (err) {
    if (rec.status !== 'checking') return undefined;
    if (err instanceof FolderError && err.code === 'data_reset') return finish(rec, 'failed', 'data_reset');
    if (err instanceof FolderError && err.code === 'dialog_expired') return finish(rec, 'expired', 'dialog_expired');
    if (err instanceof FolderError) return finish(rec, 'refused', err.code);
    console.error('Folder dialog failed:', err?.code || err?.name || 'unknown');
    return finish(rec, 'failed', 'folder_failed');
  }
}

/**
 * Handle the text after `BURROW_DIALOG_REPLY ` from the shell. Anything that is not exactly a well-formed, authentic
 * reply to the request that is waiting is dropped silently (no log: it may carry a path).
 * @param {string} json
 */
export function handleDialogReplyPayload(json) {
  sweep();
  const reply = parseReply(json);
  if (!reply) return;
  const rec = records.get(reply.id);
  if (!rec || rec.status !== 'waiting') return;
  if (!REPLY_STATUSES[rec.kind].includes(reply.status)) return;
  if (!dialogReplyMacOk(reply)) return;
  if (rec.kind === 'pick_folder') {
    if (reply.status === 'picked') {
      void checkPickedPath(rec, reply.path);
      return;
    }
    const [status, code] = PICK_OUTCOMES[reply.status];
    finish(rec, status, code);
    return;
  }
  const [status, code] = SAVE_OUTCOMES[reply.status];
  finish(rec, status, code);
}

const notFound = (res) => {
  res.set('Cache-Control', 'no-store');
  return res.status(404).json({ error: 'not_found' });
};

/**
 * `GET /desktop/dialog-file/<id>` and `GET /desktop/dialog-file/<id>/ok` for the shell, both only with their own proof
 * header (the second under a different MAC prefix). The first serves the bytes of a save request once, only while it is
 * waiting and before it expires. The second is the shell's last check right before it writes the file the user chose:
 * `204` once, only while the request is still waiting (not cancelled, expired, reset or finished) and after the bytes
 * were fetched. Every other case, for both routes, is the same 404 (the proof is checked first, in constant time).
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
export function serveDialogFile(req, res) {
  sweep();
  const match = /^\/desktop\/dialog-file\/([0-9a-f]{32})(\/ok)?$/.exec(req.path);
  const id = match?.[1];
  const commit = match?.[2] === '/ok';
  const proof = req.get(PROOF_HEADER);
  if (!id || !(commit ? dialogCommitProofOk(id, proof) : dialogFetchProofOk(id, proof))) return notFound(res);
  const rec = records.get(id);
  if (!rec || rec.kind !== 'save_file' || rec.status !== 'waiting') return notFound(res);
  if (commit) {
    if (!rec.fetched || rec.commitGranted) return notFound(res);
    rec.commitGranted = true;
    res.set('Cache-Control', 'no-store');
    return res.status(204).end();
  }
  if (!rec.bytes) return notFound(res);
  const bytes = rec.bytes;
  rec.bytes = null;
  rec.fetched = true;
  res.set('Cache-Control', 'no-store');
  res.set('Content-Type', 'application/octet-stream');
  return res.status(200).send(bytes);
}
