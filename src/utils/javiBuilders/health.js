import { round2 } from '../javiContext';
import { statusContext } from './_status';

const avg = (rows, key) => {
  const vals = rows
    .map((r) => r?.[key])
    .filter((v) => v !== null && v !== undefined && Number.isFinite(Number(v)))
    .map(Number);
  return vals.length ? round2(vals.reduce((a, b) => a + b, 0) / vals.length) : null;
};

/**
 * @param {{ days?: Array<object>, latest?: object | null, loading?: boolean, error?: unknown }} input
 */
export function buildHealthContext({ days, latest, loading, error } = {}) {
  const early = statusContext({ loading, error });
  if (early) return early;
  const rows = (Array.isArray(days) ? days : []).slice(-7);
  const l = latest ?? rows[rows.length - 1] ?? null;
  return {
    latest: l
      ? {
          day: l.day ?? null,
          readiness: round2(l.readiness),
          sleep: round2(l.sleep),
          activity: round2(l.activity),
          restingHr: round2(l.restingHr),
          hrv: round2(l.hrv),
          sleepHours: round2(l.sleepHours),
          steps: round2(l.steps),
        }
      : null,
    avg7: {
      readiness: avg(rows, 'readiness'),
      sleep: avg(rows, 'sleep'),
      activity: avg(rows, 'activity'),
      hrv: avg(rows, 'hrv'),
      sleepHours: avg(rows, 'sleepHours'),
    },
  };
}
