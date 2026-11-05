// Review fixes for the Javi speed and accuracy branch: grounding facts of a Jarvis answer, replayed
// notices, the briefing clock line, the insight card cache hour bucket, the explain caveat, the
// snapshot budget guarantee, the registry truncation reason and the eval proxy body check.
import http from 'node:http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
// Pro is on for this file (the Pro gate itself is covered in proGating.test.js).
vi.mock('../license/index.js', async (importOriginal) => (await import('./helpers/pro.js')).mockLicenseModule(importOriginal));

vi.mock('../../loadEnv.js', () => ({}));
vi.mock('node-fetch', () => ({ default: vi.fn() }));
vi.mock('../auditHook.js', () => ({ recordAudit: vi.fn(async () => {}), setAuditSink: vi.fn() }));
// getAiClient delegates to the real one unless a test hands out a fake chat client.
vi.mock('../ai/index.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, getAiClient: vi.fn(actual.getAiClient) };
});

import fetch from 'node-fetch';
import { installFakeOllama, textReply } from './helpers/fakeOllama.js';
import { __resetAiForTests, getAiClient } from '../ai/index.js';
import { clearAdviceCache } from '../javi/adviceCache.js';
import { streamAdvice } from '../javi/advisorService.js';
import { startRecordingProxy } from '../../scripts/lib/javiEval/ollamaProxy.js';
import { closeTestDb, createTestDb, resetDb } from './helpers/testDb.js';

const actualGetAiClient = getAiClient.getMockImplementation();
const saved = Object.fromEntries(['APP_PASSWORD', 'AUTH_SECRET', 'SECRETS_ENCRYPTION_KEY', 'JARVIS_CONFIRM_WRITES', 'BURROW_AI'].map((k) => [k, process.env[k]]));
let db;
beforeAll(async () => {
  for (const k of Object.keys(saved)) delete process.env[k];
  db = createTestDb();
});
afterAll(() => {
  closeTestDb(db);
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
beforeEach(() => {
  resetDb(db);
  __resetAiForTests();
  clearAdviceCache();
  fetch.mockReset();
  getAiClient.mockImplementation(actualGetAiClient);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('N4: the insight card cache key carries the local hour', () => {
  const ctx = (t) => `{"spend":1234.5,"localTime":"${t}"}`;
  const input = (t) => ({ page: 'budget', pageLabel: 'Budget', context: ctx(t), messages: [] });
  const fakeClient = () => {
    const client = {
      provider: 'ollama',
      model: 'qwen2.5:3b',
      purpose: 'chat',
      numCtx: 8192,
      stats: { calls: 0 },
      stream: vi.fn(async function* stream() {
        client.stats.calls += 1;
        yield { type: 'token', text: 'Looks fine.' };
        yield { type: 'done', usage: null, finishReason: 'stop' };
      }),
    };
    return client;
  };

  it('misses across an hour boundary and hits within the same hour', async () => {
    const client = fakeClient();
    const go = (t) => streamAdvice(input(t), { client, cache: true });
    expect((await go('08:59')).cached).toBe(false);
    expect((await go('09:01')).cached).toBe(false);
    expect((await go('09:40')).cached).toBe(true);
    expect(client.stream).toHaveBeenCalledTimes(2);
  });

  it('uses one bucket when the context has no clock', async () => {
    const client = fakeClient();
    const go = () => streamAdvice({ page: 'budget', pageLabel: 'Budget', context: '{"spend":1234.5}', messages: [] }, { client, cache: true });
    expect((await go()).cached).toBe(false);
    expect((await go()).cached).toBe(true);
  });
});

describe('registry complete(): truncation at the content cap', () => {
  it('reports finishReason length when the content was cut, and keeps the model reason otherwise', async () => {
    const huge = 'x'.repeat(600 * 1024);
    installFakeOllama(fetch, { replies: [textReply(huge, { tokens: [huge] }), textReply('short answer')] });
    const client = await getAiClient({ purpose: 'chat' });
    const cut = await client.complete({ messages: [{ role: 'user', content: 'hi' }] });
    expect(cut.content.length).toBe(512 * 1024);
    expect(cut.finishReason).toBe('length');
    const ok = await client.complete({ messages: [{ role: 'user', content: 'hi' }] });
    expect(ok.finishReason).toBe('stop');
    // Streams 600 KB through the real provider path: about 30 s alone, slower under full-suite load.
  }, 120_000);
});

describe('eval proxy refuses a generation request whose body is not valid JSON', () => {
  let upstream;
  let seen;
  let proxy;
  let calls;

  beforeEach(async () => {
    seen = [];
    calls = [];
    upstream = http.createServer((req, res) => {
      seen.push(req.url);
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}\n');
      });
    });
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    proxy = await startRecordingProxy({ upstream: `http://127.0.0.1:${upstream.address().port}`, allowModel: 'tiny:1b', onCall: (r) => calls.push(r) });
  });
  afterEach(async () => {
    await proxy.close();
    await new Promise((resolve) => upstream.close(resolve));
  });

  it.each(['not json', '', '[1,2]', 'null'])('403 for /api/chat body %j, never forwarded', async (raw) => {
    const res = await globalThis.fetch(`${proxy.url}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: raw || undefined });
    expect(res.status).toBe(403);
    expect(seen).toEqual([]);
    expect(calls.at(-1).refused).toBe('body');
  });

  it('still forwards a valid body for the model under test', async () => {
    const res = await globalThis.fetch(`${proxy.url}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'tiny:1b', messages: [] }) });
    expect(res.status).toBe(200);
    expect(seen).toEqual(['/api/chat']);
  });
});
