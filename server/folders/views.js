// Row to API shape conversions (the FolderView and FileView of the contract). Pure apart from the OneDrive check,
// which compares the stored path key with the OneDrive roots of the environment (resolved once, no per-row file system call).
import { FOLDER_MESSAGES } from './constants.js';
import { isUnderRootKeys, oneDriveRootKeys } from './pathSafety.js';

/** @param {unknown} raw last_job_error text @returns {{ code: string, message: string | null } | null} */
export function parseJobError(raw) {
  if (typeof raw !== 'string' || raw === '') return null;
  try {
    const v = JSON.parse(raw);
    if (v && typeof v.code === 'string') {
      const message = typeof v.message === 'string' ? v.message : (FOLDER_MESSAGES[v.code] ?? null);
      return { code: v.code, message };
    }
  } catch {
    /* an old or odd value: fall through */
  }
  return null;
}

/** @param {{ code: string, message: string } | null} error @returns {string | null} */
export function stringifyJobError(error) {
  if (!error) return null;
  return JSON.stringify({ code: String(error.code).slice(0, 60), message: String(error.message ?? '').slice(0, 300) });
}

/**
 * @param {object} row folders row
 * @param {object | null} jobView The latest job of this folder in memory, if any.
 * @returns {object} FolderView
 */
export function toFolderView(row, jobView = null) {
  const stats = row.stats && typeof row.stats === 'object' && Object.keys(row.stats).length > 0 ? row.stats : null;
  const err = parseJobError(row.last_job_error);
  return {
    id: row.id,
    name: row.name,
    path: row.path,
    autoRescan: row.auto_rescan === true,
    needsConfirm: row.confirm_state === 'needs_confirm',
    createdAt: row.created_at,
    lastScanAt: row.last_scan_at ?? null,
    stats,
    summary: {
      status: row.summary_status ?? 'none',
      text: row.summary ?? null,
      model: row.summary_model ?? null,
      at: row.summary_at ?? null,
    },
    report: row.report ? { text: row.report, model: row.report_model ?? null, at: row.report_at ?? null } : null,
    job: jobView,
    lastJob: row.last_job_status
      ? { status: row.last_job_status, errorCode: err?.code ?? null, message: err?.message ?? null, at: row.last_job_at ?? null }
      : null,
    warnings: isUnderRootKeys(row.path_key, oneDriveRootKeys()) ? ['onedrive'] : [],
  };
}

/**
 * @param {object} row folder_files row
 * @returns {object} FileView
 */
export function toFileView(row) {
  const readable = row.status === 'ok';
  return {
    id: row.id,
    path: row.rel_path,
    ext: row.ext ?? '',
    kind: row.kind,
    status: row.status,
    sizeBytes: Number(row.size_bytes) || 0,
    modifiedAt: row.mtime ?? null,
    lines: row.line_count ?? null,
    words: row.word_count ?? null,
    chars: row.char_count ?? null,
    summary: readable ? (row.summary ?? null) : null,
    summaryStatus: readable ? (row.summary_status ?? 'none') : 'not_text',
    indexed: readable && !!row.index_hash && row.index_hash === row.sha256 && Number(row.chunk_count) > 0,
  };
}
