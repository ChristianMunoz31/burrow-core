// Store per-feature Pro (docs/LICENSING.md 6.1) through the real server.js and the agent functions: a
// perpetual license past its update window (proScope 'features_until') passes the routes of the features it
// includes and answers 403 pro_required with reason newer_license_required for the others. The license
// evaluation itself is covered in license/storeFeatureGating.test.js; here getEntitlements() is the seam.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

vi.mock('../../loadEnv.js', () => ({}));
vi.mock('node-fetch', () => ({ default: vi.fn() }));
vi.mock('../javi/advisorService.js', () => ({ generateAdvice: vi.fn(), streamAdvice: vi.fn() }));
vi.mock('../license/index.js', async (importOriginal) => (await import('./helpers/pro.js')).mockLicenseModule(importOriginal));

import fetch from 'node-fetch';
import { installFakeOllama } from './helpers/fakeOllama.js';
import { __resetAiForTests, classifyAiError } from '../ai/index.js';
import { aiErrorBody } from '../ai/gate.js';
import { cleanupBackupEnv, resetBackupEnv } from './helpers/backupEnv.js';
import { FREE, resetPro, setEntitlements } from './helpers/pro.js';
import { MSG_NEWER_LICENSE, MSG_PRO_REQUIRED, ProRequiredError, assertPro, requirePro } from '../pro.js';
import { PRO_FEATURE_INTRODUCED_AT } from '../license/proFeatureDates.js';

const INSIGHT = { id: 'sleep_dining', n: 20, rho: 0.4, nA: 8, nB: 12, meanA: 20, meanB: 10, effectPct: 100, unit: 'usd' };
const ALL = Object.keys(PRO_FEATURE_INTRODUCED_AT);

/** The getEntitlements() result of a Store build's perpetual license past its update window. */
const lapsed = (included) => ({
  pro: false,
  edition: 'standard',
  reasons: ['update_window_passed'],
  proScope: 'features_until',
  proFeatures: { included, locked: ALL.filter((id) => !included.includes(id)) },
});

const ROUTES = [
  ['/api/jarvis', 'javi_tools', { prompt: 'what is due today' }],
  ['/api/jarvis/actions/00000000000000000000000000000000', 'javi_tools', { approve: true }],
  ['/api/jarvis/advice', 'javi_conversation', { page: 'todos', messages: [{ role: 'user', content: 'and next week?' }] }],
  ['/api/jarvis/briefing/refresh', 'briefings', {}],
  ['/api/insights/explain', 'explain', { windowDays: 30, insights: [INSIGHT] }],
];

let app;
let ip = 0;
const post = (path, body) => request(app).post(path).set('X-Forwarded-For', `198.51.100.${(ip += 1) % 250}`).send(body);
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
  delete process.env.BURROW_AI;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  resetPro();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('a lapsed Store license on the Pro routes', () => {
  it.each(ROUTES)('POST %s answers 403 newer_license_required when the feature is locked, before SSE and any model call', async (path, feature, body) => {
    setEntitlements(lapsed(ALL.filter((id) => id !== feature)));
    const res = await post(path, body).set('Accept', 'text/event-stream');
    expect(res.status).toBe(403);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({ error: 'pro_required', feature, reason: 'newer_license_required', message: MSG_NEWER_LICENSE });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('POST /api/jarvis/advice passes the Pro gate when javi_conversation is included (reaches the AI gate)', async () => {
    setEntitlements(lapsed(['javi_conversation']));
    process.env.BURROW_AI = '0';
    const res = await post('/api/jarvis/advice', { page: 'todos', messages: [{ role: 'user', content: 'and next week?' }] });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('ai_not_configured');
  });

  it('a free user still gets the plain pro_required body with no reason', async () => {
    setEntitlements(FREE);
    const res = await post('/api/jarvis', { prompt: 'hi' });
    expect(res.body).toEqual({ error: 'pro_required', feature: 'javi_tools', message: MSG_PRO_REQUIRED });
  });

  it('a state without proFeatures or with unknown ids fails closed', async () => {
    setEntitlements({ ...lapsed([]), proFeatures: undefined });
    expect((await post('/api/jarvis', { prompt: 'hi' })).status).toBe(403);
    setEntitlements(lapsed(['not_a_feature']));
    expect((await post('/api/jarvis', { prompt: 'hi' })).status).toBe(403);
  });

  it('a reserved feature (null date) is refused outright while the shipped ones are included', () => {
    setEntitlements(lapsed(['javi_tools', 'javi_conversation', 'briefings', 'explain']));
    for (const id of ALL.filter((f) => PRO_FEATURE_INTRODUCED_AT[f] === null)) {
      expect(() => assertPro(id)).toThrow(/not gated yet/);
    }
    for (const id of ['javi_tools', 'javi_conversation', 'briefings', 'explain']) expect(() => assertPro(id)).not.toThrow();
  });
});

describe('assertPro, requirePro and the error mapping with a lapsed Store license', () => {
  it('assertPro throws a 403 ProRequiredError with the reason and fixed copy for a locked feature, passes an included one', () => {
    setEntitlements(lapsed(['javi_tools']));
    expect(() => assertPro('javi_tools')).not.toThrow();
    let caught;
    try {
      assertPro('briefings');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ProRequiredError);
    expect(caught).toMatchObject({ code: 'pro_required', httpStatus: 403, feature: 'briefings', reason: 'newer_license_required', publicMessage: MSG_NEWER_LICENSE });
    expect(aiErrorBody(caught)).toEqual({ error: 'pro_required', feature: 'briefings', reason: 'newer_license_required', message: MSG_NEWER_LICENSE });
    expect(classifyAiError(caught)).toMatchObject({ code: 'pro_required', reason: 'newer_license_required', httpStatus: 403, message: MSG_NEWER_LICENSE });
  });

  it('the copy is fixed and has no em dash', () => {
    expect(MSG_NEWER_LICENSE).toBe("This feature came out after your license's updates ended. It is included in a newer Burrow Pro license.");
    expect(MSG_NEWER_LICENSE).not.toContain('—');
  });

  it('requirePro middleware calls next for an included feature', () => {
    setEntitlements(lapsed(['explain']));
    const next = vi.fn();
    requirePro('explain')({}, {}, next);
    expect(next).toHaveBeenCalled();
  });

  it('a plain free error has no reason', () => {
    setEntitlements(FREE);
    expect(() => assertPro('briefings')).toThrow(expect.objectContaining({ reason: null, publicMessage: MSG_PRO_REQUIRED }));
    expect(aiErrorBody(new ProRequiredError('briefings'))).toEqual({ error: 'pro_required', feature: 'briefings', message: MSG_PRO_REQUIRED });
  });
});
