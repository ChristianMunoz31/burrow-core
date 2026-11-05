// Context fitting for small local context windows (server/ai/contextFit.js).
import { describe, expect, it } from 'vitest';
import { contextBudgetChars, estimateTokens, fitMessages, promptBudgetTokens } from '../ai/contextFit.js';

const big = (n) => 'x'.repeat(n);

describe('estimateTokens', () => {
  it('counts about one token per three characters plus a per-message overhead', () => {
    expect(estimateTokens('abcdef')).toBe(2);
    expect(estimateTokens([{ role: 'user', content: 'abcdef' }])).toBe(6);
    expect(estimateTokens([{ role: 'assistant', content: '', tool_calls: [{ id: 'a' }] }])).toBeGreaterThan(4);
  });
});

describe('fitMessages', () => {
  it('returns the list unchanged when it fits', () => {
    const msgs = [{ role: 'system', content: 's' }, { role: 'user', content: 'hi' }];
    expect(fitMessages(msgs, { numCtx: 2048, maxTokens: 256 })).toEqual(msgs);
  });

  it('drops the oldest history first and never the system or last user message', () => {
    const msgs = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: big(3000) },
      { role: 'assistant', content: big(3000) },
      { role: 'user', content: 'recent question' },
      { role: 'assistant', content: 'recent answer' },
      { role: 'user', content: 'now' },
    ];
    const out = fitMessages(msgs, { numCtx: 1024, maxTokens: 256 });
    expect(out[0]).toEqual({ role: 'system', content: 'sys' });
    expect(out.at(-1)).toEqual({ role: 'user', content: 'now' });
    expect(out.map((m) => m.content)).toEqual(['sys', 'recent question', 'recent answer', 'now']);
  });

  it('drops an assistant tool call together with its tool results', () => {
    const msgs = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'old' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', function: { name: 'list_todos', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: big(4000) },
      { role: 'assistant', content: 'old answer' },
      { role: 'user', content: 'now' },
    ];
    const out = fitMessages(msgs, { numCtx: 1024, maxTokens: 256 });
    expect(out.some((m) => m.role === 'tool')).toBe(false);
    expect(out.some((m) => Array.isArray(m.tool_calls))).toBe(false);
    expect(out.at(-1).content).toBe('now');
  });

  it('keeps the current turn (tool rounds after the last user message) intact', () => {
    const msgs = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: big(5000) },
      { role: 'assistant', content: 'a' },
      { role: 'user', content: 'now' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'c2', function: { name: 'get_calendar', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c2', content: '{"events":[]}' },
    ];
    const out = fitMessages(msgs, { numCtx: 1024, maxTokens: 256 });
    expect(out.slice(-3).map((m) => m.role)).toEqual(['user', 'assistant', 'tool']);
  });
});

describe('budgets', () => {
  it('reserves the reply and a safety margin', () => {
    expect(promptBudgetTokens(8192, 1024)).toBe(8192 - 1024 - 256);
  });

  it('contextBudgetChars scales with numCtx and never goes below the floor', () => {
    expect(contextBudgetChars({ numCtx: 8192 }, { maxTokens: 1024 })).toBe((8192 - 1024 - 256) * 3);
    expect(contextBudgetChars({ numCtx: 2048 }, { maxTokens: 1200, reserveChars: 10_000 })).toBe(1000);
  });
});
