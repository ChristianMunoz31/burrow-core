// One short weather line for the Home Javi card, computed in code from buildWeatherContext facts (no model call).

const isTemp = (n) => typeof n === 'number' && Number.isFinite(n);
const deg = (n) => `${Math.round(n)}°`;
const conditionText = (c) => (typeof c === 'string' && c && c !== 'Unknown' ? c.toLowerCase() : null);

const WET = /rain|drizzle|shower|thunder/;
const COLD_LOW_F = 45;
const HOT_HIGH_F = 90;

/** A dry Javi aside for the day, or null. Deterministic: wet, then snow, then cold, then hot. */
export function weatherAside({ conditions = [], lowF, highF } = {}) {
  const text = conditions.filter(Boolean).join(' ');
  if (WET.test(text)) return 'Umbrella weather.';
  if (text.includes('snow')) return 'Boots, probably.';
  if (isTemp(lowF) && lowF < COLD_LOW_F) return 'Bring a jacket.';
  if (isTemp(highF) && highF >= HOT_HIGH_F) return 'Hot one. Hydrate.';
  return null;
}

/**
 * e.g. `72°, partly cloudy. Today 78° / 61°.` plus an optional aside. Null when there is nothing to say.
 * Today is the first forecast day; when it lacks a high or low, Tomorrow is used if complete.
 * @param {{ current?: { tempF?: number | null, condition?: string | null } | null, days?: Array<{ highF?: number | null, lowF?: number | null, condition?: string | null }> } | null} facts
 */
export function buildWeatherBrief(facts) {
  const current = facts?.current ?? null;
  const days = Array.isArray(facts?.days) ? facts.days : [];
  const parts = [];

  const nowTemp = isTemp(current?.tempF) ? deg(current.tempF) : null;
  const nowCond = conditionText(current?.condition);
  if (nowTemp && nowCond) parts.push(`${nowTemp}, ${nowCond}.`);
  else if (nowTemp) parts.push(`${nowTemp}.`);
  else if (nowCond) parts.push(`${nowCond[0].toUpperCase()}${nowCond.slice(1)}.`);

  const dayIndex = days.slice(0, 2).findIndex((d) => isTemp(d?.highF) && isTemp(d?.lowF));
  const day = dayIndex === -1 ? null : days[dayIndex];
  if (day) parts.push(`${dayIndex === 0 ? 'Today' : 'Tomorrow'} ${deg(day.highF)} / ${deg(day.lowF)}.`);

  if (parts.length === 0) return null;
  const aside = weatherAside({
    conditions: [nowCond, conditionText(day?.condition)],
    lowF: day?.lowF,
    highF: day?.highF,
  });
  if (aside) parts.push(aside);
  return parts.join(' ');
}
