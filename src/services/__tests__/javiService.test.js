import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { requestJaviAdvice } from '../javiService';
import { jsonResponse, sseEvent, sseResponse } from '../../test-utils/sseResponse';

const mockFetch = vi.fn();
beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
  mockFetch.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

const input = { page: 'home', context: 'ctx', messages: [] };

describe('requestJaviAdvice streaming', () => {
  it('asks for an event stream', async () => {
    mockFetch.mockResolvedValueOnce(
      sseResponse([sseEvent('done', { content: 'x', model: 'm', provider: 'ollama' })]),
    );
    await requestJaviAdvice(input);
    expect(mockFetch.mock.calls[0][1].headers.Accept).toBe('text/event-stream');
  });

  it('reports progressive text and replaces it with the authoritative done content', async () => {
    mockFetch.mockResolvedValueOnce(
      sseResponse([
        sseEvent('delta', { content: 'You have ' }),
        sseEvent('delta', { content: '3 todos' }),
        sseEvent('done', { content: 'You have 3 todos.', model: 'qwen2.5:3b', provider: 'ollama' }),
      ]),
    );
    const seen = [];
    const out = await requestJaviAdvice({ ...input, onDelta: (t) => seen.push(t) });
    expect(seen).toEqual(['You have ', 'You have 3 todos']);
    expect(out).toEqual({
      content: 'You have 3 todos.',
      model: 'qwen2.5:3b',
      provider: 'ollama',
      ai: null,
      withheld: [],
      notice: null,
      blocked: false,
    });
  });

  it('passes the warming-up status note to onStatus before any text arrives', async () => {
    mockFetch.mockResolvedValueOnce(
      sseResponse([
        sseEvent('status', { code: 'warming_up', message: 'Javi is thinking. On this computer the first answer can take a minute.' }),
        sseEvent('delta', { content: 'Hi' }),
        sseEvent('done', { content: 'Hi', model: 'm', provider: 'ollama' }),
      ]),
    );
    const notes = [];
    await requestJaviAdvice({ ...input, onStatus: (m) => notes.push(m) });
    expect(notes).toEqual(['Javi is thinking. On this computer the first answer can take a minute.']);
  });

  it('rejects with the error event code and retry hint', async () => {
    mockFetch.mockResolvedValueOnce(
      sseResponse([
        sseEvent('delta', { content: 'part' }),
        sseEvent('error', { error: 'The model took too long.', code: 'timeout', retryAfterMs: 5000 }),
      ]),
    );
    await expect(requestJaviAdvice(input)).rejects.toMatchObject({
      message: 'The model took too long.',
      code: 'timeout',
      retryAfterMs: 5000,
    });
  });

  it('falls back to the JSON body when the response is not an event stream', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ data: { content: 'Plain answer', model: 'm', provider: 'ollama' } }),
    );
    const out = await requestJaviAdvice(input);
    expect(out.content).toBe('Plain answer');
  });

  it('keeps the structured code for a 503 before any stream starts', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ error: 'ollama_unavailable', message: 'Javi cannot reach Ollama.' }, 503),
    );
    await expect(requestJaviAdvice(input)).rejects.toMatchObject({
      status: 503,
      code: 'ollama_unavailable',
      message: 'Javi cannot reach Ollama.',
    });
  });

  it('rejects when the stream ends without a done event', async () => {
    mockFetch.mockResolvedValueOnce(sseResponse([sseEvent('delta', { content: 'cut' })]));
    await expect(requestJaviAdvice(input)).rejects.toMatchObject({ code: 'stream_error' });
  });
});

describe('requestJaviAdvice: fresh and cancellation', () => {
  const doneStream = () => sseResponse([sseEvent('done', { content: 'x', model: 'm', provider: 'ollama' })]);

  it('posts to the plain URL by default and when fresh is false', async () => {
    mockFetch.mockResolvedValue(doneStream());
    await requestJaviAdvice(input);
    mockFetch.mockResolvedValue(doneStream());
    await requestJaviAdvice({ ...input, fresh: false });
    expect(mockFetch.mock.calls.map((c) => c[0])).toEqual(['/api/jarvis/advice', '/api/jarvis/advice']);
  });

  it('fresh: true adds ?fresh=1 to the query only, never to the body', async () => {
    mockFetch.mockResolvedValueOnce(doneStream());
    await requestJaviAdvice({ ...input, fresh: true });
    expect(mockFetch.mock.calls[0][0]).toBe('/api/jarvis/advice?fresh=1');
    expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toEqual({ page: 'home', context: 'ctx', messages: [] });
  });

  it('passes the AbortSignal to fetch and rejects with an AbortError when it aborts mid-request', async () => {
    const controller = new AbortController();
    mockFetch.mockImplementationOnce(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        }),
    );
    const pending = requestJaviAdvice({ ...input, signal: controller.signal });
    expect(mockFetch.mock.calls[0][1].signal).toBe(controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});
