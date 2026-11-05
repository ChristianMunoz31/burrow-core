// The cloud choke point: enforceCloudScope and createAiClient events(). A cloud call without a
// scope, or with a withheld category in it, throws before the transport; tool data of a withheld
// category (current turn or earlier local turns) is replaced before anything is sent; local
// clients are untouched.
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../loadEnv.js', () => ({}));

import { createAiClient } from '../ai/registry.js';
import { CLOUD_CATEGORY_DEFAULTS, CloudScopeError, createAiPolicy, enforceCloudScope, withheldToolResult } from '../ai/privacy.js';
import { classifyAiError } from '../ai/index.js';

const SECRET = 'SENTINEL_JOURNAL_scope1';
const NOTE = 'SENTINEL_NOTE_scope2';
const cloud = (categories = {}) => createAiPolicy({ isCloud: true, categories: { ...CLOUD_CATEGORY_DEFAULTS, ...categories } });
const local = () => createAiPolicy({ isCloud: false });

const call = (id, name, args = {}) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const assistantCalls = (...calls) => ({ role: 'assistant', content: '', tool_calls: calls });
const tool = (id, content) => ({ role: 'tool', tool_call_id: id, content: typeof content === 'string' ? content : JSON.stringify(content) });
const scope = (extra = {}) => ({ categories: [], ...extra });
// An opaque tool list: the scope layer passes it through untouched.
const TOOL_LIST = Object.freeze([{ type: 'function', function: { name: 'list_todos', description: 'List todos.', parameters: { type: 'object', properties: {} } } }]);

describe('enforceCloudScope: scope checks', () => {
  const messages = [{ role: 'user', content: 'hi' }];

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a string', 'todos'],
    ['an empty object', {}],
    ['categories not an array', { categories: 'todos' }],
    ['a non-string category', { categories: [1] }],
  ])('throws cloud_scope_missing for %s', (_label, bad) => {
    expect(() => enforceCloudScope({ messages, scope: bad, policy: cloud() })).toThrow(CloudScopeError);
    try {
      enforceCloudScope({ messages, scope: bad, policy: cloud() });
    } catch (err) {
      expect(err.code).toBe('cloud_scope_missing');
    }
  });

  it('throws cloud_scope_denied naming every withheld, internal or unknown category', () => {
    for (const bad of [['journal'], ['memory'], ['bogus'], ['todos', 'health']]) {
      let thrown;
      try {
        enforceCloudScope({ messages, scope: { categories: bad }, policy: cloud() });
      } catch (err) {
        thrown = err;
      }
      expect(thrown, bad.join()).toBeInstanceOf(CloudScopeError);
      expect(thrown.code).toBe('cloud_scope_denied');
    }
    try {
      enforceCloudScope({ messages, scope: { categories: ['todos', 'health', 'journal'] }, policy: cloud() });
    } catch (err) {
      expect(err.categories).toEqual(['health', 'journal']);
    }
  });

  it('accepts shared categories and returns them with the messages', () => {
    const out = enforceCloudScope({ messages, tools: [{ x: 1 }], scope: { categories: ['todos', 'budget'] }, policy: cloud() });
    expect(out.shared).toEqual(['budget', 'todos']);
    expect(out.tools).toEqual([{ x: 1 }]);
    expect(out.messages).toEqual(messages);
  });

  it('a category turned on by the user is accepted (settings are read at call time)', () => {
    expect(() => enforceCloudScope({ messages, scope: { categories: ['journal'] }, policy: cloud({ journal: true }) })).not.toThrow();
  });

  it('local returns the input unchanged and ignores the scope', () => {
    const tools = [{ x: 1 }];
    const out = enforceCloudScope({ messages, tools, scope: undefined, policy: local() });
    expect(out.messages).toBe(messages);
    expect(out.tools).toBe(tools);
    expect(enforceCloudScope({ messages, scope: { categories: ['journal', 'memory'] }, policy: local() }).messages).toBe(messages);
  });

  it('the denial classifies to a 403 with the fixed withheld copy', () => {
    const err = new CloudScopeError('cloud_scope_denied', ['journal']);
    expect(classifyAiError(err)).toEqual({
      code: 'cloud_scope_denied',
      message: "Your journal isn't shared with cloud AI. You can change that in Settings > AI.",
      retryMs: null,
      httpStatus: 403,
    });
  });
});

describe('enforceCloudScope: tool results', () => {
  it('replaces a withheld tool result in the current turn and blanks the arguments of its call', () => {
    const messages = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'what did I write?' },
      assistantCalls(call('c1', 'list_journal', { limit: 3 }), call('c2', 'list_todos')),
      tool('c1', { entries: [{ body: SECRET }] }),
      tool('c2', { todos: [{ title: 'Call the plumber' }] }),
    ];
    const out = enforceCloudScope({ messages, scope: scope(), policy: cloud() });
    const text = JSON.stringify(out.messages);
    expect(text).not.toContain(SECRET);
    expect(out.messages[3]).toEqual({ role: 'tool', tool_call_id: 'c1', content: JSON.stringify(withheldToolResult('journal')) });
    expect(out.messages[4].content).toContain('Call the plumber');
    expect(out.messages[2].tool_calls[0].function.arguments).toBe('{}');
    expect(out.messages[2].tool_calls[1].function.arguments).toBe('{}');
    expect(out.shared).toEqual(['todos']);
    expect(out.withheld).toEqual(['journal']);
  });

  it('keeps the arguments of calls whose category is shared', () => {
    const messages = [{ role: 'user', content: 'x' }, assistantCalls(call('c1', 'get_calendar', { days: 3 })), tool('c1', { events: [] })];
    const out = enforceCloudScope({ messages, scope: scope(), policy: cloud() });
    expect(out.messages[1].tool_calls[0].function.arguments).toBe('{"days":3}');
  });

  it('weather has no category and passes untouched', () => {
    const messages = [{ role: 'user', content: 'x' }, assistantCalls(call('c1', 'get_weather')), tool('c1', { current: { temperature_2m: 3 } })];
    expect(enforceCloudScope({ messages, scope: scope(), policy: cloud() }).messages[2].content).toContain('temperature_2m');
  });

  it('every withheld tool is replaced, whichever category it maps to', () => {
    const cases = [
      ['list_notes', 'notes'],
      ['get_health', 'health'],
      ['add_journal_entry', 'journal'],
      ['add_note', 'notes'],
    ];
    for (const [name, category] of cases) {
      const messages = [{ role: 'user', content: 'x' }, assistantCalls(call('c1', name)), tool('c1', { leak: SECRET })];
      const out = enforceCloudScope({ messages, scope: scope(), policy: cloud() });
      expect(JSON.stringify(out.messages), name).not.toContain(SECRET);
      expect(JSON.parse(out.messages[2].content)).toMatchObject({ not_shared: true, category });
    }
  });

  it('an orphan tool message (no matching call) and an unknown tool are replaced by the generic placeholder', () => {
    const orphan = enforceCloudScope({ messages: [{ role: 'user', content: 'x' }, tool('nope', { leak: SECRET })], scope: scope(), policy: cloud() });
    expect(JSON.stringify(orphan.messages)).not.toContain(SECRET);
    const unknown = enforceCloudScope({
      messages: [{ role: 'user', content: 'x' }, assistantCalls(call('c1', 'format_disk')), tool('c1', { leak: SECRET })],
      scope: scope(),
      policy: cloud(),
    });
    expect(JSON.stringify(unknown.messages)).not.toContain(SECRET);
    expect(JSON.parse(unknown.messages[2].content)).toMatchObject({ not_shared: true, category: null });
  });

  it('leaves the tool list alone', () => {
    const out = enforceCloudScope({ messages: [{ role: 'user', content: 'x' }], tools: TOOL_LIST, scope: scope(), policy: cloud() });
    expect(out.tools).toBe(TOOL_LIST);
  });
});

describe('enforceCloudScope: search_data results', () => {
  const results = [
    { kind: 'todo', id: '1', title: 'Pay rent' },
    { kind: 'journal', id: '2', title: SECRET },
    { kind: 'note', id: '3', title: NOTE },
    { kind: 'bookmark', id: '4', title: 'Docs' },
    { kind: 'transaction', id: '5', title: 'Cafe' },
    { kind: 'mystery', id: '6', title: 'unknown kind' },
  ];
  const messages = (content) => [{ role: 'user', content: 'find it' }, assistantCalls(call('c1', 'search_data', { query: 'x' })), tool('c1', content)];

  it('filters result items by their own kind, dropping withheld and unknown kinds', () => {
    const out = enforceCloudScope({ messages: messages({ query: 'x', results }), scope: scope(), policy: cloud() });
    const parsed = JSON.parse(out.messages[2].content);
    expect(parsed.query).toBe('x');
    expect(parsed.results.map((r) => r.kind)).toEqual(['todo', 'bookmark', 'transaction']);
    expect(out.messages[2].content).not.toContain(SECRET);
    expect(out.messages[2].content).not.toContain(NOTE);
    expect(out.shared).toEqual(['budget', 'todos', 'bookmarks']);
    expect(out.withheld).toEqual(['notes', 'journal']);
  });

  it('an unparseable or oddly shaped result becomes the placeholder', () => {
    for (const bad of ['not json {' + SECRET, JSON.stringify({ results: 'x', leak: SECRET }), JSON.stringify([SECRET])]) {
      const out = enforceCloudScope({ messages: messages(bad), scope: scope(), policy: cloud() });
      expect(out.messages[2].content).not.toContain(SECRET);
      expect(JSON.parse(out.messages[2].content).not_shared).toBe(true);
    }
  });

  it('shares every kind when the user shares every category', () => {
    const all = createAiPolicy({ isCloud: true, categories: { notes: true, journal: true } });
    const parsed = JSON.parse(enforceCloudScope({ messages: messages({ query: 'x', results }), scope: scope(), policy: all }).messages[2].content);
    expect(parsed.results.map((r) => r.kind)).toEqual(['todo', 'journal', 'note', 'bookmark', 'transaction']);
  });
});

describe('enforceCloudScope: earlier local turns', () => {
  // A turn answered locally with a journal tool, then an ordinary turn built on it.
  const earlier = [
    { role: 'user', content: 'tell me about my week' },
    assistantCalls(call('h1', 'list_journal')),
    tool('h1', { entries: [{ body: SECRET }] }),
    { role: 'assistant', content: `You wrote about ${SECRET}.` },
    { role: 'user', content: 'summarize that in five words' },
    { role: 'assistant', content: `Short: ${SECRET} summary.` },
  ];

  it('drops a turn that used a withheld tool entirely, user message and answer included', () => {
    const messages = [{ role: 'system', content: 'sys' }, ...earlier.slice(0, 4), { role: 'user', content: 'what is due today?' }];
    const out = enforceCloudScope({ messages, scope: scope(), policy: cloud() });
    expect(out.messages).toEqual([{ role: 'system', content: 'sys' }, { role: 'user', content: 'what is due today?' }]);
    expect(out.withheld).toEqual(['journal']);
  });

  it('also drops every later earlier turn, which may have been answered from the withheld data', () => {
    const messages = [{ role: 'system', content: 'sys' }, ...earlier, { role: 'user', content: 'and now?' }];
    const out = enforceCloudScope({ messages, scope: scope(), policy: cloud() });
    expect(JSON.stringify(out.messages)).not.toContain(SECRET);
    expect(out.messages.map((m) => m.role)).toEqual(['system', 'user']);
  });

  it('keeps earlier turns that came before the withheld one and turns that used shared tools', () => {
    const shared = [
      { role: 'user', content: 'todos?' },
      assistantCalls(call('s1', 'list_todos')),
      tool('s1', { todos: [{ title: 'Pay rent' }] }),
      { role: 'assistant', content: 'One todo: Pay rent.' },
    ];
    const messages = [...shared, ...earlier, { role: 'user', content: 'now' }];
    const out = enforceCloudScope({ messages, scope: scope(), policy: cloud() });
    expect(out.messages.slice(0, 4)).toEqual(shared);
    expect(out.messages).toHaveLength(5);
    expect(JSON.stringify(out.messages)).not.toContain(SECRET);
  });

  it('keeps everything when the earlier tool category is now shared', () => {
    const messages = [...earlier.slice(0, 4), { role: 'user', content: 'now' }];
    const out = enforceCloudScope({ messages, scope: scope(), policy: cloud({ journal: true }) });
    expect(out.messages).toHaveLength(5);
  });

  it('a tool call to an unknown tool in an earlier turn taints that turn too', () => {
    const messages = [{ role: 'user', content: 'a' }, assistantCalls(call('u1', 'format_disk')), tool('u1', { x: SECRET }), { role: 'user', content: 'b' }];
    const out = enforceCloudScope({ messages, scope: scope(), policy: cloud() });
    expect(JSON.stringify(out.messages)).not.toContain(SECRET);
  });

  it('system messages are never dropped', () => {
    const messages = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'a' }, assistantCalls(call('x1', 'list_notes')), tool('x1', {}), { role: 'system', content: 'nudge' }, { role: 'user', content: 'b' }];
    const out = enforceCloudScope({ messages, scope: scope(), policy: cloud() });
    expect(out.messages.filter((m) => m.role === 'system').map((m) => m.content)).toEqual(['sys']);
  });
});

describe('createAiClient: the single choke point', () => {
  const transportSpy = () => {
    const calls = [];
    const transport = async function* (opts) {
      calls.push(opts);
      yield { type: 'token', text: 'ok' };
      yield { type: 'done', usage: null, finishReason: 'stop' };
    };
    return { transport, calls };
  };
  const cloudClient = (categories) => {
    const spy = transportSpy();
    const client = createAiClient({
      provider: 'openai_compat',
      kind: 'cloud',
      aiHost: 'api.example.com',
      policy: cloud(categories),
      model: 'm',
      purpose: 'chat',
      numCtx: 8192,
      transport: spy.transport,
      authorizeSend: async () => ({}),
    });
    return { client, ...spy };
  };
  const msgs = [{ role: 'user', content: 'hi' }];

  it('complete, stream and chatWithTools all throw before the transport without a scope', async () => {
    const { client, calls } = cloudClient();
    await expect(client.complete({ messages: msgs })).rejects.toMatchObject({ code: 'cloud_scope_missing' });
    await expect(
      (async () => {
        for await (const ev of client.stream({ messages: msgs })) void ev;
      })(),
    ).rejects.toMatchObject({ code: 'cloud_scope_missing' });
    await expect(client.chatWithTools({ messages: msgs, tools: TOOL_LIST })).rejects.toMatchObject({ code: 'cloud_scope_missing' });
    expect(calls).toHaveLength(0);
    expect(client.stats.calls).toBe(0);
  });

  it('refuses a withheld category in the scope before the transport', async () => {
    const { client, calls } = cloudClient();
    await expect(client.complete({ messages: msgs, scope: { categories: ['journal'] } })).rejects.toMatchObject({ code: 'cloud_scope_denied', categories: ['journal'] });
    expect(calls).toHaveLength(0);
  });

  it('sends the filtered messages to the transport and keeps the data report (names only)', async () => {
    const { client, calls } = cloudClient();
    const messages = [
      { role: 'user', content: 'journal?' },
      assistantCalls(call('c1', 'list_journal')),
      tool('c1', { entries: [{ body: SECRET }] }),
    ];
    const out = await client.chatWithTools({ messages, tools: TOOL_LIST, scope: { categories: ['todos'], withheld: ['health'] } });
    expect(out.message.content).toBe('ok');
    expect(calls).toHaveLength(1);
    expect(JSON.stringify(calls[0].messages)).not.toContain(SECRET);
    expect(calls[0].tools).toBe(TOOL_LIST);
    expect(client.dataReport()).toEqual({ shared: ['todos'], withheld: ['health', 'journal'] });
    expect(client.ai).toEqual({ kind: 'cloud', host: 'api.example.com' });
    expect(client.isCloud).toBe(true);
  });

  it('a cloud client built without a policy defaults to the cloud defaults, never to allow-all', async () => {
    const spy = transportSpy();
    const client = createAiClient({ provider: 'openai_compat', model: 'm', purpose: 'chat', numCtx: 8192, transport: spy.transport, authorizeSend: async () => ({}) });
    await expect(client.complete({ messages: msgs, scope: { categories: ['journal'] } })).rejects.toMatchObject({ code: 'cloud_scope_denied' });
    expect(spy.calls).toHaveLength(0);
  });

  it('a local client needs no scope and receives every message untouched', async () => {
    const spy = transportSpy();
    const client = createAiClient({ provider: 'ollama', model: 'm', purpose: 'chat', numCtx: 8192, host: 'http://127.0.0.1:11434', transport: spy.transport });
    const messages = [{ role: 'user', content: 'x' }, assistantCalls(call('c1', 'list_journal')), tool('c1', { entries: [{ body: SECRET }] })];
    await client.chatWithTools({ messages, tools: TOOL_LIST });
    expect(JSON.stringify(spy.calls[0].messages)).toContain(SECRET);
    expect(client.ai).toEqual({ kind: 'local', host: null });
    expect(client.isCloud).toBe(false);
    expect(client.dataReport()).toEqual({ shared: [], withheld: [] });
  });

  it('a LAN Ollama client is treated as local: every category passes', async () => {
    const spy = transportSpy();
    const client = createAiClient({ provider: 'ollama', kind: 'lan', aiHost: '192.0.2.50', model: 'm', purpose: 'chat', numCtx: 8192, transport: spy.transport });
    await client.complete({ messages: [{ role: 'user', content: SECRET }], scope: { categories: ['journal'] } });
    expect(JSON.stringify(spy.calls[0].messages)).toContain(SECRET);
    expect(client.ai).toEqual({ kind: 'lan', host: '192.0.2.50' });
  });
});
