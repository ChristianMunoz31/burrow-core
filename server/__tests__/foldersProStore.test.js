// Store per-feature Pro (docs/LICENSING.md 6.1) on the three Folders ids (the report and ask routes are in foldersProStore.pro.test.js): a perpetual Store license past its update
// window answers 403 pro_required with reason newer_license_required for a folder feature it does not include, and
// passes the gate for one it does. Turning the daily re-scan off and renaming a folder stay free on every tier.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

vi.mock('../../loadEnv.js', () => ({}));
vi.mock('node-fetch', () => ({ default: vi.fn() }));
vi.mock('../license/index.js', async (importOriginal) => (await import('./helpers/pro.js')).mockLicenseModule(importOriginal));

import fetch from 'node-fetch';
import { __resetAiForTests } from '../ai/index.js';
import { PRO_FEATURE_INTRODUCED_AT } from '../license/proFeatureDates.js';
import { MSG_NEWER_LICENSE, MSG_PRO_REQUIRED, PRO_FEATURES, assertPro } from '../pro.js';
import { cleanupBackupEnv, resetBackupEnv } from './helpers/backupEnv.js';
import { installFakeOllama } from './helpers/fakeOllama.js';
import { FREE, resetPro, setEntitlements } from './helpers/pro.js';

const ALL = Object.keys(PRO_FEATURE_INTRODUCED_AT);
const NO_FOLDER = '00000000-0000-4000-8000-000000000000';
const FOLDER_IDS = ['folder_qa', 'folder_report', 'folder_auto_rescan'];

const lapsed = (included) => ({
  pro: false,
  edition: 'standard',
  reasons: ['update_window_passed'],
  proScope: 'features_until',
  proFeatures: { included, locked: ALL.filter((id) => !included.includes(id)) },
});

/** [feature, method, path, body] */
const ROUTES = [
  ['folder_auto_rescan', 'PATCH', `/api/folders/${NO_FOLDER}`, { autoRescan: true }],
];

let app;
let ip = 0;
const call = (method, path, body) => {
  const req = request(app)[method.toLowerCase()](path).set('X-Forwarded-For', `198.51.100.${(ip += 1) % 250}`);
  return body === undefined ? req : req.send(body);
};
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
  vi.restoreAllMocks();
});

describe('the three folder ids are registered, used and dated', () => {
  it.each(FOLDER_IDS)('%s', (id) => {
    expect(PRO_FEATURES[id]).toMatchObject({ used: true });
    expect(PRO_FEATURE_INTRODUCED_AT[id]).toBe('2026-10-08T00:00:00Z');
  });

  it('has the documented labels', () => {
    expect(PRO_FEATURES.folder_qa.label).toBe('Ask your folders');
    expect(PRO_FEATURES.folder_report.label).toBe('Folder cross-file reports');
    expect(PRO_FEATURES.folder_auto_rescan.label).toBe('Scheduled folder re-scan');
  });
});

describe('a lapsed Store license on the folder Pro routes (the report and ask routes are tested in the Pro twin)', () => {
  it.each(ROUTES)('%s: %s %s answers 403 newer_license_required when locked, before any lookup or model call', async (feature, method, path, body) => {
    setEntitlements(lapsed(ALL.filter((id) => id !== feature)));
    const res = await call(method, path, body);
    expect(res.status).toBe(403);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({ error: 'pro_required', feature, reason: 'newer_license_required', message: MSG_NEWER_LICENSE });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(ROUTES)('%s: %s %s passes the gate when the feature is included (the folder itself is then missing)', async (feature, method, path, body) => {
    setEntitlements(lapsed([feature]));
    const res = await call(method, path, body);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: 'folder_not_found', code: 'folder_not_found' });
  });

  it('a free user gets the plain pro_required body with no reason', async () => {
    setEntitlements(FREE);
    for (const [feature, method, path, body] of ROUTES) {
      const res = await call(method, path, body);
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: 'pro_required', feature, message: MSG_PRO_REQUIRED });
    }
  });

  it('a state without proFeatures fails closed', async () => {
    setEntitlements({ ...lapsed([]), proFeatures: undefined });
    for (const [, method, path, body] of ROUTES) expect((await call(method, path, body)).status).toBe(403);
  });

  it('assertPro throws for a locked folder feature and passes an included one', () => {
    setEntitlements(lapsed(['folder_qa']));
    expect(() => assertPro('folder_qa')).not.toThrow();
    expect(() => assertPro('folder_report')).toThrow(expect.objectContaining({ code: 'pro_required', reason: 'newer_license_required', feature: 'folder_report' }));
  });
});

describe('what stays free on every tier', () => {
  const FREE_CALLS = [
    ['PATCH {autoRescan:false}', () => call('PATCH', `/api/folders/${NO_FOLDER}`, { autoRescan: false })],
    ['PATCH {name}', () => call('PATCH', `/api/folders/${NO_FOLDER}`, { name: 'Renamed' })],
    ['PATCH {name, autoRescan:false}', () => call('PATCH', `/api/folders/${NO_FOLDER}`, { name: 'Renamed', autoRescan: false })],
    ['GET /api/folders', () => call('GET', '/api/folders')],
    ['GET job', () => call('GET', `/api/folders/${NO_FOLDER}/job`)],
    ['GET files', () => call('GET', `/api/folders/${NO_FOLDER}/files`)],
    ['POST export', () => call('POST', `/api/folders/${NO_FOLDER}/export`, { format: 'csv' })],
    ['POST scan', () => call('POST', `/api/folders/${NO_FOLDER}/scan`)],
    ['POST cancel', () => call('POST', `/api/folders/${NO_FOLDER}/cancel`)],
    ['DELETE', () => call('DELETE', `/api/folders/${NO_FOLDER}`)],
  ];

  it.each([
    ['free', () => setEntitlements(FREE)],
    ['a Store license past its update window with no folder feature', () => setEntitlements(lapsed([]))],
  ])('under %s none of the free routes is refused for tier', async (_tier, apply) => {
    apply();
    for (const [label, run] of FREE_CALLS) {
      const res = await run();
      expect(res.body?.error, label).not.toBe('pro_required');
      expect(res.status, label).not.toBe(403);
      expect(res.status, label).toBe(label === 'GET /api/folders' ? 200 : res.status);
    }
    expect((await call('PATCH', `/api/folders/${NO_FOLDER}`, { name: 'x' })).status).toBe(404);
  });
});
