// Network activity: names-only audit writes and GET /api/privacy/network-activity.
// Env is set before importing the app because server.js reads APP_PASSWORD/AUTH_SECRET at import time.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { closeTestDb, createTestDb, resetDb, rowsOf } from './helpers/testDb.js';
import { insertMany } from '../db/index.js';
import { listNetworkActivity, NETWORK_ACTIVITY_MAX_LIMIT } from '../networkAudit.js';
import { recordNetworkCall } from '../networkCall.js';
import { AUDIT_MAX_ROWS } from '../audit.js';

vi.mock('../../loadEnv.js', () => ({}));

let app;
let db;
let cookie;
const IP = '198.51.100.40';
const savedEnv = {
  SECRETS_ENCRYPTION_KEY: process.env.SECRETS_ENCRYPTION_KEY,
  APP_PASSWORD: process.env.APP_PASSWORD,
  AUTH_SECRET: process.env.AUTH_SECRET,
};

beforeAll(async () => {
  db = createTestDb();
  delete process.env.SECRETS_ENCRYPTION_KEY;
  process.env.APP_PASSWORD = 'sekret-pass';
  process.env.AUTH_SECRET = 'unit-test-secret';
  app = (await import('../../server.js')).default;
  const res = await request(app).post('/api/login').set('X-Forwarded-For', IP).send({ password: 'sekret-pass' });
  cookie = res.headers['set-cookie'][0].split(';')[0];
});

afterAll(() => {
  closeTestDb(db);
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

beforeEach(() => resetDb(db));

const get = (query = '') =>
  request(app).get(`/api/privacy/network-activity${query}`).set('Cookie', cookie).set('X-Forwarded-For', IP);

const ts = (n) => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();
const row = (n, over = {}) => ({
  created_at: ts(n),
  kind: 'export',
  feature: 'network_call',
  status: 'ok',
  meta: { net_feature: 'weather', net_host: 'api.open-meteo.com' },
  ...over,
});

describe('GET /api/privacy/network-activity', () => {
  it('needs a session', async () => {
    const res = await request(app).get('/api/privacy/network-activity').set('X-Forwarded-For', '198.51.100.41');
    expect(res.status).toBe(401);
  });

  it('is empty when nothing connected, and is no-store', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({ data: { entries: [], nextBefore: null } });
  });

  it('returns only allowlisted fields even when the row carries extras', async () => {
    insertMany(
      'audit_log',
      [
        row(1, {
          page: 'weather',
          provider: 'x',
          model: 'secret-model',
          context: 'prompt: my private question https://api.open-meteo.com/v1?latitude=1&longitude=2&key=abc',
          meta: {
            net_feature: 'weather',
            net_host: 'api.open-meteo.com',
            url: 'https://api.open-meteo.com/v1/forecast?latitude=12.3&longitude=45.6',
            body: 'payload',
            prompt: 'hello',
            key: 'sk-secret',
          },
        }),
      ],
      { db },
    );
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body.data.entries).toHaveLength(1);
    const [entry] = res.body.data.entries;
    expect(Object.keys(entry).sort()).toEqual(['at', 'feature', 'host', 'id', 'label', 'result']);
    expect(entry).toMatchObject({ feature: 'weather', label: 'Weather', host: 'api.open-meteo.com', at: ts(1), result: 'ok' });
    const text = JSON.stringify(res.body);
    for (const leaked of ['latitude', 'longitude', 'payload', 'hello', 'sk-secret', 'private question', 'secret-model', '?', 'https://']) {
      expect(text).not.toContain(leaked);
    }
  });

  it('never shows a stored host that looks like a URL', async () => {
    insertMany('audit_log', [row(1, { meta: { net_feature: 'weather', net_host: 'api.open-meteo.com/v1?latitude=1' } })], { db });
    const { entries } = (await get()).body.data;
    expect(entries[0].host).toBe('unknown host');
  });

  it('maps model downloads, cloud and other-computer AI calls, and skips calls that sent nothing', async () => {
    insertMany(
      'audit_log',
      [
        row(1, { feature: 'model_pull', provider: 'ollama', model: 'llama3.2:3b', meta: { outcome: 'ok' } }),
        row(2, { kind: 'llm', feature: 'javi_advice', context: 'private', meta: { calls: 1, ai_kind: 'cloud', ai_host: 'api.example.com' } }),
        row(3, { kind: 'llm', feature: 'jarvis', status: 'error', meta: { calls: 2, ai_kind: 'lan', ai_host: '192.168.1.20' } }),
        row(4, { kind: 'llm', feature: 'jarvis', meta: { calls: 1, ai_kind: 'local' } }),
        row(5, { kind: 'llm', feature: 'cross_insights_explain', meta: { calls: 0, ai_kind: 'cloud', ai_host: 'api.example.com' } }),
        row(6, { kind: 'llm', feature: 'cloud_ai_consent', meta: { action: 'enabled', ai_host: 'api.example.com' } }),
        row(7, { kind: 'auth', feature: 'sign_in', meta: {} }),
      ],
      { db },
    );
    const { entries } = (await get()).body.data;
    expect(entries.map((e) => [e.feature, e.label, e.host, e.result])).toEqual([
      ['aiLan', 'Helper on another computer', 'Another computer on your network', 'failed'],
      ['cloudAi', 'Cloud helper', 'api.example.com', 'ok'],
      ['model_pull', 'Model download (through Ollama)', 'Ollama on this computer', 'ok'],
    ]);
  });

  it('keeps the rows of the retired license check visible with a plain label, and still hides other unknown ids', async () => {
    insertMany(
      'audit_log',
      [
        row(1, { meta: { net_feature: 'license', net_host: 'api.gumroad.com' } }),
        row(2, { meta: { net_feature: 'constructor', net_host: 'api.gumroad.com' } }),
        row(3, { meta: { net_feature: 'nonsense', net_host: 'api.gumroad.com' } }),
      ],
      { db },
    );
    const { entries } = (await get()).body.data;
    expect(entries.map((e) => [e.feature, e.label, e.host, e.result])).toEqual([['license', 'Activation check (older version)', 'api.gumroad.com', 'ok']]);
  });

  it('reports a blocked result when the row says so', async () => {
    insertMany('audit_log', [row(1, { status: 'error', meta: { net_feature: 'updates', net_host: 'api.github.com', result: 'blocked' } })], { db });
    expect((await get()).body.data.entries[0].result).toBe('blocked');
  });

  it('maps the update handoff to its own label and a started result, and ignores unknown markers', async () => {
    insertMany(
      'audit_log',
      [
        row(1, { meta: { net_feature: 'updates', net_host: 'github.com' } }),
        row(2, { meta: { net_feature: 'updates', net_host: 'github.com', net_result: 'started', net_by: 'app' } }),
        row(3, { meta: { net_feature: 'updates', net_host: 'github.com', net_result: 'done', net_by: 'server' } }),
        row(4, { meta: { net_feature: 'weather', net_host: 'api.open-meteo.com', net_result: 'started', net_by: 'app' } }),
        row(5, { status: 'error', meta: { net_feature: 'updates', net_host: 'github.com', net_result: 'started', net_by: 'app' } }),
      ],
      { db },
    );
    const { entries } = (await get()).body.data;
    expect(entries.map((e) => [e.label, e.host, e.result])).toEqual([
      ['Update download (Burrow app)', 'github.com', 'failed'],
      ['Weather', 'api.open-meteo.com', 'ok'],
      ['Updates', 'github.com', 'ok'],
      ['Update download (Burrow app)', 'github.com', 'started'],
      ['Updates', 'github.com', 'ok'],
    ]);
  });

  it('pages newest first with a cursor and loses nothing', async () => {
    insertMany('audit_log', Array.from({ length: 5 }, (_, i) => row(i + 1)), { db });
    const first = (await get('?limit=2')).body.data;
    expect(first.entries.map((e) => e.at)).toEqual([ts(5), ts(4)]);
    expect(first.nextBefore).toBeTruthy();
    const second = (await get(`?limit=2&before=${encodeURIComponent(first.nextBefore)}`)).body.data;
    expect(second.entries.map((e) => e.at)).toEqual([ts(3), ts(2)]);
    const third = (await get(`?limit=2&before=${encodeURIComponent(second.nextBefore)}`)).body.data;
    expect(third.entries.map((e) => e.at)).toEqual([ts(1)]);
    expect(third.nextBefore).toBeNull();
  });

  it('fills a page past rows that do not count (more than one scan batch)', async () => {
    insertMany('audit_log', [row(1)], { db });
    insertMany(
      'audit_log',
      Array.from({ length: 150 }, (_, i) => row(i + 10, { kind: 'llm', feature: 'jarvis', meta: { calls: 1, ai_kind: 'local' } })),
      { db },
    );
    const { entries } = (await get('?limit=1')).body.data;
    expect(entries).toHaveLength(1);
    expect(entries[0].at).toBe(ts(1));
  });

  it('scans past the old 2000-row cap: an empty first page still finds an older connection', async () => {
    insertMany('audit_log', [row(1)], { db });
    insertMany(
      'audit_log',
      Array.from({ length: 2500 }, (_, i) => row(i + 10, { kind: 'llm', feature: 'jarvis', meta: { calls: 1, ai_kind: 'local' } })),
      { db },
    );
    const res = await get('?limit=5');
    expect(res.body.data.entries.map((e) => e.at)).toEqual([ts(1)]);
    expect(res.body.data.nextBefore).toBeNull();
  });

  it('stops scanning at AUDIT_MAX_ROWS and hands back nextBefore so the client keeps paging', async () => {
    insertMany('audit_log', [row(1)], { db });
    insertMany(
      'audit_log',
      Array.from({ length: AUDIT_MAX_ROWS }, (_, i) => row(i + 10, { kind: 'llm', feature: 'jarvis', meta: { calls: 1, ai_kind: 'local' } })),
      { db },
    );
    const first = listNetworkActivity({ db, limit: 5 });
    expect(first.entries).toEqual([]);
    expect(first.nextBefore).toBe(`${ts(10)}|${rowsOf(db, 'audit_log').find((r) => r.created_at === ts(10)).id}`);
    const second = listNetworkActivity({ db, limit: 5, before: first.nextBefore });
    expect(second.entries.map((e) => e.at)).toEqual([ts(1)]);
    expect(second.nextBefore).toBeNull();
  });

  it('returns nextBefore null when nothing in the whole table matches', async () => {
    insertMany(
      'audit_log',
      Array.from({ length: 2300 }, (_, i) => row(i + 1, { kind: 'llm', feature: 'jarvis', meta: { calls: 1, ai_kind: 'local' } })),
      { db },
    );
    expect((await get()).body).toEqual({ data: { entries: [], nextBefore: null } });
  });

  it('gives a cursor only while more matching rows may exist', async () => {
    insertMany('audit_log', Array.from({ length: 4 }, (_, i) => row(i + 1)), { db });
    const first = (await get('?limit=2')).body.data;
    expect(first.nextBefore).toBeTruthy();
    const last = (await get(`?limit=2&before=${encodeURIComponent(first.nextBefore)}`)).body.data;
    expect(last.entries).toHaveLength(2);
    expect(last.nextBefore).toBeNull();
  });

  it('caps the page size and rejects bad queries', async () => {
    expect(NETWORK_ACTIVITY_MAX_LIMIT).toBe(100);
    insertMany('audit_log', Array.from({ length: 120 }, (_, i) => row(i + 1)), { db });
    expect((await get('?limit=100')).body.data.entries).toHaveLength(100);
    expect((await get()).body.data.entries).toHaveLength(50);
    expect(listNetworkActivity({ db, limit: 5000 }).entries).toHaveLength(100);
    for (const q of ['?limit=101', '?limit=0', '?limit=abc', '?limit=1&limit=2', '?before=nope', '?before[a]=1']) {
      const res = await get(q);
      expect(res.status, q).toBe(400);
      expect(res.body.error).toBe('invalid_query');
      expect(res.body.message).toBe('That request was not valid. Close and reopen Settings to try again.');
    }
  });
});

describe('recordNetworkCall', () => {
  it('stores the feature id and the host only, never the path or query', async () => {
    await recordNetworkCall('weather', 'https://api.open-meteo.com/v1/forecast?latitude=12.34&longitude=56.78', 'ok');
    await recordNetworkCall('oura', 'https://api.ouraring.com:8443/v2/usercollection?token=pw', 'error');
    const rows = rowsOf(db, 'audit_log');
    expect(rows.map((r) => [r.status, r.context, r.meta])).toEqual([
      ['ok', null, { net_feature: 'weather', net_host: 'api.open-meteo.com' }],
      ['error', null, { net_feature: 'oura', net_host: 'api.ouraring.com' }],
    ]);
    expect(JSON.stringify(rows)).not.toMatch(/latitude|forecast|pw|usercollection|\?/);
  });

  it('ignores malformed feature ids and unusable hosts, and the list skips unknown features', async () => {
    await recordNetworkCall('bad id!', 'https://example.com', 'ok');
    await recordNetworkCall('weather', 'not a url at all ??', 'ok');
    expect(rowsOf(db, 'audit_log')).toEqual([]);
    await recordNetworkCall('nope', 'https://example.com', 'ok');
    expect(listNetworkActivity({ db }).entries).toEqual([]);
  });

  it('shows up in the list as a failed connection when it errored', async () => {
    await recordNetworkCall('oura', 'https://api.ouraring.com/v2/usercollection/sleep', 'error');
    const { entries } = listNetworkActivity({ db });
    expect(entries.map((e) => [e.label, e.host, e.result])).toEqual([['Oura Ring', 'api.ouraring.com', 'failed']]);
  });
});
