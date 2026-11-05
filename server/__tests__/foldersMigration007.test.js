// Migration 007: folders.confirm_state. A database at schema 6 keeps its folders and every one of them stays readable
// (confirm_state 'ok'); the column accepts only 'ok' and 'needs_confirm'; the lock file pins the migration.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { loadMigrations, migrate } from '../db/migrate.js';

const LOCK = JSON.parse(fs.readFileSync(new URL('../db/migrations.lock.json', import.meta.url), 'utf8'));

describe('migration 007_folder_confirm', () => {
  it('upgrades a version 6 database: existing folders are confirmed, files and chunks stay', () => {
    const all = loadMigrations();
    const db = new DatabaseSync(':memory:');
    try {
      migrate(db, { migrations: all.filter((m) => m.version <= 6) });
      db.exec(`INSERT INTO folders (id, name, path, path_key, created_at, updated_at) VALUES ('f1', 'Notes', 'C:\\x', 'k', '2026-01-01', '2026-01-01')`);
      db.exec(`INSERT INTO folder_files (id, folder_id, rel_path, kind, status, created_at) VALUES ('a', 'f1', 'p.txt', 'text', 'ok', '2026-01-01')`);
      db.exec(`INSERT INTO folder_chunks (id, folder_id, file_id, seq, start_line, end_line, text, created_at) VALUES ('c', 'f1', 'a', 0, 1, 1, 't', '2026-01-01')`);
      expect(db.prepare('PRAGMA table_info(folders)').all().map((c) => c.name)).not.toContain('confirm_state');
      migrate(db, { migrations: all });
      expect(db.prepare('SELECT MAX(version) AS v FROM schema_version').get().v).toBe(7);
      expect(db.prepare('SELECT id, confirm_state FROM folders').all()).toEqual([{ id: 'f1', confirm_state: 'ok' }]);
      expect(db.prepare('SELECT COUNT(*) AS n FROM folder_files').get().n).toBe(1);
      expect(db.prepare('SELECT COUNT(*) AS n FROM folder_chunks').get().n).toBe(1);
    } finally {
      db.close();
    }
  });

  it('the column accepts only ok and needs_confirm, and defaults to ok', () => {
    const db = new DatabaseSync(':memory:');
    try {
      migrate(db, { migrations: loadMigrations() });
      const insert = (id, state) =>
        db.exec(`INSERT INTO folders (id, name, path, path_key, ${state ? 'confirm_state, ' : ''}created_at, updated_at) VALUES ('${id}', 'n', 'p', 'k-${id}', ${state ? `'${state}', ` : ''}'2026-01-01', '2026-01-01')`);
      insert('a');
      insert('b', 'needs_confirm');
      expect(() => insert('c', 'bogus')).toThrow();
      expect(db.prepare('SELECT id, confirm_state FROM folders ORDER BY id').all()).toEqual([
        { id: 'a', confirm_state: 'ok' },
        { id: 'b', confirm_state: 'needs_confirm' },
      ]);
    } finally {
      db.close();
    }
  });

  it('is pinned in the lock file by the hash of its text with LF line endings', () => {
    const sql = fs.readFileSync(new URL('../db/migrations/007_folder_confirm.sql', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    expect(LOCK['007_folder_confirm.sql']).toBe(crypto.createHash('sha256').update(sql).digest('hex'));
    expect(Object.keys(LOCK)).toHaveLength(7);
    expect(LOCK['006_folders.sql']).toBe('c7b9f65f8761d4e5b5fd7668b68716cf2ea9bf0cceae5260727c6de7e9441a6e');
  });
});
