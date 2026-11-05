// Cloud AI safeguards: ids, defaults and consent constants shared by the Settings > AI UI.
// Pure module with no imports. server/__tests__/cloudAiParity.test.js imports it and checks it
// against server/ai/privacy.js and server/ai/consent.js, so keep them in step.

/** Data kinds the user can allow or withhold from a cloud AI provider, in display order. */
export const CLOUD_CATEGORY_IDS = Object.freeze([
  'budget',
  'todos',
  'calendar',
  'habits',
  'health',
  'notes',
  'journal',
  'bookmarks',
  'countdowns',
  'focus',
  'folders',
]);

/** What a fresh install allows: everything except the very personal kinds. */
export const CLOUD_CATEGORY_DEFAULTS = Object.freeze({
  budget: true,
  todos: true,
  calendar: true,
  habits: true,
  health: false,
  notes: false,
  journal: false,
  bookmarks: true,
  countdowns: true,
  focus: true,
  folders: false,
});

/** Bumped whenever the consent wording changes, which asks existing users again. */
export const CLOUD_CONSENT_VERSION = 1;

/** The two statements the user must tick before cloud AI turns on. */
export const CLOUD_CONSENT_ACKS = Object.freeze(['sends_data', 'pay_provider']);

const PERSONAL_HINT = "Off by default because it's very personal.";

/** Plain-language label (and optional hint) for each data kind. */
export const CLOUD_CATEGORY_LABELS = Object.freeze({
  budget: Object.freeze({ label: 'Budget', hint: 'Transactions, budget plan and subscriptions' }),
  todos: Object.freeze({ label: 'Todos', hint: null }),
  calendar: Object.freeze({ label: 'Calendar', hint: null }),
  habits: Object.freeze({ label: 'Habits', hint: null }),
  health: Object.freeze({
    label: 'Health',
    hint: `Sleep, readiness and activity. ${PERSONAL_HINT}`,
  }),
  notes: Object.freeze({ label: 'Notes', hint: PERSONAL_HINT }),
  journal: Object.freeze({ label: 'Journal', hint: PERSONAL_HINT }),
  bookmarks: Object.freeze({ label: 'Bookmarks', hint: null }),
  countdowns: Object.freeze({ label: 'Countdowns', hint: null }),
  focus: Object.freeze({ label: 'Focus sessions', hint: null }),
  folders: Object.freeze({
    label: 'Folders',
    hint: "Text from files in folders you add. Off by default because it's very personal.",
  }),
});
