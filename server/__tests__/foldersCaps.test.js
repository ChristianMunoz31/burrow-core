// The scan limits (files listed, text read, file size, depth, entries, summarized files), driven with
// tiny synthetic limits through the test seam. Each one must produce the right file statuses and `limitsHit`.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../loadEnv.js', () => ({}));
vi.mock('node-fetch', () => ({ default: vi.fn() }));

import fs from 'node:fs';
import path from 'node:path';
import fetch from 'node-fetch';
import { __resetAiForTests } from '../ai/index.js';
import { LIMIT_CODES, LIMIT_MESSAGES, LIMITS, PUBLIC_LIMITS } from '../folders/constants.js';
import { __setFolderLimitsForTests, enqueueFolderJob, waitForFolderJob } from '../folders/jobs.js';
import { __setPathOptionsForTests } from '../folders/pathSafety.js';
import { allFileRows, getFolder } from '../folders/store.js';
import { __setBusyDelaysForTests } from '../folders/summarize.js';
import { installFakeOllama, textReply } from './helpers/fakeOllama.js';
import { addFolderRow, makeTmp, rmTree, useNeutralPaths, writeTree } from './helpers/foldersEnv.js';
import { closeTestDb, createTestDb, resetDb } from './helpers/testDb.js';

let db;
let base;
let dir;
let fake;
let folder;
let n = 0;

async function scan() {
  const job = enqueueFolderJob({ folderId: folder.id, kind: 'scan', trigger: 'user' });
  const done = await waitForFolderJob(job.id, { timeoutMs: 30000 });
  expect(done.status).toBe('done');
  return done;
}
const stats = () => getFolder(folder.id).stats;
const rows = () => allFileRows(folder.id);
const statusOf = (rel) => rows().find((r) => r.rel_path === rel)?.status;

beforeAll(() => {
  db = createTestDb();
  base = makeTmp('burrow-folders-caps-');
  useNeutralPaths(base);
  __setBusyDelaysForTests([1, 1, 1]);
});
afterAll(() => {
  __setPathOptionsForTests(null);
  __setBusyDelaysForTests(null);
  closeTestDb(db);
  rmTree(base);
});
beforeEach(() => {
  resetDb(db);
  __resetAiForTests();
  fetch.mockReset();
  fake = installFakeOllama(fetch, { embedModel: true, chat: () => textReply('A short note about the files.') });
  n += 1;
  dir = path.join(base, `case-${n}`);
  fs.mkdirSync(dir, { recursive: true });
});
afterEach(() => {
  __setFolderLimitsForTests(null);
});

describe('the public limits', () => {
  it('are the documented numbers', () => {
    expect(PUBLIC_LIMITS).toEqual({ maxFolders: 20, maxFiles: 5000, maxFileBytes: 2097152, maxTotalBytes: 209715200, maxDepth: 12, summaryFiles: 300, maxIndexChunks: 10000, embedModel: 'nomic-embed-text' });
    expect(LIMITS).toMatchObject({ maxEntries: 50000, maxQueued: 20, chunkChars: 1200, chunkOverlap: 150, embedBatch: 16, maxChunksPerFile: 200 });
  });

  it('every limit code has fixed copy without an em dash', () => {
    expect(LIMIT_CODES).toEqual(['max_files', 'max_total_bytes', 'max_depth', 'max_entries', 'summary_limit', 'index_limit']);
    for (const code of LIMIT_CODES) {
      expect(LIMIT_MESSAGES[code]).toEqual(expect.any(String));
      expect(LIMIT_MESSAGES[code]).not.toMatch(/[–—]/);
    }
    expect(LIMIT_MESSAGES.max_files).toBe('Burrow listed the first 5,000 files. Pick a smaller folder to include everything.');
    expect(LIMIT_MESSAGES.max_total_bytes).toBe('Burrow stopped after reading 200 MB of text. Pick a smaller folder to include everything.');
    expect(LIMIT_MESSAGES.summary_limit).toBe('Summaries cover the 300 most recently changed files.');
  });
});

describe('max files listed', () => {
  it('lists only the first files in sorted order and records max_files', async () => {
    writeTree(dir, Object.fromEntries(['a', 'b', 'c', 'd', 'e', 'f'].map((k) => [`${k}.txt`, `file ${k}`])));
    __setFolderLimitsForTests({ maxFiles: 3 });
    folder = await addFolderRow(dir);
    await scan();
    expect(rows().map((r) => r.rel_path)).toEqual(['a.txt', 'b.txt', 'c.txt']);
    expect(stats().limitsHit).toEqual(['max_files']);
    expect(stats().filesTotal).toBe(3);
  });

  it('exactly the limit is not a limit hit', async () => {
    writeTree(dir, { 'a.txt': 'a', 'b.txt': 'b' });
    __setFolderLimitsForTests({ maxFiles: 2 });
    folder = await addFolderRow(dir);
    await scan();
    expect(stats().limitsHit).toEqual([]);
    expect(rows()).toHaveLength(2);
  });

  it('files dropped by the limit on a later scan are removed from the inventory', async () => {
    writeTree(dir, { 'a.txt': 'a', 'b.txt': 'b', 'c.txt': 'c' });
    folder = await addFolderRow(dir);
    await scan();
    expect(rows()).toHaveLength(3);
    __setFolderLimitsForTests({ maxFiles: 2 });
    await scan();
    expect(rows().map((r) => r.rel_path)).toEqual(['a.txt', 'b.txt']);
  });
});

describe('max text read', () => {
  it('files past the byte budget are listed as skipped_limit and not read', async () => {
    writeTree(dir, { 'a.txt': 'x'.repeat(100), 'b.txt': 'y'.repeat(100), 'c.txt': 'z'.repeat(100), 'd.txt': 'w'.repeat(100) });
    __setFolderLimitsForTests({ maxTotalBytes: 250 });
    folder = await addFolderRow(dir);
    await scan();
    expect(['a.txt', 'b.txt', 'c.txt', 'd.txt'].map(statusOf)).toEqual(['ok', 'ok', 'skipped_limit', 'skipped_limit']);
    expect(stats().limitsHit).toEqual(['max_total_bytes']);
    expect(stats().byStatus.skipped_limit).toBe(2);
    expect(rows().find((r) => r.rel_path === 'c.txt')).toMatchObject({ sha256: null, summary_status: 'none' });
    expect(fake.chatBodies.map((b) => JSON.stringify(b.messages)).join('')).not.toContain('zzzz');
  });

  it('files that are not supported text do not use the budget', async () => {
    writeTree(dir, { 'pic.png': 'p'.repeat(500), 'a.txt': 'x'.repeat(100) });
    __setFolderLimitsForTests({ maxTotalBytes: 250 });
    folder = await addFolderRow(dir);
    await scan();
    expect(statusOf('a.txt')).toBe('ok');
    expect(statusOf('pic.png')).toBe('unsupported');
    expect(stats().limitsHit).toEqual([]);
  });
});

describe('max file size', () => {
  it('a file over the size limit is too_large and never summarized', async () => {
    writeTree(dir, { 'small.txt': 'tiny', 'large.txt': 'L'.repeat(300) });
    __setFolderLimitsForTests({ maxFileBytes: 100 });
    folder = await addFolderRow(dir);
    await scan();
    expect(statusOf('large.txt')).toBe('too_large');
    expect(statusOf('small.txt')).toBe('ok');
    expect(rows().find((r) => r.rel_path === 'large.txt')).toMatchObject({ summary_status: 'none', size_bytes: 300 });
    expect(stats().byStatus.too_large).toBe(1);
  });
});

describe('depth and entries', () => {
  it('folders deeper than the limit are skipped and recorded as max_depth', async () => {
    writeTree(dir, { 'top.txt': 't', 'a/one.txt': '1', 'a/b/two.txt': '2', 'a/b/c/three.txt': '3' });
    __setFolderLimitsForTests({ maxDepth: 2 });
    folder = await addFolderRow(dir);
    await scan();
    expect(rows().map((r) => r.rel_path)).toEqual(['a/b/two.txt', 'a/one.txt', 'top.txt']);
    expect(stats().limitsHit).toEqual(['max_depth']);
    expect(stats().dirsSkipped).toBe(1);
  });

  it('a walk cut short by the entry budget records max_entries', async () => {
    writeTree(dir, Object.fromEntries(Array.from({ length: 8 }, (_v, i) => [`f${i}.txt`, `text ${i}`])));
    __setFolderLimitsForTests({ maxEntries: 5 });
    folder = await addFolderRow(dir);
    await scan();
    expect(rows()).toHaveLength(5);
    expect(stats().limitsHit).toEqual(['max_entries']);
  });
});

describe('summarized files', () => {
  it('only the most recently changed files are summarized; the rest are not_included', async () => {
    const names = ['oldest', 'older', 'newer', 'newest'];
    writeTree(dir, Object.fromEntries(names.map((k) => [`${k}.txt`, `${k} file text`])));
    names.forEach((k, i) => {
      const t = new Date(Date.UTC(2026, 0, 1 + i));
      fs.utimesSync(path.join(dir, `${k}.txt`), t, t);
    });
    __setFolderLimitsForTests({ summaryFiles: 2 });
    folder = await addFolderRow(dir);
    const done = await scan();
    const by = Object.fromEntries(rows().map((r) => [r.rel_path, r.summary_status]));
    expect(by).toEqual({ 'newer.txt': 'ok', 'newest.txt': 'ok', 'older.txt': 'not_included', 'oldest.txt': 'not_included' });
    expect(stats().limitsHit).toEqual(['summary_limit']);
    expect(done.progress.summariesTotal).toBe(2);
    // two file calls and the folder summary
    expect(fake.chatBodies).toHaveLength(3);
  });

  it('ties in modified time are broken by path', async () => {
    writeTree(dir, { 'b.txt': 'b text', 'a.txt': 'a text', 'c.txt': 'c text' });
    const t = new Date(Date.UTC(2026, 0, 1));
    for (const f of ['a', 'b', 'c']) fs.utimesSync(path.join(dir, `${f}.txt`), t, t);
    __setFolderLimitsForTests({ summaryFiles: 2 });
    folder = await addFolderRow(dir);
    await scan();
    expect(statusOf('a.txt')).toBe('ok');
    expect(rows().find((r) => r.rel_path === 'a.txt').summary_status).toBe('ok');
    expect(rows().find((r) => r.rel_path === 'b.txt').summary_status).toBe('ok');
    expect(rows().find((r) => r.rel_path === 'c.txt').summary_status).toBe('not_included');
  });

  it('exactly the limit is not a limit hit', async () => {
    writeTree(dir, { 'a.txt': 'a text', 'b.txt': 'b text' });
    __setFolderLimitsForTests({ summaryFiles: 2 });
    folder = await addFolderRow(dir);
    await scan();
    expect(stats().limitsHit).toEqual([]);
  });
});

describe('index chunks', () => {
  const bigText = (label) => Array.from({ length: 40 }, (_v, i) => `${label} sentence number ${i} talks about gardens and soil.`).join('\n');

  it('without the Pro index hook there is no index and the reason is not_pro, even with Pro entitlements', async () => {
    writeTree(dir, { 'a.txt': bigText('alpha') });
    folder = await addFolderRow(dir);
    await scan();
    expect(stats().index).toEqual({ status: 'none', files: 0, chunks: 0, skipped: 'not_pro' });
    expect(fake.embedBodies).toEqual([]);
    expect(rows()[0].summary_status).toBe('ok'); // summaries stay free
  });

});
