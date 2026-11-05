// Every table must be classified as erased or kept-in-part, so a new table cannot silently survive an erase
// (or be wiped by mistake). Adding a table to server/db/tables.js fails here until it is classified.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PROTECTED_APP_STATE_KEYS } from '../import/importExport.js';
import { TABLES, getDb } from '../db/index.js';
import { TABLE_CLASS, tablesToErase } from '../erase/eraseService.js';

import { cleanupBackupEnv } from './helpers/backupEnv.js';
import { freshDb } from './helpers/eraseEnv.js';

describe('erase classification against a migrated database', () => {
  beforeEach(() => {
    freshDb();
  });
  afterEach(() => {
    cleanupBackupEnv();
  });

  it('every user table the migrations create (minus schema_version) is classified, and nothing else is', () => {
    const rows = getDb()
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name")
      .all();
    const created = rows.map((r) => r.name).filter((name) => name !== 'schema_version');
    expect(
      created,
      'A migration added a table: add it to db/tables.js and classify it in TABLE_CLASS (server/erase/eraseService.js), or the erase would leave it behind',
    ).toEqual(Object.keys(TABLE_CLASS).sort());
  });
});

describe('erase classification', () => {
  it('classifies every table in db/tables.js, and only those', () => {
    const tables = Object.keys(TABLES).sort();
    expect(Object.keys(TABLE_CLASS).sort(), 'Classify the new table in TABLE_CLASS (server/erase/eraseService.js) as erased').toEqual(tables);
    for (const [table, cls] of Object.entries(TABLE_CLASS)) {
      expect(cls, table).toBe('erased');
    }
  });

  it('empties every table, children first, derived from the table list', () => {
    const order = tablesToErase();
    expect([...order].sort()).toEqual(Object.keys(TABLES).sort());
    expect(order.indexOf('habit_completions')).toBeLessThan(order.indexOf('habits'));
    expect(order.indexOf('jarvis_messages')).toBeLessThan(order.indexOf('jarvis_conversations'));
    expect(order.indexOf('jarvis_memory')).toBeLessThan(order.indexOf('jarvis_conversations'));
  });

  it('erases every row of every table: no table keeps rows, no kept state keys exist', () => {
    expect(new Set(Object.values(TABLE_CLASS))).toEqual(new Set(['erased']));
  });

  it('import still skips the legacy license state keys that older versions wrote', () => {
    for (const key of ['license.activation', 'license.clock', 'license.trial', 'license.trialNotices']) {
      expect(PROTECTED_APP_STATE_KEYS.has(key), key).toBe(true);
    }
  });
});
