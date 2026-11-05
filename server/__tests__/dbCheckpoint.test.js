// closeDb checkpoints the WAL (TRUNCATE) before closing.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { clearDbShutdown, closeDb, getDb, openDb, setDbForTests, shutdownDb } from '../db/index.js';

describe('closeDb', () => {
  it('truncates the WAL and removes it on close', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-wal-'));
    const file = path.join(dir, 'burrow.db');
    try {
      const db = openDb({ filename: file });
      setDbForTests(db);
      db.exec('CREATE TABLE wal_probe (id INTEGER PRIMARY KEY, v TEXT)');
      for (let i = 0; i < 50; i += 1) db.prepare('INSERT INTO wal_probe (v) VALUES (?)').run('x'.repeat(500));
      expect(fs.statSync(`${file}-wal`).size).toBeGreaterThan(0);

      closeDb();

      expect(fs.existsSync(`${file}-wal`)).toBe(false);
      const reopened = openDb({ filename: file, migrate: false });
      try {
        expect(reopened.prepare('SELECT COUNT(*) AS n FROM wal_probe').get().n).toBe(50);
      } finally {
        reopened.close();
      }
    } finally {
      setDbForTests(null);
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('is idempotent', () => {
    setDbForTests(null);
    expect(() => closeDb()).not.toThrow();
  });

  it('shutdownDb closes the handle and getDb then refuses to reopen until cleared', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-shutdown-'));
    const saved = process.env.BURROW_TEST_DATA_DIR;
    process.env.BURROW_TEST_DATA_DIR = dir;
    try {
      setDbForTests(null);
      expect(getDb()).toBeTruthy();
      shutdownDb();
      expect(() => getDb()).toThrow(expect.objectContaining({ code: 'db_unavailable' }));
      // plain closeDb keeps the reopen-friendly behaviour for everything else
      clearDbShutdown();
      expect(getDb()).toBeTruthy();
      closeDb();
      expect(getDb()).toBeTruthy();
    } finally {
      closeDb();
      clearDbShutdown();
      if (saved === undefined) delete process.env.BURROW_TEST_DATA_DIR;
      else process.env.BURROW_TEST_DATA_DIR = saved;
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});
