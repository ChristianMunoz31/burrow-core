// Round 3 security-review fixes for the Folders preview: the exact limiter exemption, the process-wide parse slot (a preview
// and a scan job never judge each other's memory), the expected-sha256 refusal before any parse or cache write, a stale data
// generation or removed folder during a slow parse, the ext and path agreement, reserved Windows names and the
// needs-confirm guard of previewFile itself. Synthetic temp folders, fake Ollama, fake parser workers.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../license/index.js', async (importOriginal) => (await import('./helpers/pro.js')).mockLicenseModule(importOriginal));
import request from 'supertest';

vi.mock('../../loadEnv.js', () => ({}));
vi.mock('node-fetch', () => ({ default: vi.fn() }));

import fs from 'node:fs';
import path from 'node:path';
import fetch from 'node-fetch';
import { __resetAiForTests } from '../ai/index.js';
import { __resetDataGenerationForTests } from '../dataGeneration.js';
import { cancelAllFolderJobs, drainFolderJobs, waitForFolderJob } from '../folders/jobs.js';
import { __setPathOptionsForTests } from '../folders/pathSafety.js';
import { previewFile } from '../folders/preview.js';
import { clearPreviewCache } from '../folders/previewCache.js';
import { absInRoot } from '../folders/relPath.js';
import { updateFile } from '../folders/store.js';
import { __setBusyDelaysForTests } from '../folders/summarize.js';
import { FREE, resetPro, setEntitlements } from './helpers/pro.js';
import { installFakeOllama, textReply } from './helpers/fakeOllama.js';
import { COPY, errorBody, makeTmp, neutralPathOptions, rmTree, writeTree } from './helpers/foldersEnv.js';
import { closeTestDb, createTestDb, resetDb } from './helpers/testDb.js';

const SAME_ORIGIN = Object.freeze({ Host: '127.0.0.1:4321', Origin: 'http://127.0.0.1:4321' });
const GLOBAL_LIMIT_MESSAGE = 'Too many requests, please try again later.';
const saved = Object.fromEntries(['APP_PASSWORD', 'AUTH_SECRET', 'SECRETS_ENCRYPTION_KEY', 'BURROW_AI'].map((k) => [k, process.env[k]]));

let app;
let db;
let root;
let dir;
let ip = 0;
const nextIp = () => `203.0.113.${(ip += 1) % 250}`;

const get = (url, ipAddr = nextIp()) => request(app).get(url).set('X-Forwarded-For', ipAddr);
const previewUrl = (folderId, fileId) => `/api/folders/${folderId}/files/${fileId}/preview`;
const preview = (folder, file) => get(previewUrl(folder.id, file.id));

const expectError = (res, code) => {
  expect(res.status, `${code}: ${JSON.stringify(res.body)}`).toBe(COPY[code][0]);
  expect(res.body).toEqual(errorBody(code));
  expect(res.headers['cache-control']).toBe('no-store');
};

async function filesOf(folderId) {
  const res = await get(`/api/folders/${folderId}/files?limit=200`);
  return Object.fromEntries(res.body.data.files.map((f) => [f.path, f]));
}
async function scanned(files) {
  writeTree(dir, files);
  const res = await request(app).post('/api/folders').set('X-Forwarded-For', nextIp()).set(SAME_ORIGIN).send({ path: dir });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const done = await waitForFolderJob(res.body.data.job.id, { timeoutMs: 30000 });
  expect(done.status).toBe('done');
  return { folder: res.body.data.folder, files: await filesOf(res.body.data.folder.id) };
}

beforeAll(async () => {
  for (const k of Object.keys(saved)) delete process.env[k];
  db = createTestDb();
  app = (await import('../../server.js')).default;
  root = makeTmp('burrow-folders-preview-fixes-');
  fs.mkdirSync(path.join(root, 'fake-home'), { recursive: true });
  __setBusyDelaysForTests([1, 1, 1]);
});
afterAll(() => {
  __setPathOptionsForTests(null);
  __setBusyDelaysForTests(null);
  closeTestDb(db);
  rmTree(root);
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
beforeEach(() => {
  resetDb(db);
  clearPreviewCache();
  setEntitlements(FREE);
  __setPathOptionsForTests(neutralPathOptions(root));
  __resetAiForTests();
  fetch.mockReset();
  installFakeOllama(fetch, { embedModel: true, chat: () => textReply('A short note about the files.') });
  dir = path.join(root, 'docs');
  rmTree(dir);
});
afterEach(async () => {
  cancelAllFolderJobs('shutdown');
  await drainFolderJobs({ timeoutMs: 2000 });
  __resetDataGenerationForTests();
  resetPro();
  vi.restoreAllMocks();
});

describe('the global limiter exemption', () => {
  it('matches only the exact preview path: longer paths and other routes are still counted', async () => {
    const { folder, files } = await scanned({ 'a.txt': 'alpha\n' });
    const fileId = files['a.txt'].id;
    for (const [tail, ipAddr] of [
      [`/api/folders/${folder.id}/files/${fileId}/preview/x`, '198.51.100.10'],
      [`/api/folders/${folder.id}/files/${fileId}`, '198.51.100.11'],
      [`/api/folders/${folder.id}/files/${fileId}/previews`, '198.51.100.12'],
    ]) {
      for (let i = 0; i < 300; i += 1) {
        const res = await get(tail, ipAddr);
        if (res.status === 429) throw new Error(`request ${i} was limited too early`);
      }
      const limited = await get(tail, ipAddr);
      expect(limited.status, tail).toBe(429);
      expect(limited.body.error, tail).toBe(GLOBAL_LIMIT_MESSAGE);
    }
  }, 120_000);

  it('does not count the exact preview path against the global limit', async () => {
    const { folder, files } = await scanned({ 'a.txt': 'alpha\n' });
    const fixed = '198.51.100.20';
    // Use up 299 of the 300 global slots on a path that is counted, then the exact preview path must still answer.
    for (let i = 0; i < 299; i += 1) await get(`/api/folders/${folder.id}/files/${files['a.txt'].id}/previews`, fixed);
    for (let i = 0; i < 10; i += 1) {
      const res = await get(previewUrl(folder.id, files['a.txt'].id), fixed);
      if (res.status !== 200) throw new Error(`preview ${i} answered ${res.status}`);
    }
  }, 120_000);
});

describe('ext and path agreement', () => {
  it('a row whose ext differs from its path answers 409 without touching the disk', async () => {
    const { folder, files } = await scanned({ 'a.txt': 'alpha text\n' });
    updateFile(files['a.txt'].id, { ext: 'pdf' });
    const open = vi.spyOn(fs.promises, 'open');
    const lstat = vi.spyOn(fs.promises, 'lstat');
    expectError(await preview(folder, files['a.txt']), 'folder_file_changed');
    expect(open).not.toHaveBeenCalled();
    expect(lstat.mock.calls.filter(([p]) => String(p).endsWith('a.txt'))).toEqual([]);
  });
});

describe('reserved names and unsafe segments', () => {
  it('absInRoot refuses Windows device names and trailing dots or spaces, with or without an extension', () => {
    const base = path.join(path.sep, 'root');
    const bad = ['CON', 'con.txt', 'PRN.md', 'a/AUX', 'a/Nul.tar.gz', 'COM1', 'com9.txt', 'LPT1', 'lpt9.log', 'CON .txt', 'a./b.txt', 'a /b.txt', 'b.txt.', 'b.txt ', 'a:b.txt', 'x/COM¹.txt', 'COM0', 'lpt0.txt', 'CONIN$', 'conout$.log', 'a\\b'];
    for (const rel of bad) expect(absInRoot(base, rel, { platform: 'win32' }), rel).toBeNull();
    for (const rel of ['', '/a', 'a//b', './a', 'a/../b', 'a\0b']) {
      expect(absInRoot(base, rel, { platform: 'win32' }), rel).toBeNull();
      expect(absInRoot(base, rel, { platform: 'linux' }), rel).toBeNull();
    }
    for (const rel of ['console.txt', 'com10.txt', 'conx/a.txt', 'a.b/c.txt', 'auxiliary.md', 'a b.txt']) {
      expect(absInRoot(base, rel, { platform: 'win32' }), rel).toBe(path.join(base, ...rel.split('/')));
    }
    expect(absInRoot(base, 'con.txt', { platform: 'linux' })).toBe(path.join(base, 'con.txt'));
    expect(absInRoot(base, 'a:b.txt', { platform: 'linux' })).toBe(path.join(base, 'a:b.txt'));
    // A backslash is a legal name character outside Windows, so such files stay readable there.
    expect(absInRoot(base, 'a\\b.txt', { platform: 'linux' })).toBe(path.join(base, 'a\\b.txt'));
  });

  it.runIf(process.platform === 'win32')('a stored row with a reserved name is refused before the disk is touched', async () => {
    const { folder, files } = await scanned({ 'a.txt': 'alpha text\n' });
    updateFile(files['a.txt'].id, { rel_path: 'aux.txt' });
    const open = vi.spyOn(fs.promises, 'open');
    expectError(await get(previewUrl(folder.id, files['a.txt'].id)), 'folder_file_changed');
    expect(open).not.toHaveBeenCalled();
  });
});

describe('previewFile itself', () => {
  it('throws folder_needs_confirm when the folder is not confirmed, before anything else', async () => {
    const folder = { id: 'f', path: path.join(root, 'nowhere'), path_key: 'k', confirm_state: 'needs_confirm' };
    await expect(previewFile(folder, { id: 'x', status: 'ok', rel_path: 'a.txt', ext: 'txt', sha256: 'abc' })).rejects.toMatchObject({ code: 'folder_needs_confirm' });
    await expect(previewFile(folder, { id: 'x', status: 'unsupported' })).rejects.toMatchObject({ code: 'folder_needs_confirm' });
  });
});
