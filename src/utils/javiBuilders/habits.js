import { buildGrid, currentStreak } from '../habits';
import { clip, localDay } from '../javiContext';
import { statusContext } from './_status';

/**
 * @param {{ habits?: Array<{title:string,frequency?:string,completions?:string[]}>,
 *   loading?: boolean, error?: unknown, now?: Date }} input
 */
export function buildHabitsContext({ habits, loading, error, now = new Date() } = {}) {
  const early = statusContext({ loading, error });
  if (early) return early;
  const today = localDay(now);
  const all = (Array.isArray(habits) ? habits : []).filter(Boolean);
  const completionsOf = (h) => (Array.isArray(h?.completions) ? h.completions : []);
  // Counts cover every habit, not just the 20 listed, so the model never counts or compares rows.
  const best = all.reduce((n, h) => Math.max(n, currentStreak(completionsOf(h), today)), 0);
  return {
    'habits total': all.length,
    'habits done today': all.filter((h) => completionsOf(h).includes(today)).length,
    'best streak': `${best} day${best === 1 ? '' : 's'}`,
    habits: (Array.isArray(habits) ? habits : []).slice(0, 20).map((h) => {
      const completions = Array.isArray(h?.completions) ? h.completions : [];
      const grid = buildGrid(completions, 30, today);
      return {
        title: clip(h?.title, 80),
        frequency: h?.frequency ?? null,
        'done today': completions.includes(today),
        'streak in days': currentStreak(completions, today),
        'done in the last 30 days': `${Math.round((grid.filter((g) => g.done).length / 30) * 100)}%`,
      };
    }),
  };
}
