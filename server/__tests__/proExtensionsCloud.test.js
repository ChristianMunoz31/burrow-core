// server/proExtensions.js mounts requireAi for the Pro routes whose table entry has `ai` set, which makes it an AI
// consumer (aiBoundary.test.js). Under a configured cloud provider the Pro handler gets the cloud client in
// res.locals.ai, built by core with its scope enforcement; the Pro handler never picks the provider itself.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../../loadEnv.js', () => ({}));
vi.mock('node-fetch', () => ({ default: vi.fn() }));

import fetch from 'node-fetch';
import { CLOUD_HOST, configureCloud, resetCloud } from './helpers/fakeCloud.js';
import { closeTestDb, createTestDb, resetDb } from './helpers/testDb.js';
import { PRO_API_VERSION, loadProExtensions, proSlotRouter, resetProExtensionsForTests } from '../proExtensions.js';

let db;
const saved = Object.fromEntries(['BURROW_AI'].map((k) => [k, process.env[k]]));

beforeAll(() => {
  delete process.env.BURROW_AI;
  db = createTestDb();
});
afterAll(async () => {
  resetProExtensionsForTests();
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
  resetProExtensionsForTests();
});

describe('Pro route with ai: { purpose: chat } under cloud', () => {
  it('the handler receives the cloud client from core', async () => {
    await configureCloud();
    const seen = {};
    const ok = await loadProExtensions({
      log: () => {},
      importer: async () => ({
        name: 'fake-pro',
        apiVersion: PRO_API_VERSION,
        available: () => true,
        install(ctx) {
          ctx.routes.add({
            id: 'jarvis.briefingRefresh',
            handlers: [
              (_req, res) => {
                seen.ai = res.locals.ai;
                res.json({ ok: true });
              },
            ],
          });
        },
      }),
    });
    expect(ok).toBe(true);
    const app = express();
    app.use(express.json());
    app.use(proSlotRouter('jarvis'));
    const res = await request(app).post('/api/jarvis/briefing/refresh').send({});
    expect(res.status).toBe(200);
    expect(seen.ai.isCloud).toBe(true);
    expect(seen.ai.ai).toEqual({ kind: 'cloud', host: CLOUD_HOST });
  });
});
