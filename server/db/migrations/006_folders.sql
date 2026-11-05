-- Burrow schema v6: Folders. Folders the user picked on this computer, a read-only file inventory,
-- cached summaries and the optional local question index. Source files are never copied or changed;
-- these tables are a cache that a re-scan rebuilds. Status columns are validated in code.
CREATE TABLE folders (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  path TEXT NOT NULL CHECK (length(path) BETWEEN 1 AND 1024),
  path_key TEXT NOT NULL UNIQUE,
  auto_rescan INTEGER NOT NULL DEFAULT 0 CHECK (auto_rescan IN (0, 1)),
  stats TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(stats)),
  summary TEXT,
  summary_status TEXT NOT NULL DEFAULT 'none',
  summary_model TEXT,
  summary_input_hash TEXT,
  summary_at TEXT,
  report TEXT,
  report_model TEXT,
  report_at TEXT,
  last_scan_at TEXT,
  last_job_status TEXT,
  last_job_error TEXT,
  last_job_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE folder_files (
  id TEXT PRIMARY KEY,
  folder_id TEXT NOT NULL REFERENCES folders (id) ON DELETE CASCADE,
  rel_path TEXT NOT NULL CHECK (length(rel_path) BETWEEN 1 AND 1024),
  ext TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  mtime TEXT,
  sha256 TEXT,
  line_count INTEGER,
  word_count INTEGER,
  char_count INTEGER,
  summary TEXT,
  summary_status TEXT NOT NULL DEFAULT 'none',
  summary_hash TEXT,
  summary_model TEXT,
  index_hash TEXT,
  index_model TEXT,
  chunk_count INTEGER NOT NULL DEFAULT 0,
  seen_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (folder_id, rel_path)
);
CREATE TABLE folder_chunks (
  id TEXT PRIMARY KEY,
  folder_id TEXT NOT NULL REFERENCES folders (id) ON DELETE CASCADE,
  file_id TEXT NOT NULL REFERENCES folder_files (id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  text TEXT NOT NULL,
  embedding TEXT,
  dims INTEGER,
  created_at TEXT NOT NULL,
  UNIQUE (file_id, seq)
);
CREATE INDEX folder_chunks_folder_idx ON folder_chunks (folder_id);
