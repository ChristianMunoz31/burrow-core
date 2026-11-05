// Javi page advice (POST /api/jarvis/advice, JSON and SSE) on a cloud provider: a page whose
// category is withheld makes no model call, mixed pages (home, data browser) are filtered, only
// the question is sent when something was withheld, and local Ollama gets everything.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

vi.mock('../../loadEnv.js', () => ({}));
vi.mock('node-fetch', () => ({ default: vi.fn() }));

import fetch from 'node-fetch';
import { textReply } from './helpers/fakeOllama.js';
import { CLOUD_HOST, SENTINELS, configureCloud, installCloudAndOllama, resetCloud } from './helpers/fakeCloud.js';
import { closeTestDb, createTestDb, resetDb } from './helpers/testDb.js';
import { MSG_CLOUD_DISABLED, __resetAiForTests, getAiClient, isAiQueueFull, withheldMessage } from '../ai/index.js';
import { disableCloudAi } from '../aiSettingsRoutes.js';
import { generateAdvice, streamAdvice } from '../javi/advisorService.js';

let app;
let db;
let ip = 0;
const nextIp = () => `192.0.2.${(ip += 1) % 250}`;
const saved = Object.fromEntries(['APP_PASSWORD', 'AUTH_SECRET', 'SECRETS_ENCRYPTION_KEY', 'BURROW_AI'].map((k) => [k, process.env[k]]));
const SSE = 'text/event-stream';

beforeAll(async () => {
  for (const k of Object.keys(saved)) delete process.env[k];
  db = createTestDb();
  app = (await import('../../server.js')).default;
});
afterAll(async () => {
  await resetCloud();
  closeTestDb(db);
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
beforeEach(async () => {
  resetDb(db);
  fetch.mockReset();
  await resetCloud();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

const advise = (body, { sse = false } = {}) => {
  const req = request(app).post('/api/jarvis/advice').set('X-Forwarded-For', nextIp());
  if (sse) req.set('Accept', SSE);
  return req.send(body);
};
const frames = (text) =>
  text
    .split('\n\n')
    .filter((b) => b.startsWith('event:'))
    .map((b) => {
      const [e, d] = b.split('\n');
      return { event: e.slice(7), data: JSON.parse(d.slice(6)) };
    });

const JOURNAL_CONTEXT = JSON.stringify({ entries: [{ title: 'Day', body: SENTINELS.journal }] });
const HISTORY = [
  { role: 'user', content: 'earlier question' },
  { role: 'assistant', content: `earlier answer mentioning ${SENTINELS.health}` },
  { role: 'user', content: 'the real question' },
];

describe('a page whose category is withheld', () => {
  it('JSON: blocked, deterministic copy, no model call, nothing sent', async () => {
    await configureCloud();
    const { cloud } = installCloudAndOllama(fetch);
    const res = await advise({ page: 'journal', context: JOURNAL_CONTEXT, messages: [{ role: 'user', content: 'how am I doing?' }] });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      content: withheldMessage(['journal']),
      model: 'cloud-model',
      provider: 'openai_compat',
      ai: { kind: 'cloud', host: CLOUD_HOST },
      withheld: ['journal'],
      notice: withheldMessage(['journal']),
      blocked: true,
    });
    expect(res.body.data.content).toBe("Your journal isn't shared with cloud AI. You can change that in Settings > AI.");
    expect(cloud.requests).toHaveLength(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('SSE: meta first, no deltas, done carries the notice as the content', async () => {
    await configureCloud({ categories: { budget: false } });
    const { cloud } = installCloudAndOllama(fetch);
    const res = await advise({ page: 'budget-planner', context: '{"plan":1}', messages: [] }, { sse: true });
    const ev = frames(res.text);
    expect(ev.map((e) => e.event)).toEqual(['meta', 'done']);
    expect(ev[0].data).toEqual({ ai: { kind: 'cloud', host: CLOUD_HOST } });
    expect(ev[1].data).toMatchObject({ content: withheldMessage(['budget']), notice: withheldMessage(['budget']), blocked: true, withheld: ['budget'], provider: 'openai_compat' });
    expect(ev[1].data.content).toBe(ev[1].data.notice);
    expect(cloud.requests).toHaveLength(0);
  });

  it.each([
    ['todos', 'todos'],
    ['habits', 'habits'],
    ['focus', 'focus'],
    ['countdowns', 'countdowns'],
    ['calendar', 'calendar'],
    ['bookmarks', 'bookmarks'],
    ['subscriptions', 'budget'],
  ])('page %s is blocked when %s is turned off', async (page, category) => {
    await configureCloud({ categories: { [category]: false } });
    const { cloud } = installCloudAndOllama(fetch);
    const res = await advise({ page, context: '{"x":1}', messages: [] });
    expect(res.body.data).toMatchObject({ blocked: true, withheld: [category] });
    expect(cloud.requests).toHaveLength(0);
  });

  it.each(['notes', 'journal', 'health'])('page %s is blocked by default (off until the user ticks it)', async (page) => {
    await configureCloud();
    const { cloud } = installCloudAndOllama(fetch);
    expect((await advise({ page, context: '{}', messages: [] })).body.data.blocked).toBe(true);
    expect(cloud.requests).toHaveLength(0);
  });

  it('is allowed once the user ticks the category, and then the context is sent', async () => {
    await configureCloud({ categories: { journal: true } });
    const { cloud } = installCloudAndOllama(fetch, { replies: ['- Keep writing.'] });
    const res = await advise({ page: 'journal', context: JOURNAL_CONTEXT, messages: [{ role: 'user', content: 'how am I doing?' }] });
    expect(res.body.data).toMatchObject({ blocked: false, withheld: [], notice: null, content: '- Keep writing.' });
    expect(cloud.sent()).toContain(SENTINELS.journal);
  });
});

describe('a page that is shared', () => {
  it('JSON: calls the provider with the page context and reports the cloud source', async () => {
    await configureCloud();
    const { cloud } = installCloudAndOllama(fetch, { replies: ['- Pay the rent today.'] });
    const res = await advise({ page: 'todos', context: '{"open":[{"title":"Pay rent"}]}', messages: [{ role: 'user', content: 'what first?' }] });
    expect(res.body.data).toEqual({
      content: '- Pay the rent today.',
      model: 'cloud-model',
      provider: 'openai_compat',
      ai: { kind: 'cloud', host: CLOUD_HOST },
      withheld: [],
      notice: null,
      blocked: false,
    });
    expect(cloud.sent()).toContain('Pay rent');
  });

  it('SSE: meta first, deltas, then done with the new fields', async () => {
    await configureCloud();
    installCloudAndOllama(fetch, { replies: ['One two three'] });
    const res = await advise({ page: 'todos', context: '{}', messages: [] }, { sse: true });
    const ev = frames(res.text);
    expect(ev[0]).toEqual({ event: 'meta', data: { ai: { kind: 'cloud', host: CLOUD_HOST } } });
    expect(ev.some((e) => e.event === 'delta')).toBe(true);
    expect(ev.at(-1)).toEqual({
      event: 'done',
      data: { content: 'One two three', model: 'cloud-model', provider: 'openai_compat', ai: { kind: 'cloud', host: CLOUD_HOST }, withheld: [], notice: null, blocked: false },
    });
  });

  it('settings has no category: always shared', async () => {
    await configureCloud();
    const { cloud } = installCloudAndOllama(fetch, { replies: ['ok'] });
    expect((await advise({ page: 'settings', context: '{"t":1}', messages: [] })).body.data.blocked).toBe(false);
    expect(cloud.requests).toHaveLength(1);
  });

  it('weather is not a page of its own (it shows in the Javi card on Home)', async () => {
    await configureCloud();
    installCloudAndOllama(fetch, { replies: ['ok'] });
    expect((await advise({ page: 'weather', context: '{"t":1}', messages: [] })).status).toBe(400);
  });
});

describe('the home page (mixed)', () => {
  const home = {
    mode: 'all',
    widgets: ['budget'],
    briefing: `Briefing text ${SENTINELS.health}`,
    briefingAt: '2026-01-01T07:00:00.000Z',
    alerts: [
      { kind: 'todo', severity: 'warn', text: '2 overdue todos' },
      { kind: 'health', severity: 'warn', text: `Low readiness ${SENTINELS.health}` },
      { kind: 'budget', severity: 'info', text: 'Spending is up' },
    ],
  };

  it('drops the briefing and withheld alerts, keeps shared alerts, and sends only the last question', async () => {
    await configureCloud();
    const { cloud } = installCloudAndOllama(fetch, { replies: ['- Start with the todos.'] });
    const res = await advise({ page: 'home', context: JSON.stringify(home), messages: HISTORY });
    expect(res.body.data).toMatchObject({
      blocked: false,
      withheld: ['health'],
      notice: withheldMessage(['health']),
      content: '- Start with the todos.',
    });
    const sent = cloud.sent();
    expect(sent).not.toContain(SENTINELS.health);
    expect(sent).not.toContain('Briefing text');
    expect(sent).toContain('2 overdue todos');
    expect(sent).toContain('Spending is up');
    expect(sent).toContain('the real question');
    expect(sent).not.toContain('earlier question');
    expect(sent).not.toContain('earlier answer');
    const userTurns = cloud.bodies[0].messages.filter((m) => m.role === 'user');
    expect(userTurns).toHaveLength(1);
  });

  it('keeps the briefing but sends only the last user message when everything it covers is shared', async () => {
    await configureCloud({ categories: { health: true } });
    const { cloud } = installCloudAndOllama(fetch, { replies: ['ok'] });
    const only = { ...home, alerts: [{ kind: 'todo', text: 't' }], briefing: 'Plain briefing.' };
    const res = await advise({ page: 'home', context: JSON.stringify(only), messages: HISTORY.slice(0, 1).concat([{ role: 'assistant', content: 'earlier answer' }, HISTORY[2]]) });
    expect(res.body.data.withheld).toEqual([]);
    expect(cloud.sent()).toContain('Plain briefing.');
    expect(cloud.sent()).not.toContain('earlier answer');
  });

  it('never sends the weather facts the Javi card adds to the home context', async () => {
    await configureCloud();
    const { cloud } = installCloudAndOllama(fetch, { replies: ['ok'] });
    const withWeather = { ...home, weather: { current: { tempF: 70, condition: 'Weather sentinel sky' }, days: [] } };
    await advise({ page: 'home', context: JSON.stringify(withWeather), messages: HISTORY });
    expect(cloud.sent()).not.toContain('Weather sentinel sky');
    expect(cloud.sent()).toContain('2 overdue todos');
  });

  it('an unparseable home context becomes the fixed note', async () => {
    await configureCloud();
    const { cloud } = installCloudAndOllama(fetch, { replies: ['ok'] });
    await advise({ page: 'home', context: `not json ${SENTINELS.journal}`, messages: HISTORY });
    expect(cloud.sent()).toContain('Page details are not shared with cloud AI.');
    expect(cloud.sent()).not.toContain(SENTINELS.journal);
    expect(cloud.sent()).not.toContain('earlier question');
  });
});

describe('the data browser page (mixed)', () => {
  const context = JSON.stringify({
    tables: [
      { id: 'todos', label: 'Todos', count: 3 },
      { id: 'journal', label: `Journal ${SENTINELS.journal}`, count: 40 },
      { id: 'notes', label: 'Notes', count: 5 },
      { id: 'app_state', label: 'App state', count: 9 },
    ],
    active: { id: 'journal', view: 'rows', columns: ['body'] },
    searching: false,
  });

  it('removes withheld tables and the active table, keeps the rest', async () => {
    await configureCloud();
    const { cloud } = installCloudAndOllama(fetch, { replies: ['ok'] });
    const res = await advise({ page: 'data-browser', context, messages: HISTORY });
    expect(res.body.data.withheld).toEqual(['notes', 'journal']);
    const sent = cloud.sent();
    expect(sent).not.toContain(SENTINELS.journal);
    expect(sent).not.toContain('"id":"journal"');
    expect(sent).not.toContain('"id":"notes"');
    expect(sent).toContain('todos');
    expect(sent).toContain('app_state');
    expect(sent).not.toContain('earlier question');
  });
});

describe('local Ollama is unaffected', () => {
  it('sends the full context, history and every page, with no notice', async () => {
    const side = installCloudAndOllama(fetch, { ollama: { replies: [textReply('- Fine.')] } });
    const res = await advise({ page: 'journal', context: JOURNAL_CONTEXT, messages: HISTORY });
    expect(res.body.data).toMatchObject({ content: '- Fine.', provider: 'ollama', ai: { kind: 'local', host: null }, withheld: [], notice: null, blocked: false });
    const sent = JSON.stringify(side.local.chatBodies);
    expect(sent).toContain(SENTINELS.journal);
    expect(sent).toContain('earlier question');
    expect(side.cloud.requests).toHaveLength(0);
  });

  it('SSE meta reports local', async () => {
    installCloudAndOllama(fetch, { ollama: { chat: () => textReply('Hi there') } });
    const ev = frames((await advise({ page: 'todos', context: '{}', messages: [] }, { sse: true })).text);
    expect(ev[0]).toEqual({ event: 'meta', data: { ai: { kind: 'local', host: null } } });
  });
});

describe('the service directly', () => {
  const input = (page, context = '{}') => ({ page, pageLabel: page, context, messages: [{ role: 'user', content: 'q' }] });

  it('cross insights style: an explicit scope skips the page policy', async () => {
    await configureCloud();
    const { cloud } = installCloudAndOllama(fetch, { replies: ['Explained.'] });
    const client = await getAiClient({ purpose: 'chat' });
    // home would be filtered by the page policy; with a scope the caller owns the filtering.
    const out = await generateAdvice(input('home', '{"findings":[]}'), { client, scope: { categories: ['budget', 'calendar'], withheld: ['health'] } });
    expect(out).toMatchObject({ content: 'Explained.', withheld: ['health'], blocked: false, notice: withheldMessage(['health']) });
    expect(cloud.sent()).toContain('findings');
  });

  it('a scope naming a withheld category fails with a 403 before anything is sent', async () => {
    await configureCloud();
    const { cloud } = installCloudAndOllama(fetch);
    const client = await getAiClient({ purpose: 'chat' });
    const err = await generateAdvice(input('home'), { client, scope: { categories: ['journal'] } }).catch((e) => e);
    expect(err).toMatchObject({ httpStatus: 403, code: 'cloud_scope_denied', publicMessage: withheldMessage(['journal']) });
    expect(cloud.requests).toHaveLength(0);
  });

  it('streamAdvice on a blocked page resolves without a delta', async () => {
    await configureCloud();
    installCloudAndOllama(fetch);
    const client = await getAiClient({ purpose: 'chat' });
    const onDelta = vi.fn();
    const out = await streamAdvice(input('notes'), { client, onDelta });
    expect(out).toMatchObject({ blocked: true, calls: 0, content: withheldMessage(['notes']) });
    expect(onDelta).not.toHaveBeenCalled();
  });

  it('an error carries the context that was actually sent, for the audit row', async () => {
    await configureCloud();
    fetch.mockRejectedValue(Object.assign(new Error('boom'), { code: 'ECONNREFUSED' }));
    const client = await getAiClient({ purpose: 'chat' });
    const err = await generateAdvice(input('home', JSON.stringify({ briefing: SENTINELS.health, alerts: [{ kind: 'todo', text: 't' }] })), { client }).catch((e) => e);
    expect(err.sentContext).toBeTypeOf('string');
    expect(err.sentContext).not.toContain(SENTINELS.health);
    expect(err.sentContext).toContain('"todo"');
  });
});

describe('cloud turned off while an advice stream is queued', () => {
  it('SSE: error cloud_disabled with fixed copy, a clean close, and nothing reached the cloud', async () => {
    const savedMax = process.env.BURROW_AI_QUEUE_MAX;
    process.env.BURROW_AI_QUEUE_MAX = '1';
    try {
      await configureCloud();
      installCloudAndOllama(fetch);
      const answer = fetch.getMockImplementation();
      let openGate;
      const gate = new Promise((resolve) => {
        openGate = resolve;
      });
      let cloudRequests = 0;
      fetch.mockImplementation(async (url, init) => {
        if (new URL(String(url)).hostname !== CLOUD_HOST) return answer(url, init);
        cloudRequests += 1;
        await gate; // holds the single queue slot
        return answer(url, init);
      });
      const holder = (await getAiClient({ purpose: 'chat' })).complete({ messages: [{ role: 'user', content: 'hold' }], scope: { categories: [] } });
      await vi.waitFor(() => expect(cloudRequests).toBe(1));

      // The stream starts while cloud is on, then waits in the queue behind `holder`.
      const pending = advise({ page: 'budget-planner', context: '{"plan":1}', messages: [{ role: 'user', content: 'hi' }] }, { sse: true }).then((r) => r);
      await vi.waitFor(() => expect(isAiQueueFull()).toBe(true));

      await disableCloudAi();
      openGate();
      await holder.catch(() => {});
      const res = await pending;

      const ev = frames(res.text);
      expect(ev.map((e) => e.event)).toEqual(['meta', 'error']);
      expect(ev[1].data).toEqual({ error: MSG_CLOUD_DISABLED, code: 'cloud_disabled' });
      expect(res.text.trimEnd().endsWith('}')).toBe(true);
      expect(cloudRequests).toBe(1); // the holder only
    } finally {
      if (savedMax === undefined) delete process.env.BURROW_AI_QUEUE_MAX;
      else process.env.BURROW_AI_QUEUE_MAX = savedMax;
      __resetAiForTests();
    }
  });
});
