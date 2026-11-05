// POST /api/jarvis/advice with the REAL advisor service and cache, through the real server.js, a fake
// Ollama behind node-fetch and the insight card cache,
// audit rows, ?fresh=1, and a closed request. No real Ollama.
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

vi.mock('../../loadEnv.js', () => ({}));
vi.mock('node-fetch', () => ({ default: vi.fn() }));
vi.mock('../auditHook.js', () => ({ recordAudit: vi.fn(async () => {}), setAuditSink: vi.fn() }));

import fetch from 'node-fetch';
import { installFakeOllama, textReply } from './helpers/fakeOllama.js';
import { __resetAiForTests } from '../ai/index.js';
import { recordAudit } from '../auditHook.js';
import { clearAdviceCache } from '../javi/adviceCache.js';
import { __resetDataGenerationForTests } from '../dataGeneration.js';

const URL_PATH = '/api/jarvis/advice';
const CONTEXT = '{"page":"todos","today":"2026-10-09","data":{"open":3},"localTime":"10:00"}';
const SSE = { Accept: 'text/event-stream' };

let app;
let ip = 0;
const nextIp = () => `198.51.100.${(ip += 1) % 250}`;
const saved = Object.fromEntries(['APP_PASSWORD', 'AUTH_SECRET', 'SECRETS_ENCRYPTION_KEY', 'BURROW_AI'].map((k) => [k, process.env[k]]));

beforeAll(async () => {
  for (const k of Object.keys(saved)) delete process.env[k];
  app = (await import('../../server.js')).default;
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

let fake;
const useReplies = (...replies) => {
  fetch.mockReset();
  fake = installFakeOllama(fetch, { replies: replies.length ? replies : [textReply('- Three todos are open.')] });
};

beforeEach(() => {
  delete process.env.BURROW_AI;
  __resetAiForTests();
  __resetDataGenerationForTests();
  clearAdviceCache();
  recordAudit.mockClear();
  useReplies();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

const post = (body, { path = URL_PATH, headers = SSE } = {}) => request(app).post(path).set('X-Forwarded-For', nextIp()).set(headers).send(body);
const single = (extra = {}) => ({ page: 'todos', context: CONTEXT, ...extra });
const followUp = () => single({ messages: [{ role: 'user', content: 'why?' }] });

/** Parse an SSE body into [{ event, data }]. */
const events = (res) =>
  String(res.text)
    .split('\n\n')
    .filter((b) => b.startsWith('event:'))
    .map((b) => {
      const [e, d] = b.split('\n');
      return { event: e.slice(7), data: JSON.parse(d.slice(6)) };
    });
const done = (res) => events(res).find((e) => e.event === 'done')?.data;
const advice = () => fake.chatBodies.length; // model calls so far

describe('Free single-shot and the insight card cache', () => {
  it('the second identical request is served from the cache: same content, one delta, no model call, no new audit row', async () => {
    const first = await post(single());
    expect(first.status).toBe(200);
    expect(done(first).content).toBe('- Three todos are open.');
    expect(advice()).toBe(1);
    expect(recordAudit).toHaveBeenCalledTimes(1);

    const second = await post(single());
    expect(second.status).toBe(200);
    expect(done(second)).toMatchObject({ content: '- Three todos are open.', blocked: false });
    expect(events(second).filter((e) => e.event === 'delta')).toEqual([{ event: 'delta', data: { content: '- Three todos are open.' } }]);
    expect(advice()).toBe(1);
    expect(recordAudit).toHaveBeenCalledTimes(1);
  });

  it('a different page or different data is a miss', async () => {
    await post(single());
    await post(single({ page: 'habits' }));
    await post(single({ context: CONTEXT.replace('"open":3', '"open":4') }));
    expect(advice()).toBe(3);
  });

  it('only the minute changing is still a hit; crossing the hour is a miss', async () => {
    await post(single());
    await post(single({ context: CONTEXT.replace('10:00', '10:07') }));
    expect(advice()).toBe(1);
    await post(single({ context: CONTEXT.replace('10:00', '11:00') }));
    expect(advice()).toBe(2);
  });

  it('?fresh=1 on Free single-shot skips the read, calls the model, and stores the new answer', async () => {
    await post(single());
    useReplies(textReply('- Fresh take.'));
    const fresh = await post(single(), { path: `${URL_PATH}?fresh=1` });
    expect(fresh.status).toBe(200);
    expect(done(fresh).content).toBe('- Fresh take.');
    expect(advice()).toBe(1); // only the fresh call, on the new fake
    expect(recordAudit).toHaveBeenCalledTimes(2);

    useReplies(textReply('- Should not be asked.'));
    const hit = await post(single());
    expect(done(hit).content).toBe('- Fresh take.');
    expect(advice()).toBe(0);
  });

  it('a plain JSON (non-SSE) request neither reads nor writes the cache', async () => {
    await post(single(), { headers: {} });
    expect(advice()).toBe(1);
    const sse = await post(single());
    expect(done(sse).content).toBe('- Three todos are open.');
    expect(advice()).toBe(2);
  });

  it('an answer with an unverified figure is not replayed: the next request asks the model again', async () => {
    useReplies(textReply('- You have 4,242 open.'));
    const first = await post(single());
    expect(done(first).notice).toMatch(/figure that is not in your data/);
    expect(done(first).notice).not.toMatch(/4,242/);
    await post(single());
    expect(advice()).toBe(2);
  });
});

describe('a request with messages (no tier gate)', () => {
  it('a follow-up is never 403, even when a single-shot answer for that page is cached: it runs the model', async () => {
    await post(single());
    expect(advice()).toBe(1);
    const sse = await post(followUp());
    expect(sse.status).toBe(200);
    const json = await post(followUp(), { headers: {} });
    expect(json.status).not.toBe(403);
    expect(advice()).toBe(3);
  });

  it('?fresh=1 does not change that: a follow-up is answered', async () => {
    const res = await post(followUp(), { path: `${URL_PATH}?fresh=1` });
    expect(res.status).toBe(200);
    expect(advice()).toBe(1);
  });

  it.each([
    ['a thread key in the body', { threadId: 'abc' }],
    ['a history key in the body', { history: [{ role: 'user', content: 'hi' }] }],
  ])('%s is never 403', async (_label, extra) => {
    await post(single());
    const res = await post(single(extra));
    expect(res.status).not.toBe(403);
    expect(res.body?.error).not.toBe('pro_required');
  });

  it('messages never hit the cache, runs the model and writes nothing for the card', async () => {
    await post(single());
    expect(advice()).toBe(1);
    const follow = await post(followUp());
    expect(follow.status).toBe(200);
    expect(done(follow).content).toBe('- Three todos are open.');
    expect(advice()).toBe(2);
    expect(recordAudit).toHaveBeenCalledTimes(2);

    clearAdviceCache();
    useReplies();
    await post(followUp());
    expect(advice()).toBe(1);
    await post(single());
    expect(advice()).toBe(2); // the follow-up stored no card for the single-shot request
  });

  it('an empty messages array is still single-shot (cacheable)', async () => {
    const a = await post(single({ messages: [] }));
    expect(a.status).toBe(200);
    await post(single({ messages: [] }));
    expect(advice()).toBe(1);
  });
});

describe('a closed request', () => {
  it('aborts the model call and leaves nothing in the cache', async () => {
    let seenSignal;
    let started;
    const reachedModel = new Promise((r) => (started = r));
    fetch.mockReset();
    fake = installFakeOllama(fetch, {
      chat: (_body, init) =>
        new Promise((_resolve, reject) => {
          seenSignal = init.signal;
          started();
          init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
        }),
    });
    const req = request(app).post(URL_PATH).set('X-Forwarded-For', nextIp()).set(SSE).send(single());
    req.end(() => {});
    await reachedModel;
    req.abort();
    await vi.waitFor(() => expect(seenSignal?.aborted).toBe(true), { timeout: 5000 });

    // The aborted run must not have stored anything: the next request calls the model again.
    useReplies(textReply('- After the abort.'));
    const next = await post(single());
    expect(done(next).content).toBe('- After the abort.');
    expect(advice()).toBe(1);
    const hit = await post(single());
    expect(done(hit).content).toBe('- After the abort.');
    expect(advice()).toBe(1);
  });
});
