// Export -> import round trip, the legacy v1 format with Postgres-typed values, dry run,
// orphan handling, and archive validation. Everything runs on real in-memory SQLite databases.
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { FOLDER_ARCHIVE_TABLES, IMPORT_ORDER, TABLES, insertMany, openDb } from '../db/index.js';
import { buildExportZip } from '../exportRoutes.js';
import { ImportError, importZipBuffer, parseExportZip } from '../import/importExport.js';
import { closeTestDb, createTestDb, resetDb, rowsOf, seedDb } from './helpers/testDb.js';

let src;
let dest;

beforeAll(() => {
  src = createTestDb();
  dest = openDb({ filename: ':memory:' });
});
beforeEach(() => {
  resetDb(src);
  resetDb(dest);
});
afterAll(() => {
  closeTestDb(src);
  dest.close();
});

const byPk = (table) => (a, b) => String(a[TABLES[table].primaryKey]).localeCompare(String(b[TABLES[table].primaryKey]));
const sortedRows = (db, table) => rowsOf(db, table).sort(byPk(table));
const counts = (db) => Object.fromEntries(IMPORT_ORDER.map((t) => [t, rowsOf(db, t).length]));

/** Builds an archive with the given manifest fields and table contents. */
function makeZip({ manifest = {}, tables = {}, extra = {} } = {}) {
  const files = {
    'manifest.json': strToU8(
      JSON.stringify({
        format: 'burrow-export',
        formatVersion: 2,
        exportedAt: '2026-05-01T00:00:00.000Z',
        tables: Object.keys(tables).map((id) => ({ id })),
        ...manifest,
      }),
    ),
    ...extra,
  };
  for (const [id, rows] of Object.entries(tables)) {
    files[`json/${id}.json`] = strToU8(typeof rows === 'string' ? rows : JSON.stringify(rows));
  }
  return zipSync(files);
}

function seedEverything(db) {
  const habitId = randomUUID();
  const convId = randomUUID();
  return seedDb(db, {
    transactions: [
      { date: '2026-01-02', merchant: 'Cafe, "Uno"', amount: -12.5, category: 'Dining', type: 'debit', source_file: 'a.csv', created_at: '2026-01-02T03:04:05.123Z' },
      { date: '2026-01-03', merchant: 'Pay', amount: 1000, category: 'Income', type: 'credit', created_at: '2026-01-03T00:00:00.000Z' },
    ],
    todo_columns: [
      { name: 'Backlog', order: 0, color: 'gray' },
      { name: 'Doing', order: 1, color: 'blue' },
    ],
    todos: [
      { title: 'Plan trip', description: 'multi\nline', done: false, due: '2026-06-01', priority: 'high', status: 'Backlog', order: 2 },
      { title: 'Ship it', done: true, status: 'Done' },
    ],
    habits: [{ id: habitId, title: 'Read' }, { title: 'Run', frequency: 'weekly' }],
    habit_completions: [{ habit_id: habitId, date: '2026-01-02' }, { habit_id: habitId, date: '2026-01-03' }],
    journal: [
      { title: 'Day one', body: 'Hello', date: '2026-02-03T04:05:06.789Z', mood: 'good', tags: ['a', 'b'] },
      { title: null, body: 'No title', tags: [] },
    ],
    calendar_events: [
      { summary: 'Meeting', start_at: '2026-03-01T10:00:00.000Z', end_at: '2026-03-01T11:00:00.000Z', all_day: false, source: 'manual' },
      { summary: 'Holiday', start_at: '2026-03-02T00:00:00.000Z', all_day: true, uid: 'abc@example' },
    ],
    notes: [{ body: 'First', pinned: true }, { body: 'Second', color: 'blue' }],
    bookmarks: [{ title: 'Docs', url: 'https://example.com', category: 'ref' }],
    focus_sessions: [{ kind: 'focus', duration_min: 25, started_at: '2026-04-01T09:00:00.000Z' }],
    countdowns: [{ title: 'Trip', target_date: '2026-12-25' }],
    app_state: [
      { key: 'theme', value: 'dark' },
      { key: 'sidebar', value: { collapsed: true, items: [1, 2] } },
      { key: 'openai_api_key', value: 'sk-abcdefghijklmnop' },
    ],
    jarvis_conversations: [{ id: convId, title: 'Chat' }],
    jarvis_messages: [
      { conversation_id: convId, role: 'user', content: 'hi' },
      { conversation_id: convId, role: 'assistant', content: null, tool_calls: [{ id: 'c1', function: { name: 'x', arguments: '{}' } }] },
    ],
    jarvis_memory: [{ fact: 'likes tea', category: 'prefs', weight: 2.5, source_conversation_id: convId }],
  });
}

describe('export -> import round trip', () => {
  it('restores every table into a fresh database (minus redacted app_state rows)', async () => {
    seedEverything(src);
    const { zip } = await buildExportZip({ db: src });
    const result = importZipBuffer(zip, { db: dest });

    expect(result).toMatchObject({ format: 'burrow-export', formatVersion: 2, dryRun: false });
    expect(result.ignoredTables).toEqual([]);
    expect(result.tables.map((t) => t.id)).toEqual([...IMPORT_ORDER, ...FOLDER_ARCHIVE_TABLES]);

    for (const table of IMPORT_ORDER) {
      let expected = sortedRows(src, table);
      if (table === 'app_state') expected = expected.filter((r) => r.key !== 'openai_api_key');
      expect(sortedRows(dest, table), table).toEqual(expected);
    }
    const appState = result.tables.find((t) => t.id === 'app_state');
    expect(appState).toMatchObject({ received: 3, inserted: 2, skipped: 1 });
    expect(appState.skippedReasons.redacted).toBe(1);
    expect(result.totals.skipped).toBe(1);
    expect(result.totals.updated).toBe(0);
  });

  it('is idempotent: a second import updates every row and duplicates nothing', async () => {
    seedEverything(src);
    const { zip } = await buildExportZip({ db: src });
    const first = importZipBuffer(zip, { db: dest });
    const before = counts(dest);
    const second = importZipBuffer(zip, { db: dest });
    expect(counts(dest)).toEqual(before);
    expect(second.totals.inserted).toBe(0);
    expect(second.totals.updated).toBe(first.totals.inserted);
  });

  it('overwrites a local row with the same id and keeps local-only rows', async () => {
    seedDb(src, { todos: [{ id: 'same', title: 'from export' }] });
    const { zip } = await buildExportZip({ db: src });
    seedDb(dest, { todos: [{ id: 'same', title: 'edited locally' }, { id: 'local-only', title: 'mine' }] });
    const result = importZipBuffer(zip, { db: dest });
    expect(result.tables.find((t) => t.id === 'todos')).toMatchObject({ inserted: 0, updated: 1 });
    const rows = sortedRows(dest, 'todos');
    expect(rows.map((r) => [r.id, r.title])).toEqual([
      ['local-only', 'mine'],
      ['same', 'from export'],
    ]);
  });

  it('imports a per-table ZIP and touches only that table', async () => {
    seedEverything(src);
    const { zip } = await buildExportZip({ db: src, tables: ['todos'] });
    const result = importZipBuffer(zip, { db: dest });
    expect(result.tables.map((t) => t.id)).toEqual(['todos']);
    expect(counts(dest).todos).toBe(2);
    expect(counts(dest).notes).toBe(0);
  });

  it('ignores markdown/ and csv/ entries, even malformed ones', async () => {
    seedEverything(src);
    const { zip } = await buildExportZip({ db: src, tables: ['notes', 'journal'] });
    const result = importZipBuffer(zip, { db: dest });
    expect(result.totals.inserted).toBe(4);
    const garbage = makeZip({
      tables: { notes: [{ id: 'n1', body: 'x' }] },
      extra: {
        'markdown/notes/zzz.md': strToU8('not an import'),
        'csv/notes.csv': strToU8('id,body\r\nBOGUS,BOGUS'),
        '../escape.json': strToU8('[]'),
      },
    });
    expect(importZipBuffer(garbage, { db: dest }).totals.inserted).toBe(1);
    expect(rowsOf(dest, 'notes').some((r) => r.body === 'BOGUS')).toBe(false);
  });
});

describe('legacy v1 export format', () => {
  const legacyTables = () => ({
    transactions: [
      {
        id: 'tx-1',
        date: '2026-01-02',
        merchant: 'Cafe',
        amount: '-12.50',
        category: 'Dining',
        type: 'debit',
        source_file: null,
        created_at: '2026-01-02T03:04:05.123456+00:00',
      },
    ],
    todos: [
      {
        id: 'td-1',
        title: 'Plan',
        description: '',
        done: 't',
        due: '2026-06-01',
        priority: 'high',
        status: 'Backlog',
        context: 'both',
        order: '3',
        created_at: '2026-01-02T03:04:05.5+00:00',
      },
      { id: 'td-2', title: 'Ship', done: false, order: 4.0, created_at: '2026-01-02 03:04:05+00' },
    ],
    journal: [
      { id: 'j-1', title: 'T', date: '2026-02-03T04:05:06.789012+00:00', body: 'b', mood: null, tags: ['a', 'b'], context: 'both', created_at: '2026-02-03T04:05:06.789012+00:00' },
      { id: 'j-2', title: null, date: '2026-02-04T00:00:00+0000', body: 'c', tags: '{work,home}', created_at: '2026-02-04T00:00:00+00:00' },
    ],
    calendar_events: [
      { id: 'ev-1', summary: 'Meet', description: '', location: '', start_at: '2026-03-01T10:00:00+00:00', end_at: null, all_day: 'f', source: 'manual', uid: null, context: 'both', created_at: '2026-03-01T00:00:00.000001+00:00' },
    ],
    jarvis_memory: [{ id: 'm-1', fact: 'f', category: 'general', weight: '1.5', source_conversation_id: null, created_at: '2026-01-01T00:00:00+00:00', updated_at: '2026-01-01T00:00:00+00:00' }],
    app_state: [{ key: 'theme', value: 'dark', updated_at: '2026-01-01T00:00:00.123456+00:00' }],
  });
  const legacyZip = (tables = legacyTables(), manifest = {}) =>
    makeZip({ manifest: { format: 'legacy-export', formatVersion: 1, ...manifest }, tables });

  it('coerces timestamps, numeric strings, booleans and arrays to the local forms', () => {
    const result = importZipBuffer(legacyZip(), { db: dest });
    expect(result).toMatchObject({ format: 'legacy-export', formatVersion: 1 });
    expect(result.totals.skipped).toBe(0);

    expect(rowsOf(dest, 'transactions')[0]).toMatchObject({ id: 'tx-1', amount: -12.5, created_at: '2026-01-02T03:04:05.123Z' });
    const todos = sortedRows(dest, 'todos');
    expect(todos[0]).toMatchObject({ id: 'td-1', done: true, order: 3, created_at: '2026-01-02T03:04:05.500Z' });
    expect(todos[1]).toMatchObject({ id: 'td-2', done: false, order: 4, created_at: '2026-01-02T03:04:05.000Z' });
    const journal = sortedRows(dest, 'journal');
    expect(journal[0]).toMatchObject({ date: '2026-02-03T04:05:06.789Z', tags: ['a', 'b'] });
    expect(journal[1]).toMatchObject({ date: '2026-02-04T00:00:00.000Z', tags: ['work', 'home'], title: null });
    expect(rowsOf(dest, 'calendar_events')[0]).toMatchObject({ all_day: false, start_at: '2026-03-01T10:00:00.000Z', end_at: null, created_at: '2026-03-01T00:00:00.000Z' });
    expect(rowsOf(dest, 'jarvis_memory')[0]).toMatchObject({ weight: 1.5 });
    expect(rowsOf(dest, 'app_state')[0]).toMatchObject({ key: 'theme', value: 'dark', updated_at: '2026-01-01T00:00:00.123Z' });
  });

  it('is detected by manifest shape, never by product name', () => {
    expect(parseExportZip(legacyZip(legacyTables(), { format: 'anything-export' })).formatVersion).toBe(1);
    expect(() => parseExportZip(legacyZip(legacyTables(), { format: 'legacy-data' }))).toThrow(
      expect.objectContaining({ code: 'unsupported_format' }),
    );
    // current format needs version 2; other '-export' names need version 1
    expect(() => parseExportZip(legacyZip(legacyTables(), { format: 'burrow-export', formatVersion: 3 }))).toThrow(
      expect.objectContaining({ code: 'unsupported_format' }),
    );
    expect(() => parseExportZip(legacyZip(legacyTables(), { formatVersion: 2 }))).toThrow(
      expect.objectContaining({ code: 'unsupported_format' }),
    );
  });

  it('accepts a legacy-format manifest named burrow-export at version 1', () => {
    const zip = legacyZip({ notes: [{ id: 'n1', body: 'x', pinned: 'false', created_at: '2026-01-01T00:00:00+00:00' }] }, { format: 'burrow-export', formatVersion: 1 });
    expect(importZipBuffer(zip, { db: dest }).totals.inserted).toBe(1);
    expect(rowsOf(dest, 'notes')[0]).toMatchObject({ pinned: false });
  });

  it('nulls an unreadable nullable value but skips a row whose required value is unreadable', () => {
    const zip = legacyZip({
      transactions: [{ id: 'tx-bad', date: 'not-a-date', merchant: 'm', amount: 'abc', created_at: '2026-01-01T00:00:00+00:00' }],
      habits: [{ id: 'h1', title: 'Read', created_at: '2026-01-01T00:00:00+00:00' }],
      habit_completions: [
        { id: 'c-ok', habit_id: 'h1', date: '2026-01-01', created_at: '2026-01-01T00:00:00+00:00' },
        { id: 'c-bad', habit_id: 'h1', date: 'nope', created_at: '2026-01-01T00:00:00+00:00' },
      ],
    });
    const result = importZipBuffer(zip, { db: dest });
    expect(rowsOf(dest, 'transactions')[0]).toMatchObject({ id: 'tx-bad', date: null, amount: null });
    expect(rowsOf(dest, 'habit_completions').map((r) => r.id)).toEqual(['c-ok']);
    expect(result.tables.find((t) => t.id === 'habit_completions').skippedReasons.invalid).toBe(1);
  });
});

describe('skips and orphans', () => {
  it('skips orphans, nulls an unknown memory source, and reports reasons', () => {
    const zip = makeZip({
      tables: {
        habits: [{ id: 'h1', title: 'Read' }],
        habit_completions: [
          { id: 'c1', habit_id: 'h1', date: '2026-01-01' },
          { id: 'c2', habit_id: 'ghost', date: '2026-01-01' },
        ],
        jarvis_conversations: [{ id: 'conv1', title: 'x' }],
        jarvis_messages: [
          { id: 'm1', conversation_id: 'conv1', role: 'user', content: 'hi' },
          { id: 'm2', conversation_id: 'ghost', role: 'user', content: 'lost' },
        ],
        jarvis_memory: [{ id: 'mem1', fact: 'f', source_conversation_id: 'ghost' }],
      },
    });
    const result = importZipBuffer(zip, { db: dest });
    const t = (id) => result.tables.find((x) => x.id === id);
    expect(t('habit_completions')).toMatchObject({ inserted: 1, skipped: 1 });
    expect(t('habit_completions').skippedReasons.orphan).toBe(1);
    expect(t('jarvis_messages')).toMatchObject({ inserted: 1, skipped: 1 });
    expect(t('jarvis_messages').skippedReasons.orphan).toBe(1);
    expect(t('jarvis_memory')).toMatchObject({ inserted: 1, skipped: 0 });
    expect(rowsOf(dest, 'jarvis_memory')[0].source_conversation_id).toBeNull();
  });

  it('accepts a child whose parent exists in the database but not in the archive', () => {
    seedDb(dest, { habits: [{ id: 'h-local', title: 'Local' }] });
    const zip = makeZip({ tables: { habit_completions: [{ id: 'c1', habit_id: 'h-local', date: '2026-01-01' }] } });
    expect(importZipBuffer(zip, { db: dest }).totals.inserted).toBe(1);
  });

  it('does not bring back the retired Chat personas from an old archive', () => {
    const zip = makeZip({ tables: { app_state: [{ key: 'pos:gpts', value: '[{"id":"p1"}]' }, { key: 'theme', value: '"dark"' }] } });
    const result = importZipBuffer(zip, { db: dest });
    expect(result.tables[0]).toMatchObject({ inserted: 1, skipped: 1 });
    expect(rowsOf(dest, 'app_state').map((r) => r.key)).toEqual(['theme']);
  });

  it('skips rows without a primary key and non-object rows', () => {
    const zip = makeZip({ tables: { notes: [{ body: 'no id' }, { id: '', body: 'blank' }, { id: null, body: 'null' }, 5, { id: 'ok', body: 'fine' }] } });
    const result = importZipBuffer(zip, { db: dest });
    const notes = result.tables[0];
    expect(notes).toMatchObject({ received: 5, inserted: 1, skipped: 4 });
    expect(notes.skippedReasons).toEqual({ invalid: 1, orphan: 0, redacted: 0, missing_id: 3, protected: 0 });
    expect(rowsOf(dest, 'notes').map((r) => r.id)).toEqual(['ok']);
  });

  it('skips app_state rows containing the redaction marker at any depth and keeps real ones', () => {
    seedDb(dest, { app_state: [{ key: 'theme', value: 'dark' }] });
    const zip = makeZip({
      tables: {
        app_state: [
          { key: 'theme', value: '[redacted]' },
          { key: 'a', value: { x: { y: ['ok', '[redacted]'] } } },
          { key: 'b', value: 'prefix [redacted] suffix' },
          { key: 'c', value: { fine: true } },
        ],
      },
    });
    const result = importZipBuffer(zip, { db: dest });
    expect(result.tables[0]).toMatchObject({ inserted: 1, skipped: 3 });
    expect(result.tables[0].skippedReasons.redacted).toBe(3);
    expect(rowsOf(dest, 'app_state').map((r) => [r.key, r.value])).toEqual([
      ['theme', 'dark'],
      ['c', { fine: true }],
    ]);
  });

  it('never imports app_secrets or audit_log and reports unknown or missing tables', () => {
    const secretRow = { name: 'GROQ_API_KEY', ciphertext: 'c', iv: 'i', auth_tag: 't', last4: '1234' };
    const files = {
      'manifest.json': strToU8(
        JSON.stringify({
          format: 'burrow-export',
          formatVersion: 2,
          tables: [{ id: 'app_secrets' }, { id: 'audit_log' }, { id: 'nope' }, { id: '__proto__' }, { id: 'notes' }, 'junk'],
        }),
      ),
      'json/app_secrets.json': strToU8(JSON.stringify([secretRow])),
      'json/audit_log.json': strToU8(JSON.stringify([{ id: 'a', kind: 'llm', feature: 'x' }])),
    };
    const result = importZipBuffer(zipSync(files), { db: dest });
    expect(result.ignoredTables).toEqual([
      { id: 'app_secrets', reason: 'not_importable' },
      { id: 'audit_log', reason: 'not_importable' },
      { id: 'nope', reason: 'unknown_table' },
      { id: '__proto__', reason: 'unknown_table' },
      { id: 'notes', reason: 'missing_file' },
    ]);
    expect(rowsOf(dest, 'app_secrets')).toHaveLength(0);
    expect(rowsOf(dest, 'audit_log')).toHaveLength(0);
  });
});

describe('dry run', () => {
  it('reports the same counts as a real run but writes nothing', async () => {
    seedEverything(src);
    const { zip } = await buildExportZip({ db: src });
    seedDb(dest, { notes: [{ id: 'keep', body: 'keep me' }] });
    const before = counts(dest);
    const dry = importZipBuffer(zip, { db: dest, dryRun: true });
    expect(dry.dryRun).toBe(true);
    expect(counts(dest)).toEqual(before);
    const real = importZipBuffer(zip, { db: dest });
    expect(real.dryRun).toBe(false);
    expect({ ...dry, dryRun: undefined }).toEqual({ ...real, dryRun: undefined });
    expect(dry.totals.inserted).toBeGreaterThan(0);
  });

  it('leaves no open transaction behind', () => {
    const zip = makeZip({ tables: { notes: [{ id: 'n1', body: 'x' }] } });
    importZipBuffer(zip, { db: dest, dryRun: true });
    insertMany('notes', [{ id: 'after', body: 'works' }], { db: dest });
    expect(rowsOf(dest, 'notes').map((r) => r.id)).toEqual(['after']);
  });
});

describe('archive validation', () => {
  const expectCode = (fn, code) => {
    try {
      fn();
    } catch (e) {
      expect(e).toBeInstanceOf(ImportError);
      expect(e.code).toBe(code);
      return e;
    }
    throw new Error(`expected ${code}`);
  };

  it('rejects bytes that are not a ZIP', () => {
    expectCode(() => importZipBuffer(strToU8('definitely not a zip'), { db: dest }), 'invalid_archive');
    expectCode(() => importZipBuffer(new Uint8Array(0), { db: dest }), 'invalid_archive');
  });

  it('rejects a ZIP without a readable manifest', () => {
    expectCode(() => parseExportZip(zipSync({ 'json/notes.json': strToU8('[]') })), 'invalid_archive');
    expectCode(() => parseExportZip(zipSync({ 'manifest.json': strToU8('{oops') })), 'invalid_archive');
    expectCode(() => parseExportZip(zipSync({ 'manifest.json': strToU8('[]') })), 'invalid_archive');
    expectCode(() => parseExportZip(zipSync({ 'manifest.json': strToU8(JSON.stringify({ format: 'burrow-export', formatVersion: 2 })) })), 'invalid_archive');
  });

  it('rejects an unsupported format with status 400', () => {
    const zip = makeZip({ manifest: { format: 'something-else', formatVersion: 2 }, tables: { notes: [] } });
    const e = expectCode(() => importZipBuffer(zip, { db: dest }), 'unsupported_format');
    expect(e.status).toBe(400);
  });

  it('rejects a table file that is not a JSON array', () => {
    expectCode(() => parseExportZip(makeZip({ tables: { notes: '{"id":"n1"}' } })), 'invalid_table_file');
    expectCode(() => parseExportZip(makeZip({ tables: { notes: 'not json' } })), 'invalid_table_file');
  });

  it('rejects an entry over 64 MiB with status 413', () => {
    const big = new Uint8Array(65 * 1024 * 1024);
    const withBig = zipSync({
      'manifest.json': strToU8(JSON.stringify({ format: 'burrow-export', formatVersion: 2, tables: [{ id: 'todos' }] })),
      'json/todos.json': big,
    });
    const e = expectCode(() => parseExportZip(withBig), 'import_too_large');
    expect(e.status).toBe(413);
  });

  it('rejects an archive with more than 500 entries', () => {
    const files = { 'manifest.json': strToU8(JSON.stringify({ format: 'burrow-export', formatVersion: 2, tables: [] })) };
    for (let i = 0; i < 501; i += 1) files[`markdown/f${i}.md`] = strToU8('x');
    expectCode(() => parseExportZip(zipSync(files)), 'import_too_large');
  });
});
