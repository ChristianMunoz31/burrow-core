// The "try your own cloud AI" hint: only when AI works locally and the computer is small or slow,
// at most once every 14 days, never when cloud is already in use. It only suggests; nothing is
// turned on. Also the in-memory local performance window that decides "slow".
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../loadEnv.js', () => ({}));

import { CLOUD_HINT_INTERVAL_DAYS, getCloudHint } from '../ai/cloudHint.js';
import { __resetLocalPerfForTests, localSlowSignal, recordLocalCall } from '../ai/localPerf.js';
import { createAiClient } from '../ai/registry.js';
import { getCloudHintState, recordCloudHint } from '../ai/consent.js';
import { setState } from '../dataAccess.js';

const GIB = 1024 ** 3;
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-10-05T12:00:00.000Z');
const LOCAL = { kind: 'local', host: null };
const ago = (days) => ({ lastShownAt: new Date(NOW - days * DAY).toISOString(), dismissedAt: null });
const hint = (over = {}) => getCloudHint({ ai: LOCAL, available: true, totalmem: () => 4 * GIB, now: () => NOW, state: { lastShownAt: null, dismissedAt: null }, ...over });
const saved = process.env.BURROW_AI;

beforeEach(() => {
  __resetLocalPerfForTests();
  delete process.env.BURROW_AI;
});
afterEach(() => {
  if (saved === undefined) delete process.env.BURROW_AI;
  else process.env.BURROW_AI = saved;
});

describe('localSlowSignal', () => {
  it('is quiet with no calls and with a few fast ones', () => {
    expect(localSlowSignal()).toBe(false);
    for (let i = 0; i < 5; i += 1) recordLocalCall({ firstTokenMs: 800 });
    expect(localSlowSignal()).toBe(false);
  });

  it('is slow after two timeouts among the last ten local calls', () => {
    recordLocalCall({ timedOut: true });
    expect(localSlowSignal()).toBe(false);
    recordLocalCall({ firstTokenMs: 500 });
    recordLocalCall({ timedOut: true });
    expect(localSlowSignal()).toBe(true);
  });

  it('forgets timeouts older than the last ten calls', () => {
    recordLocalCall({ timedOut: true });
    recordLocalCall({ timedOut: true });
    for (let i = 0; i < 10; i += 1) recordLocalCall({ firstTokenMs: 500 });
    expect(localSlowSignal()).toBe(false);
  });

  it('is slow when the median first token over the last five calls is above 60 s, with at least three samples', () => {
    recordLocalCall({ firstTokenMs: 90_000 });
    recordLocalCall({ firstTokenMs: 90_000 });
    expect(localSlowSignal()).toBe(false);
    recordLocalCall({ firstTokenMs: 90_000 });
    expect(localSlowSignal()).toBe(true);
  });

  it('uses the median, so one slow call among fast ones is not slow', () => {
    for (const ms of [500, 700, 200_000, 600, 800]) recordLocalCall({ firstTokenMs: ms });
    expect(localSlowSignal()).toBe(false);
  });

  it('exactly 60 s is not slow', () => {
    for (let i = 0; i < 3; i += 1) recordLocalCall({ firstTokenMs: 60_000 });
    expect(localSlowSignal()).toBe(false);
  });

  it('records real calls through a local client: first token time, and timeouts, but not caller aborts', async () => {
    vi.stubEnv('BURROW_AI_FIRST_TOKEN_TIMEOUT_MS', '15');
    try {
      const hang = async function* ({ signal }) {
        await new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
        });
        yield { type: 'token', text: 'never' };
      };
      const client = createAiClient({ provider: 'ollama', model: 'm', purpose: 'chat', numCtx: 8192, host: 'http://127.0.0.1:11434', transport: hang });
      const call = () => client.complete({ messages: [{ role: 'user', content: 'x' }] }).catch((e) => e);
      expect(await call()).toMatchObject({ code: 'timeout' });
      expect(localSlowSignal()).toBe(false);
      expect(await call()).toMatchObject({ code: 'timeout' });
      expect(localSlowSignal()).toBe(true);

      __resetLocalPerfForTests();
      const ac = new AbortController();
      const aborted = client.complete({ messages: [{ role: 'user', content: 'x' }], signal: ac.signal }).catch((e) => e);
      ac.abort();
      await aborted;
      const again = client.complete({ messages: [{ role: 'user', content: 'x' }], signal: AbortSignal.abort() }).catch((e) => e);
      await again;
      expect(localSlowSignal()).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('does not record cloud calls', async () => {
    const transport = async function* () {
      await new Promise((r) => setTimeout(r, 5));
      yield { type: 'token', text: 'ok' };
      yield { type: 'done', usage: null, finishReason: 'stop' };
    };
    const client = createAiClient({ provider: 'openai_compat', kind: 'cloud', model: 'm', purpose: 'chat', numCtx: 8192, transport, authorizeSend: async () => ({}) });
    for (let i = 0; i < 5; i += 1) await client.complete({ messages: [{ role: 'user', content: 'x' }], scope: { categories: [] } });
    for (let i = 0; i < 3; i += 1) recordLocalCall({ firstTokenMs: 100 });
    expect(localSlowSignal()).toBe(false);
  });
});

describe('getCloudHint', () => {
  it('shows low_memory on a tiny machine (under 6 GB) when nothing was shown before', async () => {
    expect(await hint()).toEqual({ show: true, reason: 'low_memory' });
    expect(await hint({ totalmem: () => 5.9 * GIB })).toEqual({ show: true, reason: 'low_memory' });
  });

  it('does not show on a machine with enough memory and no slow signal', async () => {
    expect(await hint({ totalmem: () => 6 * GIB })).toEqual({ show: false, reason: null });
    expect(await hint({ totalmem: () => 32 * GIB })).toEqual({ show: false, reason: null });
  });

  it('shows slow, even on a big machine, once local calls look slow (and slow wins over low memory)', async () => {
    recordLocalCall({ timedOut: true });
    recordLocalCall({ timedOut: true });
    expect(await hint({ totalmem: () => 32 * GIB })).toEqual({ show: true, reason: 'slow' });
    expect(await hint()).toEqual({ show: true, reason: 'slow' });
  });

  it('13 days after it was last shown: false. 14 days: true', async () => {
    expect(CLOUD_HINT_INTERVAL_DAYS).toBe(14);
    expect(await hint({ state: ago(13) })).toEqual({ show: false, reason: null });
    expect(await hint({ state: ago(13.99) })).toEqual({ show: false, reason: null });
    expect(await hint({ state: ago(14) })).toEqual({ show: true, reason: 'low_memory' });
    expect(await hint({ state: ago(60) })).toEqual({ show: true, reason: 'low_memory' });
  });

  it('a dismissal counts like a showing (dismissed sets lastShownAt too)', async () => {
    expect(await hint({ state: { lastShownAt: new Date(NOW - DAY).toISOString(), dismissedAt: new Date(NOW - DAY).toISOString() } })).toEqual({ show: false, reason: null });
  });

  it('never shows when cloud is already in use, when AI is unavailable, or when AI is off', async () => {
    expect((await hint({ ai: { kind: 'cloud', host: 'api.example.com' } })).show).toBe(false);
    expect((await hint({ available: false })).show).toBe(false);
    process.env.BURROW_AI = '0';
    expect((await hint()).show).toBe(false);
  });

  it('shows for a LAN Ollama too (it is not cloud)', async () => {
    expect((await hint({ ai: { kind: 'lan', host: '192.0.2.50' } })).show).toBe(true);
  });

  it('accepts a Date from now()', async () => {
    expect((await hint({ now: () => new Date(NOW), state: ago(14) })).show).toBe(true);
  });

  it('reads the saved state when none is injected, and a recorded showing hides it again', async () => {
    await setState('ai.cloudHint', {});
    const read = () => getCloudHint({ ai: LOCAL, available: true, totalmem: () => 4 * GIB });
    expect((await read()).show).toBe(true);
    await recordCloudHint('shown');
    expect((await read()).show).toBe(false);
    await setState('ai.cloudHint', {});
  });
});

describe('hint state', () => {
  it('shown sets lastShownAt only; dismissed sets both; garbage reads as empty', async () => {
    await setState('ai.cloudHint', {});
    expect(await getCloudHintState()).toEqual({ lastShownAt: null, dismissedAt: null });
    const shown = await recordCloudHint('shown');
    expect(shown.lastShownAt).toEqual(expect.any(String));
    expect(shown.dismissedAt).toBeNull();
    const dismissed = await recordCloudHint('dismissed');
    expect(dismissed.dismissedAt).toEqual(expect.any(String));
    await setState('ai.cloudHint', { lastShownAt: 'yesterday', dismissedAt: 5 });
    expect(await getCloudHintState()).toEqual({ lastShownAt: null, dismissedAt: null });
    await setState('ai.cloudHint', {});
  });
});
