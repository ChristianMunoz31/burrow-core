// Folders on a cloud provider: the `folders` category is off by default, so nothing from a folder reaches the
// provider and the answers are fixed copy; ticked, the call carries the text and the audit row names the category
// only. The Pro cases (the question index and ask stay local, a scheduled re-scan never uses cloud) are in cloudFolders.pro.test.js.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
// Pro is on for this file (the gate itself is covered in proTierMatrix.test.js).
vi.mock('../license/index.js', async (importOriginal) => (await import('./helpers/pro.js')).mockLicenseModule(importOriginal));
import request from 'supertest';

vi.mock('../../loadEnv.js', () => ({}));
vi.mock('node-fetch', () => ({ default: vi.fn() }));

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import fetch from 'node-fetch';
import { withheldMessage } from '../ai/index.js';
import { listAudit } from '../audit.js';
import { waitForFolderJob } from '../folders/jobs.js';
import { __setPathOptionsForTests } from '../folders/pathSafety.js';
import { __setBusyDelaysForTests } from '../folders/summarize.js';
import { CLOUD_HOST, configureCloud, installCloudAndOllama, resetCloud } from './helpers/fakeCloud.js';
import { textReply } from './helpers/fakeOllama.js';
import { closeTestDb, createTestDb, resetDb } from './helpers/testDb.js';

const SAME_ORIGIN = Object.freeze({ Host: '127.0.0.1:4321', Origin: 'http://127.0.0.1:4321' });
const SENTINEL = 'SENTINEL_FOLDER_TEXT_zq91';
const saved = Object.fromEntries(['APP_PASSWORD', 'AUTH_SECRET', 'SECRETS_ENCRYPTION_KEY', 'BURROW_AI'].map((k) => [k, process.env[k]]));
let app;
let db;
let ip = 0;
const nextIp = () => `203.0.113.${(ip += 1) % 250}`;
let root;
let folderDir;

const get = (url) => request(app).get(url).set('X-Forwarded-For', nextIp());
const post = (url, body) => request(app).post(url).set('X-Forwarded-For', nextIp()).set(SAME_ORIGIN).send(body);

async function addFolder() {
  const res = await post('/api/folders', { path: folderDir });
  expect(res.status).toBe(201);
  const done = await waitForFolderJob(res.body.data.job.id, { timeoutMs: 20000 });
  expect(done.status).toBe('done');
  return { id: res.body.data.folder.id, done };
}

beforeAll(async () => {
  for (const k of Object.keys(saved)) delete process.env[k];
  db = createTestDb();
  app = (await import('../../server.js')).default;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-folders-cloud-'));
  __setPathOptionsForTests({ env: {}, home: path.join(root, 'fake-home'), execDir: path.join(root, 'fake-exec') });
  __setBusyDelaysForTests([1, 1, 1]);
});
afterAll(async () => {
  __setPathOptionsForTests(null);
  __setBusyDelaysForTests(null);
  await resetCloud();
  closeTestDb(db);
  fs.rmSync(root, { recursive: true, force: true });
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
beforeEach(async () => {
  resetDb(db);
  fetch.mockReset();
  await resetCloud();
  folderDir = path.join(root, 'notes');
  fs.rmSync(folderDir, { recursive: true, force: true });
  fs.mkdirSync(folderDir, { recursive: true });
  fs.writeFileSync(path.join(folderDir, 'plan.txt'), `The garden plan has tomatoes. ${SENTINEL}\n`);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

const install = (replies = ['A cloud note.']) =>
  installCloudAndOllama(fetch, { replies, ollama: { embedModel: true, chat: () => textReply('A local note.') } });

describe('the folders category under a cloud provider', () => {
  it('is withheld by default: no cloud request and fixed copy', async () => {
    await configureCloud();
    const { cloud } = install();
    const { done } = await addFolder();
    expect(cloud.requests).toHaveLength(0);
    expect(cloud.sent()).not.toContain(SENTINEL);
    expect(done.notices).toContainEqual({ code: 'withheld', message: withheldMessage(['folders']) });
    expect(withheldMessage(['folders'])).toBe("Your folder files aren't shared with cloud AI. You can change that in Settings > AI.");
    const [folder] = (await get('/api/folders')).body.data.folders;
    expect(folder.summary).toMatchObject({ status: 'withheld', text: null });
    expect(cloud.requests).toHaveLength(0);
  });

  it('when ticked, the summary request goes to the provider and the audit row names the category only', async () => {
    await configureCloud({ categories: { folders: true } });
    const { cloud, local } = install();
    await addFolder();
    expect(cloud.requests.length).toBeGreaterThan(0);
    expect(cloud.sent()).toContain(SENTINEL);
    expect(local.chatBodies).toHaveLength(0);
    const { entries: rows } = await listAudit({ limit: 50 });
    const row = rows.find((r) => r.feature === 'folder_summary');
    expect(row.meta).toMatchObject({ ai_kind: 'cloud', ai_host: CLOUD_HOST });
    expect(row.meta.shared).toContain('folders');
    expect(JSON.stringify(rows)).not.toContain(SENTINEL);
  });
});
