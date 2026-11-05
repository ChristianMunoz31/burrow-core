// OpenAI-compatible client (server/ai/llmClient.js), used only for the opt-in cloud provider.
// node-fetch is mocked: no real network call is made.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { Readable } from 'node:stream';

vi.mock('node-fetch', () => ({ default: vi.fn() }));

let llm;
let fetchMock;
beforeAll(async () => {
  fetchMock = (await import('node-fetch')).default;
  llm = await import('../ai/llmClient.js');
});
beforeEach(() => {
  fetchMock.mockReset();
});

const base = {
  url: 'https://cloud.test/v1/chat/completions',
  baseURL: 'https://cloud.test/v1',
  apiKey: 'sk-test-key',
  model: 'm',
  messages: [{ role: 'user', content: 'hi' }],
};

describe('openaiCompat endpoint', () => {
  it('builds the fixed chat completions URL from the base URL', async () => {
    const { chatCompletionsUrl } = await import('../ai/providers/openaiCompat.js');
    expect(chatCompletionsUrl('https://cloud.test/v1/')).toBe('https://cloud.test/v1/chat/completions');
  });
});
const okJson = (body) => ({ ok: true, status: 200, json: async () => body, headers: { get: () => null } });

describe('buildPayload token parameter', () => {
  it('sends max_tokens by default', () => {
    const p = llm.buildPayload({ ...base, maxTokens: 50, stream: false });
    expect(p.max_tokens).toBe(50);
    expect(p).not.toHaveProperty('max_completion_tokens');
  });

  it('sends max_completion_tokens when configured, or automatically for api.openai.com', () => {
    expect(llm.buildPayload({ ...base, maxTokens: 9, tokenParam: 'max_completion_tokens', stream: false }).max_completion_tokens).toBe(9);
    const auto = llm.buildPayload({ ...base, baseURL: 'https://api.openai.com/v1', maxTokens: 7, stream: false });
    expect(auto.max_completion_tokens).toBe(7);
    expect(auto).not.toHaveProperty('max_tokens');
  });

  it('never sends a reasoning parameter, and adds tools/json mode only when asked', () => {
    const plain = llm.buildPayload({ ...base, stream: false });
    expect(plain).not.toHaveProperty('reasoning_effort');
    expect(plain).not.toHaveProperty('tools');
    const t = llm.buildPayload({ ...base, tools: [{ type: 'function', function: { name: 'x' } }], format: 'json', stream: false });
    expect(t.tool_choice).toBe('auto');
    expect(t.response_format).toEqual({ type: 'json_object' });
  });
});

describe('chatWithTools', () => {
  it('posts to the configured base URL only, with redirect:error and the bearer key', async () => {
    fetchMock.mockResolvedValue(okJson({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } }));
    const out = await llm.chatWithTools({ ...base, maxTokens: 10 });
    expect(out).toEqual({ message: { role: 'assistant', content: 'ok' }, finishReason: 'stop', usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://cloud.test/v1/chat/completions');
    expect(init.redirect).toBe('error');
    expect(init.headers.Authorization).toBe('Bearer sk-test-key');
  });

  it('drops reasoning fields and keeps tool calls', async () => {
    const calls = [{ id: 'c1', type: 'function', function: { name: 'list_todos', arguments: '{}' } }];
    fetchMock.mockResolvedValue(okJson({ choices: [{ message: { content: '', reasoning: 'secret thoughts', tool_calls: calls }, finish_reason: 'tool_calls' }] }));
    const out = await llm.chatWithTools({ ...base });
    expect(out.message).toEqual({ role: 'assistant', content: '', tool_calls: calls });
    expect(JSON.stringify(out)).not.toContain('secret thoughts');
  });

  it('tags HTTP errors with status and retry-after but never puts the body in the message', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 429, text: async () => 'UPSTREAM-BODY rate limited', headers: { get: (h) => (h === 'retry-after' ? '3' : null) } });
    const err = await llm.chatWithTools({ ...base }).catch((e) => e);
    expect(err.httpStatus).toBe(429);
    expect(err.retryAfterMs).toBe(3000);
    expect(err.message).not.toContain('UPSTREAM-BODY');
  });

  it('tags network failures as unavailable', async () => {
    fetchMock.mockRejectedValue(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));
    const err = await llm.chatWithTools({ ...base }).catch((e) => e);
    expect(err.code).toBe('unavailable');
  });
});

describe('streamChat', () => {
  it('parses SSE deltas and the [DONE] marker', async () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ];
    fetchMock.mockResolvedValue({ ok: true, status: 200, body: Readable.from(sse.map((s) => Buffer.from(s))), headers: { get: () => null } });
    const events = [];
    for await (const ev of llm.streamChat({ ...base })) events.push(ev);
    expect(events.filter((e) => e.type === 'token').map((e) => e.text).join('')).toBe('Hello');
    expect(events.at(-1)).toMatchObject({ type: 'done', finishReason: 'stop' });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).stream).toBe(true);
  });
});
