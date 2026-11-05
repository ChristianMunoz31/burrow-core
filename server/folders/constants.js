// Pure data for the Folders module: limits, extension kinds, status enums, fixed copy.
// Nothing here reads the file system, the database or the environment.

/**
 * @typedef {'ok'|'unsupported'|'binary'|'too_large'|'unreadable'|'empty'|'link'|'outside_root'|'skipped_limit'} FileStatus
 * @typedef {'text'|'data'|'code'|'document'|'other'} FileKind
 * @typedef {'queued'|'running'|'done'|'failed'|'cancelled'|'interrupted'} JobStatus
 * @typedef {'queued'|'inventory'|'summarizing_files'|'summarizing_folder'|'indexing'|'reporting'|'done'} JobPhase
 * @typedef {{ maxFolders: number, maxFiles: number, maxFileBytes: number, maxTotalBytes: number, maxDepth: number,
 *   summaryFiles: number, maxIndexChunks: number, embedModel: string }} Limits
 */

/** The limits the UI is told about (GET /api/folders `limits`). */
export const PUBLIC_LIMITS = Object.freeze({
  maxFolders: 20,
  maxFiles: 5000,
  maxFileBytes: 2 * 1024 * 1024,
  maxTotalBytes: 200 * 1024 * 1024,
  maxDepth: 12,
  summaryFiles: 300,
  maxIndexChunks: 10000,
  embedModel: 'nomic-embed-text',
});

/** Internal limits: the public ones plus the walk budget and the index shape. */
export const LIMITS = Object.freeze({
  ...PUBLIC_LIMITS,
  maxEntries: 50000,
  maxTotalChunks: 50000,
  maxChunksPerFile: 200,
  chunkChars: 1200,
  chunkOverlap: 150,
  embedBatch: 16,
  maxQueued: 20,
  maxPathChars: 1024,
  // PDF and DOCX (parsed in a worker thread, see parseDocs.js): a larger input cap than plain text, a page cap, a
  // wall-clock cap per file, a worker heap cap and the DOCX zip-bomb guards. The extracted text is cut at maxFileBytes.
  maxDocBytes: 25 * 1024 * 1024,
  maxDocPages: 200,
  docTimeoutMs: 20000,
  docHeapMb: 512,
  // The heap cap does not bound typed arrays (pdf.js inflates streams into them): parseDocs.js polls the process RSS
  // and terminates the worker once it is this far above where it was when the parse started.
  docMemoryMb: 384,
  docMemoryPollMs: 100,
  docxMaxEntries: 5000,
  docxMaxEntryBytes: 20 * 1024 * 1024,
  docxMaxTotalBytes: 40 * 1024 * 1024,
});

export const FILE_STATUSES = Object.freeze([
  'ok',
  'unsupported',
  'binary',
  'too_large',
  'unreadable',
  'empty',
  'link',
  'outside_root',
  'skipped_limit',
]);

export const FILE_KINDS = Object.freeze(['text', 'data', 'code', 'document', 'other']);

export const JOB_STATUSES = Object.freeze(['queued', 'running', 'done', 'failed', 'cancelled', 'interrupted']);

export const PHASES = Object.freeze([
  'queued',
  'inventory',
  'summarizing_files',
  'summarizing_folder',
  'indexing',
  'reporting',
  'done',
]);

export const FOLDER_SUMMARY_STATUSES = Object.freeze(['none', 'ok', 'stale', 'withheld', 'ai_unavailable', 'failed']);

export const FILE_SUMMARY_STATUSES = Object.freeze(['none', 'ok', 'stale', 'failed', 'not_included', 'withheld']);

export const LIMIT_CODES = Object.freeze(['max_files', 'max_total_bytes', 'max_depth', 'max_entries', 'summary_limit', 'index_limit']);

/** Extensions whose text is extracted by the document parser worker instead of being decoded as plain text. */
export const DOCUMENT_EXTS = Object.freeze(['pdf', 'docx']);

/** @param {string} ext lower case, no dot @returns {boolean} */
export const isDocumentExt = (ext) => DOCUMENT_EXTS.includes(ext);

const toMap = (kind, list) => list.map((ext) => [ext, kind]);

/** Extension (lower case, no dot) to the kind of content. Anything else is `unsupported` (kind `other`). */
export const EXT_KINDS = Object.freeze(
  Object.fromEntries([
    ...toMap('document', DOCUMENT_EXTS),
    ...toMap('text', ['txt', 'md', 'markdown', 'rst', 'log', 'tex', 'org', 'adoc', 'text']),
    ...toMap('data', ['csv', 'tsv', 'json', 'jsonl', 'ndjson', 'xml', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'properties', 'geojson']),
    ...toMap('code', [
      'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'c', 'h', 'cpp', 'hpp', 'cs', 'php',
      'sh', 'bat', 'ps1', 'sql', 'swift', 'lua', 'r', 'scala', 'vue', 'svelte', 'css', 'scss', 'html', 'htm',
    ]),
  ]),
);

/** Folder names the walk skips (compared lower case). Hidden names (a leading dot) are skipped too. */
export const SKIP_DIR_NAMES = Object.freeze(
  new Set([
    'node_modules', '.git', '.hg', '.svn', '__pycache__', '.venv', 'venv', '.tox', '.idea', '.vscode',
    '$recycle.bin', 'system volume information',
  ]),
);

/** The most characters of a file a preview returns. */
export const PREVIEW_MAX_CHARS = 262144;

/** Preview cache of extracted document text: at most this many entries and this many bytes (2 bytes per character). */
export const PREVIEW_CACHE = Object.freeze({ maxEntries: 8, maxBytes: 16 * 1024 * 1024 });

/** `folder_moved` as the preview route words it (the job copy above says to remove the folder). */
export const PREVIEW_MOVED_MESSAGE = 'This folder moved or changed since it was added. Re-scan it to update.';

/** Fixed copy and HTTP status for every code the module answers with. Never built from request or file text. */
const defs = {
  invalid_request: [400, 'That request was not valid. Check what you entered and try again.'],
  unsupported_media_type: [415, 'That request was not valid. Try again.'],
  folder_origin_blocked: [403, 'Folders can only be added from the Burrow window.'],
  folder_not_found: [404, 'That folder is no longer in Burrow. Reload the page.'],
  folder_file_not_found: [404, 'That file is no longer in this folder list. Re-scan the folder to refresh it.'],
  folder_file_changed: [409, 'This file changed since the last scan. Re-scan the folder to see it.'],
  folder_preview_busy: [429, 'Burrow is still opening another file. Try again in a moment.'],
  folder_failed: [500, "Burrow couldn't finish that. Your files were not changed. Try again."],
  folder_path_invalid: [422, 'Enter the full path of a folder on this computer, for example C:\\Users\\Name\\Documents\\Notes.'],
  folder_missing: [422, "Burrow can't find that folder. Check the path and try again."],
  folder_not_directory: [422, 'That path is a file, not a folder. Enter the folder that holds it.'],
  folder_is_link: [422, 'That folder is a shortcut to another place. Enter the real folder instead.'],
  folder_network_path: [422, "Network folders aren't supported yet. Pick a folder on this computer."],
  folder_too_broad: [422, 'That folder is too big to read as a whole. Pick a folder inside it, like Documents or a project folder.'],
  folder_protected: [422, "Burrow doesn't read system or app folders. Pick a folder with your own files."],
  folder_burrow_data: [422, "That folder holds Burrow's own data. Pick a different folder."],
  folder_hidden: [422, "Burrow doesn't read hidden folders. Pick a folder with your own files that doesn't start with a dot."],
  folder_unreadable: [422, "Burrow can't open that folder. Check that you have permission to read it."],
  folder_exists: [409, 'That folder is already in Burrow.'],
  folder_overlaps: [409, 'That folder is inside, or contains, a folder you already added. Remove the other one first or pick a different folder.'],
  folder_limit: [409, 'You can add up to 20 folders. Remove one to add another.'],
  folder_job_running: [409, 'Burrow is already reading this folder. Wait for it to finish or click Cancel.'],
  folder_queue_full: [429, 'Burrow is reading other folders right now. Try again in a few minutes.'],
  folder_no_job: [409, 'Nothing is running for this folder.'],
  folder_not_scanned: [409, "Burrow hasn't read this folder yet. Click Re-scan and try again when it finishes."],
  folder_not_indexed: [409, "This folder isn't ready for questions yet. Click Re-scan and wait for it to finish, then ask again."],
  rate_limited: [429, 'Too many requests. Try again in a few minutes.'],
  // Native folder picker and save dialog (desktop app), and folders that arrive from an import.
  folder_pick_required: [409, 'Use Add folder to choose the folder in the window that opens.'],
  folder_needs_confirm: [409, "Confirm where this folder is first. Burrow doesn't read a folder from an import until you choose it again."],
  folder_already_confirmed: [409, 'This folder is already confirmed.'],
  dialog_unavailable: [409, 'This needs the Burrow app on your computer.'],
  dialog_busy: [409, 'A Burrow window for choosing a folder or a file is already open. Finish with it first.'],
  dialog_not_found: [404, 'That request has ended. Try again.'],
  dialog_failed: [500, "Burrow couldn't open the window. Try again, or restart Burrow."],
  save_too_large: [413, 'This export is too large to save this way. Use Download instead.'],
  // Codes that appear only inside a dialog view (the status is a placeholder).
  dialog_expired: [409, 'That window was open too long, so nothing was changed. Try again.'],
  pick_failed: [500, "Burrow couldn't open the window to choose a folder. Try again, or restart Burrow."],
  save_exists: [409, 'A file with that name is already there, so nothing was saved. Try again with another name.'],
  save_failed: [500, "Burrow couldn't save the file. If it's open in another app, close it and try again. Nothing was changed."],
  // Job-only codes (job.error and lastJob).
  folder_moved: [409, 'This folder was moved, renamed or replaced. Remove it from Burrow and add it again.'],
  data_reset: [409, 'This was stopped because your Burrow data was erased or restored.'],
  shutdown: [409, 'This was stopped because Burrow closed. Click Re-scan to continue where it left off.'],
  folder_job_failed: [500, "Burrow couldn't finish reading this folder. Your files were not changed. Click Re-scan to try again."],
  cancelled: [409, 'Stopped. What Burrow already read is kept.'],
};

export const FOLDER_MESSAGES = Object.freeze(Object.fromEntries(Object.entries(defs).map(([code, [, message]]) => [code, message])));

export const FOLDER_STATUS = Object.freeze(Object.fromEntries(Object.entries(defs).map(([code, [status]]) => [code, status])));

/** Fixed copy for the limits a scan can hit (shown as notes next to the stats). */
export const LIMIT_MESSAGES = Object.freeze({
  max_files: 'Burrow listed the first 5,000 files. Pick a smaller folder to include everything.',
  max_total_bytes: 'Burrow stopped after reading 200 MB of text. Pick a smaller folder to include everything.',
  max_depth: 'Folders more than 12 levels deep were skipped.',
  max_entries: 'Burrow stopped after looking at 50,000 items in this folder.',
  summary_limit: 'Summaries cover the 300 most recently changed files.',
  index_limit: 'Questions can search the first 10,000 parts of this folder.',
});

export const ASK_NOT_FOUND_MESSAGE = "Burrow couldn't find anything about that in this folder.";

export const ONEDRIVE_WARNING =
  'This folder is in OneDrive. Files that are online-only may be downloaded by OneDrive when Burrow reads them.';

/** An error carrying one of the codes above. The message is always the fixed copy. */
export class FolderError extends Error {
  /** @param {keyof typeof defs | string} code */
  constructor(code) {
    const known = Object.hasOwn(FOLDER_MESSAGES, code) ? code : 'folder_failed';
    super(FOLDER_MESSAGES[known]);
    this.name = 'FolderError';
    this.code = known;
    this.status = FOLDER_STATUS[known];
  }
}
