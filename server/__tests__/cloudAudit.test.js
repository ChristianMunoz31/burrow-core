// Audit rows for cloud AI record where data went (kind, host) and which category NAMES were
// shared or withheld, never content. A sentinel planted in withheld data, and the API key, must
// never appear in any audit row, whatever route wrote it.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
// Pro is on for this file (the Pro gate itself is covered in proGating.test.js).
import request from 'supertest';

vi.mock('../../loadEnv.js', () => ({}));
vi.mock('node-fetch', () => ({ default: vi.fn() }));

import fetch from 'node-fetch';
import { textReply } from './helpers/fakeOllama.js';
import { CLOUD_HOST, CLOUD_KEY, SENTINELS, configureCloud, installCloudAndOllama, resetCloud } from './helpers/fakeCloud.js';
import { closeTestDb, createTestDb, resetDb, rowsOf } from './helpers/testDb.js';
import { aiAuditMeta } from '../ai/privacy.js';
import { createAiClient } from '../ai/registry.js';
import { normalizeAuditEvent } from '../audit.js';

let app;
let db;
let ip = 0;
const nextIp = () => `192.0.2.${(ip += 1) % 250}`;
const saved = Object.fromEntries(['APP_PASSWORD', 'AUTH_SECRET', 'SECRETS_ENCRYPTION_KEY', 'BURROW_AI'].map((k) => [k, process.env[k]]));

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

const post = (path, body, headers = {}) => {
  const req = request(app).post(path).set('X-Forwarded-For', nextIp());
  for (const [k, v] of Object.entries(headers)) req.set(k, v);
  return req.send(body);
};
const rows = (feature) => rowsOf(db, 'audit_log').filter((r) => (feature ? r.feature === feature : true));
const everything = () => JSON.stringify(rowsOf(db, 'audit_log'));
const expectClean = () => {
  const all = everything();
  for (const s of Object.values(SENTINELS)) expect(all, s).not.toContain(s);
  expect(all).not.toContain(CLOUD_KEY);
};
describe('advice', () => {
  it('a blocked cloud page records the host and the withheld name, and none of the page context', async () => {
    await configureCloud();
    installCloudAndOllama(fetch);
    const res = await post('/api/jarvis/advice', { page: 'journal', context: JSON.stringify({ body: SENTINELS.journal }), messages: [{ role: 'user', content: 'how am I doing?' }] });
    expect(res.body.data.blocked).toBe(true);
    const [row] = rows('javi_advice');
    expect(row).toMatchObject({ kind: 'llm', page: 'journal', provider: 'openai_compat', status: 'ok' });
    expect(row.meta).toEqual({ calls: 0, ms: expect.any(Number), ai_kind: 'cloud', ai_host: CLOUD_HOST, shared: [], withheld: ['journal'] });
    expect(row.context).not.toContain(SENTINELS.journal);
    expectClean();
  });

  it('a cloud home page records only the filtered context, with shared and withheld names', async () => {
    await configureCloud();
    installCloudAndOllama(fetch, { replies: ['- ok'] });
    const context = JSON.stringify({ briefing: `text ${SENTINELS.health}`, alerts: [{ kind: 'todo', text: 'overdue todos' }, { kind: 'health', text: `readiness ${SENTINELS.health}` }] });
    await post('/api/jarvis/advice', { page: 'home', context, messages: [{ role: 'user', content: 'what now?' }] });
    const [row] = rows('javi_advice');
    expect(row.meta).toMatchObject({ ai_kind: 'cloud', ai_host: CLOUD_HOST, calls: 1, shared: ['todos'], withheld: ['health'] });
    expect(row.context).toContain('overdue todos');
    expect(row.context).toContain('what now?');
    expectClean();
  });

  it('a failed cloud call still records only what was sent', async () => {
    await configureCloud();
    fetch.mockRejectedValue(Object.assign(new Error(`down ${SENTINELS.memory}`), { code: 'ECONNREFUSED' }));
    const context = JSON.stringify({ briefing: SENTINELS.health, alerts: [{ kind: 'todo', text: 'a todo' }] });
    const res = await post('/api/jarvis/advice', { page: 'home', context, messages: [{ role: 'user', content: 'q' }] });
    expect(res.status).toBeGreaterThanOrEqual(500);
    const [row] = rows('javi_advice');
    expect(row.status).toBe('error');
    expect(row.meta).toMatchObject({ ai_kind: 'cloud', ai_host: CLOUD_HOST });
    expect(row.context).toContain('a todo');
    expectClean();
  });

  it('a local call records only ai_kind local: no host, no category lists', async () => {
    installCloudAndOllama(fetch, { ollama: { replies: [textReply('- fine')] } });
    await post('/api/jarvis/advice', { page: 'journal', context: JSON.stringify({ body: 'local text' }), messages: [{ role: 'user', content: 'q' }] });
    const [row] = rows('javi_advice');
    expect(row.meta).toEqual({ calls: 1, ms: expect.any(Number), ai_kind: 'local' });
    expect(row.context).toContain('local text');
  });
});

describe('consent changes', () => {
  it('enable, categories and disable are audited with names only and never the key', async () => {
    await configureCloud({ consent: false, optIn: false, provider: 'ollama' });
    installCloudAndOllama(fetch);
    await request(app).put('/api/settings/ai/cloud-categories').set('X-Forwarded-For', nextIp()).send({ categories: { journal: true } });
    await post('/api/settings/ai/cloud/enable', { version: 1, host: CLOUD_HOST, baseUrl: `https://${CLOUD_HOST}/v1`, acknowledgements: ['sends_data', 'pay_provider'] });
    await post('/api/settings/ai/cloud/disable', {});
    const metas = rows('cloud_ai_consent')
      .map((r) => r.meta)
      .sort((a, b) => a.action.localeCompare(b.action));
    expect(metas.map((m) => m.action)).toEqual(['categories', 'disabled', 'enabled']);
    expect(metas.find((m) => m.action === 'enabled')).toEqual({ action: 'enabled', ai_host: CLOUD_HOST, version: 1 });
    expect(metas.find((m) => m.action === 'categories').shared).toContain('journal');
    expectClean();
  });
});

describe('aiAuditMeta and the audit sanitiser', () => {
  const client = (kind, host, report) => ({ ai: { kind, host }, dataReport: () => report });

  it('local and lan record the kind alone', () => {
    expect(aiAuditMeta(client('local', null, { shared: ['todos'], withheld: [] }))).toEqual({ ai_kind: 'local' });
    expect(aiAuditMeta(client('lan', '192.0.2.50', { shared: ['todos'], withheld: [] }))).toEqual({ ai_kind: 'lan' });
    expect(aiAuditMeta(null)).toEqual({ ai_kind: 'local' });
    expect(aiAuditMeta({})).toEqual({ ai_kind: 'local' });
  });

  it('cloud records the host and the category names', () => {
    expect(aiAuditMeta(client('cloud', CLOUD_HOST, { shared: ['todos'], withheld: ['journal'] }))).toEqual({
      ai_kind: 'cloud',
      ai_host: CLOUD_HOST,
      shared: ['todos'],
      withheld: ['journal'],
    });
  });

  it('a real cloud client reports the names it accumulated', async () => {
    const transport = async function* () {
      yield { type: 'token', text: 'ok' };
      yield { type: 'done', usage: null, finishReason: 'stop' };
    };
    const real = createAiClient({ provider: 'openai_compat', kind: 'cloud', aiHost: CLOUD_HOST, model: 'm', purpose: 'chat', numCtx: 8192, transport, authorizeSend: async () => ({}) });
    await real.complete({ messages: [{ role: 'user', content: 'x' }], scope: { categories: ['budget'], withheld: ['notes'] } });
    expect(aiAuditMeta(real)).toEqual({ ai_kind: 'cloud', ai_host: CLOUD_HOST, shared: ['budget'], withheld: ['notes'] });
  });

  it('refuses to build a cloud client without authorizeSend', () => {
    const transport = async function* () {};
    expect(() => createAiClient({ provider: 'openai_compat', model: 'm', purpose: 'chat', numCtx: 8192, transport })).toThrow(/authorizeSend/);
  });

  it('the sanitiser keeps those fields, clips a long host to 100 characters and drops free text in the lists', () => {
    const host = `${'a'.repeat(30)}.${'b'.repeat(30)}.example.com`;
    const row = normalizeAuditEvent({
      kind: 'llm',
      feature: 'javi_advice',
      status: 'ok',
      meta: { ai_kind: 'cloud', ai_host: host, shared: ['todos', 'my private diary entry', 'journal'], withheld: ['notes'] },
    });
    expect(row.meta).toEqual({ ai_kind: 'cloud', ai_host: host, shared: ['todos', 'journal'], withheld: ['notes'] });
    const long = normalizeAuditEvent({ kind: 'llm', feature: 'javi_advice', meta: { ai_host: 'ab.'.repeat(60) } });
    expect(long.meta.ai_host).toHaveLength(100);
  });
});
