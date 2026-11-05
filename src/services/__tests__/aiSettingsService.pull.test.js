import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { aiSettingsService } from '../aiSettingsService';
import { jsonResponse, sseEvent, sseResponse } from '../../test-utils/sseResponse';

const mockFetch = vi.fn();
beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
  mockFetch.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

describe('aiSettingsService.setup', () => {
  it('unwraps the data envelope', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: { ollama: 'missing', ready: false } }));
    await expect(aiSettingsService.setup()).resolves.toEqual({ ollama: 'missing', ready: false });
    expect(mockFetch.mock.calls[0][0]).toBe('/api/settings/ai/setup');
  });
});

describe('aiSettingsService.pull', () => {
  it('posts the model, reports progress and resolves on done', async () => {
    mockFetch.mockResolvedValueOnce(
      sseResponse([
        sseEvent('progress', { phase: 'downloading', completed: 5, total: 10 }),
        sseEvent('done', { model: 'qwen2.5:3b' }),
      ]),
    );
    const onProgress = vi.fn();
    await aiSettingsService.pull('qwen2.5:3b', { onProgress });
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('/api/settings/ai/pull');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ model: 'qwen2.5:3b' });
    expect(onProgress).toHaveBeenCalledWith({ phase: 'downloading', completed: 5, total: 10 });
  });

  it('rejects with the error event code', async () => {
    mockFetch.mockResolvedValueOnce(
      sseResponse([sseEvent('error', { code: 'pull_failed', message: 'x' })]),
    );
    await expect(aiSettingsService.pull('m')).rejects.toMatchObject({ code: 'pull_failed' });
  });

  it('rejects when the stream ends without done', async () => {
    mockFetch.mockResolvedValueOnce(
      sseResponse([sseEvent('progress', { phase: 'manifest', completed: 0, total: 0 })]),
    );
    await expect(aiSettingsService.pull('m')).rejects.toMatchObject({ code: 'stream_error' });
  });

  it.each([
    [400, 'invalid_model'],
    [409, 'pull_requires_local_ollama'],
    [409, 'pull_in_progress'],
    [503, 'ollama_unavailable'],
    [503, 'ai_not_configured'],
  ])('maps a %s JSON error to code %s', async (status, error) => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ error, message: 'nope' }, status));
    await expect(aiSettingsService.pull('m')).rejects.toMatchObject({ code: error, status });
  });

  it('keeps the rate_limited code instead of the limiter sentence', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ error: 'Too many requests, please try again later.', code: 'rate_limited' }, 429),
    );
    await expect(aiSettingsService.pull('m')).rejects.toMatchObject({
      code: 'rate_limited',
      status: 429,
    });
  });

  it('propagates an abort that happens mid-stream as AbortError', async () => {
    const encoder = new TextEncoder();
    const ctl = new AbortController();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(sseEvent('progress', { phase: 'downloading', completed: 1, total: 9 })),
        );
        ctl.signal.addEventListener('abort', () =>
          controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        );
      },
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: '',
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      body: stream,
    });
    const onProgress = vi.fn(() => ctl.abort());
    await expect(
      aiSettingsService.pull('m', { signal: ctl.signal, onProgress }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(onProgress).toHaveBeenCalledTimes(1);
  });

  it('propagates an abort as AbortError', async () => {
    mockFetch.mockRejectedValueOnce(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    await expect(aiSettingsService.pull('m')).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('reports a network failure with a code', async () => {
    mockFetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(aiSettingsService.pull('m')).rejects.toMatchObject({ code: 'network' });
  });
});
