// Settings > AI routes (/api/settings/ai*) through the real server.js on a fake Ollama.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

vi.mock('../../loadEnv.js', () => ({}));
vi.mock('node-fetch', () => ({ default: vi.fn() }));

import fetch from 'node-fetch';
import { installFakeOllama } from './helpers/fakeOllama.js';
import { __resetAiForTests } from '../ai/index.js';
import { AI_SETTINGS_KEY } from '../ai/settings.js';
import { NETWORK_STATE_KEY, __resetNetPolicyForTests } from '../netPolicy.js';
import { getState, setState } from '../dataAccess.js';

let app;
let ip = 0;
const nextIp = () => `192.0.2.${(ip += 1) % 250}`;
const get = (path) => request(app).get(path).set('X-Forwarded-For', nextIp());
const put = (path, body) => request(app).put(path).set('X-Forwarded-For', nextIp()).send(body);
const saved = Object.fromEntries(['APP_PASSWORD', 'AUTH_SECRET', 'SECRETS_ENCRYPTION_KEY', 'BURROW_NETWORK_OPTIN', 'AI_CLOUD_API_KEY'].map((k) => [k, process.env[k]]));

beforeAll(async () => {
  delete process.env.APP_PASSWORD;
  delete process.env.AUTH_SECRET;
  delete process.env.SECRETS_ENCRYPTION_KEY;
  app = (await import('../../server.js')).default;
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
beforeEach(async () => {
  delete process.env.BURROW_NETWORK_OPTIN;
  delete process.env.AI_CLOUD_API_KEY;
  await setState(AI_SETTINGS_KEY, {});
  await setState(NETWORK_STATE_KEY, {});
  __resetNetPolicyForTests();
  __resetAiForTests();
  fetch.mockReset();
});

describe('GET /api/settings/ai', () => {
  it('reports the running local setup with auto models, no-store, in a { data } envelope', async () => {
    installFakeOllama(fetch);
    const res = await get('/api/settings/ai');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({
      data: {
        enabled: true,
        provider: 'ollama',
        effectiveProvider: 'ollama',
        ollama: { host: 'http://127.0.0.1:11434', hostSource: 'default', loopback: true, running: true, version: '0.32.14', numCtx: 8192, error: null },
        models: {
          chat: { selected: null, effective: 'qwen2.5:3b', source: 'auto' },
          tools: { selected: null, effective: 'qwen2.5:7b', source: 'auto' },
        },
        cloud: {
          optIn: false,
          keySaved: false,
          baseUrl: null,
          host: null,
          model: null,
          tokenParam: 'max_tokens',
          ready: false,
          consent: { current: false, acceptedAt: null, host: null, version: null },
          consentVersion: 1,
          categories: { budget: true, todos: true, calendar: true, habits: true, health: false, notes: false, journal: false, bookmarks: true, countdowns: true, focus: true, folders: false },
          active: false,
        },
      },
    });
  });

  it('reports connection_refused with a hint when Ollama is down', async () => {
    installFakeOllama(fetch, { down: true });
    const { body } = await get('/api/settings/ai');
    expect(body.data.ollama).toMatchObject({ running: false, version: null, error: { code: 'connection_refused', hint: expect.any(String) } });
    expect(body.data.models.chat.effective).toBeNull();
  });

  it('reports no_models when nothing usable is installed', async () => {
    installFakeOllama(fetch, { models: [] });
    const { body } = await get('/api/settings/ai');
    expect(body.data.ollama).toMatchObject({ running: true, error: { code: 'no_models' } });
  });

  it('reports not_ollama when something else answers', async () => {
    fetch.mockResolvedValue({ ok: false, status: 404, text: async () => 'nope', json: async () => ({}), headers: { get: () => null } });
    const { body } = await get('/api/settings/ai');
    expect(body.data.ollama.error.code).toBe('not_ollama');
  });
});

describe('GET /api/settings/ai/models', () => {
  it('lists installed models in the public shape', async () => {
    installFakeOllama(fetch);
    const res = await get('/api/settings/ai/models');
    expect(res.status).toBe(200);
    expect(res.body.data.models[0]).toEqual({
      name: 'qwen2.5:7b',
      sizeBytes: 4683087332,
      parameterSize: '7.6B',
      parameterCount: 7.6e9,
      family: 'qwen2',
      quantization: 'Q4_K_M',
      capabilities: ['completion', 'tools'],
      contextLength: 32768,
      modifiedAt: '2026-01-01T00:00:00Z',
    });
  });

  it('503 ollama_unavailable when Ollama is unreachable', async () => {
    installFakeOllama(fetch, { down: true });
    const res = await get('/api/settings/ai/models');
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ error: 'ollama_unavailable', code: 'ollama_unavailable', message: expect.stringContaining('127.0.0.1:11434') });
  });
});

describe('PUT /api/settings/ai/models', () => {
  it('saves installed choices and returns the full status', async () => {
    installFakeOllama(fetch);
    const res = await put('/api/settings/ai/models', { chatModel: 'qwen2.5:7b', toolModel: 'qwen2.5:3b' });
    expect(res.status).toBe(200);
    expect(res.body.data.models).toEqual({
      chat: { selected: 'qwen2.5:7b', effective: 'qwen2.5:7b', source: 'settings' },
      tools: { selected: 'qwen2.5:3b', effective: 'qwen2.5:3b', source: 'settings' },
    });
    const reset = await put('/api/settings/ai/models', { chatModel: null, toolModel: null });
    expect(reset.body.data.models.chat).toEqual({ selected: null, effective: 'qwen2.5:3b', source: 'auto' });
  });

  it('400 model_not_installed / model_lacks_tools / invalid_body', async () => {
    installFakeOllama(fetch);
    expect((await put('/api/settings/ai/models', { chatModel: 'llama9:70b' })).body).toMatchObject({ error: 'model_not_installed', code: 'model_not_installed' });
    expect((await put('/api/settings/ai/models', { toolModel: 'moondream:latest' })).body.code).toBe('model_lacks_tools');
    expect((await put('/api/settings/ai/models', { chatModel: '../../etc' })).status).toBe(400);
    expect((await put('/api/settings/ai/models', [])).status).toBe(400);
    expect(await getState(AI_SETTINGS_KEY)).toEqual({});
  });

  it('503 when a model is named but Ollama is down', async () => {
    installFakeOllama(fetch, { down: true });
    expect((await put('/api/settings/ai/models', { chatModel: 'qwen2.5:3b' })).status).toBe(503);
  });
});

describe('PUT /api/settings/ai/host', () => {
  it('stores a loopback origin and resets with null', async () => {
    const fake = installFakeOllama(fetch);
    const res = await put('/api/settings/ai/host', { host: 'http://localhost:11434/' });
    expect(res.status).toBe(200);
    expect(res.body.data.ollama).toMatchObject({ host: 'http://localhost:11434', hostSource: 'settings', loopback: true });
    expect(fake.urls.at(-1)).toMatch(/^http:\/\/localhost:11434\/api\//);
    const reset = await put('/api/settings/ai/host', { host: null });
    expect(reset.body.data.ollama).toMatchObject({ host: 'http://127.0.0.1:11434', hostSource: 'default' });
  });

  it('400 invalid_host for bad input', async () => {
    for (const host of ['ftp://x', 'http://0.0.0.0:11434', 'http://a:b@127.0.0.1', 'http://127.0.0.1:11434/api', 5]) {
      const res = await put('/api/settings/ai/host', { host });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('invalid_host');
    }
    expect((await put('/api/settings/ai/host', {})).status).toBe(400);
  });

  it('a host on another machine needs the aiLan opt-in (403) and is never contacted', async () => {
    installFakeOllama(fetch);
    const res = await put('/api/settings/ai/host', { host: 'http://192.168.1.20:11434' });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: 'network_opt_in_required', feature: 'aiLan', code: 'network_opt_in_required' });
    expect(fetch.mock.calls.some(([u]) => String(u).includes('192.168'))).toBe(false);

    process.env.BURROW_NETWORK_OPTIN = 'aiLan';
    __resetNetPolicyForTests();
    const ok = await put('/api/settings/ai/host', { host: 'http://192.168.1.20:11434' });
    expect(ok.status).toBe(200);
    expect(ok.body.data.ollama).toMatchObject({ host: 'http://192.168.1.20:11434', loopback: false });
  });
});

describe('cloud provider settings', () => {
  it('saves cloud config without the opt-in, but using it needs cloudAi (403) and a full config (400)', async () => {
    installFakeOllama(fetch);
    const saved = await put('/api/settings/ai/cloud', { baseUrl: 'https://cloud.example/v1', model: 'some-model', tokenParam: null });
    expect(saved.status).toBe(200);
    expect(saved.body.data.cloud).toMatchObject({ optIn: false, keySaved: false, baseUrl: 'https://cloud.example/v1', host: 'cloud.example', model: 'some-model', tokenParam: 'max_tokens', ready: false, active: false });

    const blocked = await put('/api/settings/ai/provider', { provider: 'openai_compat' });
    expect(blocked.status).toBe(403);
    expect(blocked.body.feature).toBe('cloudAi');

    process.env.BURROW_NETWORK_OPTIN = 'cloudAi';
    __resetNetPolicyForTests();
    const incomplete = await put('/api/settings/ai/provider', { provider: 'openai_compat' });
    expect(incomplete.status).toBe(400);
    expect(incomplete.body.code).toBe('cloud_not_configured');

    process.env.AI_CLOUD_API_KEY = 'sk-test-cloud-key-123';
    // Consent is recorded by POST /cloud/enable only; the provider switch alone is refused.
    const noConsent = await put('/api/settings/ai/provider', { provider: 'openai_compat' });
    expect(noConsent.status).toBe(409);
    expect(noConsent.body.code).toBe('cloud_consent_required');
    const enabled = await request(app).post('/api/settings/ai/cloud/enable').send({ version: 1, host: 'cloud.example', baseUrl: 'https://cloud.example/v1', acknowledgements: ['sends_data', 'pay_provider'] });
    expect(enabled.status).toBe(200);
    const ok = await put('/api/settings/ai/provider', { provider: 'openai_compat' });
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ provider: 'openai_compat', cloud: { optIn: true, keySaved: true } });
    // Status checks never call the cloud endpoint.
    expect(fetch.mock.calls.some(([u]) => String(u).includes('cloud.example'))).toBe(false);
    expect((await put('/api/settings/ai/provider', { provider: 'ollama' })).body.data.provider).toBe('ollama');
  });

  it('validates the cloud fields', async () => {
    installFakeOllama(fetch);
    // The cloud base URL shares the host validator, so it shares its error code.
    expect((await put('/api/settings/ai/cloud', { baseUrl: 'http://cloud.example/v1' })).body.code).toBe('invalid_host');
    expect((await put('/api/settings/ai/cloud', { baseUrl: 'https://cloud.example/v1?k=1' })).body.code).toBe('invalid_host');
    expect((await put('/api/settings/ai/cloud', { model: 'a b' })).body.code).toBe('invalid_model');
    expect((await put('/api/settings/ai/cloud', { tokenParam: 'max' })).body.code).toBe('invalid_token_param');
    expect((await put('/api/settings/ai/provider', { provider: 'bedrock' })).status).toBe(400);
  });
});
