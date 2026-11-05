// Exhaustive category enforcement matrix for the cloud AI safeguards: EVERY Javi page id and
// EVERY tool in JARVIS_TOOLS, against cloud (category off, category on) and local Ollama. A data
// sentinel must be absent from every request body sent to the fake cloud when its category is
// off, present when it is on, and always present locally. Fake providers only (api.example.com,
// sk-test-fake); the network guard blocks anything real.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
// Pro is on for this file (the Pro gate itself is covered in proGating.test.js).
vi.mock('../license/index.js', async (importOriginal) => (await import('./helpers/pro.js')).mockLicenseModule(importOriginal));
import request from 'supertest';

vi.mock('../../loadEnv.js', () => ({}));
vi.mock('node-fetch', () => ({ default: vi.fn() }));

import fetch from 'node-fetch';
import { textReply } from './helpers/fakeOllama.js';
import { configureCloud, installCloudAndOllama, resetCloud } from './helpers/fakeCloud.js';
import { closeTestDb, createTestDb, resetDb } from './helpers/testDb.js';
import { JAVI_PAGE_LABELS } from '../javi/pages.js';
import { CLOUD_CATEGORY_IDS, PAGE_CATEGORIES } from '../ai/privacy.js';

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

const S = (cat) => `SENTINEL_MX_${cat.toUpperCase()}_k3p9`;
const advise = (body) => request(app).post('/api/jarvis/advice').set('X-Forwarded-For', nextIp()).send(body);

describe('page advice: every page id, cloud off / cloud on / local', () => {
  const pages = Object.keys(JAVI_PAGE_LABELS);

  it('covers exactly the pages the policy maps', () => {
    expect(pages.sort()).toEqual(Object.keys(PAGE_CATEGORIES).sort());
  });

  const single = pages.filter((p) => PAGE_CATEGORIES[p] && PAGE_CATEGORIES[p] !== 'mixed');
  const open = pages.filter((p) => PAGE_CATEGORIES[p] === null);

  describe.each(single)('page %s', (page) => {
    const cat = PAGE_CATEGORIES[page];
    const context = JSON.stringify({ rows: [{ text: S(page) }] });

    it(`cloud, ${cat} off: blocked, no request, sentinel never leaves`, async () => {
      await configureCloud({ categories: { [cat]: false } });
      const { cloud, local } = installCloudAndOllama(fetch);
      const res = await advise({ page, context, messages: [{ role: 'user', content: 'how is it going?' }] });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ blocked: true, withheld: [cat] });
      expect(cloud.requests).toHaveLength(0);
      expect(local.chatBodies).toHaveLength(0);
      expect(JSON.stringify(res.body)).not.toContain(S(page));
    });

    it(`cloud, ${cat} on: the context reaches the provider`, async () => {
      await configureCloud({ categories: { [cat]: true } });
      const { cloud } = installCloudAndOllama(fetch, { replies: ['- ok'] });
      const res = await advise({ page, context, messages: [{ role: 'user', content: 'how is it going?' }] });
      expect(res.body.data).toMatchObject({ blocked: false, withheld: [] });
      expect(cloud.sent()).toContain(S(page));
    });

    it('local: always sent, even with the category off in the saved settings', async () => {
      await configureCloud({ categories: { [cat]: false }, consent: false });
      const side = installCloudAndOllama(fetch, { ollama: { replies: [textReply('- fine')] } });
      const res = await advise({ page, context, messages: [{ role: 'user', content: 'how is it going?' }] });
      expect(res.body.data).toMatchObject({ blocked: false, ai: { kind: 'local', host: null } });
      expect(JSON.stringify(side.local.chatBodies)).toContain(S(page));
      expect(side.cloud.requests).toHaveLength(0);
    });
  });

  describe.each(open)('page %s (no category)', (page) => {
    it('is always shared, even with every category off', async () => {
      await configureCloud({ categories: Object.fromEntries(CLOUD_CATEGORY_IDS.map((c) => [c, false])) });
      const { cloud } = installCloudAndOllama(fetch, { replies: ['- ok'] });
      const res = await advise({ page, context: JSON.stringify({ t: S(page) }), messages: [{ role: 'user', content: 'hi' }] });
      expect(res.body.data).toMatchObject({ blocked: false, withheld: [] });
      expect(cloud.sent()).toContain(S(page));
    });
  });

  describe('home (mixed): each alert kind follows its own category', () => {
    const kinds = [
      ['todo', 'todos'],
      ['habit', 'habits'],
      ['health', 'health'],
      ['countdown', 'countdowns'],
      ['budget', 'budget'],
    ];
    const alerts = kinds.map(([kind]) => ({ kind, text: S(`alert_${kind}`) }));
    const ctx = JSON.stringify({ mode: 'all', alerts });
    const q = [{ role: 'user', content: 'what now?' }];

    it.each(kinds)('alert %s: absent when %s is off, present when on, present locally', async (kind, cat) => {
      await configureCloud({ categories: { [cat]: false } });
      let side = installCloudAndOllama(fetch, { replies: ['- ok'] });
      let res = await advise({ page: 'home', context: ctx, messages: q });
      expect(res.body.data.withheld).toContain(cat);
      expect(side.cloud.sent()).not.toContain(S(`alert_${kind}`));

      await configureCloud({ categories: { [cat]: true } });
      fetch.mockReset();
      side = installCloudAndOllama(fetch, { replies: ['- ok'] });
      res = await advise({ page: 'home', context: ctx, messages: q });
      expect(res.body.data.withheld).not.toContain(cat);
      expect(side.cloud.sent()).toContain(S(`alert_${kind}`));

      await configureCloud({ categories: { [cat]: false }, consent: false });
      fetch.mockReset();
      side = installCloudAndOllama(fetch, { ollama: { replies: [textReply('- fine')] } });
      await advise({ page: 'home', context: ctx, messages: q });
      expect(JSON.stringify(side.local.chatBodies)).toContain(S(`alert_${kind}`));
    });
  });

  describe('data browser (mixed): each table follows its own category', () => {
    const tables = [
      ['transactions', 'budget'],
      ['todos', 'todos'],
      ['habits', 'habits'],
      ['notes', 'notes'],
      ['journal', 'journal'],
      ['bookmarks', 'bookmarks'],
      ['countdowns', 'countdowns'],
      ['calendar_events', 'calendar'],
      ['focus_sessions', 'focus'],
    ];
    const ctx = JSON.stringify({ tables: tables.map(([id]) => ({ id, label: S(`tbl_${id}`), count: 1 })) });
    const q = [{ role: 'user', content: 'what is here?' }];

    it.each(tables)('table %s: absent when %s is off, present when on, present locally', async (id, cat) => {
      await configureCloud({ categories: { [cat]: false } });
      let side = installCloudAndOllama(fetch, { replies: ['- ok'] });
      await advise({ page: 'data-browser', context: ctx, messages: q });
      expect(side.cloud.sent()).not.toContain(S(`tbl_${id}`));

      await configureCloud({ categories: { [cat]: true } });
      fetch.mockReset();
      side = installCloudAndOllama(fetch, { replies: ['- ok'] });
      await advise({ page: 'data-browser', context: ctx, messages: q });
      expect(side.cloud.sent()).toContain(S(`tbl_${id}`));

      await configureCloud({ categories: { [cat]: false }, consent: false });
      fetch.mockReset();
      side = installCloudAndOllama(fetch, { ollama: { replies: [textReply('- fine')] } });
      await advise({ page: 'data-browser', context: ctx, messages: q });
      expect(JSON.stringify(side.local.chatBodies)).toContain(S(`tbl_${id}`));
    });
  });
});

