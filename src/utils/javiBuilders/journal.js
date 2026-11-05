import { clip } from '../javiContext';
import { statusContext } from './_status';

/**
 * Counts and recent moods only. Entry titles, bodies and tags are never included.
 * @param {{ entries?: Array<object>, loading?: boolean, error?: unknown, now?: Date }} input
 */
export function buildJournalContext({ entries, loading, error, now = new Date() } = {}) {
  const early = statusContext({ loading, error });
  if (early) return early;
  const list = Array.isArray(entries) ? entries : [];
  const cutoff = now.getTime() - 30 * 86400000;
  const dated = (e) => {
    const t = new Date(e?.date).getTime();
    return Number.isNaN(t) ? null : t;
  };
  const sorted = [...list].sort((a, b) => (dated(b) ?? 0) - (dated(a) ?? 0));
  const moodCounts = {};
  for (const e of sorted.slice(0, 30)) {
    if (!e?.mood) continue;
    const k = clip(e.mood, 30);
    moodCounts[k] = (moodCounts[k] ?? 0) + 1;
  }
  return {
    total: list.length,
    'entries in the last 30 days': list.filter((e) => (dated(e) ?? 0) >= cutoff).length,
    recent: sorted.slice(0, 5).map((e) => ({
      date: e?.date ? String(e.date).slice(0, 10) : null,
      mood: e?.mood ? clip(e.mood, 30) : null,
    })),
    'mood counts': moodCounts,
  };
}
