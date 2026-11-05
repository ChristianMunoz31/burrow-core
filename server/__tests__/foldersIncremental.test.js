// A second scan only does the work that changed: no reads, no model calls and no embeddings for an unchanged
// folder; a touched file is re-hashed but not re-summarized; changed content re-summarizes only
// that file; a deleted file disappears. The question index is tested in foldersIncremental.pro.test.js.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../license/index.js', async (importOriginal) => (await import('./helpers/pro.js')).mockLicenseModule(importOriginal));
vi.mock('../../loadEnv.js', () => ({}));
vi.mock('node-fetch', () => ({ default: vi.fn() }));
vi.mock('../folders/extract.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, readTextFile: vi.fn(actual.readTextFile) };
});

import fs from 'node:fs';
import path from 'node:path';
import fetch from 'node-fetch';
import { __resetAiForTests } from '../ai/index.js';
import { count, select } from '../db/index.js';
import { readTextFile } from '../folders/extract.js';
import { enqueueFolderJob, waitForFolderJob } from '../folders/jobs.js';
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

async function scan() {
  const job = enqueueFolderJob({ folderId: folder.id, kind: 'scan', trigger: 'user' });
  const done = await waitForFolderJob(job.id, { timeoutMs: 30000 });
  expect(done.status).toBe('done');
  return done;
}
const rowOf = (rel) => allFileRows(folder.id).find((r) => r.rel_path === rel);
const chunksOf = (rel) => select('folder_chunks', { where: { file_id: rowOf(rel).id } });
/** Paths named by the file-level prompts since the mark. */
const filePrompts = (fromIndex) =>
  fake.chatBodies
    .slice(fromIndex)
    .map((b) => /"File":"([^"]+)"/.exec(b.messages.map((m) => m.content).join('\n'))?.[1])
    .filter(Boolean);

beforeAll(() => {
  db = createTestDb();
  base = makeTmp('burrow-folders-incr-');
  useNeutralPaths(base);
  __setBusyDelaysForTests([1, 1, 1]);
});
afterAll(() => {
  __setPathOptionsForTests(null);
  __setBusyDelaysForTests(null);
  closeTestDb(db);
  rmTree(base);
});
beforeEach(async () => {
  resetDb(db);
  __resetAiForTests();
  fetch.mockReset();
  readTextFile.mockClear();
  fake = installFakeOllama(fetch, { embedModel: true, chat: () => textReply('A short note about the files.') });
  dir = path.join(base, 'docs');
  rmTree(dir);
  writeTree(dir, {
    'plan.txt': 'The garden plan has tomatoes and peppers.\nWater them every morning.\n',
    'sub/recipe.md': '# Soup\nTomatoes, basil and garlic.\n',
    'sub/more.md': '# Bread\nFlour, water and salt.\n',
    'picture.png': 'not really a picture',
  });
  folder = await addFolderRow(dir);
});

describe('first scan', () => {
  it('summarizes every readable file and the folder', async () => {
    await scan();
    expect(allFileRows(folder.id).filter((r) => r.summary_status === 'ok')).toHaveLength(3);
    expect(getFolder(folder.id)).toMatchObject({ summary_status: 'ok' });
    expect(count('folder_chunks')).toBe(0); // no index without the Pro module
    expect(fake.chatBodies).toHaveLength(4); // 3 files + the folder
  });
});

describe('an unchanged folder', () => {
  it('a second scan makes 0 chat calls and reads 0 files', async () => {
    await scan();
    const chat = fake.chatBodies.length;
    readTextFile.mockClear();
    const before = allFileRows(folder.id).map((r) => ({ id: r.id, summary: r.summary, sha: r.sha256, hash: r.index_hash }));
    await scan();
    expect(fake.chatBodies).toHaveLength(chat);
    expect(readTextFile).not.toHaveBeenCalled();
    expect(allFileRows(folder.id).map((r) => ({ id: r.id, summary: r.summary, sha: r.sha256, hash: r.index_hash }))).toEqual(before);
  });

  it('keeps the folder summary: it is not written again when its inputs are unchanged', async () => {
    await scan();
    const first = getFolder(folder.id);
    await scan();
    const second = getFolder(folder.id);
    expect(second.summary).toBe(first.summary);
    expect(second.summary_at).toBe(first.summary_at);
    expect(second.summary_input_hash).toBe(first.summary_input_hash);
    expect(second.last_scan_at >= first.last_scan_at).toBe(true);
  });
});

describe('a touched file (same content, new modified time)', () => {
  it('is re-hashed (one read) but nothing is re-summarized or re-written', async () => {
    await scan();
    const chat = fake.chatBodies.length;
    const summaryAt = getFolder(folder.id).summary_at;
    const sha = rowOf('plan.txt').sha256;
    readTextFile.mockClear();
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(path.join(dir, 'plan.txt'), later, later);
    await scan();
    expect(readTextFile).toHaveBeenCalledTimes(1);
    expect(readTextFile.mock.calls[0][0]).toMatch(/plan\.txt$/);
    expect(fake.chatBodies).toHaveLength(chat);
    expect(rowOf('plan.txt')).toMatchObject({ sha256: sha, summary_status: 'ok', mtime: later.toISOString() });
    expect(getFolder(folder.id).summary_at).toBe(summaryAt);
  });
});

describe('changed content', () => {
  it('re-summarizes only that file', async () => {
    await scan();
    const mark = fake.chatBodies.length;
    const otherSummary = rowOf('sub/recipe.md').summary_hash;
    fs.writeFileSync(path.join(dir, 'plan.txt'), 'The garden plan now covers beans and carrots instead.\n');
    await scan();
    expect(filePrompts(mark)).toEqual(['plan.txt']);
    // one file call plus the folder summary (its inputs changed)
    expect(fake.chatBodies.length - mark).toBe(2);
    expect(rowOf('sub/recipe.md').summary_hash).toBe(otherSummary);
    expect(rowOf('plan.txt')).toMatchObject({ summary_status: 'ok', index_hash: null });
  });

  it('the changed file is marked stale and loses its index when the model is unavailable, and the other files are kept', async () => {
    await scan();
    fs.writeFileSync(path.join(dir, 'plan.txt'), 'Completely different words now.\n');
    __resetAiForTests();
    fetch.mockReset();
    fake = installFakeOllama(fetch, { embedModel: true, down: true });
    const done = await scan();
    expect(done.notices.map((n) => n.code)).toContain('ai_unavailable');
    expect(rowOf('plan.txt')).toMatchObject({ summary_status: 'stale', index_hash: null, chunk_count: 0 });
    expect(chunksOf('plan.txt')).toEqual([]);
    expect(rowOf('sub/recipe.md')).toMatchObject({ summary_status: 'ok' });
    expect(getFolder(folder.id).summary_status).toBe('stale');
  });
});

describe('deleted and added files', () => {
  it('a deleted file loses its row, and nothing else is re-summarized', async () => {
    await scan();
    fs.rmSync(path.join(dir, 'sub', 'more.md'));
    const mark = fake.chatBodies.length;
    await scan();
    expect(rowOf('sub/more.md')).toBeUndefined();
    expect(allFileRows(folder.id)).toHaveLength(3);
    expect(filePrompts(mark)).toEqual([]);
    expect(getFolder(folder.id).stats.filesTotal).toBe(3);
  });

  it('a new file is summarized alone', async () => {
    await scan();
    const mark = fake.chatBodies.length;
    fs.writeFileSync(path.join(dir, 'fresh.txt'), 'A brand new file about birds.\n');
    await scan();
    expect(filePrompts(mark)).toEqual(['fresh.txt']);
    expect(rowOf('fresh.txt')).toMatchObject({ summary_status: 'ok', status: 'ok' });
  });

  it('a new unsupported file changes the facts, so only the folder summary is rewritten', async () => {
    await scan();
    const mark = fake.chatBodies.length;
    fs.writeFileSync(path.join(dir, 'scan.psd'), '8BPS-not-a-real-image');
    await scan();
    expect(filePrompts(mark)).toEqual([]);
    expect(fake.chatBodies.length - mark).toBe(1);
    expect(rowOf('scan.psd')).toMatchObject({ status: 'unsupported' });
  });
});

describe('a file that stops being readable text', () => {
  it('turning into a binary file clears its summary and chunks', async () => {
    await scan();
    fs.writeFileSync(path.join(dir, 'plan.txt'), Buffer.from([1, 2, 0, 3, 0, 4]));
    await scan();
    expect(rowOf('plan.txt')).toMatchObject({ status: 'binary', summary: null, summary_status: 'none', index_hash: null, chunk_count: 0 });
    expect(chunksOf('plan.txt')).toEqual([]);
  });
});
