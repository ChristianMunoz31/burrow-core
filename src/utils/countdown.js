// Whole days between today and a 'YYYY-MM-DD' target date, computed at local
// midnight on both ends so a countdown flips over exactly at the user's midnight
// (no UTC drift). Positive = future, 0 = today, negative = past.
export function daysUntil(dateStr) {
  if (!dateStr) return null;
  const [y, m, d] = String(dateStr).split('-').map(Number);
  if (!y || !m || !d) return null;
  const target = new Date(y, m - 1, d);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((target - today) / 86400000);
}

export function countdownLabel(days) {
  if (days == null) return '';
  if (days === 0) return 'Today';
  if (days > 0) return `in ${days} day${days === 1 ? '' : 's'}`;
  const past = Math.abs(days);
  return `${past} day${past === 1 ? '' : 's'} ago`;
}
