// Call sites on the AiClient: real token streaming in Javi's advice and the opt-in cloud
// provider resolution.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

vi.mock('../../loadEnv.js', () => ({}));
vi.mock('node-fetch', () => ({ default: vi.fn() }));

import fetch from 'node-fetch';
import { Readable } from 'node:stream';
import { hangingChat, installFakeOllama, textReply } from './helpers/fakeOllama.js';
import { __resetAiForTests, getAiClient } from '../ai/index.js';
import { AI_SETTINGS_KEY } from '../ai/settings.js';
import { NETWORK_STATE_KEY, __resetNetPolicyForTests } from '../netPolicy.js';
import { recordCloudConsent } from '../ai/consent.js';
import { setState } from '../dataAccess.js';

const ADVICE = { page: 'todos', context: '{}', messages: [{ role: 'user', content: 'count' }] };
const SSE = 'text/event-stream';

describe('Javi advice streams real tokens', () => {
  let app;
  beforeAll(async () => {
    delete process.env.APP_PASSWORD;
    delete process.env.AUTH_SECRET;
    app = (await import('../../server.js')).default;
  });
  beforeEach(() => {
    __resetAiForTests();
    fetch.mockReset();
  });

  it('streams the model tokens as delta events and ends with done carrying the full text', async () => {
    installFakeOllama(fetch, { chat: () => textReply('One two three', { tokens: ['One', ' two', ' three'] }) });
    const res = await request(app).post('/api/jarvis/advice').set('Accept', SSE).set('X-Forwarded-For', '192.0.2.200').send(ADVICE);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
    const deltas = [...res.text.matchAll(/event: delta\ndata: (.*)\n/g)].map((m) => JSON.parse(m[1]).content);
    expect(deltas.length).toBeGreaterThan(0);
    const done = JSON.parse(/event: done\ndata: (.*)\n/.exec(res.text)[1]);
    expect(done).toMatchObject({ content: 'One two three', model: 'qwen2.5:3b', provider: 'ollama' });
  });

  it('a full AI queue answers 429 ai_busy as JSON before any stream opens', async () => {
    process.env.BURROW_AI_QUEUE_MAX = '0';
    try {
      __resetAiForTests();
      installFakeOllama(fetch, { chat: hangingChat });
      const client = await getAiClient({ purpose: 'chat' });
      const ac = new AbortController();
      const holding = client.complete({ messages: [{ role: 'user', content: 'x' }], signal: ac.signal }).catch(() => {});
      await new Promise((r) => setTimeout(r, 20));
      const res = await request(app).post('/api/jarvis/advice').set('Accept', SSE).set('X-Forwarded-For', '192.0.2.202').send(ADVICE);
      expect(res.status).toBe(429);
      expect(res.headers['content-type']).toMatch(/application\/json/);
      expect(res.body).toEqual({ error: 'ai_busy', message: 'Javi is busy with another request. Try again in a moment.' });
      ac.abort();
      await holding;
    } finally {
      delete process.env.BURROW_AI_QUEUE_MAX;
      __resetAiForTests();
    }
  });

  it('rejects a malformed history before resolving a model', async () => {
    const res = await request(app).post('/api/jarvis/advice').set('X-Forwarded-For', '192.0.2.201').send({ ...ADVICE, messages: [{ role: 'tool', content: 'x' }] });
    expect(res.status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('cloud provider resolution', () => {
  const saved = process.env.AI_CLOUD_API_KEY;
  afterAll(() => {
    if (saved === undefined) delete process.env.AI_CLOUD_API_KEY;
    else process.env.AI_CLOUD_API_KEY = saved;
  });
  beforeEach(async () => {
    __resetAiForTests();
    __resetNetPolicyForTests();
    fetch.mockReset();
    await setState(NETWORK_STATE_KEY, {});
    await setState(AI_SETTINGS_KEY, { provider: 'openai_compat', cloud: { baseUrl: 'https://cloud.example/v1', model: 'cloud-model' } });
    process.env.AI_CLOUD_API_KEY = 'sk-cloud-test-key-1';
  });

  it('stays local until the cloudAi opt-in is on, even with a key and config', async () => {
    installFakeOllama(fetch);
    const client = await getAiClient({ purpose: 'chat' });
    expect(client.provider).toBe('ollama');
    expect(fetch.mock.calls.some(([u]) => String(u).includes('cloud.example'))).toBe(false);
  });

  it('uses the cloud endpoint only with the opt-in, sending the key only there', async () => {
    await setState(NETWORK_STATE_KEY, { cloudAi: true });
    await recordCloudConsent({ host: 'cloud.example', baseUrl: 'https://cloud.example/v1' });
    __resetNetPolicyForTests();
    const sse = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n';
    fetch.mockResolvedValue({ ok: true, status: 200, body: Readable.from([Buffer.from(sse)]), headers: { get: () => null } });
    const client = await getAiClient({ purpose: 'chat' });
    expect([client.provider, client.model]).toEqual(['openai_compat', 'cloud-model']);
    const out = await client.complete({ messages: [{ role: 'user', content: 'x' }], maxTokens: 10, scope: { categories: [] } });
    expect(out.content).toBe('hi');
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://cloud.example/v1/chat/completions');
    expect(init.headers.Authorization).toBe('Bearer sk-cloud-test-key-1');
    expect(init.redirect).toBe('error');
    expect(JSON.parse(init.body).max_tokens).toBe(10);
  });

  it('falls back to local when the cloud config is incomplete', async () => {
    await setState(NETWORK_STATE_KEY, { cloudAi: true });
    __resetNetPolicyForTests();
    delete process.env.AI_CLOUD_API_KEY;
    installFakeOllama(fetch);
    expect((await getAiClient({ purpose: 'chat' })).provider).toBe('ollama');
  });
});
