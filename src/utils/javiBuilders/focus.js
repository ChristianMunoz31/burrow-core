import { statusContext } from './_status';

/**
 * @param {{ today?: {count:number,minutes:number}, sessions?: Array<object>,
 *   loading?: boolean, error?: unknown, now?: Date }} input
 */
export function buildFocusContext({ today, sessions, loading, error, now = new Date() } = {}) {
  const early = statusContext({ loading, error });
  if (early) return early;
  const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6).getTime();
  const recent = (Array.isArray(sessions) ? sessions : []).filter(
    (s) => s?.kind === 'focus' && s.startedAt && new Date(s.startedAt).getTime() >= cutoff,
  );
  return {
    today: { count: today?.count ?? 0, minutes: today?.minutes ?? 0 },
    'last 7 days': {
      count: recent.length,
      minutes: recent.reduce((sum, s) => sum + (Number(s.durationMin) || 0), 0),
    },
  };
}
