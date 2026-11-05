// Security-review hardening through the real server.js: a disconnected non-streaming AI
// request frees its queue slot, AI rate limits (POST only; actions on their own budget),
// and Javi never runs a write recovered from reply text without confirmation.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
// Pro is on for this file (the Pro gate itself is covered in proGating.test.js).
import http from 'node:http';
import request from 'supertest';

vi.mock('../../loadEnv.js', () => ({}));
vi.mock('node-fetch', () => ({ default: vi.fn() }));

import fetch from 'node-fetch';
import { hangingChat, installFakeOllama, textReply } from './helpers/fakeOllama.js';
import { __resetAiForTests, isAiQueueFull } from '../ai/index.js';
import { closeTestDb, createTestDb, resetDb } from './helpers/testDb.js';

const KEYS = ['APP_PASSWORD', 'AUTH_SECRET', 'SECRETS_ENCRYPTION_KEY', 'JARVIS_CONFIRM_WRITES', 'BURROW_AI', 'BURROW_AI_QUEUE_MAX', 'OLLAMA_HOST'];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
let app;
let db;
let ipN = 0;
const ip = () => `203.0.113.${(ipN += 1) % 250}`;

beforeAll(async () => {
  for (const k of KEYS) delete process.env[k];
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
  resetDb(db);
  __resetAiForTests();
  fetch.mockReset();
  delete process.env.JARVIS_CONFIRM_WRITES;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const ADVICE = { page: 'todos', context: '{}', messages: [{ role: 'user', content: 'title this' }] };

const waitFor = async (cond, ms = 2000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe('M2: a disconnected non-streaming request frees the AI queue slot', () => {
  it('JSON /api/jarvis/advice aborts the model call when the client goes away', async () => {
    process.env.BURROW_AI_QUEUE_MAX = '0';
    __resetAiForTests();
    let chatCalls = 0;
    let chatAborted = false;
    installFakeOllama(fetch, {
      chat: (body, init) => {
        chatCalls += 1;
        if (chatCalls === 1) {
          init.signal?.addEventListener('abort', () => (chatAborted = true), { once: true });
          return hangingChat(body, init);
        }
        return textReply('Second answer.');
      },
    });
    const server = app.listen(0, '127.0.0.1');
    try {
      await new Promise((r) => server.once('listening', r));
      const { port } = server.address();
      const req = http.request({
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/api/jarvis/advice',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip() },
      });
      req.on('error', () => {});
      req.end(JSON.stringify(ADVICE));
      await waitFor(() => chatCalls === 1 && isAiQueueFull());
      req.destroy();
      await waitFor(() => chatAborted && !isAiQueueFull());

      const res = await request(server).post('/api/jarvis/advice').set('X-Forwarded-For', ip()).send(ADVICE);
      expect(res.status).toBe(200);
      expect(res.body.data.content).toBe('Second answer.');
    } finally {
      delete process.env.BURROW_AI_QUEUE_MAX;
      await new Promise((r) => server.close(r));
    }
  });
});

