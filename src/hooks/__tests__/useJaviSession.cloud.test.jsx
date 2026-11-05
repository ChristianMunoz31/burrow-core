import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useJaviSession } from '../useJaviSession';
import { jsonResponse, sseEvent, sseResponse } from '../../test-utils/sseResponse';

const mockFetch = vi.fn();
const readPageContext = vi.fn(() => ({ context: '{"page":"journal"}' }));

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
  mockFetch.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

const CLOUD = { kind: 'cloud', host: 'api.example.com' };
const NOTICE = "Your journal isn't shared with cloud AI. You can change that in Settings > AI.";

const setup = () => renderHook(() => useJaviSession({ readPageContext }));

describe('useJaviSession cloud fields', () => {
  it('stores ai, withheld and notice on the assistant message', async () => {
    mockFetch.mockResolvedValueOnce(
      sseResponse([
        sseEvent('meta', { ai: CLOUD }),
        sseEvent('done', {
          content: 'Advice.',
          model: 'm',
          provider: 'openai_compat',
          ai: CLOUD,
          withheld: ['journal'],
          notice: NOTICE,
          blocked: false,
        }),
      ]),
    );
    const { result } = setup();
    await act(async () => result.current.requestAdvice('journal'));
    const message = result.current.threadFor('journal').messages[0];
    expect(message).toMatchObject({ role: 'assistant', content: 'Advice.', ai: CLOUD, withheld: ['journal'], notice: NOTICE, blocked: false });
  });

  it('keeps a blocked reply as a normal message flagged blocked, not an error', async () => {
    mockFetch.mockResolvedValueOnce(
      sseResponse([
        sseEvent('done', { content: NOTICE, model: '', provider: 'openai_compat', ai: CLOUD, withheld: ['journal'], notice: NOTICE, blocked: true }),
      ]),
    );
    const { result } = setup();
    await act(async () => result.current.requestAdvice('journal'));
    const thread = result.current.threadFor('journal');
    expect(thread.status).toBe('idle');
    expect(thread.error).toBeNull();
    expect(thread.messages[0]).toMatchObject({ content: NOTICE, blocked: true, notice: NOTICE });
  });

  it('defaults the fields for an older server', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: { content: 'Plain.', model: 'm', provider: 'ollama' } }));
    const { result } = setup();
    await act(async () => result.current.requestAdvice('journal'));
    expect(result.current.threadFor('journal').messages[0]).toMatchObject({
      ai: null,
      withheld: [],
      notice: null,
      blocked: false,
    });
  });
});
