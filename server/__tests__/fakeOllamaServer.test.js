import { afterEach, describe, expect, it } from 'vitest';
import { parseArgs } from '../../scripts/fakeOllama.js';
import {
  DEFAULT_MODELS,
  FAKE_MODEL_NAME,
  PLAIN_REPLY,
  TOOL_DONE_REPLY,
  defaultChatReply,
  isWriteRequest,
  startFakeOllama,
} from '../../scripts/lib/fakeOllamaServer.js';

const TOOLS = [{ type: 'function', function: { name: 'add_todo', parameters: {} } }];
const post = (url, path, body) =>
  fetch(`${url}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const ndjson = async (res) =>
  (await res.text())
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));

describe('startFakeOllama', () => {
  let fake;
  afterEach(async () => {
    await fake?.close();
    fake = null;
  });

  it('binds loopback on a free port and refuses 11434 and non-loopback hosts', async () => {
    fake = await startFakeOllama();
    expect(fake.url).toBe(`http://127.0.0.1:${fake.port}`);
    expect(fake.port).not.toBe(11434);
    await expect(startFakeOllama({ port: 11434 })).rejects.toThrow(/11434/);
    await expect(startFakeOllama({ host: '0.0.0.0' })).rejects.toThrow(/loopback/);
    await expect(startFakeOllama({ host: '192.168.1.5' })).rejects.toThrow(/loopback/);
    await expect(startFakeOllama({ port: -1 })).rejects.toThrow(/port/);
  });

  it('answers version, tags (one small tool-capable model) and show', async () => {
    fake = await startFakeOllama();
    expect((await (await fetch(`${fake.url}/api/version`)).json()).version).toMatch(/fake/);
    const tags = await (await fetch(`${fake.url}/api/tags`)).json();
    expect(tags.models.map((m) => m.name)).toEqual([FAKE_MODEL_NAME]);
    expect(tags.models[0].capabilities).toContain('tools');
    const show = await (await post(fake.url, '/api/show', { model: FAKE_MODEL_NAME })).json();
    expect(show.capabilities).toContain('tools');
    expect(show.model_info['llama.context_length']).toBeGreaterThan(0);
    expect((await post(fake.url, '/api/show', { model: 'nope:1b' })).status).toBe(404);
  });

  it('answers anything else with 404 and records every request', async () => {
    fake = await startFakeOllama();
    expect((await fetch(`${fake.url}/api/unknown`)).status).toBe(404);
    expect((await fetch(`${fake.url}/`)).status).toBe(404);
    expect((await fetch(`${fake.url}/api/chat`)).status).toBe(404);
    await post(fake.url, '/api/show', { model: FAKE_MODEL_NAME });
    expect(fake.requests.map((r) => `${r.method} ${r.path}`)).toEqual(['GET /api/unknown', 'GET /', 'GET /api/chat', 'POST /api/show']);
    expect(fake.requests[3].body).toEqual({ model: FAKE_MODEL_NAME });
  });

  it('streams a plain NDJSON chat reply that ends with done', async () => {
    fake = await startFakeOllama();
    const res = await post(fake.url, '/api/chat', { model: FAKE_MODEL_NAME, messages: [{ role: 'user', content: 'hello' }], stream: true });
    const frames = await ndjson(res);
    expect(frames.at(-1).done).toBe(true);
    expect(frames.slice(0, -1).map((f) => f.message.content).join('')).toBe(PLAIN_REPLY);
    expect(frames.some((f) => f.message.tool_calls)).toBe(false);
  });

  it('answers a non-streaming chat with one JSON object', async () => {
    fake = await startFakeOllama();
    const res = await post(fake.url, '/api/chat', { model: FAKE_MODEL_NAME, messages: [{ role: 'user', content: 'hello' }], stream: false });
    const body = await res.json();
    expect(body.done).toBe(true);
    expect(body.message.content).toBe(PLAIN_REPLY);
  });

  it('returns an add_todo tool call for a write-ish question when the tool is offered', async () => {
    fake = await startFakeOllama();
    const messages = [{ role: 'user', content: 'Please add a todo: water the plants' }];
    const frames = await ndjson(await post(fake.url, '/api/chat', { model: FAKE_MODEL_NAME, messages, tools: TOOLS }));
    const call = frames.find((f) => f.message.tool_calls)?.message.tool_calls[0];
    expect(call.function).toEqual({ name: 'add_todo', arguments: { title: 'water the plants' } });
    const plain = await ndjson(await post(fake.url, '/api/chat', { model: FAKE_MODEL_NAME, messages })); // no tools offered
    expect(plain.some((f) => f.message.tool_calls)).toBe(false);
  });

  it('closes the loop after a tool result with fixed copy', async () => {
    fake = await startFakeOllama();
    const messages = [
      { role: 'user', content: 'add a todo' },
      { role: 'assistant', content: '', tool_calls: [{ function: { name: 'add_todo', arguments: {} } }] },
      { role: 'tool', content: '{"queued":true}' },
    ];
    const frames = await ndjson(await post(fake.url, '/api/chat', { model: FAKE_MODEL_NAME, messages, tools: TOOLS }));
    expect(frames.slice(0, -1).map((f) => f.message.content).join('')).toBe(TOOL_DONE_REPLY);
  });

  it('lets a chat hook override the reply and falls back when it returns undefined', async () => {
    fake = await startFakeOllama({ chat: (body) => (body.messages[0].content === 'custom' ? 'Custom reply.' : undefined) });
    const custom = await (await post(fake.url, '/api/chat', { stream: false, messages: [{ role: 'user', content: 'custom' }] })).json();
    expect(custom.message.content).toBe('Custom reply.');
    const other = await (await post(fake.url, '/api/chat', { stream: false, messages: [{ role: 'user', content: 'x' }] })).json();
    expect(other.message.content).toBe(PLAIN_REPLY);
  });

  it('simulates a pull with canned frames, never downloading, and lists the model afterwards', async () => {
    fake = await startFakeOllama();
    const frames = await ndjson(await post(fake.url, '/api/pull', { model: 'llama3.2:1b', stream: true }));
    expect(frames.at(-1)).toEqual({ status: 'success' });
    expect(frames.some((f) => f.total === 1000)).toBe(true);
    const tags = await (await fetch(`${fake.url}/api/tags`)).json();
    expect(tags.models.map((m) => m.name)).toContain('llama3.2:1b');
  });

  it('can refuse pulls', async () => {
    fake = await startFakeOllama({ pull: 'refuse' });
    const res = await post(fake.url, '/api/pull', { model: 'llama3.2:1b' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/does not download/);
  });

  it('takes a custom model list and does not mutate the shared defaults', async () => {
    const custom = [{ name: 'tiny:1b', model: 'tiny:1b', capabilities: ['completion'], details: { context_length: 2048 } }];
    fake = await startFakeOllama({ models: custom });
    expect((await (await fetch(`${fake.url}/api/tags`)).json()).models.map((m) => m.name)).toEqual(['tiny:1b']);
    await fake.close();
    fake = await startFakeOllama();
    await post(fake.url, '/api/pull', { model: 'llama3.2:1b' });
    expect(DEFAULT_MODELS.map((m) => m.name)).toEqual([FAKE_MODEL_NAME]);
  });

  it('survives a malformed body', async () => {
    fake = await startFakeOllama();
    const res = await fetch(`${fake.url}/api/chat`, { method: 'POST', body: '{not json' });
    expect(res.status).toBe(200);
    expect((await ndjson(res)).at(-1).done).toBe(true);
  });
});

describe('defaultChatReply', () => {
  it('detects write-ish questions', () => {
    for (const t of ['add a todo', 'Please create a task for friday', 'remind me with a reminder', 'New to-do: call mom']) {
      expect(isWriteRequest(t), t).toBe(true);
    }
    for (const t of ['what is on my todo list', 'how is my budget', '']) expect(isWriteRequest(t), t).toBe(false);
  });

  it('uses a fixed default title when none is given and never echoes computed numbers', () => {
    const reply = defaultChatReply({ messages: [{ role: 'user', content: 'add a todo' }], tools: TOOLS });
    expect(reply.tool_calls[0].function.arguments.title).toBe('Try the sandbox');
    expect(PLAIN_REPLY).not.toMatch(/\d/);
    expect(TOOL_DONE_REPLY).not.toMatch(/\d/);
  });

  it('greets the user with name and time of day in home weather overview advice', () => {
    const weatherData = JSON.stringify({
      data: {
        weather: {
          current: { tempF: 61, condition: 'Mainly Clear' },
          days: [{ highF: 71, lowF: 54 }],
        },
      },
    });
    const textMorning = `<page_context_12345678 page="Home">\n${weatherData}\n</page_context_12345678>\nLocal time: 08:30.\n\nReview this page`;
    const messages = [
      { role: 'system', content: "You are Javi. The user's name is Sam. Use it occasionally." },
      { role: 'user', content: textMorning },
    ];
    const reply = defaultChatReply({ messages });
    expect(reply.content).toMatch(/^Good morning, Sam\. 61°, mainly clear\. Today 71° \/ 54°\. Umbrella weather\./);

    const textEvening = `<page_context_12345678 page="Home">\n${weatherData}\n</page_context_12345678>\nLocal time: 18:00.\n\nReview this page`;
    const replyEvening = defaultChatReply({ messages: [{ role: 'system', content: "The user's name is Sam." }, { role: 'user', content: textEvening }] });
    expect(replyEvening.content).toMatch(/^Good evening, Sam\. 61°, mainly clear\./);

    const replyNoName = defaultChatReply({ messages: [{ role: 'system', content: 'You are Javi.' }, { role: 'user', content: textMorning }] });
    expect(replyNoName.content).toMatch(/^Good morning\. 61°, mainly clear\./);

    const noWeatherData = JSON.stringify({ data: { todos: ['renew library card'] } });
    const textNoWeather = `<page_context_12345678 page="Home">\n${noWeatherData}\n</page_context_12345678>\nLocal time: 08:30.\n\nReview this page`;
    const replyNoWeather = defaultChatReply({ messages: [{ role: 'system', content: "The user's name is Sam." }, { role: 'user', content: textNoWeather }] });
    expect(replyNoWeather.content).toBe('Good morning, Sam. Two todos are due today, and your budget is on track.');
  });
});

describe('fakeOllama CLI args', () => {
  it('defaults to a free port, parses --port and refuses 11434', () => {
    expect(parseArgs([])).toEqual({ port: 0 });
    expect(parseArgs(['--port', '47001'])).toEqual({ port: 47001 });
    expect(() => parseArgs(['--port', '11434'])).toThrow(/11434/);
    expect(() => parseArgs(['--port'])).toThrow(/--port/);
    expect(() => parseArgs(['--port', 'abc'])).toThrow(/--port/);
    expect(() => parseArgs(['--bogus'])).toThrow(/Unknown argument/);
  });
});
