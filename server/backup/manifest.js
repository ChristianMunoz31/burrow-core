// Backup metadata (burrow-<id>.meta.json, written last: a backup exists only if its meta exists) and
// the run state file (backups/state.json).
import path from 'node:path';
import { createFsOps, isMissing, readJsonOrNull, writeJsonAtomic } from './fsops.js';
import { ID_RE, backupsDir } from './paths.js';

export const META_FORMAT = 'burrow-backup';
export const META_FORMAT_VERSION = 1;
export const STATE_FILE = 'state.json';
export const STALE_AFTER_MS = 3 * 24 * 60 * 60 * 1000;

const META_RE = /^burrow-(.+)\.meta\.json$/;

export const metaPath = (id, dir = backupsDir()) => path.join(dir, `burrow-${id}.meta.json`);
export const statePath = (dir = backupsDir()) => path.join(dir, STATE_FILE);

/** @returns {object} */
export const defaultState = () => ({
  formatVersion: 1,
  lastRunAt: null,
  lastResult: null,
  lastError: null,
  lastFailureAt: null,
  lastSuccessAt: null,
  confirmedId: null,
  diskWarning: false,
  freeBytes: null,
  lastRestore: null,
  pendingRecoveryAudit: null,
});

const isIso = (v) => typeof v === 'string' && Number.isFinite(Date.parse(v));

function validMeta(meta, id) {
  return (
    meta !== null &&
    typeof meta === 'object' &&
    meta.format === META_FORMAT &&
    meta.id === id &&
    ID_RE.test(meta.id) &&
    (meta.status === 'verified' || meta.status === 'failed') &&
    isIso(meta.createdAt)
  );
}

/**
 * @param {string} id
 * @param {string} [dir]
 * @param {import('./fsops.js').FsOps} [fsOps]
 * @returns {Promise<object | null>} null when missing or unusable
 */
export async function readMeta(id, dir = backupsDir(), fsOps = createFsOps()) {
  if (!ID_RE.test(id)) return null;
  try {
    const st = await fsOps.lstat(metaPath(id, dir));
    if (st.isSymbolicLink() || !st.isFile()) return null;
  } catch {
    return null;
  }
  const meta = await readJsonOrNull(metaPath(id, dir), fsOps);
  return validMeta(meta, id) ? meta : null;
}

/**
 * @param {object} meta
 * @param {string} [dir]
 * @param {import('./fsops.js').FsOps} [fsOps]
 */
export async function writeMeta(meta, dir = backupsDir(), fsOps = createFsOps()) {
  await writeJsonAtomic(metaPath(meta.id, dir), meta, fsOps);
}

/**
 * All usable metas, newest first. Unparsable files and files with a bad id are ignored.
 * @param {string} [dir]
 * @param {import('./fsops.js').FsOps} [fsOps]
 * @returns {Promise<object[]>}
 */
export async function listMetas(dir = backupsDir(), fsOps = createFsOps()) {
  let names;
  try {
    names = await fsOps.readdir(dir);
  } catch (e) {
    if (isMissing(e)) return [];
    throw e;
  }
  const out = [];
  for (const name of names) {
    const m = META_RE.exec(name);
    if (!m || !ID_RE.test(m[1])) continue;
    const meta = await readMeta(m[1], dir, fsOps);
    if (meta) out.push(meta);
  }
  return out.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || (a.id < b.id ? 1 : -1));
}

/**
 * @param {string} [dir]
 * @param {import('./fsops.js').FsOps} [fsOps]
 */
export async function readState(dir = backupsDir(), fsOps = createFsOps()) {
  const raw = await readJsonOrNull(statePath(dir), fsOps);
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return defaultState();
  return { ...defaultState(), ...raw };
}

// Serialized so two overlapping patches (scheduler run and a settings save) never lose an update.
let writeChain = Promise.resolve();

/**
 * Merges a patch into state.json.
 * @param {object} patch
 * @param {{ dir?: string, fsOps?: import('./fsops.js').FsOps }} [opts]
 * @returns {Promise<object>} the new state
 */
export function writeState(patch, { dir = backupsDir(), fsOps = createFsOps() } = {}) {
  const run = async () => {
    const next = { ...(await readState(dir, fsOps)), ...patch };
    await writeJsonAtomic(statePath(dir), next, fsOps);
    return next;
  };
  const result = writeChain.then(run, run);
  writeChain = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/**
 * The shape the API returns for one backup.
 * @param {object} meta
 */
export function toSummary(meta) {
  const exportBytes = meta.export?.bytes ?? 0;
  return {
    id: meta.id,
    kind: meta.kind,
    createdAt: meta.createdAt,
    status: meta.status,
    error: meta.error ?? null,
    sizeBytes: (meta.db?.bytes ?? 0) + exportBytes,
    exportStatus: meta.export?.status ?? 'failed',
    schemaVersion: meta.schemaVersion ?? null,
    appVersion: meta.appVersion ?? null,
    totalRows: meta.totalRows ?? 0,
    pinned: meta.kind === 'safety',
  };
}

/**
 * Health summary for the UI. none: no verified backup; failing: the last attempt failed after the
 * last success; stale: more than 3 days since the last success; otherwise ok.
 * @param {object} state
 * @param {object[]} metas
 * @param {Date} [now]
 * @param {{ restoring?: boolean, autoEnabled?: boolean, recoveryRequired?: boolean }} [extra]
 */
export function computeStatus(state, metas, now = new Date(), { restoring = false, autoEnabled = true, recoveryRequired = false } = {}) {
  const newest = metas.find((m) => m.status === 'verified') ?? null;
  // Health looks at the newer of the recorded success and the newest verified backup (any kind, so
  // the safety copy a restore makes counts). Restore clears state.lastSuccessAt; the scheduler uses
  // its own rule (isBackupDue) so it still makes a fresh automatic backup of the restored data.
  const newestAt = newest?.verifiedAt ?? newest?.createdAt ?? null;
  const lastSuccessAt = [state.lastSuccessAt, newestAt]
    .filter(isIso)
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null;
  const failedAfterSuccess =
    isIso(state.lastFailureAt) && (!isIso(lastSuccessAt) || Date.parse(state.lastFailureAt) > Date.parse(lastSuccessAt));
  let health = 'ok';
  if (recoveryRequired) health = 'failing';
  else if (!newest) health = 'none';
  else if (failedAfterSuccess) health = 'failing';
  else if (
    !isIso(lastSuccessAt) ||
    now.getTime() - Date.parse(lastSuccessAt) > STALE_AFTER_MS ||
    // dated well in the future (clock moved back): cannot vouch for it
    Date.parse(lastSuccessAt) - now.getTime() > 5 * 60 * 1000
  ) {
    health = 'stale';
  }
  return {
    health,
    lastSuccessAt,
    lastBackupAt: newest?.createdAt ?? null,
    lastBackupId: newest?.id ?? null,
    lastRunAt: state.lastRunAt ?? null,
    lastResult: state.lastResult ?? null,
    lastError: state.lastError ?? null,
    diskWarning: Boolean(state.diskWarning),
    freeBytes: typeof state.freeBytes === 'number' ? state.freeBytes : null,
    restoring,
    lastRestore: state.lastRestore ?? null,
    autoEnabled,
    recoveryRequired,
  };
}
