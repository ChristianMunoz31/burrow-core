// Pure stat helpers for the Journal module.

export function isoToday(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function dateOnly(iso) {
  if (!iso || typeof iso !== 'string') return '';
  // If it's already a date-only string (no 'T'), keep it as-is to preserve
  // the caller's intent. Datetime strings get converted to local YYYY-MM-DD
  // so a late-night UTC entry counts toward the user's local day.
  if (!iso.includes('T')) return iso.slice(0, 10);
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso.slice(0, 10);
  return isoToday(d);
}

// Returns count of consecutive days ending today (or yesterday if today is empty,
// gives credit for keeping momentum) that have at least one entry.
export function currentStreak(entries, today = isoToday()) {
  if (!Array.isArray(entries) || entries.length === 0) return 0;
  const days = new Set(entries.map((e) => dateOnly(e.date)).filter(Boolean));
  let cursor = new Date(`${today}T00:00:00`);
  // If today is empty but yesterday has an entry, start counting from yesterday.
  if (!days.has(today)) {
    cursor.setDate(cursor.getDate() - 1);
    const yesterday = isoToday(cursor);
    if (!days.has(yesterday)) return 0;
  }
  let streak = 0;
  // Walk backwards from cursor while days have an entry.
  while (days.has(isoToday(cursor))) {
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

// Returns `days` slots oldest→newest with { date: 'YYYY-MM-DD', count: number }.
export function entriesByDay(entries, days = 30, today = isoToday()) {
  const counts = new Map();
  for (const e of entries || []) {
    const d = dateOnly(e.date);
    if (!d) continue;
    counts.set(d, (counts.get(d) || 0) + 1);
  }
  const out = [];
  const cursor = new Date(`${today}T00:00:00`);
  cursor.setDate(cursor.getDate() - (days - 1));
  for (let i = 0; i < days; i++) {
    const key = isoToday(cursor);
    out.push({ date: key, count: counts.get(key) || 0 });
    cursor.setDate(cursor.getDate() + 1);
  }
  return out;
}

const MOOD_ORDER = ['great', 'good', 'okay', 'down', 'rough'];

export function moodHistogram(entries) {
  const counts = Object.fromEntries(MOOD_ORDER.map((m) => [m, 0]));
  for (const e of entries || []) {
    if (e.mood && counts[e.mood] != null) counts[e.mood] += 1;
  }
  return MOOD_ORDER.map((mood) => ({ mood, count: counts[mood] }));
}

export function topMood(entries) {
  const hist = moodHistogram(entries);
  let top = null;
  for (const h of hist) {
    if (!top || h.count > top.count) top = h;
  }
  return top && top.count > 0 ? top.mood : null;
}
