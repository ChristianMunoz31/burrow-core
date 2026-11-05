// UI copy, labels and small lookups for the Folders page. Numbers always come from the server; nothing
// here computes a statistic. The copy mirrors the server's fixed messages (server/folders/constants.js),
// which are shown as received; these are the fallbacks for when a response carries no text.

export const FOLDERS_TITLE = 'Folders';
export const FOLDERS_SUBTITLE =
  'Burrow reads folders you pick, on this computer. Your files are never uploaded or changed.';

export const EMPTY_TEXT = "No folders yet. Add one to see what's inside and get a summary.";
export const EMPTY_BUTTON = 'Add your first folder';
export const ADD_BUTTON = 'Add folder';

export const PICK_WAITING = 'Choose a folder in the window that opened.';
export const SAVE_WAITING = 'Choose where to save in the window that opened.';
export const STOP_WAITING = 'Stop waiting';
export const PICK_AGAIN = 'Choose another folder';
export const DOWNLOAD_INSTEAD = 'Download instead';
export const NEEDS_CONFIRM_TEXT =
  "Imported from a Burrow export. Burrow won't read this folder until you confirm where it is on this computer.";
export const CHOOSE_FOLDER_BUTTON = 'Choose folder';
export const CONFIRM_FOLDER_BUTTON = 'Confirm folder';
export const CONFIRM_DIALOG_TITLE = 'Confirm this folder';
export const CONFIRM_DIALOG_HELP =
  'Check the path, or paste where this folder is on this computer. Burrow reads it only after you confirm.';

export const PATH_LABEL = 'Folder path';
export const PATH_HELP =
  'Paste the full path. In File Explorer, right-click the folder, choose Copy as path, then paste it here.';
export const PATH_PLACEHOLDER = 'C:\\Users\\Name\\Documents\\Notes';
export const NAME_LABEL = 'Name (optional)';
export const ADD_DIALOG_TITLE = 'Add a folder';

export const REMOVE_TITLE = 'Remove this folder from Burrow?';
export const REMOVE_MESSAGE =
  'Burrow forgets its summaries and file list. The folder and your files stay exactly where they are.';

export const ONEDRIVE_WARNING =
  'This folder is in OneDrive. Files that are online-only may be downloaded by OneDrive when Burrow reads them.';

export const EMBED_MODEL = 'nomic-embed-text';
export const SEARCH_MODEL_TEXT =
  'Questions need a small search model. It runs on this computer. Ollama downloads it once from the Ollama library (about 270 MB).';
export const SEARCH_MODEL_BUTTON = 'Download the search model';
export const SEARCH_MODEL_READY = 'The search model is ready. Click Re-scan, then ask again.';

export const WITHHELD_MESSAGE =
  "Your folder files aren't shared with cloud AI. You can change that in Settings > AI.";
export const ASK_NOT_FOUND = "Burrow couldn't find anything about that in this folder.";
export const NOT_INDEXED_MESSAGE =
  "This folder isn't ready for questions yet. Click Re-scan and wait for it to finish, then ask again.";
export const OLLAMA_UNREACHABLE_MESSAGE = "Burrow couldn't reach Ollama during the last scan. Start Ollama, then click Re-scan.";

export const SWITCH_LABEL = 'Re-scan once a day';
export const SWITCH_HINT = 'While Burrow is open. Only changed files are read again.';

export const ASK_HEADING = 'Ask this folder';
export const ASK_PLACEHOLDER = 'Ask about the files in this folder';
export const ASK_BUTTON = 'Ask';
export const SOURCES_HEADING = 'Sources';
export const REPORT_HEADING = 'Cross-file report';
export const REPORT_BUTTON = 'Write report';

export const EXPORT_ITEMS = Object.freeze([
  Object.freeze({ format: 'md', label: 'Report (Markdown)' }),
  Object.freeze({ format: 'json', label: 'Report (JSON)' }),
  Object.freeze({ format: 'csv', label: 'File list (CSV)' }),
]);

export const ASK_MAX_LENGTH = 500;
export const FILES_PAGE_SIZE = 100;

/** How often a queued or running job is re-read. */
export const JOB_POLL_MS = 2000;
/** How often the window the app opened for a folder or a save location is asked about. */
export const DIALOG_POLL_MS = 1000;

export const PHASE_LABELS = Object.freeze({
  queued: 'Waiting for another folder to finish',
  inventory: 'Listing files',
  summarizing_files: 'Summarizing files ({done} of {total})',
  summarizing_folder: 'Writing the folder summary',
  indexing: 'Preparing questions ({done} of {total})',
  reporting: 'Writing the report',
});

/** Shown for a phase the page does not know (including 'done'), so it never names the wrong step. */
export const PHASE_FALLBACK = 'Working on this folder';

export const FILE_STATUS_LABELS = Object.freeze({
  ok: 'Read',
  unsupported: 'Not supported yet',
  binary: 'Not a text file',
  too_large: 'Larger than 2 MB',
  unreadable: 'Could not read this file',
  empty: 'Empty',
  link: 'Shortcut, skipped',
  outside_root: 'Outside this folder, skipped',
  skipped_limit: 'Not read, folder limit reached',
});

/** Shown for a status this page does not know yet, so a raw code never reaches the screen. */
export const FILE_STATUS_FALLBACK = 'Not read';

export const FILE_SUMMARY_LABELS = Object.freeze({
  stale: 'Summary is out of date',
  failed: "Summary couldn't be written",
  not_included: 'Not summarized, folder limit reached',
  withheld: 'Not shared with cloud AI, so no summary',
  not_text: 'No summary for this file type',
});

export const KIND_LABELS = Object.freeze({
  text: 'Text',
  data: 'Data',
  code: 'Code',
  document: 'Document',
  other: 'Other',
});

export const LIMIT_COPY = Object.freeze({
  max_files: 'Burrow listed the first 5,000 files. Pick a smaller folder to include everything.',
  max_total_bytes: 'Burrow stopped after reading 200 MB of text. Pick a smaller folder to include everything.',
  max_depth: 'Folders more than 12 levels deep were skipped.',
  max_entries: 'Burrow stopped after looking at 50,000 items in this folder.',
  summary_limit: 'Summaries cover the 300 most recently changed files.',
  index_limit: 'Questions can search the first 10,000 parts of this folder.',
});

/** Copy for the job end states a user can still see after a reload (`lastJob.status`). */
export const LAST_JOB_FALLBACK = Object.freeze({
  failed: "Burrow couldn't finish reading this folder. Your files were not changed. Click Re-scan to try again.",
  cancelled: 'Stopped. What Burrow already read is kept.',
  interrupted: 'This was stopped because Burrow closed. Click Re-scan to continue where it left off.',
});

export const GENERIC_ERROR = "Burrow couldn't finish that. Your files were not changed. Try again.";

// The split view: a read-only preview of one file next to its summary.
export const PREVIEW_CSV_ROWS = 200;
export const PREVIEW_CSV_COLUMNS = 20;
export const PREVIEW_NONE_TEXT = 'Choose a file in the list to see what is inside it.';
export const PREVIEW_EMPTY_TEXT = 'This file is empty.';
export const PREVIEW_LOADING = 'Loading preview';
export const PREVIEW_CSV_ROWS_NOTE = 'Showing the first {n} rows.';
export const PREVIEW_CSV_COLUMNS_NOTE = 'Showing the first {n} columns.';
export const PREVIEW_TRUNCATED_NOTE = 'Showing the first {n} KB of this file.';
export const SUMMARY_SUMMARIZING = 'Summarizing this file';
export const PREVIEW_GONE = 'That file is no longer in the list.';
export const RESCAN_WAIT = 'Wait for the current scan to finish.';
export const SUMMARY_WAITING = 'Waiting for its turn';
export const SUMMARY_NONE = 'No summary yet.';
export const SUMMARY_AI_UNAVAILABLE = 'No summary yet. Open Files to see what is inside.';
export const REPORT_NEEDS_AI = 'Reports need Javi, which runs on this computer through Ollama.';

/** What the preview pane says for a file Burrow did not read, by the file's status. */
export const PREVIEW_REASON_COPY = Object.freeze({
  unsupported: "Burrow can't show this kind of file yet.",
  binary: "This isn't a text file, so there is nothing to show.",
  too_large: "This file is larger than 2 MB, so Burrow doesn't open it.",
  unreadable: "Burrow couldn't read this file. Check that you can open it, then click Re-scan.",
  empty: PREVIEW_EMPTY_TEXT,
  link: 'This is a shortcut, so Burrow skipped it.',
  outside_root: 'This points outside the folder, so Burrow skipped it.',
  skipped_limit: "Burrow reached this folder's file limit before it read this file.",
});
export const PREVIEW_REASON_FALLBACK = "Burrow didn't read this file, so there is nothing to show.";

/**
 * Fallback text per error code, used only when a response carries no message of its own. Codes that only ever
 * appear inside a window result (`dialog_expired`, `pick_failed`, `save_exists`, `save_failed`) always arrive with
 * the server's text, so they have no entry here.
 */
export const ERROR_COPY = Object.freeze({
  invalid_request: 'That request was not valid. Check what you entered and try again.',
  unsupported_media_type: 'That request was not valid. Try again.',
  folder_origin_blocked: 'Folders can only be added from the Burrow window.',
  folder_not_found: 'That folder is no longer in Burrow. Reload the page.',
  folder_failed: GENERIC_ERROR,
  folder_path_invalid:
    'Enter the full path of a folder on this computer, for example C:\\Users\\Name\\Documents\\Notes.',
  folder_missing: "Burrow can't find that folder. Check the path and try again.",
  folder_not_directory: 'That path is a file, not a folder. Enter the folder that holds it.',
  folder_is_link: 'That folder is a shortcut to another place. Enter the real folder instead.',
  folder_network_path: "Network folders aren't supported yet. Pick a folder on this computer.",
  folder_too_broad:
    'That folder is too big to read as a whole. Pick a folder inside it, like Documents or a project folder.',
  folder_protected: "Burrow doesn't read system or app folders. Pick a folder with your own files.",
  folder_burrow_data: "That folder holds Burrow's own data. Pick a different folder.",
  folder_hidden: "Burrow doesn't read hidden folders. Pick a folder with your own files that doesn't start with a dot.",
  folder_unreadable: "Burrow can't open that folder. Check that you have permission to read it.",
  folder_exists: 'That folder is already in Burrow.',
  folder_overlaps:
    'That folder is inside, or contains, a folder you already added. Remove the other one first or pick a different folder.',
  folder_limit: 'You can add up to 20 folders. Remove one to add another.',
  folder_job_running: 'Burrow is already reading this folder. Wait for it to finish or click Cancel.',
  folder_queue_full: 'Burrow is reading other folders right now. Try again in a few minutes.',
  folder_no_job: 'Nothing is running for this folder.',
  folder_not_scanned: "Burrow hasn't read this folder yet. Click Re-scan and try again when it finishes.",
  folder_not_indexed: NOT_INDEXED_MESSAGE,
  folder_pick_required: 'Use Add folder to choose the folder in the window that opens.',
  folder_needs_confirm: "Confirm where this folder is first. Burrow doesn't read a folder from an import until you choose it again.",
  folder_already_confirmed: 'This folder is already confirmed.',
  dialog_unavailable: 'This needs the Burrow app on your computer.',
  dialog_busy: 'A Burrow window for choosing a folder or a file is already open. Finish with it first.',
  dialog_not_found: 'That request has ended. Try again.',
  dialog_failed: "Burrow couldn't open the window. Try again, or restart Burrow.",
  save_too_large: 'This export is too large to save this way. Use Download instead.',
  rate_limited: 'Too many requests. Try again in a few minutes.',
  folder_file_not_found: 'That file is no longer in this folder list. Re-scan the folder to refresh it.',
  folder_file_changed: 'This file changed since the last scan. Re-scan the folder to see it.',
  folder_preview_busy: 'Burrow is still opening another file. Try again in a moment.',
  folder_moved: 'This folder moved or changed since it was added. Re-scan it to update.',
});

/** Dialog results that end with a message instead of a success or a silent cancel. */
export const DIALOG_PROBLEMS = Object.freeze(['refused', 'busy', 'expired', 'failed']);

/** Codes that belong next to the path field in the Add dialog. Everything else is a form-level message. */
export const PATH_ERROR_CODES = Object.freeze([
  'invalid_request',
  'folder_path_invalid',
  'folder_missing',
  'folder_not_directory',
  'folder_is_link',
  'folder_network_path',
  'folder_too_broad',
  'folder_protected',
  'folder_burrow_data',
  'folder_hidden',
  'folder_unreadable',
  'folder_exists',
  'folder_overlaps',
]);

/** True while a job still has work to do. */
export const isJobActive = (job) => job?.status === 'queued' || job?.status === 'running';

/** The phase text for a job, with the progress numbers the server reported. */
export function phaseLabel(job) {
  if (!job) return '';
  const template = Object.hasOwn(PHASE_LABELS, job.phase) ? PHASE_LABELS[job.phase] : PHASE_FALLBACK;
  const p = job.progress ?? {};
  const done = job.phase === 'indexing' ? p.chunksDone : p.summariesDone;
  const total = job.phase === 'indexing' ? p.chunksTotal : p.summariesTotal;
  return template.replace('{done}', String(done ?? 0)).replace('{total}', String(total ?? 0));
}

/** The phase in words without the counts, for the live region (the progress bar carries the numbers). */
export function phaseName(job) {
  if (!job) return '';
  return phaseLabel(job).replace(/\s*\(\d+ of \d+\)$/, '');
}

/** Done and total counts for the phases that have a known size, else null. */
export function phaseCounts(job) {
  const p = job?.progress;
  if (!p) return null;
  if (job.phase === 'summarizing_files' && p.summariesTotal > 0) {
    return { done: p.summariesDone, total: p.summariesTotal };
  }
  if (job.phase === 'indexing' && p.chunksTotal > 0) return { done: p.chunksDone, total: p.chunksTotal };
  return null;
}

/** A readable local date for an ISO timestamp, or an empty string. */
export function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString();
}
