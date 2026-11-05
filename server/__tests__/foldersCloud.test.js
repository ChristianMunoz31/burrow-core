// More cloud cases for Folders (the base ones are in cloudFolders.test.js): the category turned off in the middle of
// a job, and the Network activity rows for folder calls.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

vi.mock('../../loadEnv.js', () => ({}));
vi.mock('node-fetch', () => ({ default: vi.fn() }));

import path from 'node:path';
import fetch from 'node-fetch';
import { setState } from '../dataAccess.js';
import { insertMany } from '../db/index.js';
import { waitForFolderJob } from '../folders/jobs.js';
import { __setPathOptionsForTests } from '../folders/pathSafety.js';
import { allFileRows, getFolder } from '../folders/store.js';
import { __setBusyDelaysForTests } from '../folders/summarize.js';
import { listNetworkActivity } from '../networkAudit.js';
import { CLOUD_HOST, configureCloud, installCloudAndOllama, resetCloud } from './helpers/fakeCloud.js';
import { textReply } from './helpers/fakeOllama.js';
import { makeTmp, rmTree, useNeutralPaths, writeTree } from './helpers/foldersEnv.js';
import { closeTestDb, createTestDb, resetDb } from './helpers/testDb.js';

const SAME_ORIGIN = Object.freeze({ Host: '127.0.0.1:4321', Origin: 'http://127.0.0.1:4321' });
const SENTINEL = 'SENTINEL_FOLDER_TEXT_kq27';
const saved = Object.fromEntries(['APP_PASSWORD', 'AUTH_SECRET', 'SECRETS_ENCRYPTION_KEY', 'BURROW_AI'].map((k) => [k, process.env[k]]));
let app;
let db;
let ip = 0;
const nextIp = () => `203.0.113.${(ip += 1) % 250}`;
let root;
let dir;

const get = (url) => request(app).get(url).set('X-Forwarded-For', nextIp());
const post = (url, body) => request(app).post(url).set('X-Forwarded-For', nextIp()).set(SAME_ORIGIN).send(body);

async function addAndScan() {
  const res = await post('/api/folders', { path: dir });
  expect(res.status).toBe(201);
  const done = await waitForFolderJob(res.body.data.job.id, { timeoutMs: 20000 });
  expect(done.status).toBe('done');
  return { id: res.body.data.folder.id, done };
}
const install = (replies = ['A cloud note.']) => installCloudAndOllama(fetch, { replies, ollama: { embedModel: true, chat: () => textReply('A local note.') } });

beforeAll(async () => {
  for (const k of Object.keys(saved)) delete process.env[k];
  db = createTestDb();
  app = (await import('../../server.js')).default;
  root = makeTmp('burrow-folders-cloud2-');
  useNeutralPaths(root);
  __setBusyDelaysForTests([1, 1, 1]);
});
afterAll(async () => {
  __setPathOptionsForTests(null);
  __setBusyDelaysForTests(null);
  await resetCloud();
  closeTestDb(db);
  rmTree(root);
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
beforeEach(async () => {
  resetDb(db);
  fetch.mockReset();
  await resetCloud();
  dir = path.join(root, 'notes');
  rmTree(dir);
  writeTree(dir, {
    'plan.txt': `The garden plan has tomatoes planted by the fence. ${SENTINEL}\n`,
    'soup.md': '# Soup\nTomatoes, basil and garlic.\n',
    'bread.md': '# Bread\nFlour, water and salt.\n',
    'herbs.txt': 'Basil, thyme and parsley grow by the door.\n',
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('the category is turned off in the middle of a job', () => {
  it('the next call is refused before it is sent: the summaries stop with a notice and the job still ends done', async () => {
    await configureCloud({ categories: { folders: true } });
    const { cloud } = install(['First cloud note.', 'Second cloud note.']);
    const base = fetch.getMockImplementation();
    let turnedOff = false;
    fetch.mockImplementation(async (url, init) => {
      const out = await base(url, init);
      if (new URL(String(url)).hostname === CLOUD_HOST && !turnedOff) {
        turnedOff = true;
        await setState('ai.cloudCategories', {}); // the user unticks Folders while the job runs
      }
      return out;
    });
    const { id, done } = await addAndScan();
    expect(cloud.requests).toHaveLength(1);
    expect(done.status).toBe('done');
    expect(done.notices).toHaveLength(1);
    expect(done.notices[0].code).toBe('cloud_scope_denied');
    expect(done.notices[0].message).toEqual(expect.any(String));
    const summaries = allFileRows(id).filter((r) => r.summary_status === 'ok');
    expect(summaries).toHaveLength(1);
    expect(summaries[0].summary).toBe('First cloud note.');
    // nothing more left for the provider, and no folder summary from a half-finished set
    expect(getFolder(id).summary).toBeNull();
  });

  it('turning cloud off entirely mid-job (cloud_disabled) also stops the summaries', async () => {
    await configureCloud({ categories: { folders: true } });
    const { cloud } = install(['First cloud note.']);
    const base = fetch.getMockImplementation();
    let off = false;
    fetch.mockImplementation(async (url, init) => {
      const out = await base(url, init);
      if (new URL(String(url)).hostname === CLOUD_HOST && !off) {
        off = true;
        await setState('network.optIn', {});
        await setState('ai.cloudConsent', {});
      }
      return out;
    });
    const { done } = await addAndScan();
    expect(cloud.requests).toHaveLength(1);
    expect(done.status).toBe('done');
    expect(done.notices).toHaveLength(1);
  });
});

describe('Network activity', () => {
  it('lists a cloud folder summary as the Cloud helper with the provider host', async () => {
    await configureCloud({ categories: { folders: true } });
    install();
    await addAndScan();
    const { entries } = listNetworkActivity({ limit: 50 });
    const cloudRows = entries.filter((e) => e.feature === 'cloudAi');
    expect(cloudRows).toHaveLength(1);
    expect(cloudRows[0]).toMatchObject({ label: 'Cloud helper', host: CLOUD_HOST, result: 'ok' });
    // the embeddings were local, so they are not a network call
    expect(entries.filter((e) => e.feature === 'aiLan')).toEqual([]);
  });

  it('lists nothing for a withheld cloud scan (no call left the computer)', async () => {
    await configureCloud();
    install();
    await addAndScan();
    expect(listNetworkActivity({ limit: 50 }).entries).toEqual([]);
  });

  it('lists nothing for a local scan', async () => {
    install();
    await addAndScan();
    expect(listNetworkActivity({ limit: 50 }).entries).toEqual([]);
  });

  it.each(['folder_summary', 'folder_index', 'folder_report', 'folder_ask'])('a LAN %s row shows as the helper on another computer, without the address', (feature) => {
    insertMany('audit_log', [{ kind: 'llm', feature, page: 'folders', status: 'ok', meta: { calls: 2, ai_kind: 'lan', ai_host: '192.168.1.20' } }]);
    const { entries } = listNetworkActivity({ limit: 10 });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ feature: 'aiLan', label: 'Helper on another computer', host: 'Another computer on your network', result: 'ok' });
    expect(JSON.stringify(entries)).not.toContain('192.168.1.20');
  });

  it.each(['folder_summary', 'folder_ask'])('a cloud %s row shows as the Cloud helper; a failed one shows as failed', (feature) => {
    insertMany('audit_log', [
      { kind: 'llm', feature, page: 'folders', status: 'ok', meta: { calls: 1, ai_kind: 'cloud', ai_host: 'api.example.com' } },
      { kind: 'llm', feature, page: 'folders', status: 'error', meta: { calls: 1, ai_kind: 'cloud', ai_host: 'api.example.com' } },
    ]);
    const { entries } = listNetworkActivity({ limit: 10 });
    expect(entries.map((e) => [e.label, e.result]).sort()).toEqual([['Cloud helper', 'failed'], ['Cloud helper', 'ok']]);
  });

  it('local folder rows and rows without a call are not listed', () => {
    insertMany('audit_log', [
      { kind: 'llm', feature: 'folder_index', page: 'folders', status: 'ok', meta: { calls: 3, ai_kind: 'local' } },
      { kind: 'llm', feature: 'folder_summary', page: 'folders', status: 'ok', meta: { calls: 0, ai_kind: 'cloud', ai_host: 'api.example.com' } },
    ]);
    expect(listNetworkActivity({ limit: 10 }).entries).toEqual([]);
  });

  it('is readable through the route', async () => {
    await configureCloud({ categories: { folders: true } });
    install();
    await addAndScan();
    const res = await get('/api/privacy/network-activity');
    expect(res.status).toBe(200);
    expect(res.body.data.entries.map((e) => e.label)).toEqual(['Cloud helper']);
  });
});
