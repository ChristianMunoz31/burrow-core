// The native folder picker through the Folders routes: pick, poll, cancel, refusals with exact codes and copy, the
// pasted path being refused where dialogs exist, and confirming an imported folder. The shell is replaced by signed replies
// (the same MAC the real shell computes), the file system and database are real temp ones, Ollama is the fake one.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../license/index.js', async (importOriginal) => (await import('./helpers/pro.js')).mockLicenseModule(importOriginal));
import request from 'supertest';

vi.mock('../../loadEnv.js', () => ({}));
vi.mock('node-fetch', () => ({ default: vi.fn() }));

import fs from 'node:fs';
import path from 'node:path';
import fetch from 'node-fetch';
import { __resetAiForTests } from '../ai/index.js';
import { count, select } from '../db/index.js';
import { cancelAllFolderJobs, drainFolderJobs, waitForFolderJob } from '../folders/jobs.js';
import { __setPathOptionsForTests } from '../folders/pathSafety.js';
import { getFolder, insertFolder, updateFolder } from '../folders/store.js';
import { __setBusyDelaysForTests } from '../folders/summarize.js';
import { resetPro } from './helpers/pro.js';
import { installFakeOllama, textReply } from './helpers/fakeOllama.js';
import { COPY, errorBody, makeTmp, neutralPathOptions, rmTree, tryDirLink, writeTree } from './helpers/foldersEnv.js';
import { SAME_ORIGIN, captureRequests, deliver, makeDialogApp, startDialogs, stopDialogs } from './helpers/dialogHarness.js';
import { closeTestDb, createTestDb, resetDb } from './helpers/testDb.js';

const NO_FOLDER = '00000000-0000-4000-8000-000000000000';

let app;
let db;
let root;
let dir;
let captured;

const post = (url, body) => request(app).post(url).set(SAME_ORIGIN).send(body);
const getDialog = (id) => request(app).get(`/api/folders/dialogs/${id}`);
const expectError = (res, code) => {
  expect(res.status, `${code}: ${JSON.stringify(res.body)}`).toBe(COPY[code][0]);
  expect(res.body).toEqual(errorBody(code));
  expect(res.headers['cache-control']).toBe('no-store');
};

async function startPick(body = {}) {
  const res = await post('/api/folders/pick', body);
  expect(res.status, JSON.stringify(res.body)).toBe(202);
  return res.body.data.dialog;
}
const flush = () => new Promise((resolve) => setImmediate(resolve));
async function settled(id) {
  for (let i = 0; i < 100; i += 1) {
    const { dialog } = (await getDialog(id)).body.data;
    if (dialog.status !== 'waiting' && dialog.status !== 'checking') return dialog;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('dialog never settled');
}

beforeAll(() => {
  db = createTestDb();
  root = makeTmp('burrow-folders-pick-');
  fs.mkdirSync(path.join(root, 'fake-home'), { recursive: true });
  __setBusyDelaysForTests([1, 1, 1]);
});
afterAll(() => {
  __setPathOptionsForTests(null);
  __setBusyDelaysForTests(null);
  closeTestDb(db);
  rmTree(root);
});
beforeEach(() => {
  resetDb(db);
  startDialogs();
  captured = captureRequests();
  app = makeDialogApp();
  __setPathOptionsForTests(neutralPathOptions(root));
  __resetAiForTests();
  fetch.mockReset();
  installFakeOllama(fetch, { chat: () => textReply('A short note about the files.') });
  dir = path.join(root, 'notes');
  rmTree(dir);
  writeTree(dir, { 'plan.txt': 'The garden plan has tomatoes.\n', 'sub/recipe.md': '# Soup\nTomatoes and basil.\n' });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(async () => {
  cancelAllFolderJobs('shutdown');
  await drainFolderJobs({ timeoutMs: 2000 });
  stopDialogs();
  resetPro();
  vi.restoreAllMocks();
});

describe('POST /api/folders/pick', () => {
  it('opens the picker, adds the chosen folder, queues the first scan and lists it', async () => {
    const dialog = await startPick();
    expect(dialog).toEqual({ id: expect.stringMatching(/^[0-9a-f]{32}$/), kind: 'pick_folder', status: 'waiting', folderId: null, error: null, folder: null, job: null });
    expect(captured.requests()).toEqual([expect.objectContaining({ kind: 'pick_folder', id: dialog.id, ttl: 900, name: '', ext: '', bytes: 0 })]);

    deliver(dialog.id, 'picked', dir);
    const done = await settled(dialog.id);
    expect(done).toMatchObject({ status: 'added', error: null, folder: { name: 'notes', path: dir, needsConfirm: false } });
    expect(done.folderId).toBe(done.folder.id);
    expect(done.job).toMatchObject({ kind: 'scan', folderId: done.folderId });
    await waitForFolderJob(done.job.id, { timeoutMs: 20000 });

    const list = await request(app).get('/api/folders');
    expect(list.body.data).toMatchObject({ canPickFolder: true, canSaveFile: true });
    expect(list.body.data.folders.map((f) => f.id)).toEqual([done.folderId]);
    expect(count('folders')).toBe(1);
  });

  it('refuses a junction with the exact code and copy, and adds nothing', async () => {
    const link = path.join(root, 'link-to-notes');
    rmTree(link);
    if (!tryDirLink(dir, link)) return; // the OS refuses links here: nothing to test
    const dialog = await startPick();
    deliver(dialog.id, 'picked', link);
    expect(await settled(dialog.id)).toMatchObject({ status: 'refused', folder: null, error: { code: 'folder_is_link', message: COPY.folder_is_link[1] } });
    expect(count('folders')).toBe(0);
    rmTree(link);
  });

  it('refuses a protected folder and a folder that is too broad', async () => {
    __setPathOptionsForTests(neutralPathOptions(root, { execDir: dir }));
    const a = await startPick();
    deliver(a.id, 'picked', dir);
    expect(await settled(a.id)).toMatchObject({ status: 'refused', error: { code: 'folder_protected', message: COPY.folder_protected[1] } });
    __setPathOptionsForTests(neutralPathOptions(root));
    const b = await startPick();
    deliver(b.id, 'picked', path.join(root, 'fake-home'));
    expect(await settled(b.id)).toMatchObject({ status: 'refused', error: { code: 'folder_too_broad', message: COPY.folder_too_broad[1] } });
    expect(count('folders')).toBe(0);
  });

  it('shows an unusable choice as folder_path_invalid', async () => {
    const dialog = await startPick();
    deliver(dialog.id, 'unusable');
    expect(await settled(dialog.id)).toMatchObject({ status: 'refused', error: { code: 'folder_path_invalid', message: COPY.folder_path_invalid[1] } });
  });

  it('refuses a duplicate and an overlapping folder', async () => {
    const first = await startPick();
    deliver(first.id, 'picked', dir);
    const added = await settled(first.id);
    await waitForFolderJob(added.job.id, { timeoutMs: 20000 });
    const again = await startPick();
    deliver(again.id, 'picked', dir);
    expect(await settled(again.id)).toMatchObject({ status: 'refused', error: { code: 'folder_exists' } });
    const inner = await startPick();
    deliver(inner.id, 'picked', path.join(dir, 'sub'));
    expect(await settled(inner.id)).toMatchObject({ status: 'refused', error: { code: 'folder_overlaps' } });
    expect(count('folders')).toBe(1);
  });

  it('keeps cancelled, busy, expired and failed replies as they are', async () => {
    for (const [status, expected, code] of [
      ['cancelled', 'cancelled', null],
      ['busy', 'busy', 'dialog_busy'],
      ['expired', 'expired', 'dialog_expired'],
      ['failed', 'failed', 'pick_failed'],
    ]) {
      const dialog = await startPick();
      deliver(dialog.id, status);
      const done = await settled(dialog.id);
      expect(done.status).toBe(expected);
      expect(done.error).toEqual(code ? { code, message: COPY[code][1] } : null);
    }
  });

  it('answers folder_limit before any line is written', async () => {
    for (let i = 0; i < 20; i += 1) insertFolder({ name: `f${i}`, path: path.join(root, `f${i}`), pathKey: `key-${i}` });
    const res = await post('/api/folders/pick', {});
    expectError(res, 'folder_limit');
    expect(captured.lines).toEqual([]);
  });

  it('answers dialog_busy while a window is open', async () => {
    await startPick();
    expectError(await post('/api/folders/pick', {}), 'dialog_busy');
    expect(captured.lines).toHaveLength(1);
  });

  it('is same-origin only', async () => {
    const res = await request(app).post('/api/folders/pick').set({ Host: '127.0.0.1:4321', Origin: 'http://localhost:5174' }).send({});
    expectError(res, 'folder_origin_blocked');
    expect(captured.lines).toEqual([]);
  });

  it('needs the dialogs: 409 dialog_unavailable when the shell has none', async () => {
    app = makeDialogApp({ dialogsAvailable: false });
    expectError(await post('/api/folders/pick', {}), 'dialog_unavailable');
    expect(captured.lines).toEqual([]);
    const list = await request(app).get('/api/folders');
    expect(list.body.data).toMatchObject({ canPickFolder: false, canSaveFile: false });
  });

  it.each([
    ['an unknown key', { path: 'C:\\x' }],
    ['a folderId that is not a uuid', { folderId: 'abc' }],
    ['a folderId and another key', { folderId: NO_FOLDER, name: 'x' }],
    ['a numeric folderId', { folderId: 7 }],
    ['an array', []],
  ])('rejects %s with 400 invalid_request', async (_label, body) => {
    expectError(await post('/api/folders/pick', body), 'invalid_request');
    expect(captured.lines).toEqual([]);
  });

  it('rejects a body that is not JSON with 415', async () => {
    const res = await request(app).post('/api/folders/pick').set(SAME_ORIGIN).set('Content-Type', 'text/plain').send('{}');
    expectError(res, 'unsupported_media_type');
  });
});

describe('the pasted path where dialogs exist', () => {
  it('POST /api/folders answers 409 folder_pick_required and adds nothing', async () => {
    const res = await post('/api/folders', { path: dir });
    expectError(res, 'folder_pick_required');
    expect(count('folders')).toBe(0);
  });

  it('works where no dialogs exist (web and Docker)', async () => {
    app = makeDialogApp({ dialogsAvailable: false });
    const res = await post('/api/folders', { path: dir });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    await waitForFolderJob(res.body.data.job.id, { timeoutMs: 20000 });
    expect(res.body.data.folder).toMatchObject({ name: 'notes', needsConfirm: false });
  });

  it('POST /api/folders/:id/confirm answers 409 folder_pick_required', async () => {
    const row = insertFolder({ name: 'imported', path: dir, pathKey: 'imported:x' });
    updateFolder(row.id, { confirm_state: 'needs_confirm' });
    expectError(await post(`/api/folders/${row.id}/confirm`, { path: dir }), 'folder_pick_required');
    expect(getFolder(row.id).confirm_state).toBe('needs_confirm');
  });
});

describe('dialog poll and cancel', () => {
  it('answers 404 dialog_not_found for an unknown id and a malformed id', async () => {
    expectError(await getDialog('a'.repeat(32)), 'dialog_not_found');
    expectError(await getDialog('nope'), 'dialog_not_found');
    expectError(await getDialog('A'.repeat(32)), 'dialog_not_found');
    expectError(await post(`/api/folders/dialogs/${'a'.repeat(32)}/cancel`, {}), 'dialog_not_found');
  });

  it('cancels a waiting window: the slot is free and a late reply changes nothing', async () => {
    const dialog = await startPick();
    const res = await post(`/api/folders/dialogs/${dialog.id}/cancel`, {});
    expect(res.status).toBe(200);
    expect(res.body.data.dialog).toMatchObject({ id: dialog.id, status: 'cancelled', folder: null, job: null });
    deliver(dialog.id, 'picked', dir);
    await flush();
    expect((await getDialog(dialog.id)).body.data.dialog.status).toBe('cancelled');
    expect(count('folders')).toBe(0);
    await startPick();
  });
});

describe('confirming an imported folder with the picker', () => {
  const imported = () => {
    const row = insertFolder({ name: 'imported notes', path: 'C:\\Elsewhere\\notes', pathKey: 'imported:fixture' });
    return updateFolder(row.id, { confirm_state: 'needs_confirm', auto_rescan: false });
  };

  it('relinks the folder to the chosen path and starts its scan', async () => {
    const row = imported();
    const dialog = await startPick({ folderId: row.id });
    deliver(dialog.id, 'picked', dir);
    const done = await settled(dialog.id);
    expect(done).toMatchObject({ status: 'added', folderId: row.id, folder: { id: row.id, name: 'imported notes', path: dir, needsConfirm: false } });
    await waitForFolderJob(done.job.id, { timeoutMs: 20000 });
    const stored = getFolder(row.id);
    expect(stored).toMatchObject({ confirm_state: 'ok', path: dir });
    expect(stored.path_key).not.toBe('imported:fixture');
    expect(stored.last_scan_at).toBeTruthy();
    expect(count('folders')).toBe(1);
  });

  it('answers 404 for a missing folder and 409 for one that is already confirmed', async () => {
    expectError(await post('/api/folders/pick', { folderId: NO_FOLDER }), 'folder_not_found');
    const ok = insertFolder({ name: 'ok', path: dir, pathKey: 'real-key' });
    expectError(await post('/api/folders/pick', { folderId: ok.id }), 'folder_already_confirmed');
    expect(captured.lines).toEqual([]);
  });

  it('refuses an overlap with a confirmed folder and keeps the folder waiting', async () => {
    const first = await startPick();
    deliver(first.id, 'picked', dir);
    const added = await settled(first.id);
    await waitForFolderJob(added.job.id, { timeoutMs: 20000 });
    const row = imported();
    const dialog = await startPick({ folderId: row.id });
    deliver(dialog.id, 'picked', path.join(dir, 'sub'));
    expect(await settled(dialog.id)).toMatchObject({ status: 'refused', error: { code: 'folder_overlaps' } });
    expect(getFolder(row.id).confirm_state).toBe('needs_confirm');
  });

  it('a folder waiting for confirmation counts against the 20 folder limit but never blocks a real one', async () => {
    for (let i = 0; i < 19; i += 1) updateFolder(insertFolder({ name: `i${i}`, path: `C:\\x${i}`, pathKey: `imported:${i}` }).id, { confirm_state: 'needs_confirm' });
    const dialog = await startPick();
    deliver(dialog.id, 'picked', dir);
    expect(await settled(dialog.id)).toMatchObject({ status: 'added' });
    expect(select('folders').filter((f) => f.confirm_state === 'ok')).toHaveLength(1);
    const next = await post('/api/folders/pick', {});
    expectError(next, 'folder_limit');
  });
});

describe('POST /api/folders/:id/confirm (pasted path)', () => {
  beforeEach(() => {
    app = makeDialogApp({ dialogsAvailable: false });
  });
  const waiting = () => updateFolder(insertFolder({ name: 'imported', path: 'C:\\Elsewhere', pathKey: 'imported:paste' }).id, { confirm_state: 'needs_confirm' });

  it('confirms a folder through validateFolderRoot and starts its scan', async () => {
    const row = waiting();
    const res = await post(`/api/folders/${row.id}/confirm`, { path: dir });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.folder).toMatchObject({ id: row.id, needsConfirm: false, path: dir });
    await waitForFolderJob(res.body.data.job.id, { timeoutMs: 20000 });
  });

  it('answers the path codes, 404, 409 already confirmed and 400', async () => {
    const row = waiting();
    expectError(await post(`/api/folders/${row.id}/confirm`, { path: path.join(root, 'missing') }), 'folder_missing');
    expectError(await post(`/api/folders/${NO_FOLDER}/confirm`, { path: dir }), 'folder_not_found');
    expectError(await post(`/api/folders/${row.id}/confirm`, { path: dir, extra: 1 }), 'invalid_request');
    expectError(await post(`/api/folders/${row.id}/confirm`, { path: 5 }), 'invalid_request');
    const done = await post(`/api/folders/${row.id}/confirm`, { path: dir });
    await waitForFolderJob(done.body.data.job.id, { timeoutMs: 20000 });
    expectError(await post(`/api/folders/${row.id}/confirm`, { path: dir }), 'folder_already_confirmed');
  });

  it('refuses an overlap with a confirmed folder', async () => {
    const added = await post('/api/folders', { path: dir });
    await waitForFolderJob(added.body.data.job.id, { timeoutMs: 20000 });
    const row = waiting();
    expectError(await post(`/api/folders/${row.id}/confirm`, { path: path.join(dir, 'sub') }), 'folder_overlaps');
    expect(getFolder(row.id).confirm_state).toBe('needs_confirm');
  });

  it('is same-origin only', async () => {
    const row = waiting();
    const res = await request(app).post(`/api/folders/${row.id}/confirm`).set({ Host: '127.0.0.1:4321', Origin: 'http://localhost:5174' }).send({ path: dir });
    expectError(res, 'folder_origin_blocked');
  });
});
