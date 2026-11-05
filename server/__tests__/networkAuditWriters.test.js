// Every outbound path that had no audit row now writes one names-only row (feature id, host, result).
// All requests go through fakes: node-fetch is mocked and injected fetchImpls answer; no network.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { closeTestDb, createTestDb, resetDb, rowsOf } from './helpers/testDb.js';
import { installFakeOllama } from './helpers/fakeOllama.js';
import '../audit.js';

vi.mock('../../loadEnv.js', () => ({}));

vi.mock('node-fetch', () => ({ default: vi.fn() }));

import fetch from 'node-fetch';
import { __resetNetPolicyForTests } from '../netPolicy.js';
import { fetchOura, fetchWeather } from '../integrations.js';
import { checkForUpdate, __resetUpdateCacheForTests } from '../updateCheck.js';
import { manifest } from './helpers/updateManifest.js';
import { NETWORK_COALESCE_MS, __resetNetworkCoalesceForTests, recordNetworkCall, statusFromHttp } from '../networkCall.js';
import { __resetAiForTests } from '../ai/index.js';
import { getOllamaHealth } from '../ai/registry.js';
import { registerSecretsRoutes } from '../secretsRoutes.js';
import { __configureSecretsForTests, __resetSecretsForTests } from '../secrets/getSecret.js';

let app;

let db;
const savedOptIn = process.env.BURROW_NETWORK_OPTIN;

beforeAll(async () => {
  db = createTestDb();
  process.env.BURROW_NETWORK_OPTIN = 'weather,oura,updates,sheets,aiLan';
  delete process.env.APP_PASSWORD;
  delete process.env.AUTH_SECRET;
  app = (await import('../../server.js')).default;
});
afterAll(() => {
  closeTestDb(db);
  if (savedOptIn === undefined) delete process.env.BURROW_NETWORK_OPTIN;
  else process.env.BURROW_NETWORK_OPTIN = savedOptIn;
});
beforeEach(() => {
  resetDb(db);
  __resetNetPolicyForTests();
  __resetUpdateCacheForTests();
  __resetNetworkCoalesceForTests();
  __resetAiForTests();
  vi.mocked(fetch).mockReset();
});

// Same-millisecond rows have no stable created_at order, so read in insert (rowid) order.
const netRows = () =>
  rowsOf(db, 'audit_log')
    .filter((r) => r.feature === 'network_call')
    .map((r) => ({ status: r.status, context: r.context, ...r.meta }));

const json = (status, body) => ({ ok: status >= 200 && status < 300, status, headers: new Map(), json: async () => body, text: async () => JSON.stringify(body) });

describe('outbound audit rows', () => {
  it('weather: ok and failed', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(json(200, { current: {} }));
    await fetchWeather({ lat: 12.5, lon: 34.5 });
    vi.mocked(fetch).mockResolvedValueOnce(json(500, {}));
    await expect(fetchWeather({ lat: 12.5, lon: 34.5 })).rejects.toThrow();
    vi.mocked(fetch).mockRejectedValueOnce(new Error('offline'));
    await expect(fetchWeather({ lat: 12.5, lon: 34.5 })).rejects.toThrow('offline');
    expect(netRows()).toEqual([
      { status: 'ok', context: null, net_feature: 'weather', net_host: 'api.open-meteo.com' },
      { status: 'error', context: null, net_feature: 'weather', net_host: 'api.open-meteo.com' },
      { status: 'error', context: null, net_feature: 'weather', net_host: 'api.open-meteo.com' },
    ]);
    expect(JSON.stringify(netRows())).not.toMatch(/12\.5|34\.5|latitude/);
  });

  it('oura: one row per fetch, never the token', async () => {
    vi.mocked(fetch).mockResolvedValue(json(200, { data: [] }));
    await fetchOura('tok-secret-123', { days: 14 });
    vi.mocked(fetch).mockResolvedValue(json(401, {}));
    await expect(fetchOura('tok-secret-123', { days: 14 })).rejects.toThrow();
    expect(netRows()).toEqual([
      { status: 'ok', context: null, net_feature: 'oura', net_host: 'api.ouraring.com' },
      { status: 'error', context: null, net_feature: 'oura', net_host: 'api.ouraring.com' },
    ]);
    expect(JSON.stringify(netRows())).not.toContain('tok-secret');
  });

  it('updates: a real request writes a row, a cached answer does not', async () => {
    const ok = {
      ok: true,
      status: 200,
      headers: new Map(),
      text: async () => JSON.stringify(manifest('0.0.1')),
    };
    const fetchImpl = vi.fn(async () => ok);
    await checkForUpdate({ fetchImpl, currentVersion: '9.9.9', channel: 'stable' });
    await checkForUpdate({ fetchImpl, currentVersion: '9.9.9', channel: 'stable' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(netRows()).toEqual([{ status: 'ok', context: null, net_feature: 'updates', net_host: 'github.com' }]);
  });

  it('updates (Burrow Dev): the releases API host is still recorded', async () => {
    const list = { ok: true, status: 200, headers: new Map(), text: async () => '[]' };
    await checkForUpdate({ fetchImpl: vi.fn(async () => list), currentVersion: '0.2.0-dev.20261001.aaaaaaa', channel: 'dev' });
    expect(netRows()).toEqual([{ status: 'ok', context: null, net_feature: 'updates', net_host: 'api.github.com' }]);
  });

  it('updates: the install handoff row stores only the allowlisted started and app markers', async () => {
    await recordNetworkCall('updates', 'https://github.com', 'ok', { result: 'started', by: 'app' });
    await recordNetworkCall('updates', 'https://github.com', 'ok', { result: 'finished', by: 'server', other: 'x' });
    await recordNetworkCall('updates', 'https://github.com', 'ok');
    const metas = rowsOf(db, 'audit_log').map((r) => (typeof r.meta === 'string' ? JSON.parse(r.meta) : r.meta));
    expect(metas.map((m) => [m.net_result, m.net_by])).toEqual([['started', 'app'], [undefined, undefined], [undefined, undefined]]);
    expect(metas.every((m) => m.net_host === 'github.com' && m.net_feature === 'updates')).toBe(true);
    expect(JSON.stringify(metas)).not.toContain('finished');
  });

  it('updates: 404, 5xx, a timeout and a thrown error are failures; a 200 is ok', async () => {
    const release = {
      ok: true,
      status: 200,
      headers: new Map(),
      text: async () => JSON.stringify(manifest('0.0.1')),
    };
    const answers = [
      async () => ({ ok: false, status: 404, headers: new Map(), text: async () => '{}' }),
      async () => ({ ok: false, status: 503, headers: new Map(), text: async () => '{}' }),
      async () => {
        throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
      },
      async () => {
        throw new Error('offline');
      },
      async () => release,
    ];
    for (const fetchImpl of answers) {
      __resetUpdateCacheForTests();
      await checkForUpdate({ fetchImpl, currentVersion: '9.9.9', channel: 'stable' });
    }
    expect(netRows().map((r) => r.status)).toEqual(['error', 'error', 'error', 'error', 'ok']);
  });
});

describe('shared result rule', () => {
  it('statusFromHttp: 2xx and 3xx are ok, 4xx, 5xx and anything else are errors', () => {
    expect([200, 204, 301, 302, 399].map(statusFromHttp)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok']);
    expect([199, 400, 401, 404, 429, 500, 503, undefined, null, 'x', NaN].map(statusFromHttp)).toEqual(Array(11).fill('error'));
  });

  it('recordNetworkCall drops anything that is not a netPolicy feature or model_pull', async () => {
    await recordNetworkCall('jarvis', 'https://example.com', 'ok');
    await recordNetworkCall('network_call', 'https://example.com', 'ok');
    await recordNetworkCall('__proto__', 'https://example.com', 'ok');
    await recordNetworkCall('model_pull', 'https://registry.ollama.example', 'ok');
    await recordNetworkCall('cloudAi', 'https://api.example.com/v1', 'ok');
    expect(netRows().map((r) => r.net_feature)).toEqual(['model_pull', 'cloudAi']);
  });
});

describe('aiLan health probes', () => {
  const LAN = 'http://192.168.1.20:11434';
  afterAll(() => vi.useRealTimers());

  it('writes one row per host and never one for loopback', async () => {
    installFakeOllama(vi.mocked(fetch));
    await getOllamaHealth('http://127.0.0.1:11434', { fresh: true });
    await getOllamaHealth('http://localhost:11434', { fresh: true });
    expect(netRows()).toEqual([]);
    await getOllamaHealth(LAN, { fresh: true });
    await getOllamaHealth('http://192.168.1.21:11434', { fresh: true });
    expect(netRows()).toEqual([
      { status: 'ok', context: null, net_feature: 'aiLan', net_host: '192.168.1.20' },
      { status: 'ok', context: null, net_feature: 'aiLan', net_host: '192.168.1.21' },
    ]);
  });

  it('coalesces repeated probes to one row per host per 15 minutes', async () => {
    installFakeOllama(vi.mocked(fetch));
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-03-01T10:00:00Z'));
    await getOllamaHealth(LAN, { fresh: true });
    await getOllamaHealth(LAN, { fresh: true });
    vi.setSystemTime(Date.now() + NETWORK_COALESCE_MS - 1000);
    await getOllamaHealth(LAN, { fresh: true });
    expect(netRows()).toHaveLength(1);
    vi.setSystemTime(Date.now() + 2000);
    await getOllamaHealth(LAN, { fresh: true });
    expect(netRows()).toHaveLength(2);
    vi.useRealTimers();
  });

  it('records a failed probe as an error', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('connect ECONNREFUSED'));
    const health = await getOllamaHealth(LAN, { fresh: true });
    expect(health.running).toBe(false);
    expect(netRows()).toEqual([{ status: 'error', context: null, net_feature: 'aiLan', net_host: '192.168.1.20' }]);
  });
});

describe('GET /api/sheets/csv audit rows', () => {
  const FIRST = 'https://docs.google.com/spreadsheets/d/e/abc/pub?output=csv';
  const HOP = 'https://doc-0c-abc-sheets.googleusercontent.com/export/x.csv?secret=zzz';
  const csv = (body) => ({ ok: true, status: 200, headers: new Map(), text: async () => body });
  const redirect = (location) => ({ ok: false, status: 302, headers: new Map([['location', location]]) });
  const get = (url = FIRST) => request(app).get('/api/sheets/csv').set('X-Forwarded-For', '198.51.100.77').query({ url });

  it('writes one row for the one host when there is no redirect', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(csv('a,b\n1,2\n'));
    expect((await get()).status).toBe(200);
    expect(netRows()).toEqual([{ status: 'ok', context: null, net_feature: 'sheets', net_host: 'docs.google.com' }]);
  });

  it('writes one row per distinct host in the redirect chain, host only', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(redirect(HOP))
      .mockResolvedValueOnce(csv('a\n1\n'));
    expect((await get()).status).toBe(200);
    expect(netRows()).toEqual([
      { status: 'ok', context: null, net_feature: 'sheets', net_host: 'docs.google.com' },
      { status: 'ok', context: null, net_feature: 'sheets', net_host: 'doc-0c-abc-sheets.googleusercontent.com' },
    ]);
    expect(JSON.stringify(netRows())).not.toMatch(/secret=zzz|output=csv|export/);
  });

  it('keeps one row when the chain returns to the same host', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(redirect('https://docs.google.com/spreadsheets/d/e/abc/pub?output=csv&x=1'))
      .mockResolvedValueOnce(csv('a\n1\n'));
    expect((await get()).status).toBe(200);
    expect(netRows()).toHaveLength(1);
  });

  it('marks a failed hop as an error and keeps the earlier hop ok', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(redirect(HOP))
      .mockResolvedValueOnce({ ok: false, status: 403, headers: new Map(), text: async () => 'no' });
    expect((await get()).status).toBe(502);
    expect(netRows().map((r) => [r.net_host, r.status])).toEqual([
      ['docs.google.com', 'ok'],
      ['doc-0c-abc-sheets.googleusercontent.com', 'error'],
    ]);
  });

  it('marks a hop that throws or times out as an error', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(redirect(HOP))
      .mockRejectedValueOnce(Object.assign(new Error('timed out'), { name: 'TimeoutError' }));
    expect((await get()).status).toBe(504);
    expect(netRows().map((r) => [r.net_host, r.status])).toEqual([
      ['docs.google.com', 'ok'],
      ['doc-0c-abc-sheets.googleusercontent.com', 'error'],
    ]);
  });

  it('writes no row for a redirect target that is refused (it was never fetched)', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(redirect('https://169.254.169.254/latest'));
    expect((await get()).status).toBe(400);
    expect(netRows().map((r) => r.net_host)).toEqual(['docs.google.com']);
  });
});

describe('POST /api/secrets/:name/test audit row', () => {
  const TOKEN = `SENTINELtoken${'a'.repeat(20)}`;
  const buildApp = () => {
    const a = express();
    a.use(express.json());
    registerSecretsRoutes(a);
    return a;
  };
  beforeEach(() => {
    __resetSecretsForTests();
    __configureSecretsForTests({
      store: { list: async () => [], upsert: async () => {}, remove: async () => {} },
      env: { OURA_TOKEN: TOKEN },
    });
  });
  afterAll(() => {
    __resetSecretsForTests();
    vi.unstubAllGlobals();
  });

  it('writes exactly one row with the host only and no key', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 200 })));
    const res = await request(buildApp()).post('/api/secrets/OURA_TOKEN/test');
    expect(res.body).toEqual({ ok: true });
    expect(netRows()).toEqual([{ status: 'ok', context: null, net_feature: 'oura', net_host: 'api.ouraring.com' }]);
    const all = JSON.stringify(rowsOf(db, 'audit_log'));
    expect(all).not.toContain(TOKEN);
    expect(all).not.toMatch(/personal_info|Bearer/);
  });

  it('writes an error row for 401, 429, 500 and an unreachable server', async () => {
    for (const status of [401, 429, 500]) {
      vi.stubGlobal('fetch', vi.fn(async () => ({ status })));
      await request(buildApp()).post('/api/secrets/OURA_TOKEN/test');
    }
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('offline');
    }));
    await request(buildApp()).post('/api/secrets/OURA_TOKEN/test');
    expect(netRows().map((r) => r.status)).toEqual(['error', 'error', 'error', 'error']);
  });
});
