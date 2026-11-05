// POST /api/jarvis/advice through the real server.js with generateAdvice/streamAdvice mocked and
// a fake Ollama behind node-fetch (the route resolves the chat client before calling the service).
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';

vi.mock('../../loadEnv.js', () => ({}));
vi.mock('../javi/advisorService.js', () => ({ generateAdvice: vi.fn(), streamAdvice: vi.fn() }));
vi.mock('node-fetch', () => ({ default: vi.fn() }));
vi.mock('../auditHook.js', () => ({ recordAudit: vi.fn(async () => {}), setAuditSink: vi.fn() }));

import fetch from 'node-fetch';
import { generateAdvice, streamAdvice } from '../javi/advisorService.js';
import { installFakeOllama } from './helpers/fakeOllama.js';
import { __resetAiForTests } from '../ai/index.js';
import { recordAudit } from '../auditHook.js';
import { bumpDataGeneration, __resetDataGenerationForTests } from '../dataGeneration.js';
import { remove, selectOne } from '../db/index.js';

const SENTINEL = `gsk_SENTINEL${'7'.repeat(24)}`;
const URL_PATH = '/api/jarvis/advice';

let app;
let logs;
let ipCounter = 0;
const nextIp = () => `198.51.100.${(ipCounter += 1)}`;

const savedEncKey = process.env.SECRETS_ENCRYPTION_KEY;
afterAll(() => {
  if (savedEncKey === undefined) delete process.env.SECRETS_ENCRYPTION_KEY;
  else process.env.SECRETS_ENCRYPTION_KEY = savedEncKey;
});

beforeAll(async () => {
  delete process.env.SECRETS_ENCRYPTION_KEY;
  delete process.env.APP_PASSWORD;
  delete process.env.AUTH_SECRET;
  app = (await import('../../server.js')).default;
});

beforeEach(() => {
  generateAdvice.mockReset();
  recordAudit.mockClear();
  __resetDataGenerationForTests();
  streamAdvice.mockReset();
  delete process.env.BURROW_AI;
  __resetAiForTests();
  fetch.mockReset();
  installFakeOllama(fetch);
  logs = [
    vi.spyOn(console, 'error').mockImplementation(() => {}),
    vi.spyOn(console, 'warn').mockImplementation(() => {}),
    vi.spyOn(console, 'log').mockImplementation(() => {}),
  ];
});

afterEach(() => {
  vi.restoreAllMocks();
});

const logged = () => JSON.stringify(logs.map((l) => l.mock.calls));
const post = (body, ip = nextIp()) => request(app).post(URL_PATH).set('X-Forwarded-For', ip).send(body);

describe('POST /api/jarvis/advice', () => {
  it('returns { data } with no-store and passes the validated value to generateAdvice', async () => {
    generateAdvice.mockResolvedValue({ content: '- Do the thing', model: 'm1', provider: 'ollama', extra: 'dropped' });
    const res = await post({
      page: 'todos',
      pageLabel: 'Evil',
      context: '{"a":1}',
      messages: [{ role: 'user', content: 'hi', junk: true }],
    });
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({ data: { content: '- Do the thing', model: 'm1', provider: 'ollama' } });
    expect(generateAdvice).toHaveBeenCalledTimes(1);
    expect(generateAdvice).toHaveBeenCalledWith(
      {
        page: 'todos',
        pageLabel: 'Todos',
        context: '{"a":1}',
        messages: [{ role: 'user', content: 'hi' }],
      },
      { client: expect.objectContaining({ provider: 'ollama', model: 'qwen2.5:3b' }), signal: expect.any(AbortSignal) },
    );
  });

  it.each([
    ['unknown page', { page: 'nope' }, 400, 'unknown_page'],
    ['non-string context', { page: 'todos', context: 5 }, 400, 'invalid_context'],
    ['oversized context', { page: 'todos', context: 'x'.repeat(4001) }, 413, 'context_too_large'],
    ['bad role', { page: 'todos', messages: [{ role: 'system', content: 'x' }] }, 400, 'invalid_messages'],
    [
      'too many messages',
      { page: 'todos', messages: Array.from({ length: 13 }, () => ({ role: 'user', content: 'x' })) },
      413,
      'too_many_messages',
    ],
    ['long message', { page: 'todos', messages: [{ role: 'user', content: 'x'.repeat(4001) }] }, 413, 'message_too_long'],
  ])('rejects %s with the { error, code } envelope and never calls generateAdvice', async (_n, body, status, code) => {
    const res = await post(body);
    expect(res.status).toBe(status);
    expect(Object.keys(res.body).sort()).toEqual(['code', 'error']);
    expect(res.body.code).toBe(code);
    expect(typeof res.body.error).toBe('string');
    expect(generateAdvice).not.toHaveBeenCalled();
  });

  it('rejects an array body with 400 invalid_request', async () => {
    const res = await post([1, 2]);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_request');
    expect(generateAdvice).not.toHaveBeenCalled();
  });

  it('answers a body over 2 MB with 413 invalid_body and never logs it', async () => {
    const res = await request(app)
      .post(URL_PATH)
      .set('X-Forwarded-For', nextIp())
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ page: 'todos', context: SENTINEL + 'x'.repeat(3 * 1024 * 1024) }));
    expect(res.status).toBe(413);
    expect(res.body).toEqual({ error: 'Invalid request body', code: 'invalid_body' });
    expect(res.text).not.toContain(SENTINEL);
    expect(logged()).not.toContain(SENTINEL);
    expect(generateAdvice).not.toHaveBeenCalled();
  });

  it('answers malformed JSON with 400 invalid_body', async () => {
    const res = await request(app)
      .post(URL_PATH)
      .set('X-Forwarded-For', nextIp())
      .set('Content-Type', 'application/json')
      .send('{"page": "todos"');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid request body', code: 'invalid_body' });
  });

  it('passes service errors through (status, code, publicMessage, retryAfterMs)', async () => {
    generateAdvice.mockRejectedValue(
      Object.assign(new Error('internal detail'), {
        httpStatus: 429,
        code: 'provider_rate_limited',
        publicMessage: 'Rate limited, try later.',
        retryAfterMs: 8000,
      }),
    );
    const res = await post({ page: 'todos' });
    expect(res.status).toBe(429);
    expect(res.body).toEqual({ error: 'Rate limited, try later.', code: 'provider_rate_limited', retryAfterMs: 8000 });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.text).not.toContain('internal detail');
  });

  it('omits retryAfterMs when it is not finite', async () => {
    generateAdvice.mockRejectedValue(
      Object.assign(new Error('x'), { httpStatus: 502, code: 'upstream_error', publicMessage: 'Upstream down.', retryAfterMs: null }),
    );
    const res = await post({ page: 'todos' });
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: 'Upstream down.', code: 'upstream_error' });
  });

  it('answers the shared ai_not_configured contract when AI is turned off, before calling the service', async () => {
    process.env.BURROW_AI = '0';
    const res = await post({ page: 'todos' });
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'ai_not_configured', reason: 'ai_disabled', message: 'AI is turned off.' });
    expect(generateAdvice).not.toHaveBeenCalled();
  });

  it('answers 503 ollama_unavailable as JSON (even when a stream was asked for) when Ollama is down', async () => {
    installFakeOllama(fetch, { down: true });
    const res = await post({ page: 'todos' }).set('Accept', 'text/event-stream');
    expect(res.status).toBe(503);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body.error).toBe('ollama_unavailable');
    expect(streamAdvice).not.toHaveBeenCalled();
  });

  it('streams delta events then done { content, model, provider } with Accept: text/event-stream', async () => {
    streamAdvice.mockImplementation(async (_value, { onDelta }) => {
      onDelta('- Do ');
      onDelta('the thing');
      return { content: '- Do the thing', model: 'qwen2.5:3b', provider: 'ollama' };
    });
    const res = await post({ page: 'todos' }).set('Accept', 'text/event-stream');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
    expect(res.text).toContain('event: delta\ndata: {"content":"- Do "}');
    expect(res.text).toContain('event: done\ndata: {"content":"- Do the thing","model":"qwen2.5:3b","provider":"ollama"}');
    expect(generateAdvice).not.toHaveBeenCalled();
  });

  it('asks the service to cache a single-shot stream, skips the cache on ?fresh=1 and for a follow-up, and audits only real calls', async () => {
    streamAdvice.mockResolvedValue({ content: 'A', model: 'qwen2.5:3b', provider: 'ollama', cached: true });
    await post({ page: 'todos' }).set('Accept', 'text/event-stream');
    expect(streamAdvice.mock.calls[0][1]).toMatchObject({ cache: true, fresh: false });
    expect(recordAudit).not.toHaveBeenCalled(); // a cache hit made no model call

    streamAdvice.mockResolvedValue({ content: 'A', model: 'qwen2.5:3b', provider: 'ollama', cached: false });
    await request(app).post(`${URL_PATH}?fresh=1`).set('X-Forwarded-For', nextIp()).set('Accept', 'text/event-stream').send({ page: 'todos' });
    expect(streamAdvice.mock.calls[1][1]).toMatchObject({ cache: true, fresh: true });
    expect(recordAudit).toHaveBeenCalledTimes(1);

    await post({ page: 'todos', messages: [{ role: 'user', content: 'why?' }] }).set('Accept', 'text/event-stream');
    expect(streamAdvice.mock.calls[2][1]).toMatchObject({ cache: false });
  });

  it('streams a user-safe error event when the service fails mid-stream', async () => {
    streamAdvice.mockRejectedValue(
      Object.assign(new Error(`leak ${SENTINEL}`), { httpStatus: 504, code: 'timeout', publicMessage: 'Javi took too long to answer. Try again.' }),
    );
    const res = await post({ page: 'todos' }).set('Accept', 'text/event-stream');
    expect(res.text).toContain('event: error\ndata: {"error":"Javi took too long to answer. Try again.","code":"timeout"}');
    expect(res.text).not.toContain(SENTINEL);
  });

  it.each([
    [504, 'timeout'],
    [502, 'upstream_error'],
  ])('maps httpStatus %i / code %s', async (httpStatus, code) => {
    generateAdvice.mockRejectedValue(Object.assign(new Error('x'), { httpStatus, code, publicMessage: 'Safe text.' }));
    const res = await post({ page: 'todos' });
    expect(res.status).toBe(httpStatus);
    expect(res.body).toEqual({ error: 'Safe text.', code });
  });

  it('does not trust status/code on errors without a string publicMessage', async () => {
    generateAdvice.mockRejectedValue(Object.assign(new Error('x'), { httpStatus: 418, code: 'teapot', retryAfterMs: 5 }));
    const res = await post({ page: 'todos' });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to get advice', code: 'server_error' });
  });

  it('clamps retryAfterMs to [0, 60000]', async () => {
    const mk = (retryAfterMs) =>
      Object.assign(new Error('x'), { httpStatus: 429, code: 'provider_rate_limited', publicMessage: 'Slow down.', retryAfterMs });
    generateAdvice.mockRejectedValueOnce(mk(9000000));
    expect((await post({ page: 'todos' })).body.retryAfterMs).toBe(60000);
    generateAdvice.mockRejectedValueOnce(mk(-5));
    expect((await post({ page: 'todos' })).body.retryAfterMs).toBe(0);
  });

  it('falls back to 500 when httpStatus is missing or below 400', async () => {
    generateAdvice.mockRejectedValue(Object.assign(new Error('x'), { httpStatus: 200, publicMessage: 'Oops.' }));
    const res = await post({ page: 'todos' });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Oops.', code: 'server_error' });
  });

  it('maps an unexpected error to a generic 500 with no secrets in the response or logs', async () => {
    generateAdvice.mockRejectedValue(new Error(`boom ${SENTINEL}`));
    const res = await post({ page: 'todos', context: 'ctx-secret-context', messages: [{ role: 'user', content: 'private question' }] });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to get advice', code: 'server_error' });
    expect(res.text).not.toContain(SENTINEL);
    expect(logged()).not.toContain(SENTINEL);
    expect(logged()).not.toContain('ctx-secret-context');
    expect(logged()).not.toContain('private question');
  });
});

describe('rate limiter wiring', () => {
  it('shares the strict /api/jarvis limiter: 20 ok, the 21st is 429', async () => {
    generateAdvice.mockResolvedValue({ content: 'ok', model: 'm', provider: 'p' });
    const ip = '203.0.113.50';
    for (let i = 0; i < 20; i += 1) {
      const res = await post({ page: 'todos' }, ip);
      expect(res.status).toBe(200);
    }
    const limited = await post({ page: 'todos' }, ip);
    expect(limited.status).toBe(429);
    expect(limited.body).toEqual({ error: 'Too many requests, please try again later.', code: 'rate_limited' });
    expect(generateAdvice).toHaveBeenCalledTimes(20);
  });

  it('counts path variants (case, trailing slash) against the same strict counter', async () => {
    generateAdvice.mockResolvedValue({ content: 'ok', model: 'm', provider: 'p' });
    const ip = '203.0.113.51';
    const paths = [URL_PATH, '/API/JARVIS/ADVICE', '/api/jarvis/advice/', URL_PATH];
    for (let i = 0; i < 20; i += 1) {
      const res = await request(app).post(paths[i % paths.length]).set('X-Forwarded-For', ip).send({ page: 'todos' });
      expect(res.status).toBe(200);
    }
    for (const p of paths) {
      const res = await request(app).post(p).set('X-Forwarded-For', ip).send({ page: 'todos' });
      expect(res.status).toBe(429);
      expect(res.body.code).toBe('rate_limited');
    }
    expect(generateAdvice).toHaveBeenCalledTimes(20);
  });
});

describe('POST /api/jarvis/advice after a data reset', () => {
  const ADVICE = { page: 'todos', pageLabel: 'Todos', context: '{"a":1}', messages: [{ role: 'user', content: 'hi' }] };

  it('writes no audit row when the data was reset while the model was answering', async () => {
    let release;
    generateAdvice.mockImplementation(() => new Promise((resolve) => (release = resolve)));
    const pending = post(ADVICE).then((r) => r);
    await vi.waitFor(() => expect(generateAdvice).toHaveBeenCalledTimes(1));
    bumpDataGeneration();
    release({ content: '- late', model: 'm1', provider: 'ollama' });
    const res = await pending;
    expect(res.status).toBe(200);
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it('still audits when no reset happened', async () => {
    generateAdvice.mockResolvedValue({ content: '- ok', model: 'm1', provider: 'ollama' });
    const res = await post(ADVICE);
    expect(res.status).toBe(200);
    expect(recordAudit).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/jarvis/advice marks the page seen in the Javi inbox', () => {
  const seen = () => selectOne('app_state', { where: { key: 'javi.inbox' } })?.value?.pages?.todos ?? null;
  beforeEach(() => {
    remove('app_state', { where: { key: 'javi.inbox' } });
  });

  it('a single-shot success marks the page seen (JSON)', async () => {
    generateAdvice.mockResolvedValue({ content: '- ok', model: 'm1', provider: 'ollama' });
    expect((await post({ page: 'todos', context: 'x' })).status).toBe(200);
    expect(seen()).toEqual({ seenAt: expect.any(String), changedAt: null });
  });

  it('a cache hit marks the page seen (stream)', async () => {
    streamAdvice.mockResolvedValue({ content: 'A', model: 'qwen2.5:3b', provider: 'ollama', cached: true });
    await post({ page: 'todos' }).set('Accept', 'text/event-stream');
    expect(seen()).toEqual({ seenAt: expect.any(String), changedAt: null });
  });

  it('a follow-up, a blocked answer and an error do not', async () => {
    generateAdvice.mockResolvedValue({ content: '- ok', model: 'm1', provider: 'ollama' });
    await post({ page: 'todos', messages: [{ role: 'user', content: 'why?' }] });
    expect(seen()).toBe(null);
    generateAdvice.mockResolvedValue({ content: 'withheld', model: 'm1', provider: 'ollama', blocked: true });
    await post({ page: 'todos' });
    expect(seen()).toBe(null);
    streamAdvice.mockRejectedValue(Object.assign(new Error('x'), { publicMessage: 'Failed', code: 'server_error' }));
    await post({ page: 'todos' }).set('Accept', 'text/event-stream');
    expect(seen()).toBe(null);
  });
});
