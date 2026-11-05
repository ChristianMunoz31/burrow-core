// Pro gating by capability, through the real server.js: every Pro route answers
// 403 pro_required as plain JSON (before any SSE header, any body validation and any Ollama call)
// for a free user, and passes for a licensed or trial user. Free capabilities keep working for a
// free user. Calls go straight to the server with supertest, so no UI is involved.
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

vi.mock('../../loadEnv.js', () => ({}));
vi.mock('node-fetch', () => ({ default: vi.fn() }));
vi.mock('../javi/advisorService.js', () => ({ generateAdvice: vi.fn(), streamAdvice: vi.fn() }));
vi.mock('../license/index.js', async (importOriginal) => (await import('./helpers/pro.js')).mockLicenseModule(importOriginal));

import fetch from 'node-fetch';
import { generateAdvice, streamAdvice } from '../javi/advisorService.js';
import { installFakeOllama } from './helpers/fakeOllama.js';
import { __resetAiForTests } from '../ai/index.js';
import { cleanupBackupEnv, resetBackupEnv } from './helpers/backupEnv.js';
import { FREE, PRO, TRIAL, UPDATE_WINDOW_PASSED, resetPro, setEntitlements } from './helpers/pro.js';
import { MSG_PRO_REQUIRED, PRO_FEATURES, ProRequiredError, assertPro, isProEnabled, requirePro, requireProWhen } from '../pro.js';
import * as license from '../license/index.js';

const INSIGHT = { id: 'sleep_dining', n: 20, rho: 0.4, nA: 8, nB: 12, meanA: 20, meanB: 10, effectPct: 100, unit: 'usd' };

/** Every Pro route: [path, feature, valid body]. Keep in sync with proRoutesBoundary.test.js. */
const PRO_ROUTES = [
  ['/api/jarvis', 'javi_tools', { prompt: 'what is due today' }],
  ['/api/jarvis/actions/00000000000000000000000000000000', 'javi_tools', { approve: true }],
  ['/api/jarvis/briefing/refresh', 'briefings', {}],
  ['/api/insights/explain', 'explain', { windowDays: 30, insights: [INSIGHT] }],
];

let app;
let ip = 0;
const nextIp = () => `198.51.100.${(ip += 1) % 250}`;
const post = (path, body, headers = {}) => request(app).post(path).set('X-Forwarded-For', nextIp()).set(headers).send(body);
const get = (path) => request(app).get(path).set('X-Forwarded-For', nextIp());
// Backups and export need a sign-in unless the caller is loopback, so those use the plain local address.
const getLocal = (path) => request(app).get(path);
const postLocal = (path, body) => request(app).post(path).send(body);

const saved = Object.fromEntries(['APP_PASSWORD', 'AUTH_SECRET', 'SECRETS_ENCRYPTION_KEY', 'BURROW_AI'].map((k) => [k, process.env[k]]));

beforeAll(async () => {
  for (const k of Object.keys(saved)) delete process.env[k];
  app = (await import('../../server.js')).default;
});
afterAll(() => {
  cleanupBackupEnv();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
beforeEach(() => {
  resetBackupEnv();
  __resetAiForTests();
  fetch.mockReset();
  installFakeOllama(fetch);
  generateAdvice.mockReset();
  streamAdvice.mockReset();
  delete process.env.BURROW_AI;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  resetPro();
  vi.restoreAllMocks();
});

describe.each([
  ['a free user', FREE],
  ['an expired update window', UPDATE_WINDOW_PASSED],
])('%s on Pro routes', (_label, entitlements) => {
  beforeEach(() => setEntitlements(entitlements));

  it.each(PRO_ROUTES)('POST %s answers 403 pro_required as JSON, calls no model and opens no stream', async (path, feature, body) => {
    const res = await post(path, body, { Accept: 'text/event-stream' });
    expect(res.status).toBe(403);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.headers['content-type']).not.toMatch(/event-stream/);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({ error: 'pro_required', feature, message: MSG_PRO_REQUIRED });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(PRO_ROUTES)('POST %s is refused before body validation and before the AI gate', async (path, feature) => {
    process.env.BURROW_AI = '0';
    const res = await post(path, {});
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('pro_required');
    expect(res.body.feature).toBe(feature);
  });

  it('cannot be bypassed from the client: headers, cookies and query flags change nothing', async () => {
    const res = await request(app)
      .post('/api/jarvis?pro=1')
      .set('X-Forwarded-For', nextIp())
      .set({ 'X-Burrow-Pro': '1', 'X-Pro': 'true', Cookie: 'pro=1; burrow.pro=true' })
      .send({ prompt: 'hi', pro: true, entitlements: { pro: true } });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('pro_required');
  });
});

describe('free capabilities keep working for a free user', () => {
  beforeEach(() => setEntitlements(FREE));

  it('page advice (read-only) answers 200', async () => {
    generateAdvice.mockResolvedValue({ content: '- Do the thing', model: 'm1', provider: 'ollama' });
    const res = await post('/api/jarvis/advice', { page: 'todos', context: '{}', messages: [] });
    expect(res.status).toBe(200);
    expect(res.body.data.content).toBe('- Do the thing');
  });

  it('page advice is not refused when streaming either', async () => {
    const res = await post('/api/jarvis/advice', { page: 'todos', context: '{}', messages: [] }, { Accept: 'text/event-stream' });
    expect(res.status).not.toBe(403);
    expect(res.body.error).not.toBe('pro_required');
  });

  it.each([
    ['/api/transactions'],
    ['/api/settings/ai'],
    ['/api/settings/ai/setup'],
    ['/api/jarvis/status'],
    ['/api/jarvis/briefing'],
    ['/api/jarvis/conversations'],
    ['/api/license'],
  ])('GET %s is not gated', async (path) => {
    const res = await get(path);
    expect(res.status).toBe(200);
    expect(res.body.error).not.toBe('pro_required');
  });

  it('backups status is not gated', async () => {
    const res = await getLocal('/api/backups/status');
    expect(res.status).toBe(200);
    expect(res.body.error).not.toBe('pro_required');
  });

  it('data writes, export, backups and AI settings are not gated', async () => {
    const created = await post('/api/transactions', { description: 'Coffee', amount: -4, date: '2026-06-01' });
    expect(created.body.error).not.toBe('pro_required');
    const exported = await postLocal('/api/export', { format: 'json' });
    expect(exported.status).not.toBe(403);
    const cloud = await post('/api/settings/ai/cloud-hint', {});
    expect(cloud.body.error).not.toBe('pro_required');
    const backup = await postLocal('/api/backups', {});
    expect(backup.body.error).not.toBe('pro_required');
    expect(backup.status).not.toBe(403);
  });
});

const OK_ADVICE = { content: '- Do the thing', model: 'm1', provider: 'ollama' };
const ADVICE = '/api/jarvis/advice';
const SSE = { Accept: 'text/event-stream' };
const BASE = { page: 'todos', context: '{}' };
const MSGS = [{ role: 'user', content: 'and then?' }];
const MULTI_TURN = [
  ['non-empty messages', ADVICE, { ...BASE, messages: MSGS }],
  ['messages string', ADVICE, { ...BASE, messages: 'x' }],
  ['messages object', ADVICE, { ...BASE, messages: {} }],
  ['history', ADVICE, { ...BASE, history: [] }],
  ['threadId', ADVICE, { ...BASE, threadId: 'a' }],
  ['conversationId', ADVICE, { ...BASE, conversationId: 'c' }],
  ['followUp', ADVICE, { ...BASE, followUp: true }],
  ['continue', ADVICE, { ...BASE, continue: 1 }],
  ['query messages', `${ADVICE}?messages=1`, BASE],
  ['query threadId', `${ADVICE}?threadId=x`, BASE],
  ['empty messages plus history', ADVICE, { ...BASE, messages: [], history: MSGS }],
  ['invalid page plus messages (403 before validation)', ADVICE, { page: 'nope', context: 5, messages: MSGS }],
];

describe('free user cannot reach multi-turn advice', () => {
  beforeEach(() => {
    setEntitlements(FREE);
    generateAdvice.mockResolvedValue(OK_ADVICE);
  });

  describe.each([
    ['JSON', {}],
    ['SSE', SSE],
  ])('as %s', (_mode, headers) => {
    it.each(MULTI_TURN)('%s answers 403 pro_required and runs nothing', async (_label, path, body) => {
      const res = await post(path, body, headers);
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: 'pro_required', feature: 'javi_conversation', message: MSG_PRO_REQUIRED });
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['content-type']).toMatch(/application\/json/);
      expect(res.headers['content-type']).not.toMatch(/event-stream/);
      expect(generateAdvice).not.toHaveBeenCalled();
      expect(streamAdvice).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    });

    it('is refused before the AI gate even when AI is off', async () => {
      process.env.BURROW_AI = '0';
      const res = await post(ADVICE, { ...BASE, messages: MSGS }, headers);
      expect(res.status).toBe(403);
      expect(res.body.feature).toBe('javi_conversation');
    });
  });

  it.each([
    ['messages omitted', BASE],
    ['messages null', { ...BASE, messages: null }],
    ['messages empty array', { ...BASE, messages: [] }],
  ])('single-shot (%s) answers 200', async (_label, body) => {
    const res = await post(ADVICE, body);
    expect(res.status).toBe(200);
    expect(res.body.data.content).toBe('- Do the thing');
    expect(generateAdvice).toHaveBeenCalledTimes(1);
  });

  it('a lapsed update window is refused for multi-turn and allowed single-shot', async () => {
    setEntitlements(UPDATE_WINDOW_PASSED);
    const refused = await post(ADVICE, { ...BASE, messages: MSGS });
    expect(refused.status).toBe(403);
    expect(refused.body.feature).toBe('javi_conversation');
    const ok = await post(ADVICE, BASE);
    expect(ok.status).toBe(200);
  });

  it('a trial that ended (free entitlements) is refused for multi-turn', async () => {
    setEntitlements({ pro: false, edition: null, reasons: ['trial_ended'] });
    const res = await post(ADVICE, { ...BASE, messages: MSGS });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('pro_required');
    expect(generateAdvice).not.toHaveBeenCalled();
  });

  it.each([
    ['a licensed user', PRO],
    ['a trial user', TRIAL],
  ])('%s keeps multi-turn advice', async (_label, entitlements) => {
    setEntitlements(entitlements);
    const res = await post(ADVICE, { ...BASE, messages: MSGS });
    expect(res.status).toBe(200);
    expect(res.body.data.content).toBe('- Do the thing');
    const q = await post(`${ADVICE}?threadId=x`, BASE);
    expect(q.status).toBe(200);
    const sse = await post(ADVICE, { ...BASE, messages: MSGS }, SSE);
    expect(sse.status).not.toBe(403);
    expect(sse.body.error).not.toBe('pro_required');
  });
});

describe('requireProWhen', () => {
  const makeRes = () => {
    const res = { set: vi.fn(() => res), status: vi.fn(() => res), json: vi.fn(() => res) };
    return res;
  };

  it('rejects an unknown or reserved feature when the middleware is built', () => {
    expect(() => requireProWhen('nope', () => true)).toThrow(/Unknown Pro feature/);
    for (const id of Object.keys(PRO_FEATURES).filter((k) => PRO_FEATURES[k].used === false)) {
      expect(() => requireProWhen(id, () => true), id).toThrow(/Reserved Pro feature/);
    }
    expect(() => requireProWhen('javi_conversation', () => true)).not.toThrow();
  });

  it('answers the fixed 403 for a gated request without Pro', () => {
    setEntitlements(FREE);
    const res = makeRes();
    const next = vi.fn();
    requireProWhen('javi_conversation', () => true)({}, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.set).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'pro_required', feature: 'javi_conversation', message: MSG_PRO_REQUIRED });
  });

  it('passes a gated request with Pro', () => {
    setEntitlements(PRO);
    const next = vi.fn();
    requireProWhen('javi_conversation', () => true)({}, makeRes(), next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the predicate throws', () => {
    setEntitlements(FREE);
    const res = makeRes();
    const next = vi.fn();
    requireProWhen('javi_conversation', () => {
      throw new Error('boom');
    })({}, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('a throwing predicate still passes for Pro', () => {
    setEntitlements(PRO);
    const next = vi.fn();
    requireProWhen('javi_conversation', () => {
      throw new Error('boom');
    })({}, makeRes(), next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('gates when the predicate returns a non-boolean (only an explicit false lets it through)', () => {
    setEntitlements(FREE);
    const res = makeRes();
    requireProWhen('javi_conversation', () => undefined)({}, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('a false predicate never reads the entitlements', () => {
    const spy = vi.spyOn(license, 'getEntitlements');
    setEntitlements(FREE);
    const next = vi.fn();
    const res = makeRes();
    requireProWhen('javi_conversation', () => false)({}, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('server/pro.js', () => {
  it('registers every Pro capability, with future ones reserved and unused', () => {
    for (const id of ['javi_tools', 'javi_conversation', 'briefings', 'insights', 'explain']) expect(PRO_FEATURES[id]).toBeDefined();
    for (const id of ['semantic_search', 'automations', 'smart_importers', 'scheduled_external_backups', 'weekly_reviews', 'model_pack']) {
      expect(PRO_FEATURES[id].used).toBe(false);
    }
    expect(Object.isFrozen(PRO_FEATURES)).toBe(true);
  });

  it('isProEnabled follows getEntitlements and reads as free when it throws', () => {
    setEntitlements(PRO);
    expect(isProEnabled()).toBe(true);
    setEntitlements(TRIAL);
    expect(isProEnabled()).toBe(true);
    setEntitlements(FREE);
    expect(isProEnabled()).toBe(false);
    const spy = vi.spyOn(license, 'getEntitlements').mockImplementation(() => {
      throw new Error('boom');
    });
    expect(isProEnabled()).toBe(false);
    spy.mockRestore();
  });

  it('assertPro throws a 403 ProRequiredError without Pro and passes with it', () => {
    setEntitlements(FREE);
    let err;
    try {
      assertPro('briefings');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ProRequiredError);
    expect(err).toMatchObject({ code: 'pro_required', httpStatus: 403, feature: 'briefings', publicMessage: MSG_PRO_REQUIRED });
    setEntitlements(PRO);
    expect(() => assertPro('briefings')).not.toThrow();
  });

  it('rejects an unknown feature id when the route is built, not at request time', () => {
    expect(() => requirePro('nope')).toThrow(/Unknown Pro feature/);
    expect(() => assertPro('nope')).toThrow(/Unknown Pro feature/);
  });

  it('rejects a reserved (used: false) feature id when the route is built or asserted', () => {
    const reserved = Object.keys(PRO_FEATURES).filter((id) => PRO_FEATURES[id].used === false);
    expect(reserved.length).toBeGreaterThan(0);
    for (const id of reserved) {
      expect(() => requirePro(id), id).toThrow(/Reserved Pro feature/);
      expect(() => assertPro(id), id).toThrow(/Reserved Pro feature/);
    }
    for (const id of Object.keys(PRO_FEATURES).filter((k) => PRO_FEATURES[k].used === true)) {
      expect(() => requirePro(id), id).not.toThrow();
    }
  });

  it('uses plain copy with no em dash', () => {
    expect(MSG_PRO_REQUIRED).not.toMatch(/—|–/);
    expect(MSG_PRO_REQUIRED).toMatch(/Settings > License/);
  });
});
