import { clip } from '../javiContext';
import { statusContext } from './_status';

// Notes have no title field: the first non-empty line stands in as the name. No body
// excerpts ever leave the device.
const noteTitle = (n) => {
  const first = String(n?.body ?? '')
    .split('\n')
    .find((l) => l.trim());
  return clip((first ?? '').trim(), 40);
};

/**
 * Counts, pinned count and clipped titles only.
 * @param {{ notes?: Array<{body?:string,pinned?:boolean}>, loading?: boolean, error?: unknown }} input
 */
export function buildNotesContext({ notes, loading, error } = {}) {
  const early = statusContext({ loading, error });
  if (early) return early;
  const list = Array.isArray(notes) ? notes : [];
  const pinned = list.filter((n) => n?.pinned);
  return {
    total: list.length,
    pinnedCount: pinned.length,
    pinnedTitles: pinned.slice(0, 5).map(noteTitle),
    recentTitles: list.slice(0, 8).map(noteTitle),
  };
}
