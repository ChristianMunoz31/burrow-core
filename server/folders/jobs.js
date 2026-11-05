// The Folders job runner. One job runs at a time across all folders (FIFO queue, at most 20 waiting, at most one
// queued or running job per folder). A scan lists the files (read-only, incremental), writes summaries, and for
// Pro builds the local question index; a report job writes the cross-file report.
//
// Safety rules this file keeps:
//  - Reset safe: every DB write batch and every phase boundary calls checkpoint(), which stops the job when it was
//    cancelled or the data was erased or restored (dataGen.isStale()). Writes are short synchronous transactions,
//    never held across an await, so one can never interleave with the erase transaction.
//  - Read only: files are opened through readTextFile (read flag only); nothing under a folder root is written.
//    PDF and DOCX are parsed in a worker thread that the job's abort signal terminates.
//  - Cloud: chat calls carry the `folders` scope. Embeddings never go to a cloud provider. Scheduled scans never
//    use the cloud provider at all.
//  - Audit rows hold names and counts only, never file text, questions or paths.
import { randomUUID } from 'node:crypto';
import {
  AiBusyError,
  AiUnavailableError,
  CloudScopeError,
  aiAuditMeta,
  classifyAiError,
  getAiClient,
  withheldMessage,
} from '../ai/index.js';
import { recordAudit } from '../auditHook.js';
import { captureDataGeneration, onDataReset } from '../dataGeneration.js';
import { isDbError, yieldToLoop, withTransaction } from '../db/index.js';
import { ProRequiredError, assertPro, proAccess } from '../pro.js';
import { EXT_KINDS, FOLDER_MESSAGES, FolderError, LIMITS, isDocumentExt } from './constants.js';
import { docParsingEnabled } from './docGate.js';
import { createDocTextCache, readTextFile } from './extract.js';
import { clearPreviewFolder } from './previewCache.js';
import { TRANSIENT_DOC_CODES } from './parseDocs.js';
import { validateFolderRoot } from './pathSafety.js';
import { absInRoot } from './relPath.js';
import { buildFileFacts, buildFolderFacts, computeFolderStats, summaryInputHash } from './stats.js';
import {
  allFileRows,
  deleteFileChunks,
  deleteUnseenFiles,
  getFolder,
  updateFile,
  updateFolder,
  upsertFileRows,
} from './store.js';
import { summarizeFile, summarizeFolder } from './summarize.js';
import { stringifyJobError } from './views.js';
import { newWalkMeta, walkFolder } from './walk.js';

const nowIso = () => new Date().toISOString();
const BATCH = 100;

let L = { ...LIMITS };

/**
 * Test seam: override limits (for example a tiny maxFiles). Pass null to restore the real ones.
 * @param {Partial<typeof LIMITS> | null} partial
 */
export function __setFolderLimitsForTests(partial) {
  if (!process.env.VITEST) throw new Error('__setFolderLimitsForTests is a test seam');
  L = { ...LIMITS, ...(partial ?? {}) };
}

// ---------------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------------

/** @type {Map<string, object>} latest job per folder id */
const jobsByFolder = new Map();
/** @type {object[]} */
const queue = [];
/** @type {object | null} */
let running = null;

/** Thrown inside a job to stop it: kind is 'cancelled', 'data_reset' or 'shutdown'. */
class Stop extends Error {
  constructor(kind) {
    super(kind);
    this.name = 'FolderJobStop';
    this.kind = kind;
  }
}

const zeroProgress = () => ({ filesSeen: 0, filesRead: 0, bytesRead: 0, summariesTotal: 0, summariesDone: 0, chunksTotal: 0, chunksDone: 0, currentFileId: null });

function makeJob({ folderId, kind, trigger, client }) {
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });
  return {
    id: randomUUID(),
    folderId,
    kind,
    trigger,
    status: 'queued',
    phase: 'queued',
    progress: zeroProgress(),
    startedAt: null,
    finishedAt: null,
    error: null,
    notices: [],
    controller: new AbortController(),
    abortReason: null,
    dataGen: null,
    client: client ?? null,
    done,
    resolveDone,
  };
}

/**
 * @param {object} job
 * @returns {object} JobView
 */
export function toJobView(job) {
  return {
    id: job.id,
    folderId: job.folderId,
    kind: job.kind,
    trigger: job.trigger,
    status: job.status,
    phase: job.phase,
    queuePosition: job.status === 'queued' ? queue.indexOf(job) + 1 : null,
    progress: { ...job.progress },
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    error: job.error ? { ...job.error } : null,
    notices: job.notices.map((n) => ({ ...n })),
  };
}

const addNotice = (job, code, message) => {
  if (!job.notices.some((n) => n.code === code && n.message === message)) job.notices.push({ code, message });
};

const setPhase = (job, phase) => {
  job.phase = phase;
};

/** Stop the job when it was cancelled or the data was reset or is being restored. */
function checkpoint(job) {
  if (job.controller.signal.aborted) throw new Stop(job.abortReason ?? 'cancelled');
  if (job.dataGen?.isStale()) throw new Stop('data_reset');
}

/** Turn whatever stopped a job into a Stop, or null when it is a real failure. */
function asStop(job, err) {
  if (err instanceof Stop) return err;
  if (job.controller.signal.aborted) return new Stop(job.abortReason ?? 'cancelled');
  if (isDbError(err) && (err.code === 'db_restoring' || err.code === 'db_unavailable')) return new Stop('data_reset');
  if (job.dataGen?.isStale()) return new Stop('data_reset');
  return null;
}

/** Errors a phase must not swallow: a stop, an abort, a database error or a Folders error. */
function isControl(job, err) {
  return err instanceof Stop || err instanceof FolderError || isDbError(err) || job.controller.signal.aborted;
}

function persistLastJob(job) {
  // After a reset or restore nothing may be written; the folder row may not even exist any more.
  if (job.dataGen?.isStale()) return;
  try {
    updateFolder(job.folderId, {
      last_job_status: job.status,
      last_job_error: stringifyJobError(job.error),
      last_job_at: job.finishedAt,
    });
  } catch {
    /* the folder was removed or the database is going away: nothing to record */
  }
}

function conclude(job, status, error = null) {
  job.status = status;
  if (status === 'done') job.phase = 'done';
  job.error = error;
  job.finishedAt = nowIso();
  job.client = null; // a finished job keeps no AI client alive
  persistLastJob(job);
  job.resolveDone();
}

const stopError = (kind) => ({ code: kind, message: FOLDER_MESSAGES[kind] });

// ---------------------------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------------------------

/**
 * Queue a job for a folder.
 * @param {{ folderId: string, kind: 'scan'|'report', trigger: 'user'|'scheduled', client?: object }} args
 * @returns {object} JobView
 * @throws {FolderError} folder_not_found, folder_job_running, folder_queue_full
 */
export function enqueueFolderJob({ folderId, kind, trigger, client }) {
  const row = getFolder(folderId);
  if (!row) throw new FolderError('folder_not_found');
  // A folder that arrived from an import is never read until the user confirms where it is on this computer.
  if (row.confirm_state !== 'ok') throw new FolderError('folder_needs_confirm');
  const latest = jobsByFolder.get(folderId);
  if (latest && (latest.status === 'queued' || latest.status === 'running')) throw new FolderError('folder_job_running');
  if (queue.length >= L.maxQueued) throw new FolderError('folder_queue_full');
  const job = makeJob({ folderId, kind, trigger, client });
  jobsByFolder.set(folderId, job);
  queue.push(job);
  pump(); // an idle runner starts the job now, so the view below already says running
  return toJobView(job);
}

/** @param {string} folderId @returns {object | null} JobView of the latest job in memory */
export function getFolderJob(folderId) {
  const job = jobsByFolder.get(folderId);
  return job ? toJobView(job) : null;
}

/**
 * Cancel the queued or running job of a folder.
 * @param {string} folderId
 * @returns {object} JobView
 * @throws {FolderError} folder_no_job
 */
export function cancelFolderJob(folderId) {
  const job = jobsByFolder.get(folderId);
  if (!job || (job.status !== 'queued' && job.status !== 'running')) throw new FolderError('folder_no_job');
  if (job.status === 'queued') {
    const i = queue.indexOf(job);
    if (i !== -1) queue.splice(i, 1);
    conclude(job, 'cancelled', stopError('cancelled'));
  } else {
    job.abortReason = 'cancelled';
    job.controller.abort();
  }
  return toJobView(job);
}

/**
 * Stop everything: queued jobs are dropped, the running job is aborted.
 * @param {'data_reset'|'shutdown'} reason
 */
export function cancelAllFolderJobs(reason) {
  const kind = reason === 'shutdown' ? 'shutdown' : 'data_reset';
  for (const job of queue.splice(0)) {
    job.status = 'interrupted';
    job.error = stopError(kind);
    job.finishedAt = nowIso();
    job.resolveDone();
  }
  if (running) {
    running.abortReason = kind;
    running.controller.abort();
  }
  if (kind === 'data_reset') {
    for (const [id, job] of jobsByFolder) if (job.status !== 'running') jobsByFolder.delete(id);
  }
}

/** Forget the in-memory jobs of a removed folder. @param {string} folderId */
export function forgetFolderJobs(folderId) {
  jobsByFolder.delete(folderId);
}

/**
 * Wait for the running job (and the queue) to settle, at most `timeoutMs`.
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<boolean>} true when nothing is left running
 */
export async function drainFolderJobs({ timeoutMs = 1000 } = {}) {
  if (!running) return true;
  const current = running;
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([current.done.then(() => true), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Wait until a job ends (or `timeoutMs` passes, or `signal` aborts) and return its current view.
 * @param {string} jobId
 * @param {{ signal?: AbortSignal, timeoutMs?: number }} [opts]
 * @returns {Promise<object | null>} JobView, or null when the job is no longer known
 */
export async function waitForFolderJob(jobId, { signal, timeoutMs } = {}) {
  const job = [...jobsByFolder.values()].find((j) => j.id === jobId);
  if (!job) return null;
  if (job.status !== 'queued' && job.status !== 'running') return toJobView(job);
  let timer;
  let onAbort;
  const gates = [job.done];
  if (timeoutMs > 0) {
    gates.push(
      new Promise((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
        timer.unref?.();
      }),
    );
  }
  if (signal) {
    gates.push(
      new Promise((resolve) => {
        if (signal.aborted) return resolve();
        onAbort = resolve;
        signal.addEventListener('abort', onAbort, { once: true });
        return undefined;
      }),
    );
  }
  try {
    await Promise.race(gates);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
  return toJobView(job);
}

onDataReset(() => cancelAllFolderJobs('data_reset'));

// ---------------------------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------------------------

function pump() {
  if (running || queue.length === 0) return;
  const job = queue.shift();
  running = job;
  job.status = 'running';
  job.phase = job.kind === 'report' ? 'reporting' : 'inventory';
  job.startedAt = nowIso();
  job.dataGen = captureDataGeneration();
  runJob(job)
    .catch(() => {})
    .finally(() => {
      running = null;
      pump();
    });
}

async function runJob(job) {
  try {
    checkpoint(job);
    if (job.kind === 'report') await runReport(job);
    else await runScan(job);
    conclude(job, 'done');
  } catch (err) {
    const stop = asStop(job, err);
    if (stop) {
      if (stop.kind === 'cancelled') conclude(job, 'cancelled', stopError('cancelled'));
      else conclude(job, 'interrupted', stopError(stop.kind));
    } else if (err instanceof FolderError) {
      conclude(job, 'failed', { code: err.code, message: err.message });
    } else if (err instanceof ProRequiredError) {
      conclude(job, 'failed', { code: 'pro_required', message: err.publicMessage });
    } else if (job.kind === 'report') {
      const c = classifyAiError(err);
      if (!(err instanceof AiUnavailableError || err instanceof AiBusyError || err instanceof CloudScopeError)) {
        console.error('Folder report failed:', err?.code || err?.name || 'unknown');
      }
      conclude(job, 'failed', { code: c.code, message: c.message });
    } else {
      console.error('Folder scan failed:', err?.code || err?.name || 'unknown');
      conclude(job, 'failed', { code: 'folder_job_failed', message: FOLDER_MESSAGES.folder_job_failed });
    }
  }
}

const extOf = (relPath) => {
  const base = relPath.slice(relPath.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 && dot < base.length - 1 ? base.slice(dot + 1).toLowerCase() : '';
};

/**
 * Read an inventory row again for the summary and index phases. The stored path is validated first (a bad one reads as
 * unreadable), and bytes that no longer hash to the inventory sha256 answer `changed` before any parse.
 */
function readRow(root, row, signal, docCache) {
  const abs = absInRoot(root.realPath, row.rel_path);
  if (!abs) return Promise.resolve({ status: 'unreadable' });
  const expectedSha256 = typeof row.sha256 === 'string' && row.sha256 !== '' ? row.sha256 : undefined;
  return readTextFile(abs, { rootKey: root.pathKey, maxBytes: byteCap(row.ext), signal, docCache, expectedSha256 });
}

// Documents whose last parse failed for a transient reason (timeout, out of memory, crashed or unavailable parser), by
// folder and path, with the size and mtime they had then and how many times in a row it failed. Such a document is tried
// again on the next scan while the count is under MAX_TRANSIENT_DOC_FAILURES, even though it has not changed; after that
// it stays unreadable until it changes, like a document with a content failure. Kept in memory per process (no schema
// change): after a restart an unchanged unreadable document is final until it changes.
export const MAX_TRANSIENT_DOC_FAILURES = 3;
const transientDocFailures = new Map();
const failureKey = (folderId, relPath) => `${folderId}:${relPath}`;
const retryableUnreadable = (folderId, relPath, size, mtime) => {
  const seen = transientDocFailures.get(failureKey(folderId, relPath));
  return Boolean(seen && seen.size === size && seen.mtime === mtime && seen.count < MAX_TRANSIENT_DOC_FAILURES);
};
function noteDocParse(folderId, relPath, size, mtime, res) {
  const key = failureKey(folderId, relPath);
  if (res.status !== 'unreadable' || !TRANSIENT_DOC_CODES.has(res.docFailure)) {
    transientDocFailures.delete(key);
    return;
  }
  const seen = transientDocFailures.get(key);
  const same = seen && seen.size === size && seen.mtime === mtime;
  transientDocFailures.set(key, { size, mtime, count: same ? seen.count + 1 : 1 });
}
onDataReset(() => transientDocFailures.clear());
/** Test seam: forget the transient failure counters. */
export function __resetDocFailureCountersForTests() {
  if (!process.env.VITEST) throw new Error('__resetDocFailureCountersForTests is a test seam');
  transientDocFailures.clear();
}

/** Largest file read for an extension: PDF and DOCX have their own, larger cap than plain text. */
const byteCap = (ext) => (isDocumentExt(ext) ? L.maxDocBytes : L.maxFileBytes);

const NO_SUMMARY = Object.freeze({ summary: null, summary_status: 'none', summary_hash: null, summary_model: null });
const NO_INDEX = Object.freeze({ index_hash: null, index_model: null, chunk_count: 0 });

// ---------------------------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------------------------

async function runScan(job) {
  const signal = job.controller.signal;
  const folder = getFolder(job.folderId);
  if (!folder) throw new FolderError('folder_not_found');
  if (folder.confirm_state !== 'ok') throw new FolderError('folder_needs_confirm');
  // The root is checked again at the start of every job: it may have been replaced by a link or moved.
  const root = await validateFolderRoot(folder.path, { existing: [] });
  if (!root.ok) throw new FolderError(root.code);
  if (root.pathKey !== folder.path_key) throw new FolderError('folder_moved');
  checkpoint(job);

  clearPreviewFolder(folder.id);
  const ctx = {
    job,
    signal,
    folderId: folder.id,
    root,
    meta: newWalkMeta(),
    limitsHit: new Set(),
    indexSkipped: null,
    chat: { client: null, ms: 0, summarized: 0, failed: false },
    embed: { client: null, ms: 0, chunks: 0, failed: false },
    unavailable: false,
    withheld: false,
    chatStopped: false,
    docCache: createDocTextCache(),
  };
  try {
    await inventory(ctx);
    await summarizeFilesPhase(ctx);
    await summarizeFolderPhase(ctx);
    await indexPhase(ctx);
    checkpoint(job);
    const rows = allFileRows(folder.id);
    updateFolder(folder.id, { stats: statsOf(ctx, rows) });
  } finally {
    ctx.docCache.clear();
    clearPreviewFolder(folder.id);
    await auditScan(ctx);
  }
}

function statsOf(ctx, rows) {
  return computeFolderStats(rows, {
    dirsScanned: ctx.meta.dirsScanned,
    dirsSkipped: ctx.meta.dirsSkipped,
    limitsHit: new Set([...ctx.meta.limitsHit, ...ctx.limitsHit]),
    indexSkipped: ctx.indexSkipped,
  });
}

async function inventory(ctx) {
  const { job, signal, root, folderId, meta, docCache } = ctx;
  setPhase(job, 'inventory');
  const prior = new Map(allFileRows(folderId).map((r) => [r.rel_path, r]));
  const seenAt = job.startedAt;
  let batch = [];
  let dropChunksFor = [];
  let listed = 0;
  let supportedBytes = 0;

  const flush = async () => {
    if (batch.length === 0) return;
    checkpoint(job);
    const rows = batch;
    const drops = dropChunksFor;
    batch = [];
    dropChunksFor = [];
    withTransaction(() => {
      for (const id of drops) deleteFileChunks(id);
      upsertFileRows(folderId, rows);
    });
    await yieldToLoop();
  };

  // With document parsing off (docGate.js, issue #67) a PDF or DOCX is listed as unsupported, as in the first Folders round.
  const docsOn = docParsingEnabled();
  for await (const item of walkFolder(root.realPath, { rootKey: root.pathKey, signal, maxDepth: L.maxDepth, maxEntries: L.maxEntries, meta })) {
    checkpoint(job);
    if (item.type === 'skipDir') continue;
    if (listed >= L.maxFiles) {
      meta.limitsHit.add('max_files');
      break;
    }
    listed += 1;
    job.progress.filesSeen = listed;

    const before = prior.get(item.relPath) ?? null;
    const ext = extOf(item.relPath);
    const supported = Object.hasOwn(EXT_KINDS, ext) && (docsOn || !isDocumentExt(ext));
    const kind = supported ? EXT_KINDS[ext] : 'other';
    const size = item.lstat.size;
    const mtime = new Date(item.lstat.mtimeMs).toISOString();
    const row = { rel_path: item.relPath, ext, kind, seen_at: seenAt, size_bytes: size, mtime };
    // A row that stops being readable text loses its summary and index.
    const dropped = () => {
      if (before?.chunk_count > 0) dropChunksFor.push(before.id);
      return before && (before.summary !== null || before.summary_hash || before.index_hash || before.chunk_count > 0) ? { ...NO_SUMMARY, ...NO_INDEX } : {};
    };
    const plain = (status, extra = {}) => ({ ...row, status, sha256: null, line_count: null, word_count: null, char_count: null, ...dropped(), ...extra });

    let out;
    if (item.type === 'link') out = plain('link', { size_bytes: 0 });
    else if (item.outside) out = plain('outside_root', { size_bytes: 0 });
    else if (!supported) out = plain('unsupported');
    else if (size > byteCap(ext)) out = plain('too_large');
    else if (supportedBytes + size > L.maxTotalBytes) {
      meta.limitsHit.add('max_total_bytes');
      out = plain('skipped_limit');
    } else {
      supportedBytes += size;
      if (before && before.sha256 && before.size_bytes === size && before.mtime === mtime && (before.status === 'ok' || before.status === 'empty')) {
        // Unchanged since the last scan: no read at all.
        out = { ...row, status: before.status };
      } else if (isDocumentExt(ext) && before && before.status === 'unreadable' && before.size_bytes === size && before.mtime === mtime && !retryableUnreadable(folderId, item.relPath, size, mtime)) {
        // A PDF or DOCX that could not be read for a content reason (encrypted, corrupt, zip limits) stays unreadable until it
        // changes, so a broken one does not cost a parser run on every scan. A transient failure (timeout, out of memory,
        // crash) is retried on the next scan, at most MAX_TRANSIENT_DOC_FAILURES times in a row.
        out = { ...row, status: 'unreadable' };
      } else {
        // The walk's lstat identity is passed, so a file swapped for another since the walk is refused.
        const res = await readTextFile(item.absPath, { rootKey: root.pathKey, maxBytes: byteCap(ext), signal, docCache, expectedIdentity: { dev: item.lstat.dev, ino: item.lstat.ino } });
        job.progress.filesRead += 1;
        job.progress.bytesRead += res.sizeBytes || size;
        if (isDocumentExt(ext)) noteDocParse(folderId, item.relPath, size, mtime, res);
        if (res.status === 'ok') {
          const same = before && before.status === 'ok' && before.sha256 === res.sha256;
          let extra = {};
          if (before && !same) {
            if (before.chunk_count > 0) dropChunksFor.push(before.id);
            extra = { ...NO_INDEX, ...(before.summary ? { summary_status: 'stale' } : { summary_status: 'none', summary_hash: null }) };
          }
          out = { ...row, status: 'ok', size_bytes: res.sizeBytes, mtime: res.mtime ?? mtime, sha256: res.sha256, line_count: res.lines, word_count: res.words, char_count: res.chars, ...extra };
        } else {
          out = plain(res.status, {
            size_bytes: res.sizeBytes || size,
            mtime: res.mtime ?? mtime,
            sha256: res.sha256 ?? null,
            line_count: res.lines,
            word_count: res.words,
            char_count: res.chars,
          });
        }
      }
    }
    batch.push(out);
    if (batch.length >= BATCH) await flush();
  }
  await flush();

  checkpoint(job);
  deleteUnseenFiles(folderId, seenAt);
  const rows = allFileRows(folderId);
  updateFolder(folderId, { stats: statsOf(ctx, rows), last_scan_at: nowIso() });
}

// ---------------------------------------------------------------------------------------------
// Summaries
// ---------------------------------------------------------------------------------------------

function noteFolderStatus(ctx) {
  const rows = allFileRows(ctx.folderId);
  const folder = getFolder(ctx.folderId);
  if (!folder) return;
  const stats = statsOf(ctx, rows);
  const changed = folder.summary_input_hash !== summaryInputHash(rows, stats);
  if (folder.summary) updateFolder(ctx.folderId, { summary_status: changed ? 'stale' : folder.summary_status });
  else updateFolder(ctx.folderId, { summary_status: ctx.withheld ? 'withheld' : 'ai_unavailable' });
}

async function summarizeFilesPhase(ctx) {
  const { job, signal, root, folderId } = ctx;
  setPhase(job, 'summarizing_files');
  checkpoint(job);

  let client = null;
  try {
    client = await getAiClient({ purpose: 'chat', allowCloud: job.trigger !== 'scheduled', signal });
  } catch (err) {
    if (signal.aborted) throw err;
    const c = classifyAiError(err);
    addNotice(job, 'ai_unavailable', c.message);
    ctx.unavailable = true;
  }
  // The AI client can take a while to resolve: stop here when the job was cancelled or the data was reset, before any write.
  checkpoint(job);
  if (client && client.isCloud && !client.policy.allows('folders')) {
    client.noteWithheld(['folders']);
    ctx.chat.client = client;
    ctx.withheld = true;
    addNotice(job, 'withheld', withheldMessage(['folders']));
    for (const row of allFileRows(folderId)) {
      if (row.status === 'ok' && row.summary_status === 'none') updateFile(row.id, { summary_status: 'withheld' });
    }
    noteFolderStatus(ctx);
    return;
  }
  if (!client) {
    noteFolderStatus(ctx);
    return;
  }
  ctx.chat.client = client;
  const started = Date.now();
  try {
    const ok = allFileRows(folderId)
      .filter((r) => r.status === 'ok')
      .sort((a, b) => String(b.mtime ?? '').localeCompare(String(a.mtime ?? '')) || (a.rel_path < b.rel_path ? -1 : a.rel_path > b.rel_path ? 1 : 0));
    const eligible = ok.slice(0, L.summaryFiles);
    const cut = ok.slice(L.summaryFiles);
    if (cut.length > 0) {
      ctx.limitsHit.add('summary_limit');
      for (const row of cut) {
        if (row.summary_hash !== row.sha256 && row.summary_status !== 'not_included') updateFile(row.id, { summary_status: 'not_included' });
      }
    }
    const needs = eligible.filter((r) => r.summary_hash !== r.sha256);
    job.progress.summariesTotal = needs.length;
    let consecutive = 0;
    for (const row of needs) {
      checkpoint(job);
      job.progress.currentFileId = row.id;
      const res = await readRow(root, row, signal, ctx.docCache);
      if (res.status !== 'ok' || res.sha256 !== row.sha256) {
        // Changed or gone since the inventory: leave it for the next scan.
        if (row.summary) updateFile(row.id, { summary_status: 'stale' });
        job.progress.summariesDone += 1;
        continue;
      }
      try {
        const text = await summarizeFile({ client, text: res.text, relPath: row.rel_path, facts: buildFileFacts(row), signal });
        checkpoint(job);
        updateFile(row.id, { summary: text, summary_hash: row.sha256, summary_model: client.model, summary_status: 'ok' });
        ctx.chat.summarized += 1;
        consecutive = 0;
      } catch (err) {
        if (isControl(job, err)) throw err;
        ctx.chat.failed = true;
        const c = classifyAiError(err);
        if (err instanceof CloudScopeError || err instanceof AiUnavailableError || err instanceof AiBusyError) {
          addNotice(job, err instanceof AiUnavailableError ? 'ai_unavailable' : c.code, c.message);
          ctx.chatStopped = true;
          break;
        }
        updateFile(row.id, { summary_status: 'failed' });
        consecutive += 1;
        if (consecutive >= 3) {
          addNotice(job, c.code, c.message);
          ctx.chatStopped = true;
          break;
        }
      } finally {
        job.progress.summariesDone += 1;
      }
    }
  } finally {
    job.progress.currentFileId = null;
    ctx.chat.ms += Date.now() - started;
  }
}

async function summarizeFolderPhase(ctx) {
  const { job, signal, folderId } = ctx;
  const client = ctx.chat.client;
  if (!client || ctx.withheld) return;
  if (ctx.chatStopped) {
    noteFolderStatus(ctx);
    return;
  }
  setPhase(job, 'summarizing_folder');
  checkpoint(job);
  const rows = allFileRows(folderId);
  const stats = statsOf(ctx, rows);
  const folder = getFolder(folderId);
  if (!folder) return;
  if (stats.filesRead === 0) {
    updateFolder(folderId, { summary: null, summary_status: 'none', summary_input_hash: null, summary_model: null, summary_at: null });
    return;
  }
  const hash = summaryInputHash(rows, stats);
  if (folder.summary_input_hash === hash && folder.summary_status === 'ok') return;
  const notes = rows.filter((r) => r.status === 'ok' && r.summary_status === 'ok' && r.summary).map((r) => `- ${r.rel_path}: ${r.summary}`);
  const started = Date.now();
  try {
    const text = await summarizeFolder({ client, facts: buildFolderFacts(stats), notes, signal });
    checkpoint(job);
    updateFolder(folderId, { summary: text, summary_model: client.model, summary_at: nowIso(), summary_input_hash: hash, summary_status: 'ok' });
  } catch (err) {
    if (isControl(job, err)) throw err;
    ctx.chat.failed = true;
    const c = classifyAiError(err);
    addNotice(job, c.code, c.message);
    updateFolder(folderId, { summary_status: folder.summary ? 'stale' : 'failed' });
  } finally {
    ctx.chat.ms += Date.now() - started;
  }
}

// ---------------------------------------------------------------------------------------------
// Question index (Pro, local or LAN Ollama only)
// ---------------------------------------------------------------------------------------------

// Pro hooks (docs/adr/0001-open-core-split.md 3.7): the index phase body and the report body live in the Pro module and
// are registered through server/proExtensions.js (ctx.folders.setJobHooks). Core keeps the gates, the phase change,
// the checkpoint, the audit rows of a scan and the error classification.
const INDEX_SKIP_REASONS = new Set(['no_embed_model', 'ollama_unavailable', 'limit']);
let hooks = { index: null, report: null };

/**
 * Registers the Pro job hooks. Called only by server/proExtensions.js and tests.
 * @param {{ index?: ((api: object) => Promise<void>) | null, report?: ((api: object) => Promise<void>) | null }} [h]
 */
export function setFolderProHooks({ index = null, report = null } = {}) {
  if (index !== null && typeof index !== 'function') throw new Error('index hook must be a function');
  if (report !== null && typeof report !== 'function') throw new Error('report hook must be a function');
  hooks = { index, report };
}

/** Forgets the Pro job hooks. For tests and the install rollback. */
export function resetFolderProHooksForTests() {
  hooks = { index: null, report: null };
}

/** The IndexHook api (ADR 3.7). */
function indexApi(ctx) {
  const { job, signal, root, folderId } = ctx;
  return {
    folderId,
    signal,
    limits: L,
    progress: job.progress,
    embed: ctx.embed,
    checkpoint: () => checkpoint(job),
    readRow: (row) => readRow(root, row, signal, ctx.docCache),
    isControl: (err) => isControl(job, err),
    addNotice: (code, message) => addNotice(job, code, message),
    skip: (reason) => {
      if (!INDEX_SKIP_REASONS.has(reason)) throw new Error(`Unknown index skip reason: ${String(reason)}`);
      ctx.indexSkipped = reason;
    },
    limitHit: (code) => {
      ctx.limitsHit.add(code);
    },
  };
}

/** The ReportHook api (ADR 3.7). */
function reportApi(job) {
  return {
    folderId: job.folderId,
    client: job.client,
    signal: job.controller.signal,
    limits: L,
    auditAllowed: () => Boolean(job.dataGen) && !job.dataGen.isStale(),
    checkpoint: () => checkpoint(job),
    addNotice: (code, message) => addNotice(job, code, message),
  };
}

async function indexPhase(ctx) {
  const { job } = ctx;
  setPhase(job, 'indexing');
  checkpoint(job);
  if (!hooks.index || !proAccess('folder_qa').allowed) {
    ctx.indexSkipped = 'not_pro';
    return;
  }
  await hooks.index(indexApi(ctx));
}

// ---------------------------------------------------------------------------------------------
// Audit (names and counts only)
// ---------------------------------------------------------------------------------------------

async function auditScan(ctx) {
  const { job } = ctx;
  if (!job.dataGen || job.dataGen.isStale()) return;
  const { client } = ctx.chat;
  if (client && client.stats.calls > 0) {
    await recordAudit({
      kind: 'llm',
      feature: 'folder_summary',
      page: 'folders',
      provider: client.provider,
      model: client.model,
      status: ctx.chat.failed ? 'error' : 'ok',
      meta: { calls: client.stats.calls, ms: ctx.chat.ms, files: ctx.chat.summarized, ...aiAuditMeta(client) },
    });
  }
  const embed = ctx.embed.client;
  if (embed && embed.stats.calls > 0) {
    await recordAudit({
      kind: 'llm',
      feature: 'folder_index',
      page: 'folders',
      provider: 'ollama',
      model: embed.model,
      status: ctx.embed.failed ? 'error' : 'ok',
      meta: { calls: embed.stats.calls, ms: ctx.embed.ms, chunks: ctx.embed.chunks, ai_kind: embed.ai.kind, ...(embed.ai.kind === 'lan' && embed.ai.host ? { ai_host: embed.ai.host } : {}) },
    });
  }
}

// ---------------------------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------------------------

async function runReport(job) {
  setPhase(job, 'reporting');
  // Pro may have lapsed while the job waited in the queue.
  assertPro('folder_report');
  if (!hooks.report) throw new FolderError('folder_failed');
  await hooks.report(reportApi(job));
}
