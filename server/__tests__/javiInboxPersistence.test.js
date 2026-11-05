// `javi.inbox` is local only: never in an export, never set by an import, hidden from the data browser and the state
// API, kept in backups (and so in a restore), and it does not make an untouched database look used.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { strFromU8, unzipSync } from 'fflate';
import { createTestDb, closeTestDb } from './helpers/testDb.js';
import { openDb, selectOne, upsert } from '../db/index.js';
import { buildExportZip } from '../export/buildArchive.js';
import { importParsed } from '../import/importExport.js';
import { HIDDEN_APP_STATE_KEYS, LOCAL_ONLY_APP_STATE_KEYS } from '../dataBrowser/redact.js';
import { isPristineDb } from '../backup/directImport.js';
import { normalizeSnapshot, takeSnapshot } from '../backup/snapshot.js';

const INBOX = { v: 1, createdAt: '2026-10-01T00:00:00.000Z', pages: { todos: { seenAt: '2026-10-01T00:00:00.000Z', changedAt: null } }, briefingSeenAt: null, foldersSeenAt: null };
const put = (key, value, db) => upsert('app_state', { key, value }, { conflict: ['key'], db });

let db;
let dir;
beforeEach(() => {
  db = createTestDb();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-javi-inbox-'));
});
afterEach(() => {
  closeTestDb(db);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('javi.inbox stays on this computer', () => {
  it('is local only and hidden', () => {
    expect(LOCAL_ONLY_APP_STATE_KEYS.has('javi.inbox')).toBe(true);
    expect(HIDDEN_APP_STATE_KEYS.has('javi.inbox')).toBe(true);
  });

  it('the export ZIP has no javi.inbox row', async () => {
    put('javi.inbox', INBOX);
    put('theme', 'dark');
    const { zip } = await buildExportZip({ db });
    const json = strFromU8(unzipSync(zip)['json/app_state.json']);
    expect(json).toContain('theme');
    expect(json).not.toContain('javi.inbox');
  });

  it('an archive row javi.inbox is skipped as protected and the live row is unchanged', () => {
    put('javi.inbox', INBOX);
    const forged = { ...INBOX, createdAt: '2020-01-01T00:00:00.000Z', pages: {} };
    const result = importParsed({ format: 'burrow-export', formatVersion: 2, manifest: {}, tables: new Map([['app_state', [{ key: 'javi.inbox', value: forged }]]]) });
    const t = result.tables.find((x) => x.id === 'app_state');
    expect(t.skippedReasons.protected).toBe(1);
    expect(selectOne('app_state', { where: { key: 'javi.inbox' } }).value).toEqual(INBOX);
  });

  it('a backup snapshot keeps the row', () => {
    const file = path.join(dir, 'live.db');
    const live = openDb({ filename: file });
    try {
      put('javi.inbox', INBOX, live);
      const snap = path.join(dir, 'snap.db');
      takeSnapshot(live, snap);
      normalizeSnapshot(snap);
      const copy = new DatabaseSync(snap);
      const row = copy.prepare("SELECT value FROM app_state WHERE key = 'javi.inbox'").get();
      copy.close();
      expect(JSON.parse(row.value)).toEqual(INBOX);
    } finally {
      live.close();
    }
  });

  it('a database with only javi.inbox is still pristine', () => {
    expect(isPristineDb(db, { dataDir: dir })).toBe(true);
    put('javi.inbox', INBOX);
    expect(isPristineDb(db, { dataDir: dir })).toBe(true);
  });
});
