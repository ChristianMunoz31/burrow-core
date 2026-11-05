// A cold model load is slow, not broken: a slow first token or a busy Ollama must never be
// reported as "can't reach Ollama". Ollama is faked (fakeOllama); nothing leaves the process.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

vi.mock('../../loadEnv.js', () => ({}));
vi.mock('node-fetch', () => ({ default: vi.fn() }));

import fetch from 'node-fetch';
import { hangingChat, installFakeOllama, textReply } from './helpers/fakeOllama.js';
import { AiUnavailableError, __resetAiForTests, classifyAiError, forgetAiHealth, getAiClient, invalidateAiHealth } from '../ai/index.js';
import { LAST_GOOD_MAX_AGE_MS, describeAi } from '../ai/registry.js';
import { __resetNetPolicyForTests } from '../netPolicy.js';
import { FRIENDLY } from '../ai/llmErrors.js';

const ENV = [
  'BURROW_AI_WARMING_MS',
  'BURROW_AI_FIRST_TOKEN_TIMEOUT_MS',
  'BURROW_AI_PROBE_TIMEOUT_MS',
  'BURROW_AI_WARMUP_PROBE_MS',
  'OLLAMA_HOST',
  'BURROW_NETWORK_OPTIN',
];
const MESSAGES = [{ role: 'user', content: 'hi' }];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const delayed = (ms, reply) => async () => {
  await sleep(ms);
  return reply;
};
const hangUntilAborted = (init) =>
  new Promise((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
  });

/** Ollama where /api/version stays silent (until aborted) for the first `hangFirst` calls. */
function busyVersion(hangFirst) {
  const state = installFakeOllama(fetch);
  const real = fetch.getMockImplementation();
  let hung = 0;
  fetch.mockImplementation(async (url, init = {}) => {
    if (new URL(url).pathname === '/api/version' && hung < hangFirst) {
      hung += 1;
      return hangUntilAborted(init);
    }
    return real(url, init);
  });
  return state;
}

beforeEach(() => {
  __resetAiForTests();
  fetch.mockReset();
  process.env.BURROW_AI_PROBE_TIMEOUT_MS = '40';
  process.env.BURROW_AI_WARMUP_PROBE_MS = '120';
});
afterEach(() => {
  for (const k of ENV) delete process.env[k];
  __resetNetPolicyForTests();
  __resetAiForTests();
  vi.restoreAllMocks();
});

describe('slow first token on a cold model load', () => {
  it('answers normally and tells the caller Javi is warming up, once', async () => {
    process.env.BURROW_AI_WARMING_MS = '20';
    installFakeOllama(fetch, { chat: delayed(150, textReply('Hello there.')) });
    const client = await getAiClient({ purpose: 'chat' });
    const onWarming = vi.fn();
    let text = '';
    for await (const ev of client.stream({ messages: MESSAGES, onWarming })) if (ev.type === 'token') text += ev.text;
    expect(text).toBe('Hello there.');
    expect(onWarming).toHaveBeenCalledTimes(1);
  });

  it('says nothing when the first token is quick', async () => {
    process.env.BURROW_AI_WARMING_MS = '200';
    installFakeOllama(fetch, { chat: () => textReply('Quick.') });
    const client = await getAiClient({ purpose: 'chat' });
    const onWarming = vi.fn();
    await client.complete({ messages: MESSAGES, onWarming });
    await sleep(260);
    expect(onWarming).not.toHaveBeenCalled();
  });

  it('a first token that never comes is first_token_timeout, not ollama_unavailable', async () => {
    process.env.BURROW_AI_FIRST_TOKEN_TIMEOUT_MS = '60';
    installFakeOllama(fetch, { chat: hangingChat });
    const client = await getAiClient({ purpose: 'chat' });
    const err = await client.complete({ messages: MESSAGES }).catch((e) => e);
    expect(err).not.toBeInstanceOf(AiUnavailableError);
    expect(err).toMatchObject({ code: 'timeout', isTimeout: true, timeoutKind: 'first_token' }); // existing contract
    expect(classifyAiError(err)).toMatchObject({
      code: 'first_token_timeout',
      httpStatus: 504,
      message: FRIENDLY.first_token_timeout,
    });
    expect(FRIENDLY.first_token_timeout).toMatch(/wait a minute, then try again/i);
    expect(FRIENDLY.first_token_timeout).not.toMatch(/reach Ollama/i);
  });

  it('a total timeout keeps its own timeout classification', () => {
    const err = Object.assign(new Error('x'), { code: 'timeout', isTimeout: true, timeoutKind: 'total', provider: 'ollama' });
    expect(classifyAiError(err)).toMatchObject({ code: 'timeout', httpStatus: 504 });
  });

  it('a cloud first-token timeout keeps the plain timeout classification', () => {
    const err = Object.assign(new Error('x'), { code: 'timeout', isTimeout: true, timeoutKind: 'first_token', provider: 'openai_compat' });
    expect(classifyAiError(err)).toMatchObject({ code: 'timeout', httpStatus: 504 });
  });
});

describe('a busy Ollama is not an unreachable Ollama', () => {
  it('with nothing known yet, a probe that stays silent is ai_warming_up (503), never ollama_unavailable', async () => {
    busyVersion(99);
    const err = await getAiClient({ purpose: 'chat' }).catch((e) => e);
    expect(err).toBeInstanceOf(AiUnavailableError);
    expect(err).toMatchObject({ code: 'ai_warming_up', reason: 'ai_warming_up', httpStatus: 503 });
    expect(err.publicMessage).toMatch(/warming up/i);
    expect(err.publicMessage).not.toMatch(/can't reach/i);
  });

  it('waits once for a patient probe and then works', async () => {
    busyVersion(1);
    const client = await getAiClient({ purpose: 'chat' });
    expect(client.provider).toBe('ollama');
  });

  it('after one good probe, a probe that times out keeps using what it knew', async () => {
    installFakeOllama(fetch);
    await getAiClient({ purpose: 'chat' });
    const real = fetch.getMockImplementation();
    let silentProbes = 0;
    fetch.mockImplementation(async (url, init = {}) => {
      if (new URL(url).pathname === '/api/version') {
        silentProbes += 1;
        return hangUntilAborted(init);
      }
      return real(url, init);
    });
    invalidateAiHealth(); // the cached good probe expires; the next one times out
    const client = await getAiClient({ purpose: 'chat' });
    expect(silentProbes).toBe(1);
    expect(client.model).toBe('qwen2.5:3b');
  });

  it('a refused connection is still ollama_unavailable', async () => {
    installFakeOllama(fetch, { down: true });
    const err = await getAiClient({ purpose: 'chat' }).catch((e) => e);
    expect(err).toMatchObject({ code: 'ollama_unavailable', reason: 'ollama_unavailable' });
  });

  it('status checks never block on the patient wait', async () => {
    busyVersion(99);
    const started = Date.now();
    const d = await describeAi('chat');
    expect(Date.now() - started).toBeLessThan(110);
    expect(d).toMatchObject({ available: false, code: 'ai_warming_up', reason: 'ai_warming_up' });
  });
});

describe('a good probe is only remembered for a while', () => {
  const silentVersion = () => {
    const real = fetch.getMockImplementation();
    fetch.mockImplementation(async (url, init = {}) => (new URL(url).pathname === '/api/version' ? hangUntilAborted(init) : real(url, init)));
  };

  it('after the limit, a silent Ollama is no longer reported as running', async () => {
    installFakeOllama(fetch);
    await getAiClient({ purpose: 'chat' });
    silentVersion();
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + LAST_GOOD_MAX_AGE_MS + 1000);
    const err = await getAiClient({ purpose: 'chat' }).catch((e) => e);
    expect(err).toMatchObject({ code: 'ai_warming_up' });
  });

  it('within the limit it still is', async () => {
    installFakeOllama(fetch);
    await getAiClient({ purpose: 'chat' });
    silentVersion();
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + LAST_GOOD_MAX_AGE_MS - 1000);
    expect((await getAiClient({ purpose: 'chat' })).provider).toBe('ollama');
  });

  it('a first-token timeout on the local model drops what was remembered', async () => {
    process.env.BURROW_AI_FIRST_TOKEN_TIMEOUT_MS = '60';
    installFakeOllama(fetch, { chat: hangingChat });
    const client = await getAiClient({ purpose: 'chat' });
    await client.complete({ messages: MESSAGES }).catch(() => {});
    silentVersion();
    const err = await getAiClient({ purpose: 'chat' }).catch((e) => e);
    expect(err).toMatchObject({ code: 'ai_warming_up' });
  });

  it('changing the host setting forgets every remembered probe', async () => {
    installFakeOllama(fetch);
    await getAiClient({ purpose: 'chat' });
    silentVersion();
    forgetAiHealth();
    const err = await getAiClient({ purpose: 'chat' }).catch((e) => e);
    expect(err).toMatchObject({ code: 'ai_warming_up' });
  });

  it('a connection error on a call drops what was remembered', async () => {
    installFakeOllama(fetch, { chat: () => Promise.reject(Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })) });
    const client = await getAiClient({ purpose: 'chat' });
    await client.complete({ messages: MESSAGES }).catch(() => {});
    silentVersion();
    const err = await getAiClient({ purpose: 'chat' }).catch((e) => e);
    expect(err).toMatchObject({ code: 'ai_warming_up' });
  });
});

describe('a host on another machine that does not answer', () => {
  it('stays ollama_unavailable: no warming up, no waiting for the patient probe', async () => {
    process.env.OLLAMA_HOST = 'http://192.0.2.50:11434';
    process.env.BURROW_NETWORK_OPTIN = 'aiLan';
    __resetNetPolicyForTests();
    busyVersion(99);
    const started = Date.now();
    const err = await getAiClient({ purpose: 'chat' }).catch((e) => e);
    expect(err).toMatchObject({ code: 'ollama_unavailable', reason: 'ollama_unavailable' });
    expect(Date.now() - started).toBeLessThan(110);
  });

  it('does not borrow the last good answer for a timeout', async () => {
    process.env.OLLAMA_HOST = 'http://192.0.2.50:11434';
    process.env.BURROW_NETWORK_OPTIN = 'aiLan';
    __resetNetPolicyForTests();
    installFakeOllama(fetch);
    await getAiClient({ purpose: 'chat' });
    const real = fetch.getMockImplementation();
    fetch.mockImplementation(async (url, init = {}) => (new URL(url).pathname === '/api/version' ? hangUntilAborted(init) : real(url, init)));
    invalidateAiHealth();
    const err = await getAiClient({ purpose: 'chat' }).catch((e) => e);
    expect(err).toMatchObject({ code: 'ollama_unavailable' });
  });
});

describe('the patient probe is bounded, shared and cancellable', () => {
  const versionCalls = () => fetch.mock.calls.filter(([u]) => new URL(u).pathname === '/api/version').length;

  it('stops at one overall deadline when Ollama stays silent', async () => {
    busyVersion(99);
    const started = Date.now();
    await getAiClient({ purpose: 'chat' }).catch(() => {});
    expect(Date.now() - started).toBeLessThan(400); // quick 40 ms + one 120 ms deadline, never a sum per call
  });

  it('concurrent requests share one quick probe and one patient probe', async () => {
    busyVersion(1);
    const results = await Promise.all([getAiClient({ purpose: 'chat' }), getAiClient({ purpose: 'chat' }), getAiClient({ purpose: 'chat' })]);
    expect(results.map((c) => c.provider)).toEqual(['ollama', 'ollama', 'ollama']);
    expect(versionCalls()).toBe(2); // one quick probe (hung) and one patient probe, however many requests wait
  });

  it('stops waiting when the request closes, without cancelling the probe for others', async () => {
    busyVersion(99);
    const ctl = new AbortController();
    const waiting = getAiClient({ purpose: 'chat', signal: ctl.signal }).catch((e) => e);
    setTimeout(() => ctl.abort(), 70);
    const started = Date.now();
    const err = await waiting;
    expect(err).toMatchObject({ name: 'AbortError' });
    expect(Date.now() - started).toBeLessThan(100);
  });

  it('an already closed request does not probe at all', async () => {
    installFakeOllama(fetch);
    const err = await getAiClient({ purpose: 'chat', signal: AbortSignal.abort() }).catch((e) => e);
    expect(err).toMatchObject({ name: 'AbortError' });
  });
});

describe('POST /api/jarvis/advice while the model warms up', () => {
  let app;
  beforeAll(async () => {
    delete process.env.APP_PASSWORD;
    delete process.env.AUTH_SECRET;
    app = (await import('../../server.js')).default;
  });

  const ADVICE = { page: 'todos', context: '{}', messages: [{ role: 'user', content: 'hi' }] };

  it('streams one status event before the first delta, then the answer', async () => {
    process.env.BURROW_AI_WARMING_MS = '20';
    installFakeOllama(fetch, { chat: delayed(150, textReply('All set.')) });
    const res = await request(app)
      .post('/api/jarvis/advice')
      .set('Accept', 'text/event-stream')
      .set('X-Forwarded-For', '192.0.2.210')
      .send(ADVICE);
    const statuses = [...res.text.matchAll(/event: status\ndata: (.*)\n/g)].map((m) => JSON.parse(m[1]));
    expect(statuses).toEqual([
      { code: 'warming_up', message: 'Javi is thinking. On this computer the first answer can take a minute.' },
    ]);
    expect(res.text.indexOf('event: status')).toBeLessThan(res.text.indexOf('event: delta'));
    expect(JSON.parse(/event: done\ndata: (.*)\n/.exec(res.text)[1]).content).toBe('All set.');
  });

  it('a first token that never comes ends in a first_token_timeout error with what to do', async () => {
    process.env.BURROW_AI_FIRST_TOKEN_TIMEOUT_MS = '60';
    installFakeOllama(fetch, { chat: hangingChat });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await request(app)
      .post('/api/jarvis/advice')
      .set('Accept', 'text/event-stream')
      .set('X-Forwarded-For', '192.0.2.211')
      .send(ADVICE);
    const err = JSON.parse(/event: error\ndata: (.*)\n/.exec(res.text)[1]);
    expect(err.code).toBe('first_token_timeout');
    expect(err.error).toMatch(/wait a minute, then try again/i);
    vi.restoreAllMocks();
  });
});
