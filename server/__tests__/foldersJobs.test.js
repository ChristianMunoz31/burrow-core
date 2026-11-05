// The Folders job runner: one global FIFO runner, per-folder and queue limits, cancel, reset safety (erase and
// restore), degraded AI, busy-queue retries, links, a replaced folder, and shutdown.
// Real file-backed SQLite in the test data dir, the fake Ollama, synthetic temp folders.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../license/index.js', async (importOriginal) => (await import('./helpers/pro.js')).mockLicenseModule(importOriginal));
vi.mock('../../loadEnv.js', () => ({}));
vi.mock('node-fetch', () => ({ default: vi.fn() }));

import fs from 'node:fs';
import path from 'node:path';
import fetch from 'node-fetch';
import { __resetAiForTests, getAiClient } from '../ai/index.js';
import { __resetLockForTests, closeGate, openGate } from '../backup/lock.js';
import { currentDataGeneration } from '../dataGeneration.js';
import { count, select, setDbMaintenance } from '../db/index.js';
import { eraseAllData } from '../erase/eraseService.js';
import { FolderError } from '../folders/constants.js';
import {
  __setFolderLimitsForTests,
  cancelAllFolderJobs,
  cancelFolderJob,
  drainFolderJobs,
  enqueueFolderJob,
  getFolderJob,
  waitForFolderJob,
} from '../folders/jobs.js';
import { __setPathOptionsForTests } from '../folders/pathSafety.js';
import { allFileRows, getFolder, updateFolder } from '../folders/store.js';
import { __setBusyDelaysForTests } from '../folders/summarize.js';
import { toFolderView } from '../folders/views.js';
import { cleanupBackupEnv } from './helpers/backupEnv.js';
import { freshDb, rowCounts } from './helpers/eraseEnv.js';
import { hangingChat, installFakeOllama, textReply } from './helpers/fakeOllama.js';
import { addFolderRow, errorBody, makeTmp, rmTree, tryDirLink, tryFileLink, useNeutralPaths, writeTree } from './helpers/foldersEnv.js';
import { resetPro } from './helpers/pro.js';
import { resetLicenseForTests } from '../license/index.js';

const NOW = new Date('2026-10-05T12:30:00.000Z');
let base;
let n = 0;
let fake;

/** A new folder with files; returns { dir, folder }. */
async function mkFolder(files = { 'a.txt': 'Alpha file text about gardens.\n' }, name) {
  n += 1;
  const dir = path.join(base, `f${n}`);
  writeTree(dir, files);
  return { dir, folder: await addFolderRow(dir, name) };
}
const enqueue = (folder, extra = {}) => enqueueFolderJob({ folderId: folder.id, kind: 'scan', trigger: 'user', ...extra });
const finish = (job) => waitForFolderJob(job.id, { timeoutMs: 30000 });
const run = async (folder) => finish(enqueue(folder));
const fileOf = (body) => /"File":"([^"]+)"/.exec(body.messages.map((m) => m.content).join('\n'))?.[1] ?? null;

/** A chat that waits for release(); `honourAbort` makes a waiting call reject when its signal aborts. */
function gatedChat({ honourAbort = true, onCall } = {}) {
  let release = () => {};
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const chat = (body, init) => {
    onCall?.(body);
    return new Promise((resolve, reject) => {
      gate.then(() => resolve(textReply('A short note about the files.')));
      if (honourAbort) init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
    });
  };
  return { chat, release: () => release() };
}
const install = (opts = {}) => {
  fake = installFakeOllama(fetch, { embedModel: true, chat: () => textReply('A short note about the files.'), ...opts });
  return fake;
};

beforeAll(() => {
  base = makeTmp('burrow-folders-jobs-');
});
afterAll(() => {
  rmTree(base);
});
beforeEach(() => {
  freshDb();
  useNeutralPaths(base);
  __resetAiForTests();
  fetch.mockReset();
  __setBusyDelaysForTests([1, 1, 1]);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  install();
});
afterEach(async () => {
  cancelAllFolderJobs('shutdown');
  await drainFolderJobs({ timeoutMs: 2000 });
  __setFolderLimitsForTests(null);
  __setBusyDelaysForTests(null);
  __setPathOptionsForTests(null);
  setDbMaintenance(false);
  __resetLockForTests();
  resetPro();
  resetLicenseForTests();
  delete process.env.BURROW_AI_QUEUE_MAX;
  cleanupBackupEnv();
  vi.restoreAllMocks();
});

describe('enqueueFolderJob', () => {
  it('returns a queued/running JobView with the contract fields', async () => {
    const { folder } = await mkFolder();
    const view = enqueue(folder);
    expect(view).toMatchObject({
      folderId: folder.id,
      kind: 'scan',
      trigger: 'user',
      progress: { filesSeen: 0, filesRead: 0, bytesRead: 0, summariesTotal: 0, summariesDone: 0, chunksTotal: 0, chunksDone: 0 },
      finishedAt: null,
      error: null,
      notices: [],
    });
    expect(view.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(['queued', 'running']).toContain(view.status);
    expect(getFolderJob(folder.id)).toMatchObject({ id: view.id, status: 'running', phase: expect.stringMatching(/^(inventory|summarizing_files)$/), queuePosition: null });
    const done = await finish(view);
    expect(done).toMatchObject({ status: 'done', phase: 'done', error: null, queuePosition: null });
    expect(done.finishedAt).toEqual(expect.any(String));
    expect(done.progress).toMatchObject({ filesSeen: 1, filesRead: 1, summariesTotal: 1, summariesDone: 1 });
  });

  it('an unknown folder is folder_not_found (404)', () => {
    expect(() => enqueueFolderJob({ folderId: '00000000-0000-4000-8000-000000000000', kind: 'scan', trigger: 'user' })).toThrow(FolderError);
    try {
      enqueueFolderJob({ folderId: '00000000-0000-4000-8000-000000000000', kind: 'scan', trigger: 'user' });
    } catch (err) {
      expect(err).toMatchObject({ code: 'folder_not_found', status: 404, message: errorBody('folder_not_found').message });
    }
  });

  it('the view returned for a job that starts at once says running, not queued with a position', async () => {
    const { folder } = await mkFolder();
    const view = enqueue(folder);
    expect(view).toMatchObject({ status: 'running', queuePosition: null });
    await finish(view);
  });

  it('records the result on the folder row and in its view', async () => {
    const { folder } = await mkFolder();
    await run(folder);
    const row = getFolder(folder.id);
    expect(row).toMatchObject({ last_job_status: 'done', last_job_error: null });
    expect(row.last_job_at).toEqual(expect.any(String));
    expect(toFolderView(row).lastJob).toMatchObject({ status: 'done', errorCode: null, message: null });
  });

  it('getFolderJob is null for a folder that never had a job', async () => {
    const { folder } = await mkFolder();
    expect(getFolderJob(folder.id)).toBeNull();
  });
});

describe('one global runner, FIFO, per-folder and queue limits', () => {
  it('runs jobs one at a time in the order they were queued', async () => {
    const folders = [];
    for (const k of ['a', 'b', 'c']) folders.push((await mkFolder({ [`${k}.txt`]: `${k} file text\n` })).folder);
    const concurrent = [];
    const gated = gatedChat({
      onCall: () => concurrent.push(folders.filter((f) => getFolderJob(f.id)?.status === 'running').length),
    });
    install({ chat: gated.chat });
    const jobs = folders.map((f) => enqueue(f));
    expect(getFolderJob(folders[0].id)).toMatchObject({ status: 'running', queuePosition: null });
    expect(getFolderJob(folders[1].id)).toMatchObject({ status: 'queued', phase: 'queued', queuePosition: 1 });
    expect(getFolderJob(folders[2].id)).toMatchObject({ status: 'queued', queuePosition: 2 });
    await vi.waitFor(() => expect(fake.chatBodies.length).toBe(1));
    gated.release();
    const done = [];
    for (const j of jobs) done.push(await finish(j));
    expect(done.map((j) => j.status)).toEqual(['done', 'done', 'done']);
    // never two running at once, and each job ran entirely before the next started
    expect(Math.max(...concurrent)).toBe(1);
    expect(done[0].finishedAt <= done[1].startedAt).toBe(true);
    expect(done[1].finishedAt <= done[2].startedAt).toBe(true);
    // the model saw folder a, then b, then c
    const order = fake.chatBodies.map(fileOf).filter(Boolean);
    expect(order).toEqual(['a.txt', 'b.txt', 'c.txt']);
  });

  it('a second job for a folder that is queued or running is folder_job_running (409)', async () => {
    const { folder } = await mkFolder();
    const gated = gatedChat();
    install({ chat: gated.chat });
    const first = enqueue(folder);
    for (const kind of ['scan', 'report']) {
      try {
        enqueueFolderJob({ folderId: folder.id, kind, trigger: 'user' });
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(FolderError);
        expect(err).toMatchObject({ code: 'folder_job_running', status: 409, message: errorBody('folder_job_running').message });
      }
    }
    gated.release();
    await finish(first);
    const again = enqueue(folder); // allowed again once it ended
    expect(getFolderJob(folder.id).status).toBe('running');
    await finish(again);
  });

  it('a full queue is folder_queue_full (429) and leaves no job behind', async () => {
    __setFolderLimitsForTests({ maxQueued: 1 });
    const [a, b, c] = [(await mkFolder()).folder, (await mkFolder()).folder, (await mkFolder()).folder];
    const gated = gatedChat();
    install({ chat: gated.chat });
    const jobA = enqueue(a); // running
    const jobB = enqueue(b); // queued (1 of 1)
    expect(getFolderJob(a.id).status).toBe('running');
    expect(getFolderJob(b.id)).toMatchObject({ status: 'queued', queuePosition: 1 });
    try {
      enqueue(c);
      expect.unreachable();
    } catch (err) {
      expect(err).toMatchObject({ code: 'folder_queue_full', status: 429, message: errorBody('folder_queue_full').message });
    }
    expect(getFolderJob(c.id)).toBeNull();
    gated.release();
    await finish(jobA);
    await finish(jobB);
    const again = enqueue(c); // room again
    expect(getFolderJob(c.id).status).toBe('running');
    await finish(again);
  });

  it('twenty jobs may wait behind the running one (the default queue size)', async () => {
    const folders = [];
    for (let i = 0; i < 22; i += 1) folders.push((await mkFolder({ 'x.txt': `file ${i}\n` })).folder);
    const gated = gatedChat();
    install({ chat: gated.chat });
    folders.slice(0, 21).forEach((f) => enqueue(f)); // 1 running + 20 queued
    expect(getFolderJob(folders[0].id).status).toBe('running');
    expect(getFolderJob(folders[20].id)).toMatchObject({ status: 'queued', queuePosition: 20 });
    expect(() => enqueue(folders[21])).toThrow(expect.objectContaining({ code: 'folder_queue_full' }));
    cancelAllFolderJobs('shutdown');
    gated.release();
    await drainFolderJobs({ timeoutMs: 5000 });
  });
});

describe('cancel', () => {
  it('cancelling a queued job removes it at once: cancelled, never run', async () => {
    const [a, b] = [(await mkFolder()).folder, (await mkFolder()).folder];
    const gated = gatedChat();
    install({ chat: gated.chat });
    const jobA = enqueue(a);
    const jobB = enqueue(b);
    const cancelled = cancelFolderJob(b.id);
    expect(cancelled).toMatchObject({ id: jobB.id, status: 'cancelled', error: { code: 'cancelled', message: errorBody('cancelled').message } });
    expect(getFolder(b.id)).toMatchObject({ last_job_status: 'cancelled' });
    expect(allFileRows(b.id)).toEqual([]);
    gated.release();
    expect((await finish(jobA)).status).toBe('done');
    expect(fake.chatBodies.map(fileOf).filter(Boolean)).toEqual(['a.txt']);
  });

  it('cancelling with nothing running is folder_no_job (409)', async () => {
    const { folder } = await mkFolder();
    expect(() => cancelFolderJob(folder.id)).toThrow(expect.objectContaining({ code: 'folder_no_job', status: 409 }));
    await run(folder);
    expect(() => cancelFolderJob(folder.id)).toThrow(expect.objectContaining({ code: 'folder_no_job' }));
  });

  it('cancel in the middle of the summaries keeps what was finished, and the next scan resumes', async () => {
    const t = (i) => new Date(Date.UTC(2026, 0, 1 + i));
    const { dir, folder } = await mkFolder({ 'one.txt': 'first file text\n', 'two.txt': 'second file text\n', 'three.txt': 'third file text\n' });
    ['one', 'two', 'three'].forEach((k, i) => fs.utimesSync(path.join(dir, `${k}.txt`), t(10 - i), t(10 - i))); // one is newest
    let calls = 0;
    install({
      chat: (body, init) => {
        calls += 1;
        return calls === 1 ? textReply('First note.') : hangingChat(body, init);
      },
    });
    const job = enqueue(folder);
    await vi.waitFor(() => expect(fake.chatBodies.length).toBe(2));
    expect(allFileRows(folder.id).filter((r) => r.summary_status === 'ok').map((r) => r.rel_path)).toEqual(['one.txt']);
    cancelFolderJob(folder.id);
    const done = await finish(job);
    expect(done).toMatchObject({ status: 'cancelled', error: { code: 'cancelled', message: errorBody('cancelled').message } });
    const rows = Object.fromEntries(allFileRows(folder.id).map((r) => [r.rel_path, r.summary_status]));
    expect(rows).toEqual({ 'one.txt': 'ok', 'three.txt': 'none', 'two.txt': 'none' });
    expect(allFileRows(folder.id).find((r) => r.rel_path === 'one.txt').summary).toBe('First note.');
    expect(getFolder(folder.id)).toMatchObject({ last_job_status: 'cancelled' });
    expect(JSON.parse(getFolder(folder.id).last_job_error)).toMatchObject({ code: 'cancelled' });
    expect(toFolderView(getFolder(folder.id)).lastJob).toMatchObject({ status: 'cancelled', errorCode: 'cancelled', message: errorBody('cancelled').message });

    // resume: only the two unfinished files (and the folder) are summarized
    install({ chat: () => textReply('Later note.') });
    expect((await run(folder)).status).toBe('done');
    expect(fake.chatBodies.map(fileOf).filter(Boolean).sort()).toEqual(['three.txt', 'two.txt']);
    expect(allFileRows(folder.id).find((r) => r.rel_path === 'one.txt').summary).toBe('First note.');
    expect(allFileRows(folder.id).every((r) => r.summary_status === 'ok')).toBe(true);
  });

  it('cancel during the inventory stops without summaries', async () => {
    const files = Object.fromEntries(Array.from({ length: 30 }, (_v, i) => [`f${String(i).padStart(2, '0')}.txt`, `text ${i}`]));
    const { folder } = await mkFolder(files);
    const job = enqueue(folder);
    cancelFolderJob(folder.id);
    const done = await finish(job);
    expect(done.status).toBe('cancelled');
    expect(fake.chatBodies).toEqual([]);
  });
});

describe('erase and restore during a job', () => {
  it.each([
    ['a model that stops when asked', true],
    ['a model that ignores the abort', false],
  ])('an erase during a job (%s) ends it interrupted with data_reset and writes nothing afterwards', async (_label, honourAbort) => {
    const { folder } = await mkFolder({ 'a.txt': 'alpha text\n', 'b.txt': 'beta text\n' });
    const gated = gatedChat({ honourAbort });
    install({ chat: gated.chat });
    const generation = currentDataGeneration();
    const job = enqueue(folder);
    await vi.waitFor(() => expect(fake.chatBodies.length).toBe(1));
    await eraseAllData({ now: () => NOW });
    expect(currentDataGeneration()).toBeGreaterThan(generation);
    const afterErase = rowCounts();
    gated.release();
    const done = await finish(job);
    expect(done).toMatchObject({ status: 'interrupted', error: { code: 'data_reset', message: errorBody('data_reset').message } });
    // no later writes: the tables are exactly as the erase left them
    expect(rowCounts()).toEqual(afterErase);
    expect(rowCounts()).toMatchObject({ folders: 0, folder_files: 0, folder_chunks: 0 });
    expect(select('audit_log', { columns: ['feature'] }).map((r) => r.feature).filter((f) => f.startsWith('folder_'))).toEqual([]);
    // it only ever made the one call it had started
    expect(fake.chatBodies).toHaveLength(1);
  });

  it('an erase while jobs are queued interrupts them too and clears the queue', async () => {
    const [a, b] = [(await mkFolder()).folder, (await mkFolder()).folder];
    const gated = gatedChat();
    install({ chat: gated.chat });
    const jobA = enqueue(a);
    const jobB = enqueue(b);
    await vi.waitFor(() => expect(fake.chatBodies.length).toBe(1));
    await eraseAllData({ now: () => NOW });
    gated.release();
    expect(await finish(jobA)).toMatchObject({ status: 'interrupted', error: { code: 'data_reset' } });
    // the queued job is dropped and forgotten (its folder is gone too); it never ran
    expect(await finish(jobB)).toBeNull();
    expect(getFolderJob(b.id)).toBeNull();
    expect(rowCounts()).toMatchObject({ folders: 0, folder_files: 0 });
    expect(fake.chatBodies).toHaveLength(1);
  });

  it('a closed restore gate stops a job before it writes anything', async () => {
    const { folder } = await mkFolder();
    closeGate('restore');
    try {
      const done = await run(folder);
      expect(done).toMatchObject({ status: 'interrupted', error: { code: 'data_reset' } });
      expect(allFileRows(folder.id)).toEqual([]);
      expect(getFolder(folder.id).last_job_status).toBeNull();
      expect(fake.chatBodies).toEqual([]);
    } finally {
      openGate();
    }
  });

  it('a restore that starts mid-job interrupts it: no summary is written', async () => {
    const { folder } = await mkFolder({ 'a.txt': 'alpha text\n' });
    const gated = gatedChat({ honourAbort: false });
    install({ chat: gated.chat });
    const job = enqueue(folder);
    await vi.waitFor(() => expect(fake.chatBodies.length).toBe(1));
    closeGate('restore');
    try {
      gated.release();
      const done = await finish(job);
      expect(done).toMatchObject({ status: 'interrupted', error: { code: 'data_reset' } });
      expect(allFileRows(folder.id).every((r) => r.summary === null && r.summary_status === 'none')).toBe(true);
      expect(getFolder(folder.id)).toMatchObject({ summary: null, last_job_status: null });
    } finally {
      openGate();
    }
  });

  it('a database that is being restored (db_restoring) interrupts the job instead of failing it', async () => {
    const { folder } = await mkFolder({ 'a.txt': 'alpha text\n' });
    const gated = gatedChat({ honourAbort: false });
    install({ chat: gated.chat });
    const job = enqueue(folder);
    await vi.waitFor(() => expect(fake.chatBodies.length).toBe(1));
    setDbMaintenance(true);
    gated.release();
    const done = await finish(job);
    setDbMaintenance(false);
    expect(done).toMatchObject({ status: 'interrupted', error: { code: 'data_reset' } });
  });
});

describe('the AI is not available', () => {
  it('Ollama down: the inventory completes, a notice explains, the job is done', async () => {
    const { folder } = await mkFolder({ 'a.txt': 'alpha text\n', 'b.md': '# Beta\n', 'pic.png': 'x' });
    install({ down: true });
    const done = await run(folder);
    expect(done.status).toBe('done');
    expect(done.error).toBeNull();
    expect(done.notices).toHaveLength(1);
    expect(done.notices[0]).toMatchObject({ code: 'ai_unavailable' });
    expect(done.notices[0].message).toEqual(expect.any(String));
    expect(done.notices[0].message.length).toBeGreaterThan(10);
    const row = getFolder(folder.id);
    expect(row.last_scan_at).toEqual(expect.any(String));
    expect(row.stats).toMatchObject({ filesTotal: 3, filesRead: 2 });
    expect(row.stats.index).toMatchObject({ status: 'none', skipped: 'not_pro' });
    expect(row).toMatchObject({ summary: null, summary_status: 'ai_unavailable' });
    expect(allFileRows(folder.id).map((r) => [r.rel_path, r.status, r.summary_status])).toEqual([
      ['a.txt', 'ok', 'none'],
      ['b.md', 'ok', 'none'],
      ['pic.png', 'unsupported', 'none'],
    ]);
  });

  it('AI switched off (BURROW_AI=0) behaves the same', async () => {
    const { folder } = await mkFolder();
    process.env.BURROW_AI = '0';
    try {
      __resetAiForTests();
      const done = await run(folder);
      expect(done.status).toBe('done');
      expect(done.notices.map((x) => x.code)).toEqual(['ai_unavailable']);
      expect(getFolder(folder.id).stats.filesTotal).toBe(1);
    } finally {
      delete process.env.BURROW_AI;
    }
  });

  it('the summaries come back on the next scan once Ollama is up', async () => {
    const { folder } = await mkFolder();
    install({ down: true });
    await run(folder);
    __resetAiForTests();
    install();
    const done = await run(folder);
    expect(done.notices).toEqual([]);
    expect(getFolder(folder.id)).toMatchObject({ summary_status: 'ok', summary: 'A short note about the files.' });
    expect(allFileRows(folder.id)[0].summary_status).toBe('ok');
  });

  it('a model that answers nothing marks the file failed; three failures in a row stop the summaries with one notice', async () => {
    const files = Object.fromEntries(['a', 'b', 'c', 'd', 'e'].map((k) => [`${k}.txt`, `${k} text\n`]));
    const { folder } = await mkFolder(files);
    install({ chat: () => textReply('') });
    const done = await run(folder);
    expect(done.status).toBe('done');
    expect(done.notices).toHaveLength(1);
    const by = allFileRows(folder.id).map((r) => r.summary_status);
    expect(by.filter((s) => s === 'failed')).toHaveLength(3);
    expect(by.filter((s) => s === 'none')).toHaveLength(2);
    expect(fake.chatBodies).toHaveLength(3);
    expect(getFolder(folder.id).summary).toBeNull();
  });

  it('one failure is only that file: the others are summarized and the count resets', async () => {
    const files = Object.fromEntries(['a', 'b', 'c', 'd'].map((k) => [`${k}.txt`, `${k} text\n`]));
    const { dir, folder } = await mkFolder(files);
    ['a', 'b', 'c', 'd'].forEach((k, i) => fs.utimesSync(path.join(dir, `${k}.txt`), new Date(Date.UTC(2026, 0, 10 - i)), new Date(Date.UTC(2026, 0, 10 - i))));
    let calls = 0;
    install({ chat: () => (++calls === 2 ? textReply('') : textReply('A note.')) });
    const done = await run(folder);
    expect(done.status).toBe('done');
    expect(Object.fromEntries(allFileRows(folder.id).map((r) => [r.rel_path, r.summary_status]))).toEqual({ 'a.txt': 'ok', 'b.txt': 'failed', 'c.txt': 'ok', 'd.txt': 'ok' });
    expect(getFolder(folder.id).summary_status).toBe('ok');
  });
});

describe('the question index without the Pro module', () => {
  it('a scan skips the index as not_pro even with Pro entitlements, and still summarizes', async () => {
    const { folder } = await mkFolder();
    const done = await run(folder);
    expect(done.status).toBe('done');
    expect(getFolder(folder.id).stats.index).toMatchObject({ status: 'none', skipped: 'not_pro' });
    expect(getFolder(folder.id)).toMatchObject({ summary_status: 'ok' });
    expect(count('folder_chunks')).toBe(0);
  });
});

describe('a busy AI queue', () => {
  /** Holds the single AI slot with a long call until release(). */
  async function holdTheQueue() {
    let release = () => {};
    const held = new Promise((resolve) => {
      release = resolve;
    });
    let first = true;
    install({
      chat: (body, init) => {
        if (first) {
          first = false;
          return new Promise((resolve, reject) => {
            held.then(() => resolve(textReply('held')));
            init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
          });
        }
        return textReply('A short note about the files.');
      },
    });
    process.env.BURROW_AI_QUEUE_MAX = '0';
    __resetAiForTests();
    const client = await getAiClient({ purpose: 'chat' });
    const call = client.complete({ messages: [{ role: 'user', content: 'hold' }], maxTokens: 5, scope: { categories: ['folders'] } });
    call.catch(() => {});
    await vi.waitFor(() => expect(fake.chatBodies.length).toBe(1));
    return { release: () => release(), call };
  }

  it('retries the same call and succeeds once the queue frees up', async () => {
    const { folder } = await mkFolder();
    const held = await holdTheQueue();
    __setBusyDelaysForTests([60, 60, 60]);
    setTimeout(() => held.release(), 20);
    const done = await run(folder);
    await held.call;
    expect(done.status).toBe('done');
    expect(done.notices).toEqual([]);
    expect(allFileRows(folder.id)[0]).toMatchObject({ summary_status: 'ok', summary: 'A short note about the files.' });
  });

  it('after three retries the summaries stop with a notice and the job still finishes', async () => {
    const { folder } = await mkFolder({ 'a.txt': 'a text\n', 'b.txt': 'b text\n' });
    const held = await holdTheQueue();
    const done = await run(folder);
    held.release();
    await held.call;
    expect(done.status).toBe('done');
    expect(done.notices.map((x) => x.code)).toEqual(['ai_busy']);
    expect(allFileRows(folder.id).map((r) => r.summary_status)).toEqual(['none', 'none']);
    expect(getFolder(folder.id).stats.filesTotal).toBe(2);
    expect(fake.chatBodies).toHaveLength(1); // only the holder ever reached the model
  });
});

describe('links and replaced folders', () => {
  const SECRET = 'LINK_TARGET_SECRET_77x';

  it('a junction inside the folder that points outside is listed as `link`; its content reaches no row, chunk or prompt', async () => {
    const { dir, folder } = await mkFolder({ 'real.txt': 'The real file mentions tomatoes.\n' });
    const outside = path.join(base, `outside-${n}`);
    writeTree(outside, { 'secret.txt': `${SECRET} secret body\n`, 'deeper/more.md': `${SECRET} more\n` });
    if (!tryDirLink(outside, path.join(dir, 'link'))) return; // the OS refuses links here
    const done = await run(folder);
    expect(done.status).toBe('done');
    const rows = allFileRows(folder.id);
    expect(rows.map((r) => [r.rel_path, r.status])).toEqual([['link', 'link'], ['real.txt', 'ok']]);
    expect(rows.find((r) => r.rel_path === 'link')).toMatchObject({ size_bytes: 0, sha256: null, summary: null, summary_status: 'none' });
    const everywhere = JSON.stringify([rows, select('folder_chunks'), getFolder(folder.id), fake.chatBodies, fake.embedBodies]);
    expect(everywhere).not.toContain(SECRET);
    expect(everywhere).not.toContain('secret body');
    expect(getFolder(folder.id).stats.byStatus.link).toBe(1);
    // the target is untouched
    expect(fs.readdirSync(outside).sort()).toEqual(['deeper', 'secret.txt']);
  });

  it('a file symlink pointing outside is `link` and never read', async () => {
    const { dir, folder } = await mkFolder({ 'real.txt': 'real\n' });
    const outside = path.join(base, `outside-${n}`);
    writeTree(outside, { 'secret.txt': `${SECRET}\n` });
    if (!tryFileLink(path.join(outside, 'secret.txt'), path.join(dir, 'shortcut.txt'))) return;
    await run(folder);
    expect(allFileRows(folder.id).find((r) => r.rel_path === 'shortcut.txt')).toMatchObject({ status: 'link', summary: null });
    expect(JSON.stringify([fake.chatBodies, fake.embedBodies, select('folder_chunks')])).not.toContain(SECRET);
  });

  it('a link added between scans removes nothing and reads nothing new', async () => {
    const { dir, folder } = await mkFolder({ 'real.txt': 'real file text\n' });
    await run(folder);
    const outside = path.join(base, `outside-${n}`);
    writeTree(outside, { 'secret.txt': `${SECRET}\n` });
    if (!tryDirLink(outside, path.join(dir, 'late-link'))) return;
    const mark = fake.chatBodies.length;
    await run(folder);
    // the link is one more file in the facts, so only the folder summary is rewritten; no file prompt, nothing from the target
    expect(fake.chatBodies.slice(mark).map(fileOf).filter(Boolean)).toEqual([]);
    expect(JSON.stringify(fake.chatBodies.slice(mark))).not.toContain(SECRET);
    expect(allFileRows(folder.id).map((r) => r.status).sort()).toEqual(['link', 'ok']);
  });

  it('a folder replaced by a junction between scans fails the next scan and reads nothing through the link', async () => {
    const { dir, folder } = await mkFolder({ 'real.txt': 'real file text\n' });
    await run(folder);
    const before = allFileRows(folder.id);
    const moved = `${dir}-moved`;
    fs.renameSync(dir, moved);
    writeTree(moved, { 'planted.txt': `${SECRET}\n` });
    if (!tryDirLink(moved, dir)) {
      fs.renameSync(moved, dir);
      return;
    }
    const mark = fake.chatBodies.length;
    const done = await run(folder);
    // BEHAVIOUR NOTE: the spec says "folder_moved (or the validation code)". A replaced root is a link, so the
    // root check answers with the validation code folder_is_link before the key comparison can say folder_moved.
    expect(done.status).toBe('failed');
    expect(['folder_moved', 'folder_is_link']).toContain(done.error.code);
    expect(done.error.code).toBe('folder_is_link');
    expect(done.error.message).toEqual(expect.any(String));
    expect(fake.chatBodies).toHaveLength(mark);
    expect(JSON.stringify(allFileRows(folder.id))).not.toContain('planted');
    expect(allFileRows(folder.id)).toEqual(before); // the earlier inventory is kept as it was
    expect(getFolder(folder.id).last_job_status).toBe('failed');
    expect(toFolderView(getFolder(folder.id)).lastJob).toMatchObject({ status: 'failed', errorCode: 'folder_is_link' });
  });

  it('a folder whose real location changed (key mismatch) fails with folder_moved', async () => {
    const { folder } = await mkFolder();
    await run(folder);
    updateFolder(folder.id, { path_key: `${folder.path_key}-elsewhere` });
    const done = await run(folder);
    expect(done).toMatchObject({ status: 'failed', error: { code: 'folder_moved', message: errorBody('folder_moved').message } });
    expect(getFolder(folder.id).last_job_status).toBe('failed');
    expect(JSON.parse(getFolder(folder.id).last_job_error)).toMatchObject({ code: 'folder_moved' });
  });

  it('a folder deleted from disk fails the next scan with folder_missing and keeps the earlier inventory', async () => {
    const { dir, folder } = await mkFolder({ 'real.txt': 'text\n' });
    await run(folder);
    rmTree(dir);
    const done = await run(folder);
    expect(done).toMatchObject({ status: 'failed', error: { code: 'folder_missing' } });
    expect(allFileRows(folder.id)).toHaveLength(1);
  });

  it('a folder row removed while its job is queued is folder_not_found, not a crash', async () => {
    const [a, b] = [(await mkFolder()).folder, (await mkFolder()).folder];
    const gated = gatedChat();
    install({ chat: gated.chat });
    const jobA = enqueue(a);
    const jobB = enqueue(b);
    const { removeFolder } = await import('../folders/store.js');
    removeFolder(b.id);
    gated.release();
    await finish(jobA);
    expect(await finish(jobB)).toMatchObject({ status: 'failed', error: { code: 'folder_not_found' } });
    expect(count('folders')).toBe(1);
  });
});

describe('the report job', () => {
  it('without a client it fails with folder_failed', async () => {
    const { folder } = await mkFolder();
    await run(folder);
    const done = await finish(enqueueFolderJob({ folderId: folder.id, kind: 'report', trigger: 'user' }));
    expect(done).toMatchObject({ kind: 'report', status: 'failed', error: { code: 'folder_failed' } });
  });

});

describe('audit rows of a scan', () => {
  it('records one folder_summary row with counts only (no index row without the Pro index hook)', async () => {
    await import('../audit.js');
    const { folder } = await mkFolder({ 'a.txt': 'Alpha secret garden text.\n' }, 'Private name');
    await run(folder);
    const rows = select('audit_log', { where: { page: 'folders' } });
    expect(rows.map((r) => r.feature).sort()).toEqual(['folder_summary']);
    const summary = rows.find((r) => r.feature === 'folder_summary');
    expect(summary).toMatchObject({ kind: 'llm', provider: 'ollama', status: 'ok' });
    expect(summary.meta).toMatchObject({ calls: 2, files: 1, ai_kind: 'local' });
    expect(JSON.stringify(rows)).not.toMatch(/secret garden|Private name|a\.txt/);
    expect(rows.every((r) => r.context === null || r.context === undefined)).toBe(true);
  });
});

describe('shutdown', () => {
  it('drainFolderJobs is true at once when nothing runs', async () => {
    expect(await drainFolderJobs({ timeoutMs: 50 })).toBe(true);
  });

  it('drainFolderJobs times out (false) while a job is still running', async () => {
    const { folder } = await mkFolder();
    const gated = gatedChat({ honourAbort: false });
    install({ chat: gated.chat });
    const job = enqueue(folder);
    await vi.waitFor(() => expect(fake.chatBodies.length).toBe(1));
    expect(await drainFolderJobs({ timeoutMs: 30 })).toBe(false);
    gated.release();
    expect(await drainFolderJobs({ timeoutMs: 5000 })).toBe(true);
    await finish(job);
  });

  it("cancelAllFolderJobs('shutdown') interrupts the running and the queued jobs; drain then returns true", async () => {
    const [a, b] = [(await mkFolder()).folder, (await mkFolder()).folder];
    install({ chat: hangingChat });
    const jobA = enqueue(a);
    const jobB = enqueue(b);
    await vi.waitFor(() => expect(fake.chatBodies.length).toBe(1));
    cancelAllFolderJobs('shutdown');
    expect(await drainFolderJobs({ timeoutMs: 2000 })).toBe(true);
    expect(await finish(jobA)).toMatchObject({ status: 'interrupted', error: { code: 'shutdown', message: errorBody('shutdown').message } });
    expect(await finish(jobB)).toMatchObject({ status: 'interrupted', error: { code: 'shutdown' } });
    expect(getFolder(a.id)).toMatchObject({ last_job_status: 'interrupted' });
    expect(toFolderView(getFolder(a.id)).lastJob).toMatchObject({ status: 'interrupted', errorCode: 'shutdown' });
    // the queue is empty: a new job starts at once
    const again = enqueue(a);
    expect(getFolderJob(a.id).status).toBe('running');
    cancelAllFolderJobs('shutdown');
    await finish(again);
  });
});

describe('waitForFolderJob', () => {
  it('is null for an unknown job id', async () => {
    expect(await waitForFolderJob('nope', { timeoutMs: 10 })).toBeNull();
  });

  it('returns after the timeout with the job still running', async () => {
    const { folder } = await mkFolder();
    install({ chat: hangingChat });
    const job = enqueue(folder);
    await vi.waitFor(() => expect(fake.chatBodies.length).toBe(1));
    const view = await waitForFolderJob(job.id, { timeoutMs: 20 });
    expect(view.status).toBe('running');
  });

  it('returns when its signal aborts', async () => {
    const { folder } = await mkFolder();
    install({ chat: hangingChat });
    const job = enqueue(folder);
    await vi.waitFor(() => expect(fake.chatBodies.length).toBe(1));
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);
    expect((await waitForFolderJob(job.id, { signal: controller.signal })).status).toBe('running');
    expect((await waitForFolderJob(job.id, { signal: AbortSignal.abort() })).status).toBe('running');
  });

  it('returns a finished job at once', async () => {
    const { folder } = await mkFolder();
    const done = await run(folder);
    expect(await waitForFolderJob(done.id)).toMatchObject({ id: done.id, status: 'done' });
  });
});
