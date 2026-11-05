import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clearStmtCache, prepareCached } from '../db/stmtCache.js';

let dir;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-stmt-'));
});
afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe('prepareCached', () => {
  it('returns the same statement for the same SQL on one handle', () => {
    const db = new DatabaseSync(':memory:');
    try {
      expect(prepareCached(db, 'SELECT 1 AS n')).toBe(prepareCached(db, 'SELECT 1 AS n'));
      expect(prepareCached(db, 'SELECT 1 AS n')).not.toBe(prepareCached(db, 'SELECT 2 AS n'));
    } finally {
      clearStmtCache(db);
      db.close();
    }
  });

  it('gives different handles different statements', () => {
    const a = new DatabaseSync(':memory:');
    const b = new DatabaseSync(':memory:');
    try {
      expect(prepareCached(a, 'SELECT 1')).not.toBe(prepareCached(b, 'SELECT 1'));
    } finally {
      clearStmtCache(a);
      clearStmtCache(b);
      a.close();
      b.close();
    }
  });

  it('clearStmtCache drops the cached statements', () => {
    const db = new DatabaseSync(':memory:');
    try {
      const first = prepareCached(db, 'SELECT 1');
      clearStmtCache(db);
      expect(prepareCached(db, 'SELECT 1')).not.toBe(first);
    } finally {
      clearStmtCache(db);
      db.close();
    }
  });

  it('does not cache SQL longer than 2048 characters', () => {
    const db = new DatabaseSync(':memory:');
    try {
      const sql = `SELECT ${'1,'.repeat(1100)}1`;
      expect(sql.length).toBeGreaterThan(2048);
      expect(prepareCached(db, sql)).not.toBe(prepareCached(db, sql));
    } finally {
      clearStmtCache(db);
      db.close();
    }
  });

  it('evicts the least recently used statement at the cap', () => {
    const db = new DatabaseSync(':memory:');
    try {
      const first = prepareCached(db, 'SELECT 0');
      const second = prepareCached(db, 'SELECT 1');
      for (let i = 2; i < 200; i += 1) prepareCached(db, `SELECT ${i}`);
      // Touch the oldest entry so 'SELECT 1' becomes the least recently used.
      expect(prepareCached(db, 'SELECT 0')).toBe(first);
      prepareCached(db, 'SELECT 200');
      expect(prepareCached(db, 'SELECT 0')).toBe(first);
      expect(prepareCached(db, 'SELECT 1')).not.toBe(second);
    } finally {
      clearStmtCache(db);
      db.close();
    }
  });

  it('lets the database file be renamed after clearStmtCache and close', () => {
    const file = path.join(dir, 'lock.db');
    const db = new DatabaseSync(file);
    expect(prepareCached(db, 'SELECT 1 AS n').get()).toEqual({ n: 1 });
    clearStmtCache(db);
    db.close();
    const moved = path.join(dir, 'lock-moved.db');
    expect(() => fs.renameSync(file, moved)).not.toThrow();
    expect(fs.existsSync(moved)).toBe(true);
  });
});
