// Plain-language names for Burrow's data types, used where a table id would otherwise show
// (restore preview). Keep in sync with server/dataBrowser/tables.js labels.
const TABLE_LABELS = Object.freeze({
  transactions: 'Transactions',
  todos: 'Todos',
  todo_columns: 'Todo columns',
  habits: 'Habits',
  habit_completions: 'Habit completions',
  notes: 'Notes',
  journal: 'Journal',
  bookmarks: 'Bookmarks',
  countdowns: 'Countdowns',
  calendar_events: 'Calendar events',
  focus_sessions: 'Focus sessions',
  jarvis_conversations: 'Javi conversations',
  jarvis_messages: 'Javi messages',
  jarvis_memory: 'Javi memory',
  app_state: 'Preferences',
  folders: 'Folders',
  folder_files: 'Folder files',
});

/** Friendly label for a table id; unknown ids fall back to the id. */
export const tableLabel = (id) => TABLE_LABELS[id] ?? id;
