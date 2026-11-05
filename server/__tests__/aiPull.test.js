// POST /api/settings/ai/pull: validation, SSE progress, abort, lock, idle timeout and error
// frames, on a fake Ollama (mocked node-fetch). Upstream text must never reach the client.
import http from 'node:http';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../../loadEnv.js', () => ({}));
vi.mock('node-fetch', () => ({ default: vi.fn() }));

import fetch from 'node-fetch';
import { installFakeOllama, pullFrames } from './helpers/fakeOllama.js';
import { __resetAiForTests, describeAi } from '../ai/index.js';
import { AI_SETTINGS_KEY } from '../ai/settings.js';
import { NETWORK_STATE_KEY, __resetNetPolicyForTests } from '../netPolicy.js';
import { setState } from '../dataAccess.js';
import { __resetPullForTests, registerAiSettingsRoutes } from '../aiSettingsRoutes.js';
import { setAuditSink } from '../auditHook.js';
import { parseSseChunk, splitSseChunks } from '../../src/utils/sse.js';

const savedEnv = Object.fromEntries(['BURROW_AI', 'OLLAMA_HOST', 'BURROW_AI_PULL_IDLE_MS', 'BURROW_AI_PULL_MAX_MS'].map((k) => [k, process.env[k]]));
const servers = [];

function makeApp(deps = {}) {
  const app = express();
  app.use(express.json());
  registerAiSettingsRoutes(app, { exists: () => false, totalmem: () => 16 * 1024 ** 3, platform: 'win32', ...deps });
  return app;
}
const events = (text) =>
  splitSseChunks(text)[0]
    .map(parseSseChunk)
    .filter(Boolean)
    .map(({ event, payload }) => ({ event, ...payload }));
const pull = (app, body = { model: 'llama3.2:3b' }) => request(app).post('/api/settings/ai/pull').send(body);
const until = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('condition not met in time');
};

beforeEach(async () => {
  for (const k of Object.keys(savedEnv)) delete process.env[k];
  await setState(AI_SETTINGS_KEY, {});
  await setState(NETWORK_STATE_KEY, {});
  __resetNetPolicyForTests();
  __resetAiForTests();
  __resetPullForTests();
  fetch.mockReset();
});
afterEach(async () => {
  setAuditSink(null);
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});
afterAll(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('pre-stream JSON errors', () => {
  it.each([[{ model: 'evil:latest' }], [{ model: '../../etc' }], [{ model: 5 }], [{}], [[1]], [{ model: 'qwen2.5:3b' }]])('400 invalid_model for %j', async (body) => {
    const state = installFakeOllama(fetch);
    const res = await pull(makeApp(), body);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'invalid_model', code: 'invalid_model' });
    expect(res.body.message).toBeTruthy();
    expect(state.pullBodies).toEqual([]);
  });

  it('409 pull_requires_local_ollama for a non-loopback host, with no upstream call', async () => {
    await setState(AI_SETTINGS_KEY, { ollamaHost: 'http://192.0.2.5:11434' });
    installFakeOllama(fetch);
    const res = await pull(makeApp());
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: 'pull_requires_local_ollama' });
    expect(fetch).not.toHaveBeenCalled();
    // The lock was not left held.
    await setState(AI_SETTINGS_KEY, {});
    installFakeOllama(fetch);
    expect((await pull(makeApp())).status).toBe(200);
  });

  it('503 ai_not_configured when AI is off', async () => {
    process.env.BURROW_AI = '0';
    installFakeOllama(fetch);
    const res = await pull(makeApp());
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ error: 'ai_not_configured', reason: 'ai_disabled' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('503 ollama_unavailable when Ollama is down, and the lock is released', async () => {
    installFakeOllama(fetch, { down: true });
    const res = await pull(makeApp());
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ error: 'ollama_unavailable' });
    installFakeOllama(fetch);
    __resetAiForTests();
    expect((await pull(makeApp())).status).toBe(200);
  });

  it('409 pull_in_progress while another download runs; the first still finishes', async () => {
    const state = installFakeOllama(fetch, { pull: { delayMs: 40 } });
    const app = makeApp();
    const first = pull(app).then((r) => r);
    await until(() => state.pullBodies.length === 1);
    const second = await pull(app, { model: 'llama3.2:1b' });
    expect(second.status).toBe(409);
    expect(second.body).toMatchObject({ error: 'pull_in_progress' });
    expect(state.pullBodies).toHaveLength(1);
    const res = await first;
    expect(events(res.text).at(-1)).toEqual({ event: 'done', model: 'llama3.2:3b' });
    expect((await pull(app)).status).toBe(200);
  });

  it('429 once the local rate limit is used up', async () => {
    installFakeOllama(fetch);
    const app = makeApp({ pullRateMax: 2 });
    expect((await pull(app)).status).toBe(200);
    expect((await pull(app)).status).toBe(200);
    const res = await pull(app);
    expect(res.status).toBe(429);
    expect(res.body.code).toBe('rate_limited');
  });
});

describe('streaming pull', () => {
  it('happy path: phases in order, then done; request body is { model, stream: true }', async () => {
    const audits = [];
    setAuditSink((e) => audits.push(e));
    const state = installFakeOllama(fetch);
    const res = await pull(makeApp());
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
    expect(state.pullBodies).toEqual([{ model: 'llama3.2:3b', stream: true }]);
    const ev = events(res.text);
    const progress = ev.filter((e) => e.event === 'progress');
    const phases = [...new Set(progress.map((e) => e.phase))];
    expect(phases).toEqual(['manifest', 'downloading', 'verifying', 'finalizing']);
    for (const p of progress) {
      expect(Object.keys(p).sort()).toEqual(['completed', 'event', 'phase', 'total']);
      expect(Number.isFinite(p.completed) && Number.isFinite(p.total)).toBe(true);
    }
    // The last downloading frame is never dropped by the throttle.
    const downloading = progress.filter((e) => e.phase === 'downloading');
    expect(downloading.at(-1)).toMatchObject({ completed: 1000, total: 1000 });
    expect(ev.at(-1)).toEqual({ event: 'done', model: 'llama3.2:3b' });
    expect(ev.filter((e) => e.event === 'done' || e.event === 'error')).toHaveLength(1);
    expect(audits).toEqual([expect.objectContaining({ kind: 'llm', feature: 'model_pull', provider: 'ollama', model: 'llama3.2:3b', status: 'ok' })]);
  });

  it('throttles progress but keeps the first and last frame', async () => {
    installFakeOllama(fetch, { pull: { frames: pullFrames({ total: 4000, steps: 40 }) } });
    const res = await pull(makeApp());
    const downloading = events(res.text).filter((e) => e.event === 'progress' && e.phase === 'downloading');
    expect(downloading.length).toBeGreaterThanOrEqual(2);
    expect(downloading.length).toBeLessThan(40);
    expect(downloading.at(-1)).toMatchObject({ completed: 4000, total: 4000 });
  });

  it('aggregates layers: overall completed and total grow monotonically across digests', async () => {
    const frames = [
      { status: 'pulling manifest' },
      { status: 'pulling aaaaaaaaaaaa', digest: 'sha256:aaaaaaaaaaaa', total: 800, completed: 200 },
      { status: 'pulling aaaaaaaaaaaa', digest: 'sha256:aaaaaaaaaaaa', total: 800, completed: 800 },
      { status: 'pulling bbbbbbbbbbbb', digest: 'sha256:bbbbbbbbbbbb', total: 200, completed: 0 },
      { status: 'pulling bbbbbbbbbbbb', digest: 'sha256:bbbbbbbbbbbb', total: 200, completed: 100 },
      { status: 'pulling aaaaaaaaaaaa', digest: 'sha256:aaaaaaaaaaaa', total: 800, completed: 500 },
      { status: 'pulling bbbbbbbbbbbb', digest: 'sha256:bbbbbbbbbbbb', total: 200, completed: 200 },
      { status: 'verifying sha256 digest' },
      { status: 'success' },
    ];
    installFakeOllama(fetch, { pull: { frames } });
    const state = await (async () => {
      const { pullModel } = await import('../ai/registry.js');
      const out = [];
      for await (const f of pullModel({ model: 'llama3.2:3b' })) out.push(f);
      return out;
    })();
    const downloading = state.filter((f) => f.phase === 'downloading');
    expect(downloading.map((f) => [f.completed, f.total])).toEqual([
      [200, 800],
      [800, 800],
      [800, 1000],
      [900, 1000],
      [900, 1000],
      [1000, 1000],
    ]);
    for (let i = 1; i < downloading.length; i += 1) {
      expect(downloading[i].completed).toBeGreaterThanOrEqual(downloading[i - 1].completed);
      expect(downloading[i].total).toBeGreaterThanOrEqual(downloading[i - 1].total);
    }
    expect(state.map((f) => f.phase)).toEqual(['manifest', ...downloading.map(() => 'downloading'), 'verifying']);
    expect(state.at(-1)).toEqual({ phase: 'verifying', completed: 1000, total: 1000 });
  });

  it('invalidates the health cache after a pull so the new model is usable at once', async () => {
    const models = [];
    installFakeOllama(fetch, { models });
    const app = makeApp();
    // Prime the 5 s health cache with an empty model list.
    expect((await describeAi('chat')).available).toBe(false);
    models.push({ name: 'llama3.2:3b', model: 'llama3.2:3b', size: 2e9, details: { parameter_size: '3.2B' }, capabilities: ['completion', 'tools'] });
    expect((await describeAi('chat')).available).toBe(false);
    const res = await pull(app);
    expect(events(res.text).at(-1).event).toBe('done');
    expect(await describeAi('chat')).toMatchObject({ available: true, model: 'llama3.2:3b' });
  });

  it('never forwards upstream text: unknown statuses are dropped, names and digests stay private', async () => {
    const frames = [
      { status: 'pulling manifest' },
      { status: 'SECRET-STATUS-TEXT /home/user/.ollama', digest: 'sha256:deadbeefcafe' },
      { status: 'pulling deadbeefcafe', digest: 'sha256:deadbeefcafe', total: 10, completed: 5 },
      { status: 'verifying sha256 digest' },
      { status: 'success' },
    ];
    installFakeOllama(fetch, { pull: { frames } });
    const res = await pull(makeApp());
    expect(res.text).not.toMatch(/SECRET|deadbeef|sha256|someone|\.ollama/);
    const ev = events(res.text);
    expect(ev.map((e) => e.event)).toEqual(['progress', 'progress', 'progress', 'done']);
  });

  it('an upstream error frame becomes a fixed pull_failed error event', async () => {
    const audits = [];
    setAuditSink((e) => audits.push(e));
    installFakeOllama(fetch, { pull: { frames: [{ status: 'pulling manifest' }, { error: 'secret upstream detail: pull model manifest: file does not exist' }] } });
    const res = await pull(makeApp());
    expect(res.status).toBe(200);
    expect(res.text).not.toMatch(/secret|manifest: file/);
    const last = events(res.text).at(-1);
    expect(last).toMatchObject({ event: 'error', code: 'pull_failed' });
    expect(last.message).not.toMatch(/—/);
    expect(events(res.text).some((e) => e.event === 'done')).toBe(false);
    expect(audits[0]).toMatchObject({ feature: 'model_pull', status: 'error' });
  });

  it('a stream that ends without success is pull_failed', async () => {
    installFakeOllama(fetch, { pull: { frames: [{ status: 'pulling manifest' }] } });
    const res = await pull(makeApp());
    expect(events(res.text).at(-1)).toMatchObject({ event: 'error', code: 'pull_failed' });
  });

  it('an upstream HTTP error never leaks its body', async () => {
    installFakeOllama(fetch, { pull: { status: 500 } });
    const res = await pull(makeApp());
    expect(res.text).not.toMatch(/upstream secret detail/);
    expect(events(res.text).at(-1)).toMatchObject({ event: 'error', code: 'pull_failed' });
  });

  it('idle timeout: no upstream frame for the limit gives a timeout error and aborts upstream', async () => {
    process.env.BURROW_AI_PULL_IDLE_MS = '150';
    const state = installFakeOllama(fetch, { pull: { hangAfter: 2 } });
    const app = makeApp();
    const res = await pull(app);
    const last = events(res.text).at(-1);
    expect(last).toMatchObject({ event: 'error', code: 'timeout' });
    expect(last.message).toBeTruthy();
    expect(state.pullAborted).toBe(true);
    // Lock released.
    delete process.env.BURROW_AI_PULL_IDLE_MS;
    installFakeOllama(fetch);
    expect((await pull(app)).status).toBe(200);
  });
});

describe('pull time limits', () => {
  it('unknown-status frames do not re-arm the idle timer', async () => {
    process.env.BURROW_AI_PULL_IDLE_MS = '150';
    const audits = [];
    setAuditSink((e) => audits.push(e));
    const noise = Array.from({ length: 40 }, () => ({ status: 'noise frame' }));
    const state = installFakeOllama(fetch, { pull: { delayMs: 30, frames: [{ status: 'pulling manifest' }, ...noise] } });
    const res = await pull(makeApp());
    expect(events(res.text).at(-1)).toMatchObject({ event: 'error', code: 'timeout' });
    expect(state.pullAborted).toBe(true);
    expect(audits).toEqual([expect.objectContaining({ feature: 'model_pull', status: 'error' })]);
  });

  it('wall-clock cap ends a pull that keeps making progress with a timeout error', async () => {
    process.env.BURROW_AI_PULL_MAX_MS = '250';
    const state = installFakeOllama(fetch, { pull: { delayMs: 30, frames: pullFrames({ steps: 200 }) } });
    const app = makeApp();
    const res = await pull(app);
    expect(events(res.text).at(-1)).toMatchObject({ event: 'error', code: 'timeout' });
    expect(state.pullAborted).toBe(true);
    delete process.env.BURROW_AI_PULL_MAX_MS;
    installFakeOllama(fetch);
    expect((await pull(app)).status).toBe(200);
  });
});

describe('client disconnect', () => {
  it('before the stream opens: never starts the download, records an aborted row, frees the lock', async () => {
    const audits = [];
    setAuditSink((e) => audits.push(e));
    const state = installFakeOllama(fetch);
    const impl = fetch.getMockImplementation();
    let release;
    const gate = new Promise((r) => {
      release = r;
    });
    let tagsHit = false;
    fetch.mockImplementation(async (url, init) => {
      if (new URL(url).pathname === '/api/tags') {
        tagsHit = true;
        await gate;
      }
      return impl(url, init);
    });
    const app = makeApp();
    const server = http.createServer(app);
    servers.push(server);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    const body = JSON.stringify({ model: 'llama3.2:3b' });
    const req = http.request({ host: '127.0.0.1', port, path: '/api/settings/ai/pull', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } });
    req.on('error', () => {});
    req.end(body);
    await until(() => tagsHit);
    req.destroy();
    await new Promise((r) => setTimeout(r, 50));
    release();
    await until(() => audits.length === 1);
    expect(audits[0]).toMatchObject({ feature: 'model_pull', status: 'aborted' });
    expect(state.pullBodies).toEqual([]);
    installFakeOllama(fetch);
    __resetAiForTests();
    expect((await pull(app)).status).toBe(200);
  });

  it('aborts the upstream fetch, records an aborted row and releases the lock', async () => {
    const audits = [];
    setAuditSink((e) => audits.push(e));
    const state = installFakeOllama(fetch, { pull: { delayMs: 30, frames: pullFrames({ steps: 200 }) } });
    const app = makeApp();
    const server = http.createServer(app);
    servers.push(server);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    const body = JSON.stringify({ model: 'llama3.2:3b' });
    const req = http.request({ host: '127.0.0.1', port, path: '/api/settings/ai/pull', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } });
    const gotData = new Promise((resolve, reject) => {
      req.on('response', (r) => r.once('data', resolve));
      req.on('error', reject);
    });
    req.end(body);
    await gotData;
    req.destroy();
    await until(() => state.pullAborted);
    expect(state.pullAborted).toBe(true);
    await until(() => audits.length === 1);
    expect(audits[0]).toMatchObject({ kind: 'llm', feature: 'model_pull', model: 'llama3.2:3b', status: 'aborted' });
    // The lock frees once the aborted stream unwinds.
    let status = 0;
    const end = Date.now() + 3000;
    while (Date.now() < end) {
      installFakeOllama(fetch);
      status = (await pull(app)).status;
      if (status !== 409) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(status).toBe(200);
  });
});

describe('pull body validation edge cases', () => {
  const long = `llama3.2:3b${'a'.repeat(5000)}`;
  it.each([
    ['top-level array', []],
    ['array holding a valid name', ['llama3.2:3b']],
    ['null', null],
    ['model as array', { model: ['llama3.2:3b'] }],
    ['model as object', { model: { name: 'llama3.2:3b' } }],
    ['empty string', { model: '' }],
    ['whitespace padded name', { model: ' llama3.2:3b ' }],
    ['case variant', { model: 'LLAMA3.2:3B' }],
    ['path traversal', { model: '../llama3.2:3b' }],
    ['very long name', { model: long }],
    ['registry-qualified name', { model: 'registry.example.com/llama3.2:3b' }],
  ])('400 invalid_model for %s, with no upstream call', async (_l, body) => {
    const state = installFakeOllama(fetch);
    const res = await pull(makeApp(), body);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_model');
    expect(JSON.stringify(res.body)).not.toContain('aaaa');
    expect(state.pullBodies).toEqual([]);
  });

  it('400 for a missing or non-JSON body, and the lock stays free afterwards', async () => {
    const state = installFakeOllama(fetch);
    const app = makeApp();
    expect((await request(app).post('/api/settings/ai/pull')).status).toBe(400);
    expect((await request(app).post('/api/settings/ai/pull').type('text').send('llama3.2:3b')).status).toBe(400);
    expect((await pull(app)).status).toBe(200);
    expect(state.pullBodies).toHaveLength(1);
  });
});
