// Humorous, time-appropriate greetings from Javi for the Home card.
// Adheres strictly to Javi's voice: witty, dryly humorous, and impeccably polite, devoted professional butler.
// No emoji, no emoticons, no em dashes or en dashes.

export const MORNING_GREETINGS = [
  'Good morning. I have laid out your schedule, though I cannot vouch for its mercy.',
  'Good morning. Your affairs await, precisely as disorderly as you left them.',
  'Good morning. Coffee is strongly advised before we confront your itinerary.',
  'Good morning. The sun has risen, and your todo list appears to have accompanied it.',
  'Good morning. Burrow is at your service, prepared to bring order to the inevitable chaos.',
  'Good morning. Another day, another heroic attempt at fiscal restraint.',
  'Good morning. I took the liberty of reviewing your agenda; do try to pace yourself.',
  'Good morning. Ready to embark upon today\'s triumphs, however modest they may prove?',
  'Good morning. A fresh day awaits, and I remain ever devoted to keeping you on course.',
  'Good morning. Up early, I see. Shall we pretend today will proceed strictly according to plan?',
];

export const AFTERNOON_GREETINGS = [
  'Good afternoon. Half the day has elapsed, and catastrophe remains remarkably well contained.',
  'Good afternoon. May I suggest a brief pause before the post-lunch lethargy settles in?',
  'Good afternoon. Your remaining agenda is watching with cautious optimism.',
  'Good afternoon. Still persevering, I observe. A most commendable effort.',
  'Good afternoon. Hydration and composure, if I may be so bold as to advise.',
];

export const EVENING_GREETINGS = [
  'Good evening. The day draws to a close; perhaps step away before the spreadsheet begins to stare back.',
  'Good evening. A respectable showing today. Shall we review what survived the ordeal?',
  'Good evening. Time to retire from your duties, unless overthinking remains on the docket.',
  'Good evening. I recommend stepping away from the keyboard; tomorrow\'s tasks will wait patiently.',
  'Good evening. Burrow stands watch while you attend to the dignified art of resting.',
];

export const NIGHT_GREETINGS = [
  'Good night. Do retire to bed; the database will faithfully keep vigil until dawn.',
  'Good night. Nothing constructive has ever happened to one\'s budget past midnight.',
  'Good night. Sleep is remarkably cost-effective, which should please your financial sensibilities.',
  'Good night. I strongly advise closing the screen before your sleep metrics file a formal complaint.',
  'Good night. Pondering existential queries at this hour will not resolve tomorrow\'s agenda.',
  'Good night. Even the most devoted personal operating systems require their quiet hours.',
  'Good night. Tomorrow\'s tasks are quite content to wait; do grant yourself some repose.',
  'Good night. Burning the midnight oil will merely compromise tomorrow\'s composure.',
  'Good night. One cannot negotiate with sleep deprivation, regardless of how organized one feels.',
  'Good night. I must respectfully insist on sleep before you conjure up five additional tasks.',
];

export const GREETINGS_BY_TIME = {
  morning: MORNING_GREETINGS,
  afternoon: AFTERNOON_GREETINGS,
  evening: EVENING_GREETINGS,
  night: NIGHT_GREETINGS,
};

/**
 * Return time of day bucket ('morning' | 'afternoon' | 'evening' | 'night') from an hour (0-23).
 * Night covers late night (0-4) and late evening (21-23).
 * Morning is 5-11.
 * Afternoon is 12-16.
 * Evening is 17-20.
 *
 * @param {number} hour
 * @returns {'morning' | 'afternoon' | 'evening' | 'night'}
 */
export function getTimeOfDay(hour) {
  if (hour < 5 || hour >= 21) return 'night';
  if (hour < 12) return 'morning';
  if (hour < 17) return 'afternoon';
  return 'evening';
}

/**
 * Personalize a greeting with the user's name if provided.
 *
 * @param {string} greeting
 * @param {string | null} [name]
 * @returns {string}
 */
export function personalizeGreeting(greeting, name) {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (!trimmed || typeof greeting !== 'string') return greeting;
  return greeting.replace(/^(Good (?:morning|afternoon|evening|night))\./, `$1, ${trimmed}.`);
}

/**
 * Pick a random humorous greeting based on the current local time,
 * optionally personalized with the user's name.
 *
 * @param {Date} [now]
 * @param {() => number} [randomFn]
 * @param {string | null} [name]
 * @returns {string}
 */
export function getRandomGreeting(now = new Date(), randomFn = Math.random, name = null) {
  const time = getTimeOfDay(now.getHours());
  const list = GREETINGS_BY_TIME[time] || MORNING_GREETINGS;
  const idx = Math.floor(randomFn() * list.length);
  const base = list[Math.min(idx, list.length - 1)];
  return personalizeGreeting(base, name);
}

