// Where each kind of Burrow data lives. Display-only; keep in sync with the
// server routes and useSyncedSetting consumers when a module changes storage.

export const STORAGE_KINDS = ['database', 'synced', 'device', 'external'];

export const STORAGE_MAP = Object.freeze([
  { id: 'transactions', label: 'Transactions', kind: 'database', group: 'database', detail: 'CSV import on the Budget page, or a published Google Sheet link' },
  { id: 'budget', label: 'Budget', kind: 'synced', group: 'database', detail: 'Budget planner settings' },
  { id: 'todos', label: 'Todos', kind: 'database', group: 'database', detail: 'Todos & board columns' },
  { id: 'notes', label: 'Notes', kind: 'database', group: 'database', detail: 'Notes' },
  { id: 'journal', label: 'Journal', kind: 'database', group: 'database', detail: 'Journal entries' },
  { id: 'habits', label: 'Habits', kind: 'database', group: 'database', detail: 'Habits & completions' },
  { id: 'bookmarks', label: 'Bookmarks', kind: 'database', group: 'database', detail: 'Bookmarks' },
  { id: 'countdowns', label: 'Countdowns', kind: 'database', group: 'database', detail: 'Countdowns' },
  { id: 'calendar', label: 'Calendar', kind: 'database', group: 'database', detail: 'Calendar events incl. .ics imports' },
  { id: 'focus', label: 'Focus', kind: 'database', group: 'database', detail: 'Focus sessions' },
  { id: 'health', label: 'Health', kind: 'external', group: 'external', detail: 'From your Oura account' },
  { id: 'weather', label: 'Weather', kind: 'external', group: 'external', detail: 'Open-Meteo, fetched live, nothing stored' },
  {
    id: 'jarvis',
    label: 'Javi',
    kind: 'database',
    group: 'database',
    detail: 'Javi conversations, what Javi remembers about you, and your daily briefing',
  },
  { id: 'settings', label: 'Settings', kind: 'synced', group: 'database', detail: 'Theme, background, budget defaults, Home layout, focus timer' },
].map((entry) => Object.freeze(entry)));

export const STORAGE_GROUPS = Object.freeze(
  [
    { id: 'database', title: 'On this computer', description: "Saved in Burrow's data file on this computer" },
    { id: 'device', title: 'This browser only', description: 'Kept only in this browser' },
    { id: 'external', title: 'Live from other services', description: 'Fetched from the internet only if you turn it on' },
  ].map((group) => Object.freeze(group)),
);

/**
 * Pure: STORAGE_GROUPS in display order, each with its entries sorted by label.
 * Throws on an entry whose group is not in STORAGE_GROUPS so a new entry can never
 * silently vanish from the UI.
 */
export function groupStorageMap(entries = STORAGE_MAP) {
  const known = new Set(STORAGE_GROUPS.map((g) => g.id));
  const unknown = entries.find((entry) => !known.has(entry.group));
  if (unknown) throw new Error(`Unknown storage group "${unknown.group}" on entry "${unknown.id}"`);
  return STORAGE_GROUPS.map((group) => ({
    ...group,
    items: entries.filter((entry) => entry.group === group.id).sort((a, b) => a.label.localeCompare(b.label)),
  }));
}

/**
 * Pure: the "where is this stored" label and tone for one STORAGE_MAP entry.
 */
export function describeLocation(entry) {
  if (entry.kind === 'database' || entry.kind === 'synced') return { text: 'On this computer', tone: 'muted' };
  if (entry.kind === 'device') return { text: 'This browser only', tone: 'muted' };
  return { text: 'Online, if turned on', tone: 'muted' };
}
