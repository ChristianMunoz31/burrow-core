-- Burrow schema v1 (translated from the retired scripts/schema.sql).
-- Timestamps: TEXT 'YYYY-MM-DDTHH:MM:SS.sssZ'. Dates: TEXT 'YYYY-MM-DD'. Booleans: INTEGER 0/1.
-- JSON (jsonb / text[]): TEXT holding JSON. ids: TEXT uuid generated in JS.

CREATE TABLE transactions (
  id TEXT PRIMARY KEY NOT NULL,
  date TEXT,
  merchant TEXT,
  amount REAL,
  category TEXT,
  type TEXT,
  source_file TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;
CREATE INDEX transactions_date_idx ON transactions (date);
CREATE INDEX transactions_source_file_idx ON transactions (source_file);

CREATE TABLE todo_columns (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  "order" INTEGER NOT NULL DEFAULT 0,
  color TEXT DEFAULT 'gray',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;

CREATE TABLE todos (
  id TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  done INTEGER NOT NULL DEFAULT 0 CHECK (done IN (0, 1)),
  due TEXT,
  priority TEXT DEFAULT 'medium',
  status TEXT,
  context TEXT DEFAULT 'both',
  "order" INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;
CREATE INDEX todos_created_idx ON todos (created_at);

CREATE TABLE habits (
  id TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL,
  frequency TEXT DEFAULT 'daily',
  color TEXT DEFAULT 'blue',
  context TEXT DEFAULT 'both',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;

CREATE TABLE habit_completions (
  id TEXT PRIMARY KEY NOT NULL,
  habit_id TEXT NOT NULL REFERENCES habits (id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;
CREATE INDEX habit_completions_habit_idx ON habit_completions (habit_id);
CREATE INDEX habit_completions_date_idx ON habit_completions (date);

CREATE TABLE journal (
  id TEXT PRIMARY KEY NOT NULL,
  title TEXT,
  date TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  body TEXT NOT NULL,
  mood TEXT,
  tags TEXT DEFAULT '[]' CHECK (tags IS NULL OR (json_valid(tags) AND json_type(tags) = 'array')),
  context TEXT DEFAULT 'both',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;
CREATE INDEX journal_date_idx ON journal (date DESC);

CREATE TABLE calendar_events (
  id TEXT PRIMARY KEY NOT NULL,
  summary TEXT NOT NULL,
  description TEXT DEFAULT '',
  location TEXT DEFAULT '',
  start_at TEXT NOT NULL,
  end_at TEXT,
  all_day INTEGER NOT NULL DEFAULT 0 CHECK (all_day IN (0, 1)),
  source TEXT NOT NULL DEFAULT 'manual',
  uid TEXT,
  context TEXT DEFAULT 'both',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;
CREATE INDEX calendar_events_start_idx ON calendar_events (start_at);
CREATE INDEX calendar_events_uid_idx ON calendar_events (uid);

CREATE TABLE notes (
  id TEXT PRIMARY KEY NOT NULL,
  body TEXT NOT NULL,
  color TEXT DEFAULT 'yellow',
  pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  context TEXT DEFAULT 'both',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;
CREATE INDEX notes_created_idx ON notes (created_at DESC);

CREATE TABLE bookmarks (
  id TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  category TEXT DEFAULT '',
  context TEXT DEFAULT 'both',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;
CREATE INDEX bookmarks_category_idx ON bookmarks (category);

CREATE TABLE focus_sessions (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL DEFAULT 'focus',
  duration_min INTEGER NOT NULL,
  context TEXT DEFAULT 'both',
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;
CREATE INDEX focus_sessions_started_idx ON focus_sessions (started_at DESC);

CREATE TABLE countdowns (
  id TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL,
  target_date TEXT NOT NULL,
  context TEXT DEFAULT 'both',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;
CREATE INDEX countdowns_target_idx ON countdowns (target_date);

CREATE TABLE app_state (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL CHECK (json_valid(value)),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;

CREATE TABLE jarvis_conversations (
  id TEXT PRIMARY KEY NOT NULL,
  title TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;

CREATE TABLE jarvis_messages (
  id TEXT PRIMARY KEY NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES jarvis_conversations (id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT,
  tool_calls TEXT CHECK (tool_calls IS NULL OR json_valid(tool_calls)),
  tool_call_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;
CREATE INDEX jarvis_messages_conv_idx ON jarvis_messages (conversation_id, created_at);

CREATE TABLE jarvis_memory (
  id TEXT PRIMARY KEY NOT NULL,
  fact TEXT NOT NULL,
  category TEXT DEFAULT 'general',
  weight REAL NOT NULL DEFAULT 1.0,
  source_conversation_id TEXT REFERENCES jarvis_conversations (id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;
CREATE INDEX jarvis_memory_category_idx ON jarvis_memory (category);
CREATE INDEX jarvis_memory_weight_idx ON jarvis_memory (weight DESC);

-- AES-256-GCM ciphertext only; plaintext never stored. Never exported.
CREATE TABLE app_secrets (
  name TEXT PRIMARY KEY NOT NULL,
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  auth_tag TEXT NOT NULL,
  last4 TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  -- was: name ~ '^[A-Z][A-Z0-9_]{1,63}$'
  CONSTRAINT app_secrets_name_chk CHECK (
    length(name) BETWEEN 2 AND 64
    AND substr(name, 1, 1) BETWEEN 'A' AND 'Z'
    AND name NOT GLOB '*[^A-Z0-9_]*'
  ),
  CONSTRAINT app_secrets_last4_chk CHECK (length(last4) BETWEEN 1 AND 4)
) STRICT;

-- Access & AI audit log. Redacted, size-capped context only. Pruned to 90 days / 5,000 rows.
CREATE TABLE audit_log (
  id TEXT PRIMARY KEY NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  kind TEXT NOT NULL,
  feature TEXT NOT NULL,
  page TEXT,
  provider TEXT,
  model TEXT,
  status TEXT NOT NULL DEFAULT 'ok',
  context TEXT,
  meta TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(meta)),
  CONSTRAINT audit_log_kind_chk CHECK (kind IN ('llm', 'export', 'auth')),
  CONSTRAINT audit_log_status_chk CHECK (status IN ('ok', 'error')),
  -- was: feature ~ '^[a-z0-9_]{1,40}$'
  CONSTRAINT audit_log_feature_chk CHECK (length(feature) BETWEEN 1 AND 40 AND feature NOT GLOB '*[^a-z0-9_]*'),
  CONSTRAINT audit_log_page_len_chk CHECK (page IS NULL OR length(page) <= 40),
  CONSTRAINT audit_log_provider_len_chk CHECK (provider IS NULL OR length(provider) <= 20),
  CONSTRAINT audit_log_model_len_chk CHECK (model IS NULL OR length(model) <= 80),
  CONSTRAINT audit_log_context_len_chk CHECK (context IS NULL OR length(context) <= 2000)
) STRICT;
CREATE INDEX audit_log_created_idx ON audit_log (created_at DESC);
