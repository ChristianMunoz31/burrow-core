import { formatBytes } from './backupFormat';

export const count = (n) => (Number.isFinite(n) ? n.toLocaleString() : '0');

/**
 * The inventory of a folder as one quiet line ("124 files, 118 read, 12.4 MB, 30,500 words"). Every number
 * was measured by Burrow's code on the server; none was written or added up by the helper.
 * @param {object|null} stats
 * @returns {string}
 */
export function statsLine(stats) {
  if (!stats) return '';
  const parts = [`${count(stats.filesTotal)} ${stats.filesTotal === 1 ? 'file' : 'files'}`];
  if (stats.filesRead !== stats.filesTotal) parts.push(`${count(stats.filesRead)} read`);
  parts.push(formatBytes(stats.bytesTotal), `${count(stats.wordsTotal)} words`);
  return parts.join(', ');
}

/** The file kinds that have at least one file, as `[kind, { files, bytes }]` pairs. */
export const kindsOf = (stats) => Object.entries(stats?.byKind ?? {}).filter(([, v]) => v?.files > 0);

/** Whether the Details toggle of a folder has anything to show. */
export function hasDetails(stats) {
  return Boolean(
    stats &&
      (kindsOf(stats).length > 0 ||
        (stats.oldestModifiedAt && stats.newestModifiedAt) ||
        stats.duplicateGroups > 0 ||
        stats.largestFiles?.length > 0),
  );
}
