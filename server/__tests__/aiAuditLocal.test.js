// Audit through the real server.js with NOTHING in the AI path mocked except the network: a fake
// Ollama behind node-fetch serves the model calls, the real audit sink writes to a real temp
// SQLite database. Each user request records exactly one llm row naming provider 'ollama', the
// local model that served it and a redacted, capped context, plus call count metadata.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
// Pro is on for this file (the Pro gate itself is covered in proGating.test.js).
import request from 'supertest';

vi.mock('../../loadEnv.js', () => ({}));
vi.mock('node-fetch', () => ({ default: vi.fn() }));

import fetch from 'node-fetch';
import { installFakeOllama, textReply, toolReply } from './helpers/fakeOllama.js';
import { __resetAiForTests } from '../ai/index.js';
import { logAudit, resetAuditState } from '../audit.js';
import { setAuditSink } from '../auditHook.js';
import { closeTestDb, createTestDb, resetDb, rowsOf } from './helpers/testDb.js';

const CHAT = 'qwen2.5:3b';
const SECRET = 'gsk_AUDITSENTINEL0123456789abcdefghij';
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYXVkaXQifQ.AUDITSENTINELsig0123456789';
const EMAIL = 'someone@example.com';
const ENV_KEYS = ['APP_PASSWORD', 'AUTH_SECRET', 'SECRETS_ENCRYPTION_KEY', 'BURROW_AI', 'OLLAMA_HOST'];
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

let app;
let db;
let ip = 0;
const nextIp = () => `198.51.100.${(ip += 1) % 250}`;
const sseParser = (res, cb) => {
  let d = '';
  res.on('data', (c) => (d += c));
  res.on('end', () => cb(null, d));
};
const post = (path, body, headers = {}) =>
  request(app).post(path).set('X-Forwarded-For', nextIp()).set(headers).send(body).buffer(true).parse(sseParser);
const rows = () => rowsOf(db, 'audit_log');
const metaOf = (row) => (typeof row.meta === 'string' ? JSON.parse(row.meta) : row.meta);

beforeAll(async () => {
  for (const k of ENV_KEYS) delete process.env[k];
  db = createTestDb();
  app = (await import('../../server.js')).default;
});
afterAll(() => {
  closeTestDb(db);
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
beforeEach(() => {
  resetAuditState();
  resetDb(db);
  setAuditSink(logAudit);
  delete process.env.BURROW_AI;
  __resetAiForTests();
  fetch.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());


const CASES = [
  {
    name: 'POST /api/jarvis/advice (JSON)',
    feature: 'javi_advice',
    page: 'todos',
    model: CHAT,
    fire: () =>
      post('/api/jarvis/advice', {
        page: 'todos',
        context: JSON.stringify({ note: `token ${JWT}`, apiKey: 'plain-api-key-zzz' }),
        messages: [{ role: 'user', content: `key ${SECRET} mail ${EMAIL}` }],
      }),
    secrets: [SECRET, JWT, EMAIL, 'plain-api-key-zzz'],
  },
  {
    name: 'POST /api/jarvis/advice (SSE)',
    feature: 'javi_advice',
    page: 'todos',
    model: CHAT,
    fire: () =>
      post(
        '/api/jarvis/advice',
        { page: 'todos', context: '{"open":1}', messages: [{ role: 'user', content: `key ${SECRET}` }] },
        { Accept: 'text/event-stream' },
      ),
    secrets: [SECRET],
  },
];

describe('one audit row per AI request, naming the local provider and model', () => {
  it.each(CASES)('$name', async ({ feature, page, model, fire, secrets, minCalls = 1 }) => {
    installFakeOllama(fetch, {
      chat: (body) =>
        Array.isArray(body.tools) && body.tools.length && !body.messages.some((m) => m.role === 'tool')
          ? toolReply([{ name: 'list_todos', arguments: {} }])
          : textReply('Here you go, friend.'),
    });
    const res = await fire();
    expect(res.status).toBe(200);

    // The audit write may land just after the response closes (SSE routes audit after streaming).
    await vi.waitFor(() => expect(rows()).toHaveLength(1));
    const [row] = rows();
    expect(row).toMatchObject({ kind: 'llm', feature, provider: 'ollama', model, status: 'ok' });
    if (page) expect(row.page).toBe(page);
    const meta = metaOf(row);
    expect(meta.calls).toBeGreaterThanOrEqual(minCalls);
    expect(Number(meta.ms)).toBeGreaterThanOrEqual(0);

    const stored = JSON.stringify(row);
    for (const s of secrets) expect(stored, `row leaked ${s}`).not.toContain(s);
    expect(stored).not.toMatch(/AUDITSENTINEL/);
    expect((row.context ?? '').length).toBeLessThanOrEqual(2000);
    for (const bad of ['gsk_', 'Authorization', 'X-Forwarded-For']) expect(stored).not.toContain(bad);
  });

});
