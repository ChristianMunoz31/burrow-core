// Strict allowlist for the read-only data browser. A table name reaches the db query
// helper ONLY as `def.id` from this list (the helper re-validates it against TABLES).
// app_secrets and audit_log are deliberately absent.

/** @typedef {'uuid'|'text'|'date'|'timestamptz'|'numeric'|'integer'|'real'|'boolean'|'jsonb'|'text[]'} ColType */
/** @typedef {{ id: string, label: string, group: string, primaryKey: string,
 *   columns: { name: string, type: ColType }[],
 *   sortable: string[], search: string[],
 *   defaultSort: { column: string, order: 'asc'|'desc' },
 *   dateColumn: string|null, amountColumn: string|null, redact?: 'app_state' }} DataTableDef */

const cols = (spec) =>
  Object.freeze(
    spec.split(',').map((pair) => {
      const [name, type] = pair.trim().split(':');
      return Object.freeze({ name, type });
    }),
  );

const def = (d) =>
  Object.freeze({
    amountColumn: null,
    primaryKey: 'id',
    ...d,
    sortable: Object.freeze(d.sortable),
    search: Object.freeze(d.search),
    defaultSort: Object.freeze(d.defaultSort),
  });

/** @type {ReadonlyArray<DataTableDef>} */
export const DATA_TABLES = Object.freeze([
  def({
    id: 'transactions',
    label: 'Transactions',
    group: 'Money',
    columns: cols('id:uuid,date:date,merchant:text,amount:numeric,category:text,type:text,source_file:text,created_at:timestamptz'),
    sortable: ['date', 'merchant', 'amount', 'category', 'type', 'created_at'],
    search: ['merchant', 'category', 'type', 'source_file'],
    defaultSort: { column: 'date', order: 'desc' },
    dateColumn: 'date',
    amountColumn: 'amount',
  }),
  def({
    id: 'todos',
    label: 'Todos',
    group: 'Plan',
    columns: cols('id:uuid,title:text,description:text,done:boolean,due:date,priority:text,status:text,context:text,order:integer,created_at:timestamptz'),
    sortable: ['title', 'done', 'due', 'priority', 'status', 'order', 'created_at'],
    search: ['title', 'description', 'priority', 'status', 'context'],
    defaultSort: { column: 'created_at', order: 'desc' },
    dateColumn: 'created_at',
  }),
  def({
    id: 'todo_columns',
    label: 'Todo columns',
    group: 'Plan',
    columns: cols('id:uuid,name:text,order:integer,color:text,created_at:timestamptz'),
    sortable: ['name', 'order', 'created_at'],
    search: ['name', 'color'],
    defaultSort: { column: 'order', order: 'asc' },
    dateColumn: 'created_at',
  }),
  def({
    id: 'habits',
    label: 'Habits',
    group: 'Plan',
    columns: cols('id:uuid,title:text,frequency:text,color:text,context:text,created_at:timestamptz'),
    sortable: ['title', 'frequency', 'created_at'],
    search: ['title', 'frequency', 'color', 'context'],
    defaultSort: { column: 'created_at', order: 'desc' },
    dateColumn: 'created_at',
  }),
  def({
    id: 'habit_completions',
    label: 'Habit completions',
    group: 'Plan',
    columns: cols('id:uuid,habit_id:uuid,date:date,created_at:timestamptz'),
    sortable: ['date', 'created_at'],
    search: [],
    defaultSort: { column: 'date', order: 'desc' },
    dateColumn: 'date',
  }),
  def({
    id: 'notes',
    label: 'Notes',
    group: 'Notes',
    columns: cols('id:uuid,body:text,color:text,pinned:boolean,context:text,created_at:timestamptz'),
    sortable: ['pinned', 'color', 'created_at'],
    search: ['body', 'color', 'context'],
    defaultSort: { column: 'created_at', order: 'desc' },
    dateColumn: 'created_at',
  }),
  def({
    id: 'journal',
    label: 'Journal',
    group: 'Notes',
    columns: cols('id:uuid,title:text,date:timestamptz,body:text,mood:text,tags:text[],context:text,created_at:timestamptz'),
    sortable: ['date', 'title', 'mood', 'created_at'],
    search: ['title', 'body', 'mood', 'context'],
    defaultSort: { column: 'date', order: 'desc' },
    dateColumn: 'date',
  }),
  def({
    id: 'bookmarks',
    label: 'Bookmarks',
    group: 'Notes',
    columns: cols('id:uuid,title:text,url:text,category:text,context:text,created_at:timestamptz'),
    sortable: ['title', 'category', 'created_at'],
    search: ['title', 'url', 'category', 'context'],
    defaultSort: { column: 'created_at', order: 'desc' },
    dateColumn: 'created_at',
  }),
  def({
    id: 'countdowns',
    label: 'Countdowns',
    group: 'Plan',
    columns: cols('id:uuid,title:text,target_date:date,context:text,created_at:timestamptz'),
    sortable: ['title', 'target_date', 'created_at'],
    search: ['title', 'context'],
    defaultSort: { column: 'target_date', order: 'asc' },
    dateColumn: 'created_at',
  }),
  def({
    id: 'calendar_events',
    label: 'Calendar events',
    group: 'Plan',
    columns: cols('id:uuid,summary:text,description:text,location:text,start_at:timestamptz,end_at:timestamptz,all_day:boolean,source:text,uid:text,context:text,created_at:timestamptz'),
    sortable: ['start_at', 'end_at', 'summary', 'source', 'created_at'],
    search: ['summary', 'description', 'location', 'source', 'context'],
    defaultSort: { column: 'start_at', order: 'desc' },
    dateColumn: 'start_at',
  }),
  def({
    id: 'focus_sessions',
    label: 'Focus sessions',
    group: 'Plan',
    columns: cols('id:uuid,kind:text,duration_min:integer,context:text,started_at:timestamptz,created_at:timestamptz'),
    sortable: ['started_at', 'duration_min', 'kind', 'created_at'],
    search: ['kind', 'context'],
    defaultSort: { column: 'started_at', order: 'desc' },
    dateColumn: 'started_at',
  }),
  def({
    id: 'jarvis_conversations',
    label: 'Javi conversations',
    group: 'Javi',
    columns: cols('id:uuid,title:text,created_at:timestamptz,updated_at:timestamptz'),
    sortable: ['title', 'created_at', 'updated_at'],
    search: ['title'],
    defaultSort: { column: 'updated_at', order: 'desc' },
    dateColumn: 'created_at',
  }),
  def({
    id: 'jarvis_messages',
    label: 'Javi messages',
    group: 'Javi',
    columns: cols('id:uuid,conversation_id:uuid,role:text,content:text,tool_calls:jsonb,tool_call_id:text,created_at:timestamptz'),
    sortable: ['role', 'created_at'],
    search: ['role', 'content'],
    defaultSort: { column: 'created_at', order: 'desc' },
    dateColumn: 'created_at',
  }),
  def({
    id: 'jarvis_memory',
    label: 'Javi memory',
    group: 'Javi',
    columns: cols('id:uuid,fact:text,category:text,weight:real,source_conversation_id:uuid,created_at:timestamptz,updated_at:timestamptz'),
    sortable: ['category', 'weight', 'created_at', 'updated_at'],
    search: ['fact', 'category'],
    defaultSort: { column: 'weight', order: 'desc' },
    dateColumn: 'created_at',
  }),
  def({
    id: 'app_state',
    label: 'Preferences',
    group: 'Preferences',
    primaryKey: 'key',
    columns: cols('key:text,value:jsonb,updated_at:timestamptz'),
    sortable: ['key', 'updated_at'],
    search: ['key'],
    defaultSort: { column: 'key', order: 'asc' },
    dateColumn: 'updated_at',
    redact: 'app_state',
  }),
]);

const BY_ID = new Map(DATA_TABLES.map((t) => [t.id, t]));

/** @param {unknown} id @returns {DataTableDef | undefined} */
export const getTableDef = (id) => (typeof id === 'string' ? BY_ID.get(id) : undefined);
