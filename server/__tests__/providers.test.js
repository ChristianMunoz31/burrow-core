// Local AI providers and the registry: native Ollama transport (NDJSON streaming, tool-call
// conversion, fixed paths) and model resolution (auto choice, settings > env > auto,
// num_ctx, availability errors). node-fetch is mocked with a fake Ollama; nothing real runs.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node-fetch', () => ({ default: vi.fn() }));

import fetch from 'node-fetch';
import { MODELS, hangingChat, installFakeOllama, textReply, toolReply } from './helpers/fakeOllama.js';
import { fromOllamaToolCalls, ollamaChatStream, toOllamaMessages } from '../ai/providers/ollama.js';
import {
  __resetAiForTests,
  describeAi,
  effectiveNumCtx,
  getAiClient,
  parseParameterSize,
  pickAutoModels,
} from '../ai/registry.js';
import { AiUnavailableError, MSG_AI_OFF, MSG_NO_MODEL } from '../ai/gate.js';
import { setState } from '../dataAccess.js';
import { AI_SETTINGS_KEY } from '../ai/settings.js';
import { __resetNetPolicyForTests } from '../netPolicy.js';

const ENV_KEYS = [
  'BURROW_AI',
  'OLLAMA_HOST',
  'OLLAMA_NUM_CTX',
  'BURROW_AI_CHAT_MODEL',
  'BURROW_AI_TOOL_MODEL',
  'BURROW_AI_FIRST_TOKEN_TIMEOUT_MS',
  'BURROW_AI_AUTO_MAX_PARAMS_B',
];
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

beforeEach(async () => {
  for (const k of ENV_KEYS) delete process.env[k];
  fetch.mockReset();
  __resetAiForTests();
  __resetNetPolicyForTests();
  await setState(AI_SETTINGS_KEY, {});
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const asModels = (raw) =>
  raw.map((m) => ({
    name: m.name,
    sizeBytes: m.size,
    parameterSize: m.details.parameter_size,
    parameterCount: null,
    capabilities: m.capabilities,
    contextLength: m.details.context_length,
  }));

describe('message conversion', () => {
  it('sends assistant tool_call arguments as objects and names tool results', () => {
    const out = toOllamaMessages([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'list_todos', arguments: '{"includeDone":true}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: '{"todos":[]}' },
      { role: 'weird', content: 'dropped' },
    ]);
    expect(out).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '', tool_calls: [{ function: { name: 'list_todos', arguments: { includeDone: true } } }] },
      { role: 'tool', content: '{"todos":[]}', tool_name: 'list_todos' },
    ]);
  });

  it('returns incoming tool calls in OpenAI shape with string arguments and safe ids', () => {
    expect(fromOllamaToolCalls([{ function: { name: 'a', arguments: { x: 1 } } }, { id: 'bad id!', function: { name: 'b', arguments: {} } }], 2)).toEqual([
      { id: 'call_2', type: 'function', function: { name: 'a', arguments: '{"x":1}' } },
      { id: 'call_3', type: 'function', function: { name: 'b', arguments: '{}' } },
    ]);
  });
});

describe('ollamaChatStream', () => {
  it('streams tokens from NDJSON split mid-line and reports usage', async () => {
    const state = installFakeOllama(fetch, { chat: () => textReply('One two three.') });
    const events = [];
    for await (const ev of ollamaChatStream({ host: 'http://127.0.0.1:11434', model: 'qwen2.5:3b', messages: [{ role: 'user', content: 'x' }], numCtx: 4096, numPredict: 100, temperature: 0.3, keepAlive: '10m', format: 'json' })) {
      events.push(ev);
    }
    expect(events.filter((e) => e.type === 'token').map((e) => e.text).join('')).toBe('One two three.');
    expect(events.at(-1)).toEqual({ type: 'done', usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 }, finishReason: 'stop' });
    const body = state.chatBodies[0];
    expect(body).toMatchObject({ model: 'qwen2.5:3b', stream: true, keep_alive: '10m', format: 'json', options: { num_ctx: 4096, num_predict: 100, temperature: 0.3 } });
    expect(body).not.toHaveProperty('tools');
    expect(fetch.mock.calls[0][0]).toBe('http://127.0.0.1:11434/api/chat');
    expect(fetch.mock.calls[0][1].redirect).toBe('error');
  });

  it('converts native tool calls and reports finishReason tool_calls', async () => {
    installFakeOllama(fetch, { chat: () => toolReply([{ name: 'list_todos', arguments: { includeDone: false } }]) });
    const events = [];
    for await (const ev of ollamaChatStream({ host: 'http://127.0.0.1:11434', model: 'qwen2.5:7b', messages: [], tools: [{ type: 'function', function: { name: 'list_todos' } }], numCtx: 4096 })) {
      events.push(ev);
    }
    expect(events[0]).toEqual({ type: 'tool_calls', calls: [{ id: 'call_0', type: 'function', function: { name: 'list_todos', arguments: '{"includeDone":false}' } }] });
    expect(events.at(-1).finishReason).toBe('tool_calls');
  });

  it('turns an in-stream error into a classified error without echoing it', async () => {
    installFakeOllama(fetch, { chat: () => [{ error: 'model "nope" not found, try pulling it first' }] });
    const run = async () => {
      for await (const ev of ollamaChatStream({ host: 'http://127.0.0.1:11434', model: 'nope', messages: [], numCtx: 2048 })) void ev;
    };
    const err = await run().catch((e) => e);
    expect(err.code).toBe('model_missing');
    expect(err.message).not.toContain('nope');
  });
});

describe('auto model choice', () => {
  it('picks the largest tools model for tools and a faster distinct model for chat', () => {
    expect(pickAutoModels(asModels(MODELS))).toEqual({ tools: 'qwen2.5:7b', chat: 'qwen2.5:3b' });
  });

  it('respects the parameter cap and skips embeddings and vision-only models', () => {
    const big = { name: 'big:70b', size: 4e10, details: { parameter_size: '70B', context_length: 8192 }, capabilities: ['completion', 'tools'] };
    const embed = { name: 'embed', size: 1e8, details: { parameter_size: '137M' }, capabilities: ['embedding'] };
    expect(pickAutoModels(asModels([big, embed, ...MODELS]), { maxParamsB: 14 })).toEqual({ tools: 'qwen2.5:7b', chat: 'qwen2.5:3b' });
    expect(pickAutoModels(asModels([MODELS[2], embed]))).toEqual({ tools: null, chat: null });
  });

  it('uses the tool model for chat when it is the only one', () => {
    expect(pickAutoModels(asModels([MODELS[0]]))).toEqual({ tools: 'qwen2.5:7b', chat: 'qwen2.5:7b' });
  });

  it('parses parameter sizes', () => {
    expect(parseParameterSize('7.6B')).toBeCloseTo(7.6e9);
    expect(parseParameterSize('500M')).toBe(5e8);
    expect(parseParameterSize('?')).toBeNull();
  });

  it('caps num_ctx at the model context length', () => {
    expect(effectiveNumCtx({ contextLength: 2048 }, { numCtx: 8192 })).toBe(2048);
    expect(effectiveNumCtx({ contextLength: 32768 }, { numCtx: 8192 })).toBe(8192);
    expect(effectiveNumCtx({ contextLength: null }, { numCtx: 8192 })).toBe(8192);
  });
});

describe('getAiClient', () => {
  it('BURROW_AI=0 refuses before any request', async () => {
    process.env.BURROW_AI = '0';
    installFakeOllama(fetch);
    const err = await getAiClient({ purpose: 'chat' }).catch((e) => e);
    expect(err).toBeInstanceOf(AiUnavailableError);
    expect(err).toMatchObject({ code: 'ai_not_configured', publicMessage: MSG_AI_OFF, httpStatus: 503 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('Ollama down -> ollama_unavailable naming the host', async () => {
    installFakeOllama(fetch, { down: true });
    const err = await getAiClient({ purpose: 'tools' }).catch((e) => e);
    expect(err.code).toBe('ollama_unavailable');
    expect(err.publicMessage).toBe(`Javi can't reach Ollama at http://127.0.0.1:11434. Open the Ollama app or run "ollama serve", then try again.`);
  });

  it('no usable model -> ai_not_configured with the pull hint', async () => {
    installFakeOllama(fetch, { models: [MODELS[2]] });
    const err = await getAiClient({ purpose: 'chat' }).catch((e) => e);
    expect(err).toMatchObject({ code: 'ai_not_configured', publicMessage: MSG_NO_MODEL });
  });

  it('resolves auto models per purpose and only talks to loopback fixed paths', async () => {
    const state = installFakeOllama(fetch);
    const tools = await getAiClient({ purpose: 'tools' });
    const chat = await getAiClient({ purpose: 'chat' });
    expect([tools.provider, tools.model, tools.numCtx]).toEqual(['ollama', 'qwen2.5:7b', 8192]);
    expect(chat.model).toBe('qwen2.5:3b');
    for (const url of state.urls) expect(url).toMatch(/^http:\/\/127\.0\.0\.1:11434\/api\/(version|tags|show|chat)$/);
  });

  it('honors an explicit model only when installed, and settings over env', async () => {
    installFakeOllama(fetch);
    expect((await getAiClient({ purpose: 'chat', model: 'qwen2.5:7b' })).model).toBe('qwen2.5:7b');
    expect((await getAiClient({ purpose: 'chat', model: 'not-installed:1b' })).model).toBe('qwen2.5:3b');
    process.env.BURROW_AI_CHAT_MODEL = 'qwen2.5:7b';
    expect((await getAiClient({ purpose: 'chat' })).model).toBe('qwen2.5:7b');
    await setState(AI_SETTINGS_KEY, { chatModel: 'qwen2.5:3b' });
    expect((await getAiClient({ purpose: 'chat' })).model).toBe('qwen2.5:3b');
    // A vision-only model is never used for tools, even if saved.
    await setState(AI_SETTINGS_KEY, { toolModel: 'moondream:latest' });
    expect((await getAiClient({ purpose: 'tools' })).model).toBe('qwen2.5:7b');
  });

  it('a non-loopback OLLAMA_HOST needs the aiLan opt-in and is never contacted without it', async () => {
    process.env.OLLAMA_HOST = '192.168.1.20:11434';
    installFakeOllama(fetch);
    const err = await getAiClient({ purpose: 'chat' }).catch((e) => e);
    expect(err.code).toBe('ollama_unavailable');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('normalizes a wildcard OLLAMA_HOST to this machine', async () => {
    process.env.OLLAMA_HOST = '0.0.0.0';
    const state = installFakeOllama(fetch);
    await getAiClient({ purpose: 'chat' });
    expect(state.urls[0]).toBe('http://127.0.0.1:11434/api/version');
  });

  it('describeAi never throws', async () => {
    installFakeOllama(fetch, { down: true });
    expect(await describeAi('chat')).toMatchObject({ available: false, provider: 'ollama', model: null, reason: 'ollama_unavailable' });
  });
});

describe('AiClient calls', () => {
  it('complete() streams under the hood, counts calls and caps num_predict at half the context', async () => {
    const state = installFakeOllama(fetch, { chat: () => textReply('Hi there.') });
    const client = await getAiClient({ purpose: 'chat' });
    const out = await client.complete({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 9000 });
    expect(out).toMatchObject({ content: 'Hi there.', model: 'qwen2.5:3b' });
    expect(client.stats.calls).toBe(1);
    expect(state.chatBodies[0].stream).toBe(true);
    expect(state.chatBodies[0].options.num_predict).toBe(4096);
  });

  it('complete() surfaces finishReason "length" from the fake Ollama done_reason, and "stop" for a normal end', async () => {
    const lengthFrames = textReply('Cut off mid').map((f) => (f.done ? { ...f, done_reason: 'length' } : f));
    installFakeOllama(fetch, { replies: [lengthFrames, textReply('Done properly.')] });
    const client = await getAiClient({ purpose: 'chat' });
    const cut = await client.complete({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 5 });
    expect(cut).toMatchObject({ content: 'Cut off mid', finishReason: 'length', model: 'qwen2.5:3b' });
    const whole = await client.complete({ messages: [{ role: 'user', content: 'hi' }] });
    expect(whole).toMatchObject({ content: 'Done properly.', finishReason: 'stop' });
  });

  it('stream() ends with a done event that carries the same finishReason', async () => {
    const lengthFrames = textReply('Cut off mid').map((f) => (f.done ? { ...f, done_reason: 'length' } : f));
    installFakeOllama(fetch, { replies: [lengthFrames] });
    const client = await getAiClient({ purpose: 'chat' });
    const evs = [];
    for await (const ev of client.stream({ messages: [{ role: 'user', content: 'hi' }] })) evs.push(ev);
    expect(evs.at(-1)).toMatchObject({ type: 'done', finishReason: 'length' });
  });

  it('chatWithTools returns OpenAI-shaped tool calls and streams tokens to onToken', async () => {
    installFakeOllama(fetch, { replies: [toolReply([{ name: 'get_calendar', arguments: { days: 1 } }]), textReply('Nothing today.')] });
    const client = await getAiClient({ purpose: 'tools' });
    const first = await client.chatWithTools({ messages: [{ role: 'user', content: 'cal' }], tools: [{ type: 'function', function: { name: 'get_calendar' } }] });
    expect(first.finishReason).toBe('tool_calls');
    expect(first.message.tool_calls[0].function).toEqual({ name: 'get_calendar', arguments: '{"days":1}' });
    const tokens = [];
    const second = await client.chatWithTools({ messages: [{ role: 'user', content: 'cal' }], tools: [], onToken: (t) => tokens.push(t) });
    expect(second.message).toEqual({ role: 'assistant', content: 'Nothing today.' });
    expect(tokens.join('')).toBe('Nothing today.');
    expect(client.stats.calls).toBe(2);
  });

  it('a silent model hits the first-token timeout as a classified timeout', async () => {
    process.env.BURROW_AI_FIRST_TOKEN_TIMEOUT_MS = '40';
    installFakeOllama(fetch, { chat: hangingChat });
    const client = await getAiClient({ purpose: 'chat' });
    const err = await client.complete({ messages: [{ role: 'user', content: 'hi' }] }).catch((e) => e);
    expect(err).toMatchObject({ code: 'timeout', isTimeout: true, timeoutKind: 'first_token' });
  });

  it('Ollama dying mid-call surfaces as ollama_unavailable', async () => {
    const state = installFakeOllama(fetch);
    const client = await getAiClient({ purpose: 'chat' });
    fetch.mockImplementation(async (url) => {
      state.urls.push(url);
      throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    });
    const err = await client.complete({ messages: [{ role: 'user', content: 'hi' }] }).catch((e) => e);
    expect(err).toBeInstanceOf(AiUnavailableError);
    expect(err.code).toBe('ollama_unavailable');
  });
});
