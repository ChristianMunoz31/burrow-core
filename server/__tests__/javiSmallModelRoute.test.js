// Small-model variant through the REAL POST /api/jarvis/advice route (real server.js, registry, advisor
// service and cache) with a fake Ollama and a fake cloud behind node-fetch: the system prompt sent on the
// wire per client (llama3.2:1b local, qwen2.5:3b local, llama3.2:1b named on a cloud endpoint), byte
// stability across pages, and a per-variant cache key. No real Ollama.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

vi.mock('../../loadEnv.js', () => ({}));
vi.mock('node-fetch', () => ({ default: vi.fn() }));
vi.mock('../auditHook.js', () => ({ recordAudit: vi.fn(async () => {}), setAuditSink: vi.fn() }));
vi.mock('../license/index.js', async (importOriginal) => (await import('./helpers/pro.js')).mockLicenseModule(importOriginal));

import fetch from 'node-fetch';
import { MODELS, installFakeOllama, textReply } from './helpers/fakeOllama.js';
import { configureCloud, installCloudAndOllama, resetCloud } from './helpers/fakeCloud.js';
import { closeTestDb, createTestDb, resetDb } from './helpers/testDb.js';
import { __resetAiForTests } from '../ai/index.js';
import { clearAdviceCache, adviceCacheKey } from '../javi/adviceCache.js';
import { AUTO_ADVICE_REQUEST, AUTO_ADVICE_REQUEST_SMALL, PROMPT_VERSION, advisorSystemPrompt, promptVersionFor } from '../javi/advisorPrompt.js';
import { FREE, resetPro, setEntitlements } from './helpers/pro.js';

const SSE = { Accept: 'text/event-stream' };
const SMALL = advisorSystemPrompt({ variant: 'small' });
const STANDARD = advisorSystemPrompt();

const ONE_B = {
  name: 'llama3.2:1b',
  model: 'llama3.2:1b',
  size: 1300000000,
  digest: 'd1',
  modified_at: '2026-01-01T00:00:00Z',
  details: { family: 'llama', parameter_size: '1.2B', quantization_level: 'Q8_0', context_length: 32768 },
  capabilities: ['completion'],
};
const MODEL_LIST = [...MODELS, ONE_B];

let app;
let db;
let ip = 0;
const nextIp = () => `198.51.100.${(ip += 1) % 250}`;
const saved = Object.fromEntries(['APP_PASSWORD', 'AUTH_SECRET', 'SECRETS_ENCRYPTION_KEY', 'BURROW_AI', 'BURROW_AI_CHAT_MODEL'].map((k) => [k, process.env[k]]));

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
  __resetAiForTests();
  clearAdviceCache();
  setEntitlements(FREE);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  resetPro();
  delete process.env.BURROW_AI_CHAT_MODEL;
  vi.restoreAllMocks();
});

const advise = (page, context) => request(app).post('/api/jarvis/advice').set('X-Forwarded-For', nextIp()).set(SSE).send({ page, context });
const ctx = (page, extra = 1) => JSON.stringify({ page, today: '2026-10-09', data: { open: extra }, localTime: '10:00' });
const done = (res) => {
  const block = String(res.text)
    .split('\n\n')
    .find((b) => b.startsWith('event: done'));
  return JSON.parse(block.split('\n')[1].slice(6));
};
const localWith = (model, ...replies) => {
  process.env.BURROW_AI_CHAT_MODEL = model;
  __resetAiForTests();
  return installFakeOllama(fetch, { models: MODEL_LIST, replies: replies.length ? replies : [textReply('- Fine.')] });
};
const systemOf = (chatBody) => chatBody.messages.find((m) => m.role === 'system').content;
const userOf = (chatBody) => chatBody.messages.filter((m) => m.role === 'user').at(-1).content;

describe('advice route: system prompt variant by client', () => {
  it('a local llama3.2:1b gets the small system prompt and the small synthetic request', async () => {
    const fake = localWith('llama3.2:1b');
    const res = await advise('todos', ctx('todos'));
    expect(res.status).toBe(200);
    expect(done(res)).toMatchObject({ model: 'llama3.2:1b', provider: 'ollama' });
    expect(fake.chatBodies).toHaveLength(1);
    expect(fake.chatBodies[0].model).toBe('llama3.2:1b');
    expect(systemOf(fake.chatBodies[0])).toBe(SMALL);
    expect(userOf(fake.chatBodies[0]).endsWith(AUTO_ADVICE_REQUEST_SMALL)).toBe(true);
  });

  it('a local qwen2.5:3b gets the standard system prompt and request', async () => {
    const fake = localWith('qwen2.5:3b');
    const res = await advise('todos', ctx('todos'));
    expect(res.status).toBe(200);
    expect(fake.chatBodies[0].model).toBe('qwen2.5:3b');
    expect(systemOf(fake.chatBodies[0])).toBe(STANDARD);
    expect(userOf(fake.chatBodies[0]).endsWith(AUTO_ADVICE_REQUEST)).toBe(true);
    expect(userOf(fake.chatBodies[0])).not.toContain(AUTO_ADVICE_REQUEST_SMALL);
  });

  it('a cloud client whose configured model is named llama3.2:1b still gets the standard prompt', async () => {
    await configureCloud({ model: 'llama3.2:1b' });
    const { cloud, local } = installCloudAndOllama(fetch, { ollama: { models: MODEL_LIST } });
    const res = await advise('todos', ctx('todos'));
    expect(res.status).toBe(200);
    expect(done(res)).toMatchObject({ model: 'llama3.2:1b', provider: 'openai_compat' });
    expect(local.chatBodies).toHaveLength(0);
    expect(cloud.requests).toHaveLength(1);
    const body = cloud.requests[0].body;
    expect(body.model).toBe('llama3.2:1b');
    expect(systemOf(body)).toBe(STANDARD);
    expect(systemOf(body)).not.toBe(SMALL);
    expect(userOf(body).endsWith(AUTO_ADVICE_REQUEST)).toBe(true);
  });

  it('the small and standard prompts are different texts (the check above is meaningful)', () => {
    expect(SMALL).not.toBe(STANDARD);
  });
});

describe('advice route: byte stability and caching', () => {
  it('a small model sends a byte-identical system prompt on two pages (the prefix a local model caches)', async () => {
    const fake = localWith('llama3.2:1b');
    await advise('todos', ctx('todos', 3));
    await advise('habits', ctx('habits', 5));
    expect(fake.chatBodies).toHaveLength(2);
    const [a, b] = fake.chatBodies.map(systemOf);
    expect(a).toBe(b);
    expect(a).toBe(SMALL);
    expect(userOf(fake.chatBodies[0])).not.toBe(userOf(fake.chatBodies[1]));
  });

  it('the standard model also keeps one system prompt across pages', async () => {
    const fake = localWith('qwen2.5:3b');
    await advise('todos', ctx('todos', 3));
    await advise('habits', ctx('habits', 5));
    expect(fake.chatBodies.map(systemOf)).toEqual([STANDARD, STANDARD]);
  });

  it('a small-model card is replayed from the cache (one model call for two identical requests)', async () => {
    const fake = localWith('llama3.2:1b', textReply('- Small card.'));
    const first = await advise('todos', ctx('todos'));
    const second = await advise('todos', ctx('todos'));
    expect(done(first).content).toBe('- Small card.');
    expect(done(second).content).toBe('- Small card.');
    expect(fake.chatBodies).toHaveLength(1);
  });

  it('the same page data on the 3b model is a cache miss after a 1b card (never replayed across variants)', async () => {
    const fake = localWith('llama3.2:1b', textReply('- Small card.'));
    await advise('todos', ctx('todos'));
    expect(fake.chatBodies).toHaveLength(1);
    const fake3 = localWith('qwen2.5:3b', textReply('- Standard card.'));
    const res = await advise('todos', ctx('todos'));
    expect(done(res).content).toBe('- Standard card.');
    expect(fake3.chatBodies).toHaveLength(1);
    expect(systemOf(fake3.chatBodies[0])).toBe(STANDARD);
  });

  it('promptVersionFor keys the cache: identical other parts, different variant, different key', () => {
    const parts = { model: 'llama3.2:1b', kind: 'local', host: null, page: 'todos', context: '{"a":1}', displayName: null, hourBucket: '10' };
    const std = adviceCacheKey({ ...parts, promptVersion: promptVersionFor('standard') });
    const small = adviceCacheKey({ ...parts, promptVersion: promptVersionFor('small') });
    expect(std).not.toBe(small);
    expect(promptVersionFor('standard')).toBe(PROMPT_VERSION);
    expect(adviceCacheKey({ ...parts, promptVersion: promptVersionFor('small') })).toBe(small);
  });
});
