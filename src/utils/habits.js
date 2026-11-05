// Pure helpers for working with habit completion data. Dates are ISO strings
// in 'YYYY-MM-DD' form so plain string comparison and Set lookups Just Work.

export function isoToday() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function parseIso(iso) {
  // Build at local midnight so addDays math doesn't drift across DST.
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function formatIso(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function addDays(iso, delta) {
  const d = parseIso(iso);
  d.setDate(d.getDate() + delta);
  return formatIso(d);
}

// Counts consecutive completions ending today. If today isn't done yet but
// yesterday was, the streak still counts (give credit for momentum until the
// day rolls over).
export function currentStreak(completions, today = isoToday()) {
  if (!Array.isArray(completions) || completions.length === 0) return 0;
  const done = new Set(completions);

  let cursor;
  if (done.has(today)) {
    cursor = today;
  } else {
    const yesterday = addDays(today, -1);
    if (!done.has(yesterday)) return 0;
    cursor = yesterday;
  }

  let streak = 0;
  while (done.has(cursor)) {
    streak += 1;
    cursor = addDays(cursor, -1);
  }
  return streak;
}

// Returns the last `days` days, oldest -> newest, each tagged with whether
// the habit was completed on that date.
export function buildGrid(completions, days = 30, today = isoToday()) {
  const done = new Set(Array.isArray(completions) ? completions : []);
  const grid = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const date = addDays(today, -i);
    grid.push({ date, done: done.has(date) });
  }
  return grid;
}
