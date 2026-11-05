// Column-type map: the single source of truth for the codec and the query helper.
// ColType = 'uuid'|'text'|'date'|'timestamptz'|'numeric'|'integer'|'real'|'boolean'|'jsonb'|'text[]'
import { DbError } from './errors.js';

const table = (primaryKey, autoNow, columns) =>
  Object.freeze({
    primaryKey,
    autoNow: Object.freeze(autoNow),
    columns: Object.freeze(columns),
  });

export const TABLES = Object.freeze({
  transactions: table('id', ['created_at'], {
    id: 'uuid', date: 'date', merchant: 'text', amount: 'numeric', category: 'text', type: 'text',
    source_file: 'text', created_at: 'timestamptz',
  }),
  todo_columns: table('id', ['created_at'], {
    id: 'uuid', name: 'text', order: 'integer', color: 'text', created_at: 'timestamptz',
  }),
  todos: table('id', ['created_at'], {
    id: 'uuid', title: 'text', description: 'text', done: 'boolean', due: 'date', priority: 'text',
    status: 'text', context: 'text', order: 'integer', created_at: 'timestamptz',
  }),
  habits: table('id', ['created_at'], {
    id: 'uuid', title: 'text', frequency: 'text', color: 'text', context: 'text', created_at: 'timestamptz',
  }),
  habit_completions: table('id', ['created_at'], {
    id: 'uuid', habit_id: 'uuid', date: 'date', created_at: 'timestamptz',
  }),
  journal: table('id', ['date', 'created_at'], {
    id: 'uuid', title: 'text', date: 'timestamptz', body: 'text', mood: 'text', tags: 'text[]',
    context: 'text', created_at: 'timestamptz',
  }),
  calendar_events: table('id', ['created_at'], {
    id: 'uuid', summary: 'text', description: 'text', location: 'text', start_at: 'timestamptz',
    end_at: 'timestamptz', all_day: 'boolean', source: 'text', uid: 'text', context: 'text',
    created_at: 'timestamptz',
  }),
  notes: table('id', ['created_at'], {
    id: 'uuid', body: 'text', color: 'text', pinned: 'boolean', context: 'text', created_at: 'timestamptz',
  }),
  bookmarks: table('id', ['created_at'], {
    id: 'uuid', title: 'text', url: 'text', category: 'text', context: 'text', created_at: 'timestamptz',
  }),
  focus_sessions: table('id', ['started_at', 'created_at'], {
    id: 'uuid', kind: 'text', duration_min: 'integer', context: 'text', started_at: 'timestamptz',
    created_at: 'timestamptz',
  }),
  countdowns: table('id', ['created_at'], {
    id: 'uuid', title: 'text', target_date: 'date', context: 'text', created_at: 'timestamptz',
  }),
  app_state: table('key', ['updated_at'], {
    key: 'text', value: 'jsonb', updated_at: 'timestamptz',
  }),
  jarvis_conversations: table('id', ['created_at', 'updated_at'], {
    id: 'uuid', title: 'text', created_at: 'timestamptz', updated_at: 'timestamptz',
  }),
  jarvis_messages: table('id', ['created_at'], {
    id: 'uuid', conversation_id: 'uuid', role: 'text', content: 'text', tool_calls: 'jsonb',
    tool_call_id: 'text', created_at: 'timestamptz',
  }),
  jarvis_memory: table('id', ['created_at', 'updated_at'], {
    id: 'uuid', fact: 'text', category: 'text', weight: 'real', source_conversation_id: 'uuid',
    created_at: 'timestamptz', updated_at: 'timestamptz',
  }),
  app_secrets: table('name', ['updated_at'], {
    name: 'text', ciphertext: 'text', iv: 'text', auth_tag: 'text', last4: 'text', updated_at: 'timestamptz',
  }),
  audit_log: table('id', ['created_at'], {
    id: 'uuid', created_at: 'timestamptz', kind: 'text', feature: 'text', page: 'text', provider: 'text',
    model: 'text', status: 'text', context: 'text', meta: 'jsonb',
  }),
  // Folders module: folders the user picked, plus what Burrow read from them. Exported and imported through
  // FOLDER_ARCHIVE_TABLES (insert-only, paused until confirmed), never through IMPORT_ORDER; folder_chunks never.
  folders: table('id', ['created_at', 'updated_at'], {
    id: 'uuid', name: 'text', path: 'text', path_key: 'text', auto_rescan: 'boolean', stats: 'jsonb',
    summary: 'text', summary_status: 'text', summary_model: 'text', summary_input_hash: 'text',
    summary_at: 'timestamptz', report: 'text', report_model: 'text', report_at: 'timestamptz',
    last_scan_at: 'timestamptz', last_job_status: 'text', last_job_error: 'text', last_job_at: 'timestamptz',
    created_at: 'timestamptz', updated_at: 'timestamptz',
    confirm_state: 'text',
  }),
  folder_files: table('id', ['created_at'], {
    id: 'uuid', folder_id: 'uuid', rel_path: 'text', ext: 'text', kind: 'text', status: 'text',
    size_bytes: 'integer', mtime: 'timestamptz', sha256: 'text', line_count: 'integer', word_count: 'integer',
    char_count: 'integer', summary: 'text', summary_status: 'text', summary_hash: 'text', summary_model: 'text',
    index_hash: 'text', index_model: 'text', chunk_count: 'integer', seen_at: 'timestamptz',
    created_at: 'timestamptz',
  }),
  folder_chunks: table('id', ['created_at'], {
    id: 'uuid', folder_id: 'uuid', file_id: 'uuid', seq: 'integer', start_line: 'integer', end_line: 'integer',
    text: 'text', embedding: 'text', dims: 'integer', created_at: 'timestamptz',
  }),
});

// FK parents first. Exactly the 15 exportable/importable tables (no app_secrets, no audit_log).
export const IMPORT_ORDER = Object.freeze([
  'transactions', 'todo_columns', 'todos', 'habits', 'habit_completions', 'journal', 'calendar_events',
  'notes', 'bookmarks', 'focus_sessions', 'countdowns', 'app_state', 'jarvis_conversations',
  'jarvis_messages', 'jarvis_memory',
]);

// The Folders tables an export archive carries and an import accepts (parents first). Handled by their own insert-only
// rules (server/folders/importRules.js); folder_chunks (chunk text and vectors) is never archived.
export const FOLDER_ARCHIVE_TABLES = Object.freeze(['folders', 'folder_files']);

const fk = (tbl, column, refTable, onDelete) =>
  Object.freeze({
    table: tbl,
    column,
    references: Object.freeze({ table: refTable, column: 'id' }),
    onDelete,
  });

export const FOREIGN_KEYS = Object.freeze([
  fk('habit_completions', 'habit_id', 'habits', 'cascade'),
  fk('jarvis_messages', 'conversation_id', 'jarvis_conversations', 'cascade'),
  fk('jarvis_memory', 'source_conversation_id', 'jarvis_conversations', 'set_null'),
  fk('folder_files', 'folder_id', 'folders', 'cascade'),
  fk('folder_chunks', 'folder_id', 'folders', 'cascade'),
  fk('folder_chunks', 'file_id', 'folder_files', 'cascade'),
]);

/**
 * Returns the table definition; throws DbError('unknown_table') for anything not in TABLES.
 * @param {string} name
 */
export function getTable(name) {
  if (typeof name !== 'string' || !Object.hasOwn(TABLES, name)) {
    throw new DbError('unknown_table', 'Unknown table');
  }
  return TABLES[name];
}

/**
 * @param {string} tableName
 * @param {string} column
 * @returns {boolean}
 */
export function hasColumn(tableName, column) {
  return (
    typeof tableName === 'string' &&
    Object.hasOwn(TABLES, tableName) &&
    typeof column === 'string' &&
    Object.hasOwn(TABLES[tableName].columns, column)
  );
}
