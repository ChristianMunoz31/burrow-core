// Shared setup for the erase-all-data tests: a file-backed database in the per-file temp data dir
// seeded with one row in every table, plus the legacy license rows and files that older versions left behind.
import fs from 'node:fs';
import path from 'node:path';
import '../../audit.js';
import { TABLES, count, getDb, insert, select, upsert } from '../../db/index.js';
import {
  ACTIVATION_FILE_NAME,
  ACTIVATION_STATE_KEY,
  CLOCK_FILE_NAME,
  CLOCK_STATE_KEY,
  LICENSE_KEY_SECRET_NAME,
  TRIAL_FILE_NAME,
  TRIAL_NOTICES_STATE_KEY,
  TRIAL_STATE_KEY,
} from '../../license/constants.js';
import { resetBackupEnv, dataDir } from './backupEnv.js';
import { seedDb } from './testDb.js';

export const SENTINEL = 'BURROW_ERASE_SENTINEL_7f3a';

/** What the Burrow window itself sends: Origin and Host name the same page (supertest has no real port). */
export const SAME_ORIGIN = Object.freeze({ Host: '127.0.0.1:4321', Origin: 'http://127.0.0.1:4321' });

const DAY = '2026-10-05';
const STAMP = '2026-10-05T12:00:00.000Z';

/** One row in each module table (app_state, app_secrets and audit_log are filled by seedErasable). */
export function moduleRows() {
  return {
    transactions: [{ date: DAY, merchant: 'Sample Cafe', amount: 4.5, category: 'Food', type: 'expense' }],
    todo_columns: [{ name: 'Later', order: 1 }],
    todos: [{ title: 'Sample todo', status: 'todo' }],
    habits: [{ title: 'Stretch', frequency: 'daily' }],
    journal: [{ title: 'A day', date: STAMP, body: `Entry text ${SENTINEL}`, mood: 'good', tags: ['a'] }],
    calendar_events: [{ summary: 'Lunch', start_at: STAMP, end_at: STAMP, all_day: false }],
    notes: [{ body: `Note text ${SENTINEL}` }],
    bookmarks: [{ title: 'Docs', url: 'https://example.com/docs' }],
    focus_sessions: [{ kind: 'focus', duration_min: 25, started_at: STAMP }],
    countdowns: [{ title: 'Trip', target_date: '2027-01-01' }],
    jarvis_conversations: [{ title: 'Chat' }],
  };
}

/** Legacy license files that older versions kept in the data folder (nothing reads them now). */
export const LEGACY_LICENSE_FILES = Object.freeze([ACTIVATION_FILE_NAME, CLOCK_FILE_NAME, TRIAL_FILE_NAME]);

/** Fresh data dir and a migrated live database. */
export function freshDb() {
  return resetBackupEnv();
}

/**
 * Puts a row in every table, a saved API key, a legacy license key secret, profile, consent, categories,
 * onboarding, and the legacy license rows and files that older versions left behind.
 * @returns {{ db: import('node:sqlite').DatabaseSync, dir: string }}
 */
export function seedEverything() {
  const db = getDb();
  const dir = dataDir();
  const rows = seedDb(db, moduleRows());
  const conversationId = rows.jarvis_conversations[0].id;
  // Folders: a folder, one file and one chunk (the tables are a regenerable cache, but the wipe must empty them).
  const { folders } = seedDb(db, { folders: [{ name: 'Sample notes', path: 'C:/Sample/Notes', path_key: 'c:/sample/notes' }] });
  const { folder_files: files } = seedDb(db, { folder_files: [{ folder_id: folders[0].id, rel_path: 'a.txt', ext: 'txt', kind: 'text', status: 'ok' }] });
  seedDb(db, { folder_chunks: [{ folder_id: folders[0].id, file_id: files[0].id, seq: 0, start_line: 1, end_line: 1, text: 'sample chunk' }] });
  seedDb(db, {
    habit_completions: [{ habit_id: rows.habits[0].id, date: DAY }],
    jarvis_messages: [{ conversation_id: conversationId, role: 'user', content: 'hello there' }],
    jarvis_memory: [{ fact: 'Likes tea', category: 'preference', weight: 1, source_conversation_id: conversationId }],
    audit_log: [{ kind: 'llm', feature: 'javi_chat', status: 'ok' }],
  });
  const state = {
    profile: { displayName: 'Sample Name', onboardedAt: STAMP },
    'ai.cloudConsent': { version: 1, baseUrl: 'https://api.example.com/v1' },
    'ai.cloudCategories': { journal: true },
    'network.optIn': { weather: true },
    theme: 'dark',
  };
  for (const [key, value] of Object.entries(state)) upsert('app_state', { key, value }, { conflict: ['key'], db });
  for (const name of ['GROQ_API_KEY', LICENSE_KEY_SECRET_NAME]) {
    upsert(
      'app_secrets',
      { name, ciphertext: 'c2VhbGVk', iv: 'aXY', auth_tag: 'dGFn', last4: 'abcd' },
      { conflict: ['name'], db },
    );
  }
  for (const key of [ACTIVATION_STATE_KEY, CLOCK_STATE_KEY, TRIAL_STATE_KEY, TRIAL_NOTICES_STATE_KEY]) {
    upsert('app_state', { key, value: { legacy: true } }, { conflict: ['key'], db });
  }
  // The encryption key of saved API keys: Erase keeps it.
  fs.writeFileSync(path.join(dir, 'secrets.key'), 'a'.repeat(64));
  for (const file of LEGACY_LICENSE_FILES) fs.writeFileSync(path.join(dir, file), JSON.stringify({ legacy: true }));
  return { db, dir };
}

export const rowCounts = (db = getDb()) => Object.fromEntries(Object.keys(TABLES).map((t) => [t, count(t, { db })]));
export const stateKeys = (db = getDb()) => select('app_state', { columns: ['key'], db }).map((r) => r.key).sort();
export const secretNames = (db = getDb()) => select('app_secrets', { columns: ['name'], db }).map((r) => r.name).sort();
export const licenseRows = (db = getDb()) =>
  Object.fromEntries(
    select('app_state', { columns: ['key', 'value'], db })
      .filter((r) => r.key.startsWith('license.'))
      .map((r) => [r.key, r.value]),
  );

const TEXTY_TYPES = new Set(['text', 'jsonb', 'text[]']);

// A row that satisfies the NOT NULL columns of each table, so one sentinel column can be varied at a time.
const baseRow = (table, conversationId, folder) =>
  ({
    ...Object.fromEntries(Object.entries(moduleRows()).map(([t, rows]) => [t, rows[0]])),
    habit_completions: undefined,
    jarvis_messages: { conversation_id: conversationId, role: 'user', content: 'x' },
    jarvis_memory: { fact: 'x', category: 'preference', weight: 1 },
    audit_log: { kind: 'llm', feature: 'javi_chat', status: 'ok' },
    app_state: { value: { k: 1 } },
    app_secrets: { name: 'GROQ_API_KEY', ciphertext: 'c2VhbGVk', iv: 'aXY', auth_tag: 'dGFn', last4: 'abcd' },
    folders: { name: 'F', path: 'C:/F', path_key: 'k' },
    folder_files: { folder_id: folder.folderId, rel_path: 'f.txt', kind: 'text', status: 'ok' },
    folder_chunks: { folder_id: folder.folderId, file_id: folder.fileId, seq: 0, start_line: 1, end_line: 1, text: 'x' },
  })[table];

// Columns with a UNIQUE constraint get a value of their own in every planted row.
const uniqueFor = (table, label, n) =>
  ({
    folders: { path_key: `pk-${label}-${n}` },
    folder_files: { rel_path: `f-${label}-${n}.txt` },
    folder_chunks: { seq: (label === 'a' ? 0 : 5000) + n },
  })[table] ?? {};

const sentinelFor = (type, n) => {
  const text = `${SENTINEL}_${n}`;
  if (type === 'jsonb') return { s: text };
  if (type === 'text[]') return [text];
  return text;
};

/**
 * Puts the sentinel into every text, json and text[] column of every table (one row per column, built
 * from TABLES), after a first pass that is then updated and partly deleted, so old frames reach the WAL.
 * A column whose CHECK constraint refuses the sentinel (an enum, a pattern, a length cap) is reported in
 * `skipped` instead of being silently left out.
 * @returns {{ planted: string[], skipped: string[] }} `table.column` names
 */
export function plantSentinelEverywhere(db = getDb()) {
  const planted = [];
  const skipped = [];
  const conversationId = select('jarvis_conversations', { columns: ['id'], db })[0].id;
  const folder = { folderId: select('folders', { columns: ['id'], db })[0].id, fileId: select('folder_files', { columns: ['id'], db })[0].id };
  const pass = (label) => {
    let n = 0;
    for (const [table, def] of Object.entries(TABLES)) {
      const base = baseRow(table, conversationId, folder);
      if (!base) continue;
      for (const [column, type] of Object.entries(def.columns)) {
        if (!TEXTY_TYPES.has(type)) continue;
        n += 1;
        const row = { ...base, ...uniqueFor(table, label, n) };
        if (def.primaryKey === 'key') row.key = `sentinel.${label}.${n}`;
        if (def.primaryKey === 'name') row.name = 'GROQ_API_KEY';
        row[column] = sentinelFor(type, `${label}${n}`);
        try {
          if (def.primaryKey === 'key' || def.primaryKey === 'name') upsert(table, row, { conflict: [def.primaryKey], db });
          else insert(table, row, { db });
          if (label === 'b') planted.push(`${table}.${column}`);
        } catch {
          if (label === 'b') skipped.push(`${table}.${column}`);
        }
      }
    }
  };
  pass('a');
  // Updates and deletes first: the first pass's text is rewritten and removed, leaving old frames behind.
  db.exec(`UPDATE notes SET body = body || ' ${'x'.repeat(2000)}'`);
  db.exec(`UPDATE journal SET body = body || ' ${'y'.repeat(2000)}', title = 'rewritten'`);
  db.exec(`DELETE FROM transactions WHERE merchant LIKE '${SENTINEL}%'`);
  db.exec(`DELETE FROM jarvis_memory`);
  pass('b');
  for (const [key, value] of Object.entries({
    profile: { displayName: `${SENTINEL}_name`, onboardedAt: STAMP },
    'ai.cloudConsent': { version: 1, baseUrl: `https://api.example.com/${SENTINEL}` },
  })) {
    upsert('app_state', { key, value }, { conflict: ['key'], db });
  }
  return { planted, skipped };
}

/**
 * Every file under `dir` (recursively) whose bytes contain `needle`, except the named top-level
 * directories and file names.
 * @returns {string[]} paths relative to dir
 */
export function filesContaining(dir, needle = SENTINEL, { skipDirs = [], skipFiles = [] } = {}) {
  const found = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      const rel = path.relative(dir, full);
      if (entry.isDirectory()) {
        if (!skipDirs.includes(rel)) walk(full);
      } else if (!skipFiles.includes(rel) && fs.readFileSync(full).includes(Buffer.from(needle))) {
        found.push(rel);
      }
    }
  };
  walk(dir);
  return found;
}

/** Raw bytes of burrow.db, its WAL and its shared-memory file (whichever exist). */
export function rawDbBytes(dir = dataDir()) {
  return ['burrow.db', 'burrow.db-wal', 'burrow.db-shm']
    .map((n) => path.join(dir, n))
    .filter((f) => fs.existsSync(f))
    .map((f) => fs.readFileSync(f));
}
