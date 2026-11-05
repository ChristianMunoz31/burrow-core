// Security review fixes for cloud AI: consent and categories cannot be written outside the
// consent flow (importer, state route), earlier assistant and tool rows written by a local model
// never reach a cloud provider, advice threads are user-only under cloud, a long Jarvis run stops
// when cloud is turned off or a category is withheld, consent is bound to the exact base URL,
// literal-IP SSRF ranges and the page-context allowlist. Fake provider only (api.example.com,
// sk-test-fake); nothing real is contacted.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
// Pro is on for this file (the Pro gate itself is covered in proGating.test.js).
vi.mock('../license/index.js', async (importOriginal) => (await import('./helpers/pro.js')).mockLicenseModule(importOriginal));
import request from 'supertest';
import { strToU8, zipSync } from 'fflate';

vi.mock('../../loadEnv.js', () => ({}));
vi.mock('node-fetch', () => ({ default: vi.fn() }));

import fetch from 'node-fetch';
import { CLOUD_HOST, SENTINELS, configureCloud, installCloudAndOllama, resetCloud } from './helpers/fakeCloud.js';
import { scanModelCalls } from './helpers/modelCallScan.js';
import { closeTestDb, createTestDb, resetDb, rowsOf } from './helpers/testDb.js';
import { __resetAiForTests, getAiClient } from '../ai/index.js';
import { CLOUD_CONSENT_ACKS, getCloudConsent, isConsentCurrent } from '../ai/consent.js';
import { isPublicIp } from '../ai/cloudGuard.js';
import { CLOUD_CATEGORY_IDS, applyPagePolicy, cloudHistoryUserRows, createAiPolicy } from '../ai/privacy.js';
import { listAudit } from '../audit.js';
import { validateCloudBaseUrl } from '../ai/settings.js';
import { importZipBuffer } from '../import/importExport.js';
import { getState, setState } from '../dataAccess.js';

let app;
let db;
let ip = 0;
const nextIp = () => `198.51.100.${(ip += 1) % 250}`;
const saved = Object.fromEntries(['APP_PASSWORD', 'AUTH_SECRET', 'SECRETS_ENCRYPTION_KEY', 'JARVIS_CONFIRM_WRITES', 'BURROW_AI'].map((k) => [k, process.env[k]]));

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

const ISO = '2026-01-01T00:00:00.000Z';
const BASE = 'https://api.example.com/v1';
const goodConsent = (extra = {}) => ({ version: 1, host: CLOUD_HOST, baseUrl: BASE, acceptedAt: ISO, acknowledgements: [...CLOUD_CONSENT_ACKS], ...extra });

function exportZip(appStateRows) {
  const manifest = { format: 'burrow-export', formatVersion: 2, tables: [{ id: 'app_state' }] };
  return zipSync({
    'manifest.json': strToU8(JSON.stringify(manifest)),
    'json/app_state.json': strToU8(JSON.stringify(appStateRows)),
  });
}
const row = (key, value) => ({ key, value, updated_at: ISO });

// ---------------------------------------------------------------------------------------------
describe('C1: consent and categories are not writable outside the consent flow', () => {
  it('the importer skips every ai.cloud* key as protected and reports it', async () => {
    const result = importZipBuffer(
      exportZip([
        row('ai.cloudConsent', goodConsent()),
        row('ai.cloudCategories', { journal: true, health: true, notes: true }),
        row('ai.cloudHint', { lastShownAt: ISO }),
        row('network.optIn', { cloudAi: true }),
        row('AI.CloudConsent', goodConsent()),
        row('theme', 'dark'),
      ]),
    );
    const t = result.tables.find((x) => x.id === 'app_state');
    expect(t.skippedReasons.protected).toBe(5);
    expect(t.inserted).toBe(1);
    const keys = rowsOf(db, 'app_state').map((r) => r.key);
    expect(keys).toContain('theme');
    expect(keys).not.toContain('ai.cloudConsent');
    expect(keys).not.toContain('AI.CloudConsent');
    // Rows that existed before the import (reset to empty values) are untouched.
    for (const key of ['ai.cloudCategories', 'ai.cloudHint', 'network.optIn']) expect(await getState(key, null), key).toEqual({});
  });

  it('an imported consent row cannot turn cloud on: getAiClient stays local', async () => {
    await configureCloud({ consent: false });
    importZipBuffer(exportZip([row('ai.cloudConsent', goodConsent({ baseUrl: 'https://api.example.com/v1' })), row('ai.cloudCategories', { journal: true })]));
    __resetAiForTests();
    installCloudAndOllama(fetch);
    expect(await getCloudConsent()).toBeNull();
    const client = await getAiClient({ purpose: 'chat' });
    expect(client.provider).toBe('ollama');
    expect(client.isCloud).toBeFalsy();
  });

  it('an imported ai.settings loses provider and cloud; the saved provider and endpoint stay', async () => {
    await configureCloud({ provider: 'ollama' });
    const result = importZipBuffer(
      exportZip([
        row('ai.settings', {
          provider: 'openai_compat',
          chatModel: 'llama3.2:3b',
          cloud: { baseUrl: 'https://evil.example.net/v1', model: 'gpt-evil', tokenParam: null },
        }),
      ]),
    );
    expect(result.tables[0].skippedReasons.protected).toBe(0);
    const settings = await getState('ai.settings', null);
    expect(settings.provider).toBe('ollama');
    expect(settings.cloud.baseUrl).toBe('https://api.example.com/v1');
    expect(settings.chatModel).toBe('llama3.2:3b');
    __resetAiForTests();
    installCloudAndOllama(fetch);
    expect((await getAiClient({ purpose: 'chat' })).provider).toBe('ollama');
  });

  it('with no saved ai.settings an import adds only the harmless model preference', async () => {
    importZipBuffer(exportZip([row('ai.settings', { provider: 'openai_compat', chatModel: 'llama3.2:3b', cloud: { baseUrl: 'https://api.example.com/v1' } })]));
    expect(await getState('ai.settings', null)).toEqual({ chatModel: 'llama3.2:3b' });
  });

  it.each(['ai.cloudConsent', 'ai.cloudCategories', 'ai.cloudHint', 'ai.settings', 'network.optIn'])('PUT /api/state/%s is refused with 403', async (key) => {
    const before = await getState(key, null);
    const res = await request(app)
      .put(`/api/state/${key}`)
      .set('X-Forwarded-For', nextIp())
      .send({ value: key === 'ai.cloudConsent' ? goodConsent() : { journal: true } });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'protected_key' });
    expect(await getState(key, null)).toEqual(before);
  });

  it('other keys are still writable through the state route', async () => {
    const res = await request(app).put('/api/state/theme').set('X-Forwarded-For', nextIp()).send({ value: 'dark' });
    expect(res.status).toBe(200);
  });

  it('a hand-written consent without the acknowledgements, a baseUrl or a valid acceptedAt is not current', () => {
    expect(isConsentCurrent(goodConsent(), CLOUD_HOST, BASE)).toBe(true);
    expect(isConsentCurrent(goodConsent({ baseUrl: undefined }), CLOUD_HOST, BASE)).toBe(false);
    expect(isConsentCurrent(goodConsent({ baseUrl: '' }), CLOUD_HOST, BASE)).toBe(false);
    expect(isConsentCurrent(goodConsent({ acknowledgements: [] }), CLOUD_HOST, BASE)).toBe(false);
    expect(isConsentCurrent(goodConsent({ acknowledgements: ['sends_data'] }), CLOUD_HOST, BASE)).toBe(false);
    expect(isConsentCurrent(goodConsent({ acknowledgements: ['pay_provider'] }), CLOUD_HOST, BASE)).toBe(false);
    expect(isConsentCurrent(goodConsent({ acceptedAt: '' }), CLOUD_HOST, BASE)).toBe(false);
    expect(isConsentCurrent(goodConsent({ acceptedAt: 'not a date' }), CLOUD_HOST, BASE)).toBe(false);
    expect(isConsentCurrent(goodConsent({ acceptedAt: undefined }), CLOUD_HOST, BASE)).toBe(false);
  });

  it('a stored consent row missing the acks leaves the registry on local', async () => {
    await configureCloud({ consent: { version: 1, host: CLOUD_HOST, baseUrl: BASE, acceptedAt: ISO } });
    installCloudAndOllama(fetch);
    expect((await getAiClient({ purpose: 'chat' })).provider).toBe('ollama');
  });
});

// ---------------------------------------------------------------------------------------------
describe('H3: advice threads under cloud', () => {
  const advise = (body) => request(app).post('/api/jarvis/advice').set('X-Forwarded-For', nextIp()).send(body);
  const THREAD = [
    { role: 'user', content: 'how is my health?' },
    { role: 'assistant', content: `Your sleep notes: ${SENTINELS.health}` },
    { role: 'user', content: 'and today?' },
  ];

  it('a Home thread holding a local health answer sends only the last user message', async () => {
    await configureCloud();
    const { cloud } = installCloudAndOllama(fetch, { replies: ['Fine.'] });
    const context = JSON.stringify({ mode: 'all', widgets: [], briefing: null, briefingAt: null, alerts: [] });
    const res = await advise({ page: 'home', context, messages: THREAD });
    expect(res.status).toBe(200);
    expect(cloud.sent()).not.toContain(SENTINELS.health);
    expect(cloud.sent()).not.toContain('how is my health?');
    expect(cloud.sent()).toContain('and today?');
  });

  it('a single-category page drops prior assistant messages and keeps the user questions', async () => {
    await configureCloud();
    const { cloud } = installCloudAndOllama(fetch, { replies: ['Fine.'] });
    const res = await advise({ page: 'todos', context: '{"todos":[]}', messages: THREAD });
    expect(res.status).toBe(200);
    expect(cloud.sent()).not.toContain(SENTINELS.health);
    expect(cloud.sent()).toContain('how is my health?');
    expect(cloud.sent()).toContain('and today?');
    expect(cloud.bodies[0].messages.map((m) => m.role)).toEqual(['system', 'user']);
  });

  it('applyPagePolicy: user messages only, joined, on a single page; last user only on mixed pages', () => {
    const policy = createAiPolicy({ isCloud: true, categories: null });
    const single = applyPagePolicy({ page: 'todos', context: '{}', messages: THREAD }, policy);
    expect(single.messages).toEqual([{ role: 'user', content: 'how is my health?\n\nand today?' }]);
    const home = applyPagePolicy({ page: 'home', context: '{}', messages: THREAD }, policy);
    expect(home.messages).toEqual([{ role: 'user', content: 'and today?' }]);
  });

  it('local advice is unfiltered', () => {
    const policy = createAiPolicy({ isCloud: false });
    expect(applyPagePolicy({ page: 'home', context: '{}', messages: THREAD }, policy).messages).toEqual(THREAD);
  });
});

// ---------------------------------------------------------------------------------------------
describe('L4: page context allowlist under cloud', () => {
  const policy = createAiPolicy({ isCloud: true, categories: Object.fromEntries(CLOUD_CATEGORY_IDS.map((id) => [id, true])) });
  it('home keeps only the keys the builder emits', () => {
    const context = JSON.stringify({
      mode: 'all',
      widgets: ['a'],
      briefing: 'b',
      briefingAt: ISO,
      alerts: [{ kind: 'todo', severity: 'info', text: 't', extra: SENTINELS.journal }],
      rows: [SENTINELS.journal],
      secret: SENTINELS.notes,
    });
    const out = JSON.parse(applyPagePolicy({ page: 'home', context, messages: [] }, policy).context);
    expect(Object.keys(out).sort()).toEqual(['alerts', 'briefing', 'briefingAt', 'mode', 'widgets']);
    expect(out.alerts).toEqual([{ kind: 'todo', severity: 'info', text: 't' }]);
    expect(JSON.stringify(out)).not.toContain('SENTINEL');
  });
  it('data-browser keeps only tables, active and searching, with only their known fields', () => {
    const context = JSON.stringify({
      tables: [{ id: 'todos', label: 'Todos', group: 'g', count: 2, status: 'ok', sample: SENTINELS.todo }],
      active: { id: 'todos', view: 'rows', page: 1, pageSize: 25, total: 2, columns: ['title'], firstRow: SENTINELS.todo },
      searching: false,
      rows: [{ title: SENTINELS.todo }],
    });
    const out = JSON.parse(applyPagePolicy({ page: 'data-browser', context, messages: [] }, policy).context);
    expect(Object.keys(out).sort()).toEqual(['active', 'searching', 'tables']);
    expect(JSON.stringify(out)).not.toContain('SENTINEL');
    expect(out.tables[0]).toEqual({ id: 'todos', label: 'Todos', group: 'g', count: 2, status: 'ok' });
  });
});

// ---------------------------------------------------------------------------------------------
describe('L1: consent is bound to the exact base URL', () => {
  const putCloud = (body) => request(app).put('/api/settings/ai/cloud').set('X-Forwarded-For', nextIp()).send(body);

  it('a new path on the same host clears consent and goes back to local', async () => {
    await configureCloud();
    installCloudAndOllama(fetch);
    const res = await putCloud({ baseUrl: 'https://api.example.com/v2' });
    expect(res.status).toBe(200);
    expect(res.body.data.cloud.consent.current).toBe(false);
    expect(res.body.data.provider).toBe('ollama');
    expect(await getCloudConsent()).toBeNull();
  });

  it('saving the same URL again (even with a trailing slash) keeps consent', async () => {
    await configureCloud();
    installCloudAndOllama(fetch);
    const res = await putCloud({ baseUrl: 'https://api.example.com/v1/' });
    expect(res.status).toBe(200);
    expect(res.body.data.cloud.consent.current).toBe(true);
    expect(res.body.data.provider).toBe('openai_compat');
  });

  it('enable stores the normalized base URL, and a consent for another path is not current', async () => {
    await configureCloud({ consent: false, provider: 'ollama' });
    installCloudAndOllama(fetch);
    const res = await request(app)
      .post('/api/settings/ai/cloud/enable')
      .set('X-Forwarded-For', nextIp())
      .send({ version: 1, host: CLOUD_HOST, baseUrl: BASE, acknowledgements: [...CLOUD_CONSENT_ACKS] });
    expect(res.status).toBe(200);
    const consent = await getCloudConsent();
    expect(consent.baseUrl).toBe('https://api.example.com/v1');
    expect(isConsentCurrent(consent, CLOUD_HOST, 'https://api.example.com/v1')).toBe(true);
    expect(isConsentCurrent(consent, CLOUD_HOST, 'https://api.example.com/other')).toBe(false);
  });

  it('a stored consent for one path does not cover a saved base URL with another', async () => {
    await configureCloud({ consent: goodConsent({ baseUrl: 'https://api.example.com/v0' }) });
    installCloudAndOllama(fetch);
    expect((await getAiClient({ purpose: 'chat' })).provider).toBe('ollama');
  });
});

// ---------------------------------------------------------------------------------------------
describe('L3: literal-IP ranges that look public but are not', () => {
  it.each([
    '192.88.99.1',
    '100::1',
    'fec0::1',
    'fec0:0:0:1::5',
    '64:ff9b:1::1',
    '64:ff9b::a00:1',
    '64:ff9b::10.0.0.1',
    '::ffff:0:a00:1',
    '::ffff:0:10.0.0.1',
    '::ffff:0:7f00:1',
    '0:0:0:0:ffff:0:c0a8:1',
    '0:0:0:0:0:ffff:a00:1',
  ])('%s is not public', (addr) => {
    expect(isPublicIp(addr)).toBe(false);
  });

  it.each(['::ffff:0:808:808', '::ffff:8.8.8.8', '2606:4700:4700::1111', '8.8.8.8'])('%s stays public', (addr) => {
    expect(isPublicIp(addr)).toBe(true);
  });

  it.each([
    'https://192.88.99.1/v1',
    'https://[100::1]/v1',
    'https://[fec0::1]/v1',
    'https://[64:ff9b:1::1]/v1',
    'https://[64:ff9b::a00:1]/v1',
    'https://[::ffff:0:a00:1]/v1',
  ])('validateCloudBaseUrl refuses %s and cloudConfig stays local', async (baseUrl) => {
    expect(validateCloudBaseUrl(baseUrl)).toEqual({ ok: false, reason: 'private_address' });
    await configureCloud({ baseUrl });
    installCloudAndOllama(fetch);
    const client = await getAiClient({ purpose: 'chat' });
    expect(client.provider).toBe('ollama');
    expect(fetch.mock.calls.some(([u]) => String(u).includes('example'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
describe('M2: the scope scan in aiBoundary', () => {
  const problems = (src) => scanModelCalls(src).problems;
  it('accepts an object literal with a real scope key', () => {
    expect(scanModelCalls('ai.complete({ messages, scope: { categories: [] } });')).toEqual({ calls: 1, problems: [] });
    expect(problems("await ai['chatWithTools']({ messages, 'scope': prep.scope })")).toEqual([]);
    expect(problems('for await (const e of ai.stream({ messages, scope })) {}')).toEqual([]);
  });
  it('flags a missing scope, even when the word appears elsewhere', () => {
    expect(problems('ai.complete({ messages, maxTokens: 10 });')).toHaveLength(1);
    expect(problems('// scope: here\nai.complete({ messages }); /* scope */')).toHaveLength(1);
    expect(problems("ai.complete({ messages, note: 'scope' })")).toHaveLength(1);
    expect(problems('ai.complete({ messages, [scope]: 1 })')).toHaveLength(1);
  });
  it('flags scope: undefined, void 0, and a non-literal first argument', () => {
    expect(problems('ai.complete({ messages, scope: undefined })')).toHaveLength(1);
    expect(problems('ai.stream({ messages, scope: void 0 })')).toHaveLength(1);
    expect(problems('ai.complete(opts)')).toHaveLength(1);
    expect(problems('ai.complete({ ...opts })')).toHaveLength(1);
    expect(problems('ai.complete()')).toHaveLength(1);
  });
  it('sees bracket access and optional calls', () => {
    expect(problems("ai['complete']({ messages })")).toHaveLength(1);
    expect(problems('ai.stream?.({ messages })')).toHaveLength(1);
    expect(problems('ai[`chatWithTools`](opts)')).toHaveLength(1);
  });
  it('ignores unrelated calls and mentions in strings or comments', () => {
    expect(scanModelCalls("x.then(() => 1); const s = 'ai.complete(opts)'; // ai.complete(opts)")).toEqual({ calls: 0, problems: [] });
  });
});

// ---------------------------------------------------------------------------------------------
describe('re-review: withheld local turns never send their user prompt to the cloud', () => {
  const call = (id, name, args = '{}') => ({ id, type: 'function', function: { name, arguments: args } });

  it('the withheld turn and every later turn are dropped, earlier clean turns stay', () => {
    const policy = createAiPolicy({ isCloud: true, categories: null });
    const rows = [
      { role: 'user', content: 'clean one' },
      { role: 'assistant', content: '', toolCalls: [call('a', 'list_todos')] },
      { role: 'user', content: 'private one' },
      { role: 'assistant', content: '', toolCalls: [call('b', 'list_journal')] },
      { role: 'user', content: 'later one' },
      { role: 'assistant', content: 'plain reply' },
    ];
    expect(cloudHistoryUserRows(rows, policy).map((r) => r.content)).toEqual(['clean one']);
  });

  it('an unknown tool taints its turn; search_data with only allowed kinds does not; string or object arguments both parse', () => {
    const policy = createAiPolicy({ isCloud: true, categories: null });
    const unknown = [{ role: 'user', content: 'u' }, { role: 'assistant', content: '', toolCalls: [call('a', 'mystery_tool')] }];
    expect(cloudHistoryUserRows(unknown, policy)).toEqual([]);
    const ok = [
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: '', toolCalls: [call('a', 'search_data', '{"kinds":["todos","bookmarks"]}')] },
      { role: 'user', content: 'u2' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'b', function: { name: 'search_data', arguments: { kinds: ['todos'] } } }] },
    ];
    expect(cloudHistoryUserRows(ok, policy).map((r) => r.content)).toEqual(['u1', 'u2']);
  });

  it('M1: string, object or undecodable tool_calls taint; null is clean unless a tool row is orphaned', () => {
    const policy = createAiPolicy({ isCloud: true, categories: null });
    const turn = (toolCalls, extra = []) => [
      { role: 'user', content: 'p' },
      { role: 'assistant', content: '', toolCalls },
      ...extra,
      { role: 'user', content: 'q' },
    ];
    const sent = (rows) => cloudHistoryUserRows(rows, policy).map((r) => r.content);
    // A double-encoded value decodes to a string: parsed once, then judged like an array.
    expect(sent(turn(JSON.stringify([call('a', 'add_journal_entry')])))).toEqual([]);
    expect(sent(turn(JSON.stringify([call('a', 'list_todos')])))).toEqual(['p', 'q']);
    expect(sent(turn('{not json'))).toEqual([]);
    expect(sent(turn(JSON.stringify(JSON.stringify([call('a', 'list_todos')]))))).toEqual([]);
    // An object (not an array) cannot be inspected.
    expect(sent(turn({ id: 'a', function: { name: 'list_todos' } }))).toEqual([]);
    // null with no tool row is a plain reply.
    expect(sent(turn(null))).toEqual(['p', 'q']);
    // null with a tool row nobody declared: provenance unknown.
    expect(sent(turn(null, [{ role: 'tool', content: '{}', toolCallId: 'x' }]))).toEqual([]);
    expect(sent(turn(null, [{ role: 'tool', content: '{}' }]))).toEqual([]);
    // A tool row that answers a call declared in the same turn is fine.
    expect(sent(turn([call('a', 'list_todos')], [{ role: 'tool', content: '{}', toolCallId: 'a' }]))).toEqual(['p', 'q']);
    // A declaration in an earlier turn does not cover a later turn's tool row.
    const split = [
      { role: 'user', content: 'p' },
      { role: 'assistant', content: '', toolCalls: [call('a', 'list_todos')] },
      { role: 'user', content: 'q' },
      { role: 'tool', content: '{}', toolCallId: 'a' },
    ];
    expect(sent(split)).toEqual(['p']);
  });

  it('M2: a user row directly followed by another user row shares the next turn fate', () => {
    const policy = createAiPolicy({ isCloud: true, categories: null });
    const sent = (rows) => cloudHistoryUserRows(rows, policy).map((r) => r.content);
    // Runs X and Y interleave: X user, Y user, X assistant (private write).
    const tainted = [
      { role: 'user', content: 'X private' },
      { role: 'user', content: 'Y innocent' },
      { role: 'assistant', content: '', toolCalls: [call('a', 'add_journal_entry')] },
      { role: 'user', content: 'later' },
    ];
    expect(sent(tainted)).toEqual([]);
    const clean = [
      { role: 'user', content: 'X' },
      { role: 'user', content: 'Y' },
      { role: 'assistant', content: 'plain' },
      { role: 'user', content: 'later' },
    ];
    expect(sent(clean)).toEqual(['X', 'Y', 'later']);
    // An earlier clean turn survives a tainted interleaved pair.
    expect(sent([{ role: 'user', content: 'ok' }, { role: 'assistant', content: 'r' }, ...tainted])).toEqual(['ok']);
  });

});

// ---------------------------------------------------------------------------------------------
describe('re-review: imported ai.settings cannot repoint the Ollama host', () => {
  it('ollamaHost from the archive is ignored and the saved one is kept', async () => {
    await setState('ai.settings', { provider: 'ollama', ollamaHost: 'http://192.168.0.5:11434' });
    importZipBuffer(exportZip([row('ai.settings', { chatModel: 'llama3.2:3b', ollamaHost: 'http://203.0.113.9:11434' })]));
    const settings = await getState('ai.settings', null);
    expect(settings.ollamaHost).toBe('http://192.168.0.5:11434');
    expect(settings.chatModel).toBe('llama3.2:3b');
  });

  it('with no saved host, an imported one is not added', async () => {
    importZipBuffer(exportZip([row('ai.settings', { chatModel: 'llama3.2:3b', ollamaHost: 'http://203.0.113.9:11434' })]));
    expect(await getState('ai.settings', null)).toEqual({ chatModel: 'llama3.2:3b' });
  });
});

// ---------------------------------------------------------------------------------------------
describe('re-review: page context values under cloud', () => {
  const policy = createAiPolicy({ isCloud: true, categories: Object.fromEntries(CLOUD_CATEGORY_IDS.map((id) => [id, true])) });
  const home = (extra) => JSON.parse(applyPagePolicy({ page: 'home', context: JSON.stringify({ mode: 'all', widgets: [], ...extra }), messages: [] }, policy).context);
  const browser = (extra) => JSON.parse(applyPagePolicy({ page: 'data-browser', context: JSON.stringify({ tables: [], searching: false, ...extra }), messages: [] }, policy).context);

  it.each(['all', 'work', 'home'])('home mode %s is kept', (mode) => {
    expect(home({ mode }).mode).toBe(mode);
  });
  it.each([[SENTINELS.journal], [5], [null], [{ a: 1 }]])('home mode %j is dropped', (mode) => {
    expect(home({ mode })).not.toHaveProperty('mode');
  });
  it('home widgets: short strings kept; non-array, non-string, long or too many dropped', () => {
    expect(home({ widgets: ['todos', 'habits'] }).widgets).toEqual(['todos', 'habits']);
    expect(home({ widgets: SENTINELS.journal })).not.toHaveProperty('widgets');
    expect(home({ widgets: [{ note: SENTINELS.journal }] })).not.toHaveProperty('widgets');
    expect(home({ widgets: [SENTINELS.journal.repeat(10)] })).not.toHaveProperty('widgets');
    expect(home({ widgets: Array.from({ length: 21 }, () => 'a') })).not.toHaveProperty('widgets');
  });
  it('data-browser: active without a string id, or on a disallowed table, is deleted', () => {
    expect(browser({ active: { id: 'todos', view: 'rows' } }).active).toEqual({ id: 'todos', view: 'rows' });
    expect(browser({ active: { view: 'rows', columns: [SENTINELS.journal] } })).not.toHaveProperty('active');
    expect(browser({ active: { id: 7 } })).not.toHaveProperty('active');
    expect(browser({ active: { id: 'secrets_table' } })).not.toHaveProperty('active');
    const strict = createAiPolicy({ isCloud: true, categories: null });
    const out = JSON.parse(applyPagePolicy({ page: 'data-browser', context: JSON.stringify({ tables: [], active: { id: 'journal' } }), messages: [] }, strict).context);
    expect(out).not.toHaveProperty('active');
  });
  it('data-browser: table entries that are not objects with a string id are dropped; non-array tables is removed', () => {
    const out = browser({ tables: ['todos', null, 5, { id: 9 }, { id: 'todos', label: 'Todos' }] });
    expect(out.tables).toEqual([{ id: 'todos', label: 'Todos' }]);
    expect(browser({ tables: SENTINELS.todo })).not.toHaveProperty('tables');
  });
});

// ---------------------------------------------------------------------------------------------
describe('re-review: turning cloudAi off in Network settings ends the cloud setup', () => {
  const putNetwork = (body) => request(app).put('/api/settings/network').set('X-Forwarded-For', nextIp()).send(body);

  it('clears consent, returns the provider to ollama and writes a disabled audit row', async () => {
    await configureCloud();
    const res = await putNetwork({ id: 'cloudAi', enabled: false });
    expect(res.status).toBe(200);
    expect(await getCloudConsent()).toBeNull();
    expect((await getState('ai.settings', null)).provider).toBe('ollama');
    const rows = (await listAudit({ limit: 100 })).entries.filter((e) => e.feature === 'cloud_ai_consent');
    expect(rows.map((r) => r.meta.action)).toEqual(['disabled']);
    __resetAiForTests();
    installCloudAndOllama(fetch);
    expect((await getAiClient({ purpose: 'chat' })).provider).toBe('ollama');
  });

  it('turning it on, or another feature off, does not touch consent', async () => {
    await configureCloud();
    expect((await putNetwork({ id: 'cloudAi', enabled: true })).status).toBe(200);
    expect((await putNetwork({ id: 'weather', enabled: false })).status).toBe(200);
    expect(await getCloudConsent()).not.toBeNull();
    expect((await getState('ai.settings', null)).provider).toBe('openai_compat');
  });
});
