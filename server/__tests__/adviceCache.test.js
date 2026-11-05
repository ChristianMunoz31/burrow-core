// The insight card cache (server/javi/adviceCache.js): LRU, TTL (injected clock), key parts, data
// resets and generations, and which requests may read or write it through streamAdvice.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const displayName = vi.hoisted(() => ({ value: 'Sam' }));
vi.mock('../profile.js', () => ({ getDisplayName: vi.fn(async () => displayName.value) }));

import {
  ADVICE_CACHE_MAX,
  ADVICE_CACHE_TTL_MS,
  adviceCacheKey,
  clearAdviceCache,
  getCachedAdvice,
  putCachedAdvice,
} from '../javi/adviceCache.js';
import { streamAdvice } from '../javi/advisorService.js';
import { PROMPT_VERSION } from '../javi/advisorPrompt.js';
import { bumpDataGeneration, currentDataGeneration, runDataResetHooks } from '../dataGeneration.js';
import { createAiPolicy } from '../ai/index.js';

const value = (content) => ({ content, groundingNote: null });
const parts = {
  model: 'qwen2.5:3b',
  kind: 'local',
  host: '',
  page: 'budget',
  context: '{"spend":1}',
  promptVersion: 'advice-v3',
  displayName: 'Sam',
  hourBucket: '10',
};

beforeEach(() => {
  clearAdviceCache();
  displayName.value = 'Sam';
});

describe('constants', () => {
  it('keeps the documented bounds', () => {
    expect(ADVICE_CACHE_MAX).toBe(50);
    expect(ADVICE_CACHE_TTL_MS).toBe(10 * 60 * 1000);
  });
});

describe('adviceCacheKey', () => {
  const base = adviceCacheKey(parts);

  it('is a stable sha256 hex digest', () => {
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(adviceCacheKey({ ...parts })).toBe(base);
  });

  it.each([
    ['model', 'llama3.2:1b'],
    ['kind', 'lan'],
    ['host', '10.0.0.5'],
    ['page', 'goals'],
    ['context', '{"spend":2}'],
    ['promptVersion', 'advice-v4'],
    ['displayName', 'Alex'],
    ['character', 'valet'],
    ['hourBucket', '11'],
  ])('changes when %s changes', (field, other) => {
    expect(adviceCacheKey({ ...parts, [field]: other })).not.toBe(base);
  });

  it('treats a missing host or name like an empty one, and a missing hour like null', () => {
    const rest = { ...parts };
    delete rest.host;
    delete rest.displayName;
    delete rest.hourBucket;
    expect(adviceCacheKey(rest)).toBe(adviceCacheKey({ ...parts, host: '', displayName: '', hourBucket: null }));
    expect(adviceCacheKey({ ...parts, host: null, displayName: null, hourBucket: undefined })).toBe(adviceCacheKey(rest));
  });

  it('cannot be forged by moving text between neighbouring fields', () => {
    expect(adviceCacheKey({ ...parts, page: 'bud', context: 'get{"spend":1}' })).not.toBe(adviceCacheKey({ ...parts, page: 'budget', context: '{"spend":1}' }));
    expect(adviceCacheKey({ ...parts, model: 'a', kind: 'bc' })).not.toBe(adviceCacheKey({ ...parts, model: 'ab', kind: 'c' }));
  });

  it('the live PROMPT_VERSION is a non-empty string (it is part of the key)', () => {
    expect(typeof PROMPT_VERSION).toBe('string');
    expect(PROMPT_VERSION.length).toBeGreaterThan(0);
  });
});

describe('get / put', () => {
  it('returns null for an unknown key and the stored value for a known one', () => {
    expect(getCachedAdvice('nope')).toBeNull();
    putCachedAdvice('k', { content: 'hello', groundingNote: 'note' }, currentDataGeneration());
    expect(getCachedAdvice('k')).toEqual({ content: 'hello', groundingNote: 'note' });
  });

  it('normalizes a missing groundingNote to null and never returns internals', () => {
    putCachedAdvice('k', { content: 'x' }, currentDataGeneration());
    expect(getCachedAdvice('k')).toEqual({ content: 'x', groundingNote: null });
  });

  it('overwrites an existing key', () => {
    putCachedAdvice('k', value('one'), currentDataGeneration());
    putCachedAdvice('k', value('two'), currentDataGeneration());
    expect(getCachedAdvice('k').content).toBe('two');
  });
});

describe('TTL with an injected clock', () => {
  it('serves just before the TTL and drops at the TTL', () => {
    const gen = currentDataGeneration();
    putCachedAdvice('k', value('x'), gen, 1_000);
    expect(getCachedAdvice('k', 1_000 + ADVICE_CACHE_TTL_MS - 1)).not.toBeNull();
    putCachedAdvice('k2', value('y'), gen, 1_000);
    expect(getCachedAdvice('k2', 1_000 + ADVICE_CACHE_TTL_MS)).toBeNull();
  });

  it('an expired entry is removed, so it is still a miss with a rewound clock', () => {
    putCachedAdvice('k', value('x'), currentDataGeneration(), 1_000);
    expect(getCachedAdvice('k', 1_000 + ADVICE_CACHE_TTL_MS + 5)).toBeNull();
    expect(getCachedAdvice('k', 1_001)).toBeNull();
  });

  it('a hit does not extend the lifetime', () => {
    const gen = currentDataGeneration();
    putCachedAdvice('k', value('x'), gen, 0);
    expect(getCachedAdvice('k', ADVICE_CACHE_TTL_MS - 10)).not.toBeNull();
    expect(getCachedAdvice('k', ADVICE_CACHE_TTL_MS + 1)).toBeNull();
  });

  it('a rewrite restarts the lifetime', () => {
    const gen = currentDataGeneration();
    putCachedAdvice('k', value('x'), gen, 0);
    putCachedAdvice('k', value('y'), gen, ADVICE_CACHE_TTL_MS - 1);
    expect(getCachedAdvice('k', ADVICE_CACHE_TTL_MS + 100)?.content).toBe('y');
  });
});

describe('LRU eviction', () => {
  const fill = (n, from = 0) => {
    const gen = currentDataGeneration();
    for (let i = from; i < from + n; i += 1) putCachedAdvice(`k${i}`, value(`v${i}`), gen);
  };

  it('holds exactly ADVICE_CACHE_MAX entries and drops the oldest first', () => {
    fill(ADVICE_CACHE_MAX);
    expect(getCachedAdvice('k0')).not.toBeNull(); // touching k0 makes k1 the oldest
    fill(1, ADVICE_CACHE_MAX);
    expect(getCachedAdvice('k1')).toBeNull();
    expect(getCachedAdvice('k0')).not.toBeNull();
    expect(getCachedAdvice(`k${ADVICE_CACHE_MAX}`)).not.toBeNull();
  });

  it('without any reads, the first written goes first', () => {
    fill(ADVICE_CACHE_MAX + 3);
    for (let i = 0; i < 3; i += 1) expect(getCachedAdvice(`k${i}`)).toBeNull();
    for (let i = 3; i < ADVICE_CACHE_MAX + 3; i += 1) expect(getCachedAdvice(`k${i}`)).not.toBeNull();
  });

  it('rewriting an existing key does not grow the cache or evict another', () => {
    fill(ADVICE_CACHE_MAX);
    putCachedAdvice('k5', value('again'), currentDataGeneration());
    for (let i = 0; i < ADVICE_CACHE_MAX; i += 1) expect(getCachedAdvice(`k${i}`)).not.toBeNull();
  });
});

describe('data resets and generations', () => {
  it('onDataReset (runDataResetHooks) clears everything', () => {
    putCachedAdvice('a', value('x'), currentDataGeneration());
    putCachedAdvice('b', value('y'), currentDataGeneration());
    runDataResetHooks();
    expect(getCachedAdvice('a')).toBeNull();
    expect(getCachedAdvice('b')).toBeNull();
  });

  it('an entry written before a generation bump is never served', () => {
    putCachedAdvice('a', value('x'), currentDataGeneration());
    bumpDataGeneration();
    expect(getCachedAdvice('a')).toBeNull();
  });

  it('a put with a generation captured before a bump is ignored (the model call outlived a reset)', () => {
    const before = currentDataGeneration();
    bumpDataGeneration();
    putCachedAdvice('late', value('x'), before);
    expect(getCachedAdvice('late')).toBeNull();
    putCachedAdvice('now', value('x'), currentDataGeneration());
    expect(getCachedAdvice('now')).not.toBeNull();
  });
});

describe('streamAdvice: what varies the key', () => {
  const input = { page: 'budget', pageLabel: 'Budget', context: '{"page":"budget","data":{"spend":1}}', messages: [] };
  const client = (over = {}) => {
    const c = {
      provider: 'ollama',
      model: 'qwen2.5:3b',
      purpose: 'chat',
      numCtx: 8192,
      stats: { calls: 0 },
      ai: { kind: 'local', host: null },
      stream: vi.fn(async function* stream() {
        c.stats.calls += 1;
        yield { type: 'token', text: '- Spend is 1 dollar.' };
        yield { type: 'done', usage: null, finishReason: 'stop' };
      }),
      ...over,
    };
    return c;
  };
  const prime = () => streamAdvice(input, { client: client(), cache: true });
  const missWith = async (inp, c) => {
    const out = await streamAdvice(inp, { client: c, cache: true });
    return { out, c };
  };

  beforeEach(async () => {
    await prime();
    // sanity: the same request now hits
    const hit = await missWith(input, client());
    expect(hit.out.cached).toBe(true);
    expect(hit.c.stream).not.toHaveBeenCalled();
  });

  const expectMiss = async (inp, c) => {
    const { out } = await missWith(inp, c);
    expect(out.cached).toBe(false);
    expect(c.stream).toHaveBeenCalledTimes(1);
  };

  it('a different model misses', () => expectMiss(input, client({ model: 'llama3.2:1b' })));
  it('a different provider kind misses', () => expectMiss(input, client({ ai: { kind: 'lan', host: null } })));
  it('a different LAN host misses', () => expectMiss(input, client({ ai: { kind: 'lan', host: '10.0.0.9' } })));
  it('a different page misses', () => expectMiss({ ...input, page: 'goals' }, client()));
  it('a different context misses', () => expectMiss({ ...input, context: '{"page":"budget","data":{"spend":2}}' }, client()));
  it('a different display name misses', async () => {
    displayName.value = 'Alex';
    await expectMiss(input, client());
  });
  it('a changed minute within the same hour (localTime lifted out) still hits', async () => {
    await clearAndPrimeWithClock('10:01');
    const { out, c } = await missWith({ ...input, context: '{"page":"budget","data":{"spend":1},"localTime":"10:59"}' }, client());
    expect(out.cached).toBe(true);
    expect(c.stream).not.toHaveBeenCalled();
  });
  it('crossing an hour boundary misses, so a card never replays across the hour', async () => {
    await clearAndPrimeWithClock('10:59');
    await expectMiss({ ...input, context: '{"page":"budget","data":{"spend":1},"localTime":"11:00"}' }, client());
  });
  it('a snapshot with no clock does not share an entry with one that has a clock', async () => {
    await clearAndPrimeWithClock('10:01');
    await expectMiss({ ...input, context: '{"page":"budget","data":{"spend":1}}' }, client());
  });

  async function clearAndPrimeWithClock(time) {
    clearAdviceCache();
    await streamAdvice({ ...input, context: `{"page":"budget","data":{"spend":1},"localTime":"${time}"}` }, { client: client(), cache: true });
  }
});

describe('streamAdvice: fresh and what is never cached', () => {
  const input = { page: 'todos', pageLabel: 'Todos', context: '{"page":"todos","data":{"open":3}}', messages: [] };
  const mk = (content = '- Three open.', finishReason = 'stop', extra = {}) => {
    const c = {
      provider: 'ollama',
      model: 'qwen2.5:3b',
      purpose: 'chat',
      numCtx: 8192,
      stats: { calls: 0 },
      ai: { kind: 'local', host: null },
      stream: vi.fn(async function* stream() {
        c.stats.calls += 1;
        yield { type: 'token', text: content };
        yield { type: 'done', usage: null, finishReason };
      }),
      ...extra,
    };
    return c;
  };

  it('fresh bypasses the read, calls the model, and its answer is what the next hit replays', async () => {
    await streamAdvice(input, { client: mk('- First answer.'), cache: true });
    const c = mk('- Second answer.');
    const fresh = await streamAdvice(input, { client: c, cache: true, fresh: true });
    expect(c.stream).toHaveBeenCalledTimes(1);
    expect(fresh).toMatchObject({ cached: false, content: '- Second answer.' });
    const hit = await streamAdvice(input, { client: mk('- Third.'), cache: true });
    expect(hit).toMatchObject({ cached: true, content: '- Second answer.' });
  });

  it('cache: false neither reads nor writes', async () => {
    await streamAdvice(input, { client: mk(), cache: false });
    const c = mk();
    const out = await streamAdvice(input, { client: c, cache: true });
    expect(out.cached).toBe(false);
    expect(c.stream).toHaveBeenCalledTimes(1);
  });

  it('a scope (cross insights, explain) is never cached', async () => {
    const scope = { categories: ['todos'] };
    await streamAdvice(input, { client: mk(), cache: true, scope });
    const c = mk();
    const out = await streamAdvice(input, { client: c, cache: true, scope });
    expect(out.cached).toBe(false);
    expect(c.stream).toHaveBeenCalledTimes(1);
    // and the scoped call stored nothing for the plain request either
    const plain = mk();
    expect((await streamAdvice(input, { client: plain, cache: true })).cached).toBe(false);
  });

  it('a follow-up (messages present) never reads or writes', async () => {
    const withMsg = { ...input, messages: [{ role: 'user', content: 'why?' }] };
    await streamAdvice(withMsg, { client: mk(), cache: true });
    const c = mk();
    expect((await streamAdvice(withMsg, { client: c, cache: true })).cached).toBe(false);
    expect(c.stream).toHaveBeenCalledTimes(1);
    expect((await streamAdvice(input, { client: mk(), cache: true })).cached).toBe(false); // nothing was stored for the card
  });

  it('cloud and an unknown kind are never cached, even for the same page and text', async () => {
    const cloud = () =>
      mk('- Three open.', 'stop', { isCloud: true, ai: { kind: 'cloud', host: 'api.example.com' }, policy: createAiPolicy({ isCloud: true, categories: ['todos'] }), noteWithheld: vi.fn() });
    await streamAdvice(input, { client: cloud(), cache: true });
    const again = cloud();
    expect((await streamAdvice(input, { client: again, cache: true })).cached).toBe(false);
    expect(again.stream).toHaveBeenCalledTimes(1);
    const odd = () => mk('- Three open.', 'stop', { ai: { kind: 'hosted', host: null } });
    await streamAdvice(input, { client: odd(), cache: true });
    expect((await streamAdvice(input, { client: odd(), cache: true })).cached).toBe(false);
  });

  it('a flagged answer (ungrounded figure, or cut short) is not stored', async () => {
    const bad = () => mk('- You have 4,242 open.');
    await streamAdvice(input, { client: bad(), cache: true });
    expect((await streamAdvice(input, { client: bad(), cache: true })).cached).toBe(false);
    const cut = () => mk('- Three open.', 'length');
    await streamAdvice(input, { client: cut(), cache: true });
    expect((await streamAdvice(input, { client: cut(), cache: true })).cached).toBe(false);
  });

  it('a failed model call and an empty answer store nothing', async () => {
    const boom = mk();
    boom.stream = vi.fn(async function* stream() {
      yield { type: 'token', text: '- partial' };
      throw new Error('boom');
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(streamAdvice(input, { client: boom, cache: true })).rejects.toBeTruthy();
    const ok = mk();
    expect((await streamAdvice(input, { client: ok, cache: true })).cached).toBe(false);
    expect(ok.stream).toHaveBeenCalledTimes(1);
  });

  it('an aborted call (signal propagated, stream throws AbortError) writes nothing to the cache', async () => {
    const controller = new AbortController();
    let seen;
    const c = mk();
    c.stream = vi.fn(async function* stream(opts) {
      seen = opts.signal;
      yield { type: 'token', text: '- partial' };
      controller.abort();
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(streamAdvice(input, { client: c, cache: true, signal: controller.signal })).rejects.toBeTruthy();
    expect(seen).toBe(controller.signal);
    expect(seen.aborted).toBe(true);
    const next = mk();
    expect((await streamAdvice(input, { client: next, cache: true })).cached).toBe(false);
    expect(next.stream).toHaveBeenCalledTimes(1);
  });

  it('a hit made after a data reset during the model call is not stored', async () => {
    const c = mk();
    c.stream = vi.fn(async function* stream() {
      yield { type: 'token', text: '- Three open.' };
      bumpDataGeneration(); // the data was erased while the model was answering
      yield { type: 'done', usage: null, finishReason: 'stop' };
    });
    await streamAdvice(input, { client: c, cache: true });
    const next = mk();
    expect((await streamAdvice(input, { client: next, cache: true })).cached).toBe(false);
  });
});
