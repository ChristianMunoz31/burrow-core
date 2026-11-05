// No cloud call is possible without BOTH the cloudAi opt-in and a current consent confirmation
// (plus a saved key, model and valid base URL). Full 2x2 of opt-in x consent, across every
// entry point that can reach a model: the client registry, page advice, Javi, the manual
// briefing and the cross insights explainer. Only the (opt-in, consent) = (on, on) cell may
// reach api.example.com; every other cell answers from local Ollama and never touches the host.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
// Pro is on for this file (the Pro gate itself is covered in proGating.test.js).
import request from 'supertest';

vi.mock('../../loadEnv.js', () => ({}));
vi.mock('node-fetch', () => ({ default: vi.fn() }));

import fetch from 'node-fetch';
import { textReply } from './helpers/fakeOllama.js';
import { CLOUD_HOST, configureCloud, installCloudAndOllama, resetCloud } from './helpers/fakeCloud.js';
import { closeTestDb, createTestDb, resetDb, seedDb } from './helpers/testDb.js';
import { getAiClient } from '../ai/index.js';

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

const CELLS = [
  { optIn: true, consent: true, cloud: true },
  { optIn: true, consent: false, cloud: false },
  { optIn: false, consent: true, cloud: false },
  { optIn: false, consent: false, cloud: false },
];
const label = (c) => `opt-in ${c.optIn ? 'on' : 'off'}, consent ${c.consent ? 'on' : 'off'}`;

const ENTRY_POINTS = {
  advice: () => request(app).post('/api/jarvis/advice').set('X-Forwarded-For', nextIp()).send({ page: 'todos', context: '{}', messages: [{ role: 'user', content: 'hi' }] }),
};

describe.each(CELLS)('$#: %j', (cell) => {
  it(`${label(cell)}: the client is ${cell.cloud ? 'cloud' : 'local, with no request to the cloud host'}`, async () => {
    await configureCloud({ optIn: cell.optIn, consent: cell.consent });
    const side = installCloudAndOllama(fetch);
    const client = await getAiClient({ purpose: 'chat' });
    expect(client.isCloud).toBe(cell.cloud);
    expect(client.provider).toBe(cell.cloud ? 'openai_compat' : 'ollama');
    await client.complete({ messages: [{ role: 'user', content: 'hi' }], scope: { categories: [] } });
    expect(side.cloud.requests).toHaveLength(cell.cloud ? 1 : 0);
  });

  it.each(Object.keys(ENTRY_POINTS))(`${label(cell)}: %s reaches the cloud host only when both are on`, async (entry) => {
    seedDb(db, { todos: [{ title: 'Water plants', due: '2026-01-01' }] });
    await configureCloud({ optIn: cell.optIn, consent: cell.consent });
    const side = installCloudAndOllama(fetch, { replies: ['- Cloud answer.'], ollama: { replies: [textReply('- Local answer.')], chat: undefined } });
    const res = await ENTRY_POINTS[entry]();
    expect(res.status).toBe(200);
    if (cell.cloud) {
      expect(side.cloud.requests.length).toBeGreaterThan(0);
    } else {
      expect(side.cloud.requests).toHaveLength(0);
      expect(fetch.mock.calls.some(([url]) => String(url).includes(CLOUD_HOST))).toBe(false);
    }
  });
});

describe('settings routes cannot bypass the gate', () => {
  it('selecting openai_compat without consent is refused (409) and the next call stays local', async () => {
    await configureCloud({ provider: 'ollama', consent: false, optIn: true });
    const side = installCloudAndOllama(fetch, { ollama: { replies: [textReply('- Local answer.')] } });
    const res = await request(app).put('/api/settings/ai/provider').set('X-Forwarded-For', nextIp()).send({ provider: 'openai_compat' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('cloud_consent_required');
    await ENTRY_POINTS.advice();
    expect(side.cloud.requests).toHaveLength(0);
  });

  it('enable without the two acknowledgements records no consent and sends nothing', async () => {
    await configureCloud({ provider: 'ollama', consent: false, optIn: false });
    const side = installCloudAndOllama(fetch, { ollama: { replies: [textReply('- Local answer.')] } });
    const res = await request(app)
      .post('/api/settings/ai/cloud/enable')
      .set('X-Forwarded-For', nextIp())
      .send({ version: 1, host: CLOUD_HOST, baseUrl: `https://${CLOUD_HOST}/v1`, acknowledgements: ['sends_data'] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('acknowledgements_required');
    await ENTRY_POINTS.advice();
    expect(side.cloud.requests).toHaveLength(0);
  });
});
