// GET /api/settings/ai/setup: every first-run state, on a fake Ollama (mocked node-fetch).
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../../loadEnv.js', () => ({}));
vi.mock('node-fetch', () => ({ default: vi.fn() }));

import fetch from 'node-fetch';
import { MODELS, installFakeOllama } from './helpers/fakeOllama.js';
import { __resetAiForTests } from '../ai/index.js';
import { AI_SETTINGS_KEY } from '../ai/settings.js';
import { NETWORK_STATE_KEY, __resetNetPolicyForTests } from '../netPolicy.js';
import { setState } from '../dataAccess.js';
import { registerAiSettingsRoutes } from '../aiSettingsRoutes.js';

const GIB = 1024 ** 3;
const savedAi = process.env.BURROW_AI;
const savedHost = process.env.OLLAMA_HOST;

function makeApp(deps = {}) {
  const app = express();
  app.use(express.json());
  registerAiSettingsRoutes(app, { exists: () => false, totalmem: () => 16 * GIB, platform: 'win32', ...deps });
  return app;
}
const setup = (app) => request(app).get('/api/settings/ai/setup');

beforeEach(async () => {
  delete process.env.BURROW_AI;
  delete process.env.OLLAMA_HOST;
  await setState(AI_SETTINGS_KEY, {});
  await setState(NETWORK_STATE_KEY, {});
  __resetNetPolicyForTests();
  __resetAiForTests();
  fetch.mockReset();
});
afterAll(() => {
  if (savedAi === undefined) delete process.env.BURROW_AI;
  else process.env.BURROW_AI = savedAi;
  if (savedHost === undefined) delete process.env.OLLAMA_HOST;
  else process.env.OLLAMA_HOST = savedHost;
});

describe('GET /api/settings/ai/setup', () => {
  it('running with a usable model: ready and can pull; no-store { data } envelope', async () => {
    installFakeOllama(fetch);
    const res = await setup(makeApp());
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const d = res.body.data;
    expect(d.ollama).toBe('running');
    expect(d.host).toBe('http://127.0.0.1:11434');
    expect(d.version).toBe('0.32.14');
    expect(d.ready).toBe(true);
    expect(d.canPull).toBe(true);
    expect(d.models.map((m) => m.name)).toEqual(MODELS.map((m) => m.name));
    expect(d.models[0]).toEqual({ name: 'qwen2.5:7b', sizeBytes: 4683087332 });
    expect(d.ramGb).toBe(16);
    expect(d.recommended.tier).toBe('large');
    expect(d.recommended.ramGb).toBe(16);
  });

  it('running with nothing installed: not ready, can still pull', async () => {
    installFakeOllama(fetch, { models: [] });
    const d = (await setup(makeApp({ totalmem: () => 8 * GIB }))).body.data;
    expect(d.ollama).toBe('running');
    expect(d.ready).toBe(false);
    expect(d.canPull).toBe(true);
    expect(d.models).toEqual([]);
    expect(d.recommended.tier).toBe('small');
  });

  it('stopped: unreachable on loopback but an install is found', async () => {
    installFakeOllama(fetch, { down: true });
    const d = (await setup(makeApp({ exists: () => true, platform: 'linux' }))).body.data;
    expect(d).toMatchObject({ ollama: 'stopped', ready: false, canPull: false, version: null, models: [] });
  });

  it('missing: unreachable on loopback and no install found', async () => {
    installFakeOllama(fetch, { down: true });
    const d = (await setup(makeApp({ exists: () => false }))).body.data;
    expect(d).toMatchObject({ ollama: 'missing', ready: false, canPull: false });
  });

  it('passes the platform and LOCALAPPDATA to the install probe', async () => {
    installFakeOllama(fetch, { down: true });
    const seen = [];
    const saved = process.env.LOCALAPPDATA;
    process.env.LOCALAPPDATA = 'C:\\Fake\\Local';
    try {
      await setup(
        makeApp({
          exists: (p) => {
            seen.push(p);
            return false;
          },
        }),
      );
    } finally {
      if (saved === undefined) delete process.env.LOCALAPPDATA;
      else process.env.LOCALAPPDATA = saved;
    }
    expect(seen).toEqual(['C:\\Fake\\Local\\Programs\\Ollama\\ollama.exe']);
  });

  it('unreachable: something answers that is not Ollama', async () => {
    fetch.mockImplementation(async () => ({ ok: true, status: 200, json: async () => ({ hello: 'world' }), text: async () => '{"hello":"world"}', headers: { get: () => null } }));
    const d = (await setup(makeApp({ exists: () => true }))).body.data;
    expect(d).toMatchObject({ ollama: 'unreachable', canPull: false, ready: false });
  });

  it('unreachable: an HTTP error from the host', async () => {
    fetch.mockImplementation(async () => ({ ok: false, status: 502, text: async () => 'bad gateway', headers: { get: () => null } }));
    expect((await setup(makeApp())).body.data.ollama).toBe('unreachable');
  });

  it('remote: a non-loopback host is reported, never probed, and cannot pull', async () => {
    await setState(AI_SETTINGS_KEY, { ollamaHost: 'http://192.0.2.5:11434' });
    installFakeOllama(fetch);
    const d = (await setup(makeApp())).body.data;
    expect(d).toMatchObject({ ollama: 'remote', host: 'http://192.0.2.5:11434', canPull: false, ready: false });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('disabled: BURROW_AI=0 reports disabled and probes nothing', async () => {
    process.env.BURROW_AI = '0';
    installFakeOllama(fetch);
    const d = (await setup(makeApp())).body.data;
    expect(d).toMatchObject({ ollama: 'disabled', ready: false, canPull: false });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('only loopback URLs are fetched', async () => {
    const state = installFakeOllama(fetch);
    await setup(makeApp());
    expect(state.urls.length).toBeGreaterThan(0);
    for (const u of state.urls) expect(new URL(u).hostname).toBe('127.0.0.1');
  });
});

describe('GET /api/settings/ai/setup edge cases', () => {
  it('disabled AI never reports ready or canPull even if Ollama and models exist', async () => {
    process.env.BURROW_AI = '0';
    installFakeOllama(fetch);
    const res = await setup(makeApp({ exists: () => true }));
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.data).toMatchObject({ ollama: 'disabled', ready: false, canPull: false });
  });

  it('maps os.totalmem-style values at the 8 and 16 GiB boundaries', async () => {
    installFakeOllama(fetch, { models: [] });
    expect((await setup(makeApp({ totalmem: () => Math.floor(7.8 * GIB) }))).body.data.recommended.tier).toBe('small');
    expect((await setup(makeApp({ totalmem: () => Math.floor(15.7 * GIB) }))).body.data.recommended.tier).toBe('large');
  });

  it('a throwing install probe does not leak internals', async () => {
    installFakeOllama(fetch, { down: true });
    const res = await setup(makeApp({ exists: () => { throw new Error('EACCES secret-path'); } }));
    expect(res.status).toBe(200);
    expect(res.body.data.ollama).toBe('missing');
    expect(JSON.stringify(res.body)).not.toContain('secret-path');
  });
});
