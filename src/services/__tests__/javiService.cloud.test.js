import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { requestJaviAdvice } from '../javiService';
import { jsonResponse, sseEvent, sseResponse } from '../../test-utils/sseResponse';

const mockFetch = vi.fn();
beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
  mockFetch.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

const input = { page: 'journal', context: 'ctx', messages: [] };
const CLOUD = { kind: 'cloud', host: 'api.example.com' };
const NOTICE = "Your journal isn't shared with cloud AI. You can change that in Settings > AI.";

describe('requestJaviAdvice cloud fields (stream)', () => {
  it('reads ai, withheld, notice and blocked from done', async () => {
    mockFetch.mockResolvedValueOnce(
      sseResponse([
        sseEvent('meta', { ai: CLOUD }),
        sseEvent('delta', { content: 'Part' }),
        sseEvent('done', {
          content: 'Part and more.',
          model: 'some-model',
          provider: 'openai_compat',
          ai: CLOUD,
          withheld: ['journal', 'health'],
          notice: NOTICE,
          blocked: false,
        }),
      ]),
    );
    const out = await requestJaviAdvice(input);
    expect(out).toEqual({
      content: 'Part and more.',
      model: 'some-model',
      provider: 'openai_compat',
      ai: CLOUD,
      withheld: ['journal', 'health'],
      notice: NOTICE,
      blocked: false,
    });
  });

  it('falls back to the meta source when done has none', async () => {
    mockFetch.mockResolvedValueOnce(
      sseResponse([
        sseEvent('meta', { ai: CLOUD }),
        sseEvent('done', { content: 'Hi.', model: 'm', provider: 'openai_compat' }),
      ]),
    );
    const out = await requestJaviAdvice(input);
    expect(out.ai).toEqual(CLOUD);
    expect(out.withheld).toEqual([]);
    expect(out.notice).toBeNull();
    expect(out.blocked).toBe(false);
  });

  it('reads a blocked reply: notice as content, no deltas', async () => {
    mockFetch.mockResolvedValueOnce(
      sseResponse([
        sseEvent('meta', { ai: CLOUD }),
        sseEvent('done', {
          content: NOTICE,
          model: '',
          provider: 'openai_compat',
          ai: CLOUD,
          withheld: ['journal'],
          notice: NOTICE,
          blocked: true,
        }),
      ]),
    );
    const onDelta = vi.fn();
    const out = await requestJaviAdvice({ ...input, onDelta });
    expect(onDelta).not.toHaveBeenCalled();
    expect(out.blocked).toBe(true);
    expect(out.content).toBe(NOTICE);
    expect(out.notice).toBe(NOTICE);
    expect(out.withheld).toEqual(['journal']);
  });

  it('drops malformed values instead of passing them on', async () => {
    mockFetch.mockResolvedValueOnce(
      sseResponse([
        sseEvent('done', {
          content: 'Hi.',
          ai: { kind: 'mystery' },
          withheld: 'journal',
          notice: 7,
          blocked: 'yes',
        }),
      ]),
    );
    const out = await requestJaviAdvice(input);
    expect(out).toMatchObject({ ai: null, withheld: [], notice: null, blocked: false });
  });

  it('keeps an error event as an error', async () => {
    mockFetch.mockResolvedValueOnce(
      sseResponse([sseEvent('meta', { ai: CLOUD }), sseEvent('error', { code: 'timeout', message: 'Too slow.' })]),
    );
    await expect(requestJaviAdvice(input)).rejects.toMatchObject({ code: 'timeout' });
  });
});

describe('requestJaviAdvice cloud fields (JSON)', () => {
  it('passes the new fields through and defaults missing ones', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: {
          content: 'Hi.',
          model: 'm',
          provider: 'openai_compat',
          ai: CLOUD,
          withheld: ['notes'],
          notice: 'Your notes are not shared with cloud AI.',
          blocked: false,
        },
      }),
    );
    expect(await requestJaviAdvice(input)).toMatchObject({
      ai: CLOUD,
      withheld: ['notes'],
      notice: 'Your notes are not shared with cloud AI.',
      blocked: false,
    });
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: { content: 'Old server.', model: 'm', provider: 'ollama' } }));
    expect(await requestJaviAdvice(input)).toMatchObject({ ai: null, withheld: [], notice: null, blocked: false });
  });
});
