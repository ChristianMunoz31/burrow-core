// Javi page advisor service on the local chat model: one call, no fallback, user-safe error
// mapping, output sanitizing, context clipping, and token streaming. A fake AiClient is passed
// in, so nothing here touches Ollama.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../profile.js', () => ({ getDisplayName: vi.fn(async () => 'Sam') }));

import {
  ADVICE_MAX_TOKENS,
  ADVICE_TEMPERATURE,
  CLOUD_ADVICE_MAX_TOKENS,
  CLOUD_ADVICE_TEMPERATURE,
  MSG_CUT_SHORT,
  MSG_UNGROUNDED,
  generateAdvice,
  streamAdvice,
} from '../javi/advisorService.js';
import { clearAdviceCache } from '../javi/adviceCache.js';
import { bumpDataGeneration, runDataResetHooks } from '../dataGeneration.js';
import { AiBusyError, AiUnavailableError } from '../ai/gate.js';
import { createAiPolicy } from '../ai/index.js';

const input = {
  page: 'budget',
  pageLabel: 'Budget',
  context: '{"today":"2026-06-01","spend":1234.5}',
  messages: [{ role: 'user', content: 'How am I doing?' }],
};

function fakeClient({ content = 'Looks fine.', tokens, error, numCtx = 8192, finishReason = 'stop', ai, isCloud } = {}) {
  const client = {
    provider: 'ollama',
    model: 'qwen2.5:3b',
    purpose: 'chat',
    numCtx,
    stats: { calls: 0 },
    ...(ai ? { ai } : {}),
    ...(isCloud ? { isCloud, policy: createAiPolicy({ isCloud: true, categories: ['budget'] }), noteWithheld: vi.fn() } : {}),
    complete: vi.fn(async () => {
      client.stats.calls += 1;
      if (error) throw error;
      return { content, usage: null, model: 'qwen2.5:3b', finishReason };
    }),
    stream: vi.fn(async function* stream() {
      client.stats.calls += 1;
      for (const t of tokens || [content]) yield { type: 'token', text: t };
      if (error) throw error;
      yield { type: 'done', usage: null, finishReason };
    }),
  };
  return client;
}

let errors;
beforeEach(() => {
  errors = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.BURROW_AI;
});

describe('generateAdvice', () => {
  it('makes one call with the advisor messages, 450 tokens and the advice temperature', async () => {
    const client = fakeClient();
    const out = await generateAdvice(input, { client });
    expect(out).toMatchObject({ content: 'Looks fine.', model: 'qwen2.5:3b', provider: 'ollama', calls: 1, ai: { kind: 'local', host: null }, withheld: [], notice: null, blocked: false });
    expect(client.complete).toHaveBeenCalledTimes(1);
    const args = client.complete.mock.calls[0][0];
    expect(args.maxTokens).toBe(ADVICE_MAX_TOKENS);
    expect(args.temperature).toBe(ADVICE_TEMPERATURE);
    expect(args.messages[0].role).toBe('system');
    expect(args.messages[0].content).toContain("The user's name is Sam.");
    expect(args.messages[1].content).toContain('"spend":1234.5');
    expect(args.messages[1].content).toContain('How am I doing?');
    expect(args).not.toHaveProperty('tools');
  });

  it('resolves the chat client itself when none is passed (AI off -> AiUnavailableError)', async () => {
    process.env.BURROW_AI = '0';
    const err = await generateAdvice(input).catch((e) => e);
    expect(err).toBeInstanceOf(AiUnavailableError);
    expect(err.code).toBe('ai_not_configured');
  });

  it('clips the page context to the model budget before fencing it', async () => {
    const client = fakeClient({ numCtx: 2048 });
    await generateAdvice({ ...input, context: 'x'.repeat(50_000) }, { client });
    const user = client.complete.mock.calls[0][0].messages[1].content;
    expect(user.length).toBeLessThan(5000);
  });

  it('strips dashes and normalizes dollar amounts in the reply', async () => {
    const out = await generateAdvice(input, { client: fakeClient({ content: '- Dining — $1234.5 this month\n- Rent: $-50' }) });
    expect(out.content).toBe('- Dining, $1,234.50 this month\n- Rent: -$50');
  });

  it.each([
    ['empty content', '', 502, 'empty_response'],
    ['dash-only content', '—', 502, 'empty_response'],
  ])('%s -> %s', async (_label, content, status, code) => {
    const err = await generateAdvice(input, { client: fakeClient({ content }) }).catch((e) => e);
    expect(err).toMatchObject({ httpStatus: status, code });
    expect(typeof err.publicMessage).toBe('string');
  });

  it('maps a timeout to 504 timeout', async () => {
    const error = Object.assign(new Error('x'), { code: 'timeout', isTimeout: true });
    const err = await generateAdvice(input, { client: fakeClient({ error }) }).catch((e) => e);
    expect(err).toMatchObject({ httpStatus: 504, code: 'timeout', publicMessage: 'Javi took too long to answer. Try again.' });
  });

  it('maps a cloud 429 to provider_rate_limited with a clamped retry hint', async () => {
    const error = Object.assign(new Error('429'), { httpStatus: 429, retryAfterMs: 999_999 });
    const err = await generateAdvice(input, { client: fakeClient({ error }) }).catch((e) => e);
    expect(err).toMatchObject({ httpStatus: 429, code: 'provider_rate_limited', retryAfterMs: 60000 });
  });

  it('passes availability and busy errors through unchanged', async () => {
    const down = new AiUnavailableError('ollama_unavailable', 'down');
    expect(await generateAdvice(input, { client: fakeClient({ error: down }) }).catch((e) => e)).toBe(down);
    const busy = new AiBusyError();
    expect(await generateAdvice(input, { client: fakeClient({ error: busy }) }).catch((e) => e)).toBe(busy);
  });

  it('never logs or exposes provider text, context or messages', async () => {
    const error = Object.assign(new Error('UPSTREAM gsk_LEAKYLEAKYLEAKYLEAKY1234'), { httpStatus: 500, body: 'SECRET-BODY' });
    const err = await generateAdvice({ ...input, context: 'CONTEXT-SENTINEL' }, { client: fakeClient({ error }) }).catch((e) => e);
    expect(err).toMatchObject({ httpStatus: 502, code: 'upstream_error' });
    const logged = JSON.stringify(errors.mock.calls);
    for (const s of ['LEAKY', 'SECRET-BODY', 'CONTEXT-SENTINEL', 'How am I doing']) {
      expect(logged).not.toContain(s);
      expect(err.publicMessage).not.toContain(s);
    }
  });

  it('logs nothing on success', async () => {
    await generateAdvice(input, { client: fakeClient() });
    expect(errors).not.toHaveBeenCalled();
  });
});

describe('streamAdvice', () => {
  it('streams sanitized deltas whose concatenation equals the final content', async () => {
    const tokens = ['Dining', ' is ', '$1234', '.5 —', ' trim', ' it.'];
    const deltas = [];
    const out = await streamAdvice(input, { client: fakeClient({ tokens }), onDelta: (t) => deltas.push(t) });
    expect(out.content).toBe('Dining is $1,234.50, trim it.');
    expect(deltas.join('').trim()).toBe(out.content);
    expect(out).toMatchObject({ model: 'qwen2.5:3b', provider: 'ollama' });
  });

  it('maps a mid-stream failure like generateAdvice', async () => {
    const error = Object.assign(new Error('x'), { code: 'timeout', isTimeout: true });
    const err = await streamAdvice(input, { client: fakeClient({ tokens: ['partial'], error }) }).catch((e) => e);
    expect(err).toMatchObject({ httpStatus: 504, code: 'timeout' });
  });

  it('an empty stream is empty_response', async () => {
    const err = await streamAdvice(input, { client: fakeClient({ tokens: ['  '] }) }).catch((e) => e);
    expect(err).toMatchObject({ httpStatus: 502, code: 'empty_response' });
  });
});

describe('number grounding', () => {
  it('adds the fixed note (never the figure) when the answer quotes a number that is not in the context', async () => {
    const out = await generateAdvice(input, { client: fakeClient({ content: '- Spend is $9.10 a day.' }) });
    expect(out.notice).toBe(MSG_UNGROUNDED);
    expect(out.notice).not.toContain('9.10');
    expect(out.content).toBe('- Spend is $9.10 a day.');
  });

  it('adds no note when every figure is in the context or the sent turns', async () => {
    const out = await generateAdvice(input, { client: fakeClient({ content: '- Spend is $1,234.50 and 2026 is the year.' }) });
    expect(out.notice).toBeNull();
    expect(out.groundingNote).toBeNull();
  });
});

describe('insight card cache', () => {
  const single = { ...input, messages: [] };
  const run = (extra, client = fakeClient({ content: '- Cached $1,234.50' })) =>
    streamAdvice(single, { client, cache: true, ...extra }).then((out) => ({ out, client }));

  beforeEach(() => clearAdviceCache());

  it('replays a stored single-shot answer with no model call, and stays per context', async () => {
    const first = await run({});
    expect(first.out.cached).toBe(false);
    const deltas = [];
    const second = await run({ onDelta: (t) => deltas.push(t) });
    expect(second.client.stream).not.toHaveBeenCalled();
    expect(second.out).toMatchObject({ content: '- Cached $1,234.50', cached: true, calls: 0 });
    expect(deltas).toEqual(['- Cached $1,234.50']);
    const other = await streamAdvice({ ...single, context: '{"spend":1}' }, { client: fakeClient(), cache: true });
    expect(other.cached).toBe(false);
  });

  it('ignores the minute-by-minute clock in the key', async () => {
    await streamAdvice({ ...single, context: '{"page":"budget","data":{"a":1},"localTime":"10:01"}' }, { client: fakeClient(), cache: true });
    const again = await streamAdvice({ ...single, context: '{"page":"budget","data":{"a":1},"localTime":"10:02"}' }, { client: fakeClient(), cache: true });
    expect(again.cached).toBe(true);
  });

  it('fresh skips the lookup but stores the new answer; follow-ups and cloud are never cached', async () => {
    await run({});
    const fresh = await run({ fresh: true });
    expect(fresh.client.stream).toHaveBeenCalledTimes(1);
    const followUp = await streamAdvice(input, { client: fakeClient(), cache: true });
    expect(followUp.cached).toBe(false);
    const cloud = { ...fakeClient(), isCloud: true };
    await streamAdvice({ ...single, page: 'goals' }, { client: cloud, cache: true });
    const again = await streamAdvice({ ...single, page: 'goals' }, { client: cloud, cache: true });
    expect(again.cached).toBe(false);
  });

  it('is cleared by a data reset and not served after the generation changes', async () => {
    await run({});
    runDataResetHooks();
    expect((await run({})).out.cached).toBe(false);
    bumpDataGeneration();
    expect((await run({})).out.cached).toBe(false);
  });
});

describe('call parameters and cut-short notice', () => {
  const single = { ...input, messages: [] };
  const cloud = () => fakeClient({ ai: { kind: 'cloud', host: 'api.example.com' }, isCloud: true });

  it('cloud keeps 1200 tokens and temperature 0.4 for advice (stream and complete); local and LAN use the tuned caps', async () => {
    expect([CLOUD_ADVICE_MAX_TOKENS, CLOUD_ADVICE_TEMPERATURE]).toEqual([1200, 0.4]);
    const c = cloud();
    await streamAdvice(single, { client: c, scope: { categories: [] } });
    expect(c.stream.mock.calls[0][0]).toMatchObject({ maxTokens: 1200, temperature: 0.4 });
    const c2 = cloud();
    await generateAdvice(input, { client: c2, scope: { categories: [] } });
    expect(c2.complete.mock.calls[0][0]).toMatchObject({ maxTokens: 1200, temperature: 0.4 });
    for (const kind of ['local', 'lan']) {
      const l = fakeClient({ ai: { kind, host: kind === 'lan' ? '192.168.1.5' : null } });
      await streamAdvice(single, { client: l });
      expect(l.stream.mock.calls[0][0]).toMatchObject({ maxTokens: ADVICE_MAX_TOKENS, temperature: ADVICE_TEMPERATURE });
    }
  });

  it('an unknown provider kind is treated like cloud (fail closed to the old caps)', async () => {
    const c = fakeClient({ ai: { kind: 'mystery', host: null } });
    await streamAdvice(single, { client: c });
    expect(c.stream.mock.calls[0][0]).toMatchObject({ maxTokens: 1200, temperature: 0.4 });
  });

  it('appends the fixed cut-short line when a local answer hit the token cap, and never for cloud', async () => {
    const local = await streamAdvice(single, { client: fakeClient({ finishReason: 'length', content: 'Half a thou' }) });
    expect(local.notice).toBe(MSG_CUT_SHORT);
    expect(local.cutShort).toBe(true);
    expect(local.content).toBe('Half a thou');
    const viaComplete = await generateAdvice(input, { client: fakeClient({ finishReason: 'length' }) });
    expect(viaComplete.notice).toBe(MSG_CUT_SHORT);
    const cl = await streamAdvice(single, { client: { ...cloud(), stream: fakeClient({ finishReason: 'length' }).stream }, scope: { categories: [] } });
    expect(cl.notice).toBeNull();
    expect(cl.cutShort).toBe(false);
  });
});

describe('clock line and grounding facts', () => {
  const ctx = (t) => `{"page":"budget","today":"2026-06-01","data":{"net":120},"localTime":"${t}"}`;

  it('lifts the trailing clock out of the fenced snapshot into a line after the fence', async () => {
    const c = fakeClient();
    const out = await generateAdvice({ ...input, context: ctx('10:07') }, { client: c });
    const user = c.complete.mock.calls[0][0].messages[1].content;
    expect(user).not.toContain('"localTime"');
    expect(user).toMatch(/\n<\/page_context_[0-9a-f]{12}>\nLocal time: 10:07\.\n\n/);
    expect(out.sentContext).not.toContain('localTime');
  });

  it('keeps the clock when a long snapshot is clipped to the budget', async () => {
    const c = fakeClient({ numCtx: 2048 });
    await generateAdvice({ ...input, context: `{"page":"budget","data":{"t":"${'x'.repeat(50_000)}"},"localTime":"10:07"}` }, { client: c });
    expect(c.complete.mock.calls[0][0].messages[1].content).toContain('Local time: 10:07.');
  });

  it('gives the same fence tag for the same snapshot across minutes, so the prefix is reusable', async () => {
    const a = fakeClient();
    const b = fakeClient();
    await generateAdvice({ ...input, context: ctx('10:07') }, { client: a });
    await generateAdvice({ ...input, context: ctx('10:08') }, { client: b });
    const head = (c) => {
      const u = c.complete.mock.calls[0][0].messages[1].content;
      return u.slice(0, u.indexOf('Local time:'));
    };
    expect(head(a)).toBe(head(b));
  });

  it('counts only the user turns as facts: a figure from an earlier assistant turn is flagged, one from a user turn is not', async () => {
    const history = [
      { role: 'user', content: 'I owe $77.00 maybe?' },
      { role: 'assistant', content: 'Earlier I said $55.55 is due.' },
      { role: 'user', content: 'ok and now?' },
    ];
    const flagged = await generateAdvice({ ...input, messages: history }, { client: fakeClient({ content: '- Pay $55.55 soon.' }) });
    expect(flagged.notice).toBe(MSG_UNGROUNDED);
    const ok = await generateAdvice({ ...input, messages: history }, { client: fakeClient({ content: '- You said $77.00.' }) });
    expect(ok.notice).toBeNull();
  });
});

describe('insight card cache: who may use it', () => {
  const single = { ...input, messages: [] };
  const local = (extra = {}) => fakeClient({ ai: { kind: 'local', host: null }, ...extra });
  const lan = (host) => fakeClient({ ai: { kind: 'lan', host } });
  const cloud = () => fakeClient({ ai: { kind: 'cloud', host: 'api.example.com' }, isCloud: true });

  beforeEach(() => clearAdviceCache());

  it('a local answer is never served to a cloud client: the model is called and the result is not stored', async () => {
    await streamAdvice(single, { client: local(), cache: true });
    const c = cloud();
    const out = await streamAdvice(single, { client: c, cache: true });
    expect(c.stream).toHaveBeenCalledTimes(1);
    expect(out.cached).toBe(false);
    const c2 = cloud();
    expect((await streamAdvice(single, { client: c2, cache: true })).cached).toBe(false);
    expect(c2.stream).toHaveBeenCalledTimes(1);
  });

  it('LAN host A and host B do not share entries; the same host does', async () => {
    await streamAdvice(single, { client: lan('10.0.0.5'), cache: true });
    const b = lan('10.0.0.6');
    expect((await streamAdvice(single, { client: b, cache: true })).cached).toBe(false);
    expect(b.stream).toHaveBeenCalledTimes(1);
    const a2 = lan('10.0.0.5');
    expect((await streamAdvice(single, { client: a2, cache: true })).cached).toBe(true);
    expect(a2.stream).not.toHaveBeenCalled();
  });

  it('an unknown provider kind is never cached', async () => {
    const odd = () => fakeClient({ ai: { kind: 'mystery', host: null } });
    await streamAdvice(single, { client: odd(), cache: true });
    expect((await streamAdvice(single, { client: odd(), cache: true })).cached).toBe(false);
  });

  it('does not store an answer whose grounding notice or cut-short notice fired', async () => {
    const ungrounded = () => local({ content: '- Spend is $9.10 a day.' });
    await streamAdvice(single, { client: ungrounded(), cache: true });
    expect((await streamAdvice(single, { client: ungrounded(), cache: true })).cached).toBe(false);
    const cut = () => local({ content: '- Half', finishReason: 'length' });
    await streamAdvice(single, { client: cut(), cache: true });
    const again = cut();
    expect((await streamAdvice(single, { client: again, cache: true })).cached).toBe(false);
    expect(again.stream).toHaveBeenCalledTimes(1);
  });
});
