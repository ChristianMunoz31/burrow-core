import { StrictMode } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useJaviSession } from '../useJaviSession';

const mockFetch = vi.fn();
const readPageContext = vi.fn(() => ({ context: '{"page":"todos"}' }));

const ok = (content) => ({ ok: true, status: 200, json: async () => ({ data: { content, model: 'm', provider: 'p' } }) });
const fail = (status, error, code) => ({ ok: false, status, json: async () => ({ error, code }) });

function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}

const frame = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const bodyOf = (call) => JSON.parse(call[1].body);

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
  mockFetch.mockReset();
  readPageContext.mockClear();
});
afterEach(() => vi.unstubAllGlobals());

const setup = () => renderHook(() => useJaviSession({ readPageContext }));

describe('useJaviSession', () => {
  it('requestAdvice posts page, context and no messages', async () => {
    mockFetch.mockResolvedValueOnce(ok('Do the thing'));
    const { result } = setup();
    await act(async () => result.current.requestAdvice('todos'));
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toBe('/api/jarvis/advice');
    expect(bodyOf(mockFetch.mock.calls[0])).toEqual({ page: 'todos', context: '{"page":"todos"}', messages: [] });
    const t = result.current.threadFor('todos');
    expect(t.status).toBe('idle');
    expect(t.messages).toHaveLength(1);
    expect(t.messages[0]).toMatchObject({ role: 'assistant', content: 'Do the thing', auto: true });
  });

  it('shows the warming-up note in the reply bubble while waiting, then the real text replaces it', async () => {
    const enc = new TextEncoder();
    let controller;
    const body = new ReadableStream({ start: (c) => (controller = c) });
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, headers: { get: () => 'text/event-stream' }, body });
    const { result } = setup();
    let pending;
    act(() => {
      pending = result.current.requestAdvice('todos');
    });
    await act(async () => {
      controller.enqueue(enc.encode(frame('status', { code: 'warming_up', message: 'Javi is warming up.' })));
    });
    await waitFor(() => expect(result.current.threadFor('todos').partial).toBe('Javi is warming up.'));
    expect(result.current.threadFor('todos').status).toBe('loading');
    await act(async () => {
      controller.enqueue(enc.encode(frame('delta', { content: 'Hi' })));
    });
    await waitFor(() => expect(result.current.threadFor('todos').partial).toBe('Hi'));
    await act(async () => {
      controller.enqueue(enc.encode(frame('done', { content: 'Hi there', model: 'm', provider: 'p' })));
      controller.close();
      await pending;
    });
    await waitFor(() => expect(result.current.threadFor('todos').status).toBe('idle'));
    expect(result.current.threadFor('todos').partial).toBe('');
    expect(result.current.threadFor('todos').messages[0]).toMatchObject({ role: 'assistant', content: 'Hi there' });
  });

  it('sendMessage appends the user message and posts a window that ends with user', async () => {
    mockFetch.mockResolvedValue(ok('reply'));
    const { result } = setup();
    for (let i = 0; i < 10; i += 1) {
      await act(async () => result.current.sendMessage('todos', `q${i}`));
    }
    const lastBody = bodyOf(mockFetch.mock.calls.at(-1));
    expect(lastBody.messages.length).toBeLessThanOrEqual(12);
    expect(lastBody.messages.at(-1)).toEqual({ role: 'user', content: 'q9' });
    expect(lastBody.messages.every((m, i, a) => i === 0 || m.role !== a[i - 1].role)).toBe(true);
  });

  it('keeps the posted payload under the total character cap with long turns', async () => {
    mockFetch.mockResolvedValue(ok('a'.repeat(4000)));
    const { result } = setup();
    for (let i = 0; i < 6; i += 1) {
      await act(async () => result.current.sendMessage('todos', `question ${i}`));
    }
    for (const call of mockFetch.mock.calls) {
      const { messages } = bodyOf(call);
      expect(messages.reduce((n, m) => n + m.content.length, 0)).toBeLessThanOrEqual(16000);
      expect(messages.at(-1).role).toBe('user');
    }
    expect(bodyOf(mockFetch.mock.calls.at(-1)).messages.at(-1).content).toBe('question 5');
  });

  it('maps a 401 to the session-expired message', async () => {
    mockFetch.mockResolvedValueOnce(fail(401, 'Unauthorized'));
    const { result } = setup();
    await act(async () => result.current.requestAdvice('todos'));
    expect(result.current.threadFor('todos').error.message).toBe('Session expired. Please sign in again.');
  });

  it('ignores a second send while one is in flight', async () => {
    const d = deferred();
    mockFetch.mockReturnValueOnce(d.promise);
    const { result } = setup();
    act(() => {
      result.current.sendMessage('todos', 'one');
      result.current.sendMessage('todos', 'two');
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    await act(async () => d.resolve(ok('done')));
  });

  it('keeps the user message on error and retry re-reads the context', async () => {
    mockFetch.mockResolvedValueOnce(fail(429, 'Slow down', 'rate_limited'));
    const { result } = setup();
    await act(async () => result.current.sendMessage('todos', 'hello'));
    let t = result.current.threadFor('todos');
    expect(t.status).toBe('error');
    expect(t.error).toMatchObject({ message: "Javi couldn't answer (error 429). Try again.", code: 'rate_limited' });
    expect(t.messages.at(-1)).toMatchObject({ role: 'user', content: 'hello' });

    readPageContext.mockReturnValueOnce({ context: '{"fresh":true}' });
    mockFetch.mockResolvedValueOnce(ok('now ok'));
    await act(async () => result.current.retry('todos'));
    const body = bodyOf(mockFetch.mock.calls.at(-1));
    expect(body.messages).toEqual([{ role: 'user', content: 'hello' }]);
    expect(body.context).toBe('{"fresh":true}');
    t = result.current.threadFor('todos');
    expect(t.status).toBe('idle');
    expect(t.error).toBeNull();
    expect(t.messages.at(-1)).toMatchObject({ role: 'assistant', content: 'now ok' });
  });

  it('reports network failures with a friendly message', async () => {
    mockFetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const { result } = setup();
    await act(async () => result.current.requestAdvice('todos'));
    expect(result.current.threadFor('todos').error).toMatchObject({ code: 'network' });
  });

  it('aborting an auto-advice leaves no error state', async () => {
    mockFetch.mockImplementationOnce(
      (_url, { signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        }),
    );
    const { result } = setup();
    act(() => result.current.requestAdvice('todos'));
    expect(result.current.threadFor('todos').status).toBe('loading');
    act(() => result.current.abortAll());
    await waitFor(() => expect(result.current.threadFor('todos').status).toBe('idle'));
    expect(result.current.threadFor('todos').error).toBeNull();
  });

  it('lands the result on the requested page key', async () => {
    const d = deferred();
    mockFetch.mockReturnValueOnce(d.promise);
    const { result } = setup();
    act(() => result.current.requestAdvice('todos'));
    await act(async () => d.resolve(ok('for todos')));
    expect(result.current.threadFor('todos').messages).toHaveLength(1);
    expect(result.current.threadFor('habits').messages).toHaveLength(0);
  });

  it('does not call the LLM on its own', () => {
    setup();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('useJaviSession follow-ups work in every build', () => {
  const hook = () => renderHook(() => useJaviSession({ readPageContext }));

  it('has no conversation option: sendMessage sends the follow-up after the card', async () => {
    mockFetch.mockResolvedValueOnce(ok('card')).mockResolvedValueOnce(ok('answer'));
    const { result } = hook();
    await act(async () => result.current.requestAdvice('todos'));
    await act(async () => result.current.sendMessage('todos', 'what is due?'));
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(bodyOf(mockFetch.mock.calls.at(-1)).messages.at(-1)).toEqual({ role: 'user', content: 'what is due?' });
    expect(result.current.threadFor('todos').messages).toHaveLength(3);
  });

  it('retry resends a failed follow-up', async () => {
    mockFetch.mockResolvedValueOnce(ok('card')).mockResolvedValueOnce(fail(500, 'boom')).mockResolvedValueOnce(ok('answer'));
    const { result } = hook();
    await act(async () => result.current.requestAdvice('todos'));
    await act(async () => result.current.sendMessage('todos', 'follow up'));
    expect(result.current.threadFor('todos').status).toBe('error');
    await act(async () => result.current.retry('todos'));
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(bodyOf(mockFetch.mock.calls.at(-1)).messages.at(-1)).toEqual({ role: 'user', content: 'follow up' });
    expect(result.current.threadFor('todos').status).toBe('idle');
  });

  it('keeps every turn on the thread and never collapses it to one card', async () => {
    mockFetch.mockResolvedValueOnce(ok('card')).mockResolvedValueOnce(ok('answer'));
    const { result, rerender } = hook();
    await act(async () => result.current.requestAdvice('todos'));
    await act(async () => result.current.sendMessage('todos', 'one'));
    rerender();
    expect(result.current.threadFor('todos').messages).toHaveLength(3);
  });
});

describe('useJaviSession: fresh and cancellation', () => {
  const hanging = () =>
    mockFetch.mockImplementationOnce(
      (_url, { signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        }),
    );

  it('requestAdvice(page) posts to the plain URL; requestAdvice(page, true) adds ?fresh=1 and keeps the body the same', async () => {
    mockFetch.mockResolvedValue(ok('first'));
    const { result } = setup();
    await act(async () => result.current.requestAdvice('todos'));
    await act(async () => result.current.requestAdvice('todos', true));
    expect(mockFetch.mock.calls[0][0]).toBe('/api/jarvis/advice');
    expect(mockFetch.mock.calls[1][0]).toBe('/api/jarvis/advice?fresh=1');
    expect(bodyOf(mockFetch.mock.calls[1])).toEqual(bodyOf(mockFetch.mock.calls[0]));
    expect(bodyOf(mockFetch.mock.calls[1])).not.toHaveProperty('fresh');
  });

  it('a follow-up message never asks for a fresh answer', async () => {
    mockFetch.mockResolvedValue(ok('answer'));
    const { result } = setup();
    await act(async () => result.current.sendMessage('todos', 'why?'));
    expect(mockFetch.mock.calls[0][0]).toBe('/api/jarvis/advice');
  });

  it('a second request for the same page while one is in flight is ignored: one fetch, the first is not aborted', async () => {
    hanging();
    const { result } = setup();
    act(() => {
      result.current.requestAdvice('todos');
      result.current.requestAdvice('todos', true);
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][1].signal.aborted).toBe(false);
    act(() => result.current.abortAll());
  });

  it('abortAll aborts the in-flight signal of every page, and each page can then ask again', async () => {
    hanging();
    hanging();
    const { result } = setup();
    act(() => {
      result.current.requestAdvice('todos');
      result.current.requestAdvice('habits');
    });
    const signals = mockFetch.mock.calls.map((c) => c[1].signal);
    expect(signals).toHaveLength(2);
    expect(signals[0]).not.toBe(signals[1]);
    act(() => result.current.abortAll());
    expect(signals.every((s) => s.aborted)).toBe(true);
    await waitFor(() => expect(result.current.threadFor('todos').status).toBe('idle'));
    mockFetch.mockResolvedValueOnce(ok('again'));
    await act(async () => result.current.requestAdvice('todos', true));
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('unmounting aborts what is still in flight', () => {
    hanging();
    const { result, unmount } = setup();
    act(() => result.current.requestAdvice('todos'));
    const signal = mockFetch.mock.calls[0][1].signal;
    expect(signal.aborted).toBe(false);
    unmount();
    expect(signal.aborted).toBe(true);
  });

  it('StrictMode double-mount does not send a second request by itself', () => {
    mockFetch.mockResolvedValue(ok('x'));
    renderHook(() => useJaviSession({ readPageContext }), { wrapper: ({ children }) => <StrictMode>{children}</StrictMode> });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('a page changing the ai kind aborts the in-flight request and starts the thread over', async () => {
    hanging();
    const { result, rerender } = renderHook(({ ai }) => useJaviSession({ readPageContext, ai }), { initialProps: { ai: { kind: 'local', host: null } } });
    act(() => result.current.requestAdvice('todos'));
    const signal = mockFetch.mock.calls[0][1].signal;
    rerender({ ai: { kind: 'cloud', host: 'api.example.com' } });
    expect(signal.aborted).toBe(true);
    await waitFor(() => expect(result.current.threadFor('todos').messages).toHaveLength(0));
  });
});
