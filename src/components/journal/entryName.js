const TIME_FMT = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' });

// A date-only value (no 'T') parses as UTC midnight, which would show a made-up local time.
export const entryTime = (e) =>
  typeof e.date === 'string' && e.date.includes('T') ? TIME_FMT.format(new Date(e.date)) : '';

/** Accessible name for a journal entry: its title, else "entry from <time>" or "entry from earlier". */
export const entryName = (e) => e.title || `entry from ${entryTime(e) || 'earlier'}`;
