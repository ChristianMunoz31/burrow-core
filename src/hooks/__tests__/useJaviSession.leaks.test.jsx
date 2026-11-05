import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { dropForeignTurns, useJaviSession } from '../useJaviSession';
import { jsonResponse } from '../../test-utils/sseResponse';

const mockFetch = vi.fn();
const readPageContext = vi.fn(() => ({ context: '{"page":"todos"}' }));
const LOCAL = { kind: 'local', host: null };
const CLOUD = { kind: 'cloud', host: 'api.example.com' };

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
  mockFetch.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

const reply = (content, ai) => jsonResponse({ data: { content, model: 'm', provider: 'ollama', ai } });
const sentMessages = (callIndex) => JSON.parse(mockFetch.mock.calls[callIndex][1].body).messages;

describe('dropForeignTurns', () => {
  const thread = [
    { role: 'user', content: 'q1' },
    { role: 'assistant', content: 'local answer', ai: LOCAL },
    { role: 'user', content: 'q2' },
    { role: 'assistant', content: 'cloud answer', ai: CLOUD },
    { role: 'user', content: 'q3' },
  ];

  it('drops an assistant reply from another kind together with the question it answered', () => {
    expect(dropForeignTurns(thread, CLOUD).map((m) => m.content)).toEqual(['q2', 'cloud answer', 'q3']);
    expect(dropForeignTurns(thread, LOCAL).map((m) => m.content)).toEqual(['q1', 'local answer', 'q3']);
  });

  it('treats a missing ai as local on both sides', () => {
    const plain = [
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'old answer' },
      { role: 'user', content: 'q2' },
    ];
    expect(dropForeignTurns(plain, null)).toEqual(plain);
    expect(dropForeignTurns(plain, CLOUD).map((m) => m.content)).toEqual(['q2']);
  });
});

describe('useJaviSession and a changing model', () => {
  it('never resends an earlier reply written under a different kind of model', async () => {
    // The status still says local while the server answered from the cloud (a stale status).
    mockFetch.mockResolvedValueOnce(reply('Cloud advice.', CLOUD)).mockResolvedValueOnce(reply('Follow-up.', LOCAL));
    const { result } = renderHook(() => useJaviSession({ readPageContext, ai: LOCAL }));
    await act(async () => result.current.requestAdvice('todos'));
    await act(async () => result.current.sendMessage('todos', 'and then?'));
    expect(sentMessages(1)).toEqual([{ role: 'user', content: 'and then?' }]);
  });

  it('keeps earlier replies of the same kind', async () => {
    mockFetch.mockResolvedValueOnce(reply('Local advice.', LOCAL)).mockResolvedValueOnce(reply('Follow-up.', LOCAL));
    const { result } = renderHook(() => useJaviSession({ readPageContext, ai: LOCAL }));
    await act(async () => result.current.requestAdvice('todos'));
    await act(async () => result.current.sendMessage('todos', 'and then?'));
    expect(sentMessages(1).map((m) => m.content)).toEqual(['Local advice.', 'and then?']);
  });

  it('resets every thread when the status kind or host changes', async () => {
    mockFetch.mockResolvedValueOnce(reply('Local advice.', LOCAL));
    const { result, rerender } = renderHook(({ ai }) => useJaviSession({ readPageContext, ai }), { initialProps: { ai: LOCAL } });
    await act(async () => result.current.requestAdvice('todos'));
    expect(result.current.threadFor('todos').messages).toHaveLength(1);
    rerender({ ai: CLOUD });
    expect(result.current.threadFor('todos').messages).toHaveLength(0);

    mockFetch.mockResolvedValueOnce(reply('Cloud advice.', CLOUD));
    await act(async () => result.current.requestAdvice('todos'));
    expect(result.current.threadFor('todos').messages).toHaveLength(1);
    rerender({ ai: { kind: 'cloud', host: 'other.example.com' } });
    expect(result.current.threadFor('todos').messages).toHaveLength(0);
  });

  it('does not reset when the status first loads', async () => {
    mockFetch.mockResolvedValueOnce(reply('Local advice.', LOCAL));
    const { result, rerender } = renderHook(({ ai }) => useJaviSession({ readPageContext, ai }), { initialProps: { ai: null } });
    await act(async () => result.current.requestAdvice('todos'));
    rerender({ ai: LOCAL });
    expect(result.current.threadFor('todos').messages).toHaveLength(1);
  });
});
