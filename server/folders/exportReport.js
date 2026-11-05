// Exports of one folder: a Markdown report, a JSON report and a CSV file list. Free for everyone, and they include
// the cross-file report text when one was written. Built from stored rows only; nothing is read from the folder.
import { toCsv } from '../export/csv.js';
import { buildFolderFacts, computeFolderStats, singleLine as oneLine } from './stats.js';
import { toFileView } from './views.js';

/**
 * @param {object} folder folders row
 * @param {object[]} files folder_files rows
 * @returns {string}
 */
export function folderMarkdown(folder, files) {
  const lines = [`# Folder report: ${oneLine(folder.name)}`, '', `Folder: ${oneLine(folder.path)}`];
  if (!folder.last_scan_at) {
    lines.push('', 'Not read yet.');
    return `${lines.join('\n')}\n`;
  }
  const stats = computeFolderStats(files, folder.stats ?? {});
  lines.push(`Last read: ${folder.last_scan_at}`, '', '## Summary', '', folder.summary ? String(folder.summary).trim() : 'No summary yet.', '');
  lines.push('## Facts', '');
  for (const [key, value] of Object.entries(buildFolderFacts(stats))) lines.push(`- ${oneLine(key)}: ${oneLine(value)}`);
  if (folder.report) lines.push('', '## Cross-file report', '', String(folder.report).trim());
  lines.push('', '## Files', '');
  for (const row of files) {
    const f = toFileView(row);
    const note = f.summary ? `: ${oneLine(f.summary)}` : '';
    lines.push(`- ${oneLine(f.path)} (${f.status}, ${f.sizeBytes} bytes)${note}`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * @param {object} folder folders row
 * @param {object[]} files folder_files rows
 * @param {Date} [now]
 * @returns {string}
 */
export function folderJson(folder, files, now = new Date()) {
  const scanned = !!folder.last_scan_at;
  return `${JSON.stringify(
    {
      format: 'burrow-folder',
      formatVersion: 1,
      exportedAt: now.toISOString(),
      folder: { name: folder.name, path: folder.path, createdAt: folder.created_at, lastScanAt: folder.last_scan_at ?? null, scanned },
      summary: { status: folder.summary_status, text: folder.summary ?? null, model: folder.summary_model ?? null, at: folder.summary_at ?? null },
      report: folder.report ? { text: folder.report, model: folder.report_model ?? null, at: folder.report_at ?? null } : null,
      stats: scanned && folder.stats && Object.keys(folder.stats).length ? folder.stats : null,
      files: files.map(toFileView),
    },
    null,
    2,
  )}\n`;
}

const CSV_COLUMNS = Object.freeze([
  { name: 'Path', type: 'text' },
  { name: 'Extension', type: 'text' },
  { name: 'Kind', type: 'text' },
  { name: 'Status', type: 'text' },
  { name: 'Size (bytes)', type: 'integer' },
  { name: 'Modified', type: 'text' },
  { name: 'Lines', type: 'integer' },
  { name: 'Words', type: 'integer' },
  { name: 'Summary', type: 'text' },
]);

/**
 * File list as CSV (formula-injection guard on every text cell).
 * @param {object[]} files folder_files rows
 * @returns {string}
 */
export function folderCsv(files) {
  return toCsv(
    CSV_COLUMNS,
    files.map((row) => {
      const f = toFileView(row);
      return {
        Path: f.path,
        Extension: f.ext,
        Kind: f.kind,
        Status: f.status,
        'Size (bytes)': f.sizeBytes,
        Modified: f.modifiedAt,
        Lines: f.lines,
        Words: f.words,
        Summary: f.summary,
      };
    }),
  );
}
