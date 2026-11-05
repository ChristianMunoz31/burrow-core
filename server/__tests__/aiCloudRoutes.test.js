// Settings > AI cloud API: consent, categories, base URL checks, enable and disable, the hint,
// and the status payloads. Through the real server.js on a temp database; no real network.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

vi.mock('../../loadEnv.js', () => ({}));
vi.mock('node-fetch', () => ({ default: vi.fn() }));

import fetch from 'node-fetch';
import { CLOUD_BASE_URL, CLOUD_HOST, CLOUD_KEY, configureCloud, installCloudAndOllama, resetCloud } from './helpers/fakeCloud.js';
import { closeTestDb, createTestDb, resetDb } from './helpers/testDb.js';
import { getCloudCategories, getCloudConsent } from '../ai/consent.js';
import { getAiSettings } from '../ai/settings.js';
import { isEnabled, __resetNetPolicyForTests } from '../netPolicy.js';
import { listAudit } from '../audit.js';
import { setState } from '../dataAccess.js';
import { AI_SETTINGS_KEY } from '../ai/settings.js';
import { NETWORK_STATE_KEY } from '../netPolicy.js';

let app;
let db;
let ip = 0;
const nextIp = () => `198.51.100.${(ip += 1) % 250}`;
const get = (path) => request(app).get(path).set('X-Forwarded-For', nextIp());
const put = (path, body) => request(app).put(path).set('X-Forwarded-For', nextIp()).send(body);
const post = (path, body) => request(app).post(path).set('X-Forwarded-For', nextIp()).send(body);
const ACKS = ['sends_data', 'pay_provider'];
const enableBody = (extra = {}) => ({ version: 1, host: CLOUD_HOST, baseUrl: CLOUD_BASE_URL, acknowledgements: ACKS, ...extra });
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
  installCloudAndOllama(fetch);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

/** A configured but not yet consented cloud setup: address, model and key saved, nothing on. */
const prepared = () => configureCloud({ consent: false, optIn: false, provider: 'ollama' });
const auditRows = async () => (await listAudit({ limit: 100 })).entries.filter((e) => e.feature === 'cloud_ai_consent');

describe('GET /api/settings/ai (cloud block)', () => {
  it('reports the default cloud state: off, nothing consented, default categories', async () => {
    const res = await get('/api/settings/ai');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.data.cloud).toEqual({
      optIn: false,
      keySaved: false,
      baseUrl: null,
      host: null,
      model: null,
      tokenParam: 'max_tokens',
      ready: false,
      consent: { current: false, acceptedAt: null, host: null, version: null },
      consentVersion: 1,
      categories: { budget: true, todos: true, calendar: true, habits: true, health: false, notes: false, journal: false, bookmarks: true, countdowns: true, focus: true, folders: false },
      active: false,
    });
  });

  it('reports ready once address, model and key exist, and never returns the key', async () => {
    await prepared();
    const res = await get('/api/settings/ai');
    expect(res.body.data.cloud).toMatchObject({ keySaved: true, baseUrl: CLOUD_BASE_URL, host: CLOUD_HOST, model: 'cloud-model', ready: true, active: false, consent: { current: false } });
    expect(JSON.stringify(res.body)).not.toContain(CLOUD_KEY);
  });

  it('an old consent (wrong version or host) is not current but is still described', async () => {
    await configureCloud({ consent: { version: 1, host: 'old.example.com', acceptedAt: '2026-01-01T00:00:00.000Z', acknowledgements: ACKS } });
    const { cloud } = (await get('/api/settings/ai')).body.data;
    expect(cloud.consent).toEqual({ current: false, acceptedAt: '2026-01-01T00:00:00.000Z', host: 'old.example.com', version: 1 });
    expect(cloud.active).toBe(false);
  });
});

describe('PUT /api/settings/ai/cloud', () => {
  it.each([
    ['http://api.example.com/v1', 'https_required'],
    ['https://127.0.0.1:8443/v1', 'private_address'],
    ['https://192.168.1.20/v1', 'private_address'],
    ['https://169.254.169.254/v1', 'private_address'],
    ['https://localhost/v1', 'local_name'],
    ['https://nas.local/v1', 'local_name'],
    ['https://api.example.com/v1?key=1', 'query_or_hash'],
    ['https://user:pw@api.example.com/v1', 'credentials'],
    ['ftp://api.example.com', 'protocol'],
    ['', 'length'],
    [42, 'not_a_string'],
  ])('rejects %j with 400 invalid_host and reason %s', async (baseUrl, reason) => {
    const res = await put('/api/settings/ai/cloud', { baseUrl });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'invalid_host', code: 'invalid_host', reason });
    expect((await getAiSettings()).cloud.baseUrl).toBeNull();
  });

  it('saves a public https address and reports its host', async () => {
    const res = await put('/api/settings/ai/cloud', { baseUrl: `https://${CLOUD_HOST}/v1/`, model: 'gpt-test', tokenParam: null });
    expect(res.status).toBe(200);
    expect(res.body.data.cloud).toMatchObject({ baseUrl: CLOUD_BASE_URL, host: CLOUD_HOST, model: 'gpt-test' });
  });

  it('changing to a different host clears consent and sets the provider back to ollama (key, model and address stay)', async () => {
    await configureCloud();
    expect((await get('/api/settings/ai')).body.data.cloud.active).toBe(true);
    const res = await put('/api/settings/ai/cloud', { baseUrl: 'https://api.other-example.org/v1' });
    expect(res.status).toBe(200);
    expect(res.body.data.provider).toBe('ollama');
    expect(res.body.data.effectiveProvider).toBe('ollama');
    expect(res.body.data.cloud).toMatchObject({ host: 'api.other-example.org', model: 'cloud-model', keySaved: true, consent: { current: false, host: null }, active: false });
    expect(await getCloudConsent()).toBeNull();
  });

  it('clearing the address also clears consent', async () => {
    await configureCloud();
    const res = await put('/api/settings/ai/cloud', { baseUrl: null });
    expect(res.body.data.provider).toBe('ollama');
    expect(await getCloudConsent()).toBeNull();
  });

  it('a different path on the same host clears consent and returns to local; changing only the model keeps it', async () => {
    await configureCloud();
    const model = await put('/api/settings/ai/cloud', { model: 'another-model' });
    expect(model.body.data.cloud).toMatchObject({ consent: { current: true }, active: true, model: 'another-model' });
    const path = await put('/api/settings/ai/cloud', { baseUrl: `https://${CLOUD_HOST}/other/v2` });
    expect(path.body.data.provider).toBe('ollama');
    expect(path.body.data.cloud).toMatchObject({ consent: { current: false }, active: false });
  });

  it('validates the other fields as before', async () => {
    expect((await put('/api/settings/ai/cloud', { model: 'a b' })).body.code).toBe('invalid_model');
    expect((await put('/api/settings/ai/cloud', { tokenParam: 'max' })).body.code).toBe('invalid_token_param');
    expect((await put('/api/settings/ai/cloud', [1])).body.code).toBe('invalid_body');
  });
});

describe('PUT /api/settings/ai/cloud-categories', () => {
  it('saves a partial change, returns the full payload, and records an audit row with names only', async () => {
    const res = await put('/api/settings/ai/cloud-categories', { categories: { journal: true, todos: false } });
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.data.cloud.categories).toMatchObject({ journal: true, todos: false, health: false, budget: true });
    expect(await getCloudCategories()).toMatchObject({ journal: true, todos: false });
    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].meta).toEqual({
      action: 'categories',
      shared: ['budget', 'calendar', 'habits', 'journal', 'bookmarks', 'countdowns', 'focus'],
      withheld: ['todos', 'health', 'notes', 'folders'],
    });
    expect(rows[0].kind).toBe('llm');
  });

  it('later patches merge with earlier ones', async () => {
    await put('/api/settings/ai/cloud-categories', { categories: { journal: true } });
    const res = await put('/api/settings/ai/cloud-categories', { categories: { health: true } });
    expect(res.body.data.cloud.categories).toMatchObject({ journal: true, health: true });
  });

  it.each([
    ['an unknown id', { categories: { bogus: true } }],
    ['the internal memory scope', { categories: { memory: true } }],
    ['a non-boolean value', { categories: { journal: 'yes' } }],
    ['a null value', { categories: { journal: null } }],
    ['categories as an array', { categories: [true] }],
    ['no categories key', {}],
    ['an array body', ['journal']],
  ])('rejects %s with 400 invalid_body and changes nothing', async (_label, body) => {
    const res = await put('/api/settings/ai/cloud-categories', body);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'invalid_body', code: 'invalid_body' });
    expect(await getCloudCategories()).toMatchObject({ journal: false });
    expect(await auditRows()).toHaveLength(0);
  });

  it('accepts an empty categories object (no change)', async () => {
    expect((await put('/api/settings/ai/cloud-categories', { categories: {} })).status).toBe(200);
  });
});

describe('POST /api/settings/ai/cloud/enable', () => {
  it('records consent, turns the opt-in and the provider on, audits it, and returns the full payload', async () => {
    await prepared();
    expect(await isEnabled('cloudAi')).toBe(false);
    const res = await post('/api/settings/ai/cloud/enable', enableBody());
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.data).toMatchObject({
      provider: 'openai_compat',
      effectiveProvider: 'openai_compat',
      cloud: { optIn: true, ready: true, active: true, consent: { current: true, host: CLOUD_HOST, version: 1 } },
    });
    expect(await isEnabled('cloudAi')).toBe(true);
    expect(await getCloudConsent()).toMatchObject({ version: 1, host: CLOUD_HOST, acknowledgements: ACKS });
    expect((await getAiSettings()).provider).toBe('openai_compat');
    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].meta).toEqual({ action: 'enabled', ai_host: CLOUD_HOST, version: 1 });
    expect(rows[0].provider).toBe('openai_compat');
    expect(JSON.stringify(rows)).not.toContain(CLOUD_KEY);
    // Turning it on does not itself call the provider.
    expect(fetch.mock.calls.some(([u]) => String(u).includes(CLOUD_HOST))).toBe(false);
  });

  it.each([
    ['no body', undefined],
    ['an array body', ['yes']],
    ['a string version', { version: '1', host: CLOUD_HOST, baseUrl: CLOUD_BASE_URL, acknowledgements: ACKS }],
    ['a missing host', { version: 1, baseUrl: CLOUD_BASE_URL, acknowledgements: ACKS }],
    ['a missing baseUrl', { version: 1, host: CLOUD_HOST, acknowledgements: ACKS }],
    ['a non-string baseUrl', { version: 1, host: CLOUD_HOST, baseUrl: 5, acknowledgements: ACKS }],
    ['acknowledgements not an array', { version: 1, host: CLOUD_HOST, baseUrl: CLOUD_BASE_URL, acknowledgements: 'sends_data' }],
  ])('400 invalid_body for %s', async (_label, body) => {
    await prepared();
    const res = await post('/api/settings/ai/cloud/enable', body);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_body');
    expect(await getCloudConsent()).toBeNull();
  });

  it.each([[[]], [['sends_data']], [['pay_provider']], [['sends_data', 'something_else']]])('400 acknowledgements_required for %j', async (acknowledgements) => {
    await prepared();
    const res = await post('/api/settings/ai/cloud/enable', enableBody({ acknowledgements }));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('acknowledgements_required');
    expect(await getCloudConsent()).toBeNull();
    expect(await isEnabled('cloudAi')).toBe(false);
  });

  it.each([
    ['no key', { key: null }],
    ['no model', { model: null }],
  ])('400 cloud_not_configured with %s', async (_label, overrides) => {
    await configureCloud({ consent: false, optIn: false, provider: 'ollama', ...overrides });
    const res = await post('/api/settings/ai/cloud/enable', enableBody());
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('cloud_not_configured');
    expect(await getCloudConsent()).toBeNull();
  });

  it('400 cloud_not_configured with no address', async () => {
    const res = await post('/api/settings/ai/cloud/enable', enableBody());
    expect(res.body.code).toBe('cloud_not_configured');
  });

  it('409 consent_outdated for another consent version', async () => {
    await prepared();
    const res = await post('/api/settings/ai/cloud/enable', enableBody({ version: 2 }));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('consent_outdated');
    expect(await getCloudConsent()).toBeNull();
    expect(await isEnabled('cloudAi')).toBe(false);
  });

  it('409 host_changed when the host the user confirmed is not the saved one', async () => {
    await prepared();
    const res = await post('/api/settings/ai/cloud/enable', enableBody({ host: 'api.somewhere-else.org' }));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('host_changed');
    expect(await getCloudConsent()).toBeNull();
    expect(await isEnabled('cloudAi')).toBe(false);
    expect((await getAiSettings()).provider).toBe('ollama');
  });

  it.each([
    ['another path on the same host', `https://${CLOUD_HOST}/other/v2`],
    ['another host', 'https://api.somewhere-else.org/v1'],
    ['an unparseable address', 'not a url'],
  ])('409 host_changed when the confirmed baseUrl is %s', async (_label, baseUrl) => {
    await prepared();
    const res = await post('/api/settings/ai/cloud/enable', enableBody({ baseUrl }));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('host_changed');
    expect(await getCloudConsent()).toBeNull();
    expect(await isEnabled('cloudAi')).toBe(false);
  });

  it('accepts the same baseUrl with a trailing slash (compared normalized)', async () => {
    await prepared();
    const res = await post('/api/settings/ai/cloud/enable', enableBody({ baseUrl: `${CLOUD_BASE_URL}/` }));
    expect(res.status).toBe(200);
    expect((await getCloudConsent()).baseUrl).toBe(CLOUD_BASE_URL);
  });
});

describe('POST /api/settings/ai/cloud/disable', () => {
  it('switches back to ollama, clears consent, turns the opt-in off and keeps address, model and key', async () => {
    await configureCloud();
    const res = await post('/api/settings/ai/cloud/disable', {});
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      provider: 'ollama',
      effectiveProvider: 'ollama',
      cloud: { optIn: false, keySaved: true, baseUrl: CLOUD_BASE_URL, model: 'cloud-model', ready: true, active: false, consent: { current: false, host: null } },
    });
    expect(await getCloudConsent()).toBeNull();
    expect(await isEnabled('cloudAi')).toBe(false);
    const rows = await auditRows();
    expect(rows.map((r) => r.meta)).toEqual([{ action: 'disabled' }]);
  });

  it('works when cloud was never on, and writes no audit row because nothing changed', async () => {
    expect((await post('/api/settings/ai/cloud/disable', {})).status).toBe(200);
    expect(await auditRows()).toEqual([]);
  });

  it('a second disable changes nothing and is not audited again', async () => {
    await configureCloud();
    await post('/api/settings/ai/cloud/disable', {});
    await post('/api/settings/ai/cloud/disable', {});
    expect((await auditRows()).map((r) => r.meta)).toEqual([{ action: 'disabled' }]);
  });

  it('enable then disable then enable again needs a fresh consent record each time', async () => {
    await prepared();
    expect((await post('/api/settings/ai/cloud/enable', enableBody())).body.data.cloud.consent.current).toBe(true);
    expect((await post('/api/settings/ai/cloud/disable', {})).body.data.cloud.consent.current).toBe(false);
    expect((await put('/api/settings/ai/provider', { provider: 'openai_compat' })).status).toBe(403);
    expect((await post('/api/settings/ai/cloud/enable', enableBody())).body.data.cloud.active).toBe(true);
  });
});

describe('PUT /api/settings/ai/provider', () => {
  it('refuses openai_compat with 409 cloud_consent_required when consent is not current', async () => {
    await configureCloud({ consent: false });
    const res = await put('/api/settings/ai/provider', { provider: 'openai_compat' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('cloud_consent_required');
    expect((await getAiSettings()).provider).toBe('openai_compat');
  });

  it('refuses openai_compat for consent given to another host', async () => {
    await configureCloud({ consent: { version: 1, host: 'old.example.com', acceptedAt: '2026-01-01T00:00:00.000Z', acknowledgements: ACKS }, provider: 'ollama' });
    await setState(AI_SETTINGS_KEY, { provider: 'ollama', cloud: { baseUrl: CLOUD_BASE_URL, model: 'cloud-model' } });
    expect((await put('/api/settings/ai/provider', { provider: 'openai_compat' })).status).toBe(409);
    expect((await getAiSettings()).provider).toBe('ollama');
  });

  it('allows openai_compat once consent is current, and ollama any time', async () => {
    await configureCloud({ provider: 'ollama' });
    expect((await put('/api/settings/ai/provider', { provider: 'openai_compat' })).status).toBe(200);
    expect((await put('/api/settings/ai/provider', { provider: 'ollama' })).status).toBe(200);
  });

  it('keeps the older checks first: opt-in (403) and configuration (400)', async () => {
    await setState(NETWORK_STATE_KEY, {});
    __resetNetPolicyForTests();
    expect((await put('/api/settings/ai/provider', { provider: 'openai_compat' })).status).toBe(403);
    await setState(NETWORK_STATE_KEY, { cloudAi: true });
    __resetNetPolicyForTests();
    expect((await put('/api/settings/ai/provider', { provider: 'openai_compat' })).body.code).toBe('cloud_not_configured');
  });
});

describe('POST /api/settings/ai/cloud-hint', () => {
  it.each(['shown', 'dismissed'])('records %s and answers that nothing is showing now', async (event) => {
    const res = await post('/api/settings/ai/cloud-hint', { event });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: { cloudHint: { show: false, reason: null } } });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('dismissed sets both timestamps, shown only lastShownAt', async () => {
    const { getCloudHintState } = await import('../ai/consent.js');
    await post('/api/settings/ai/cloud-hint', { event: 'shown' });
    const afterShown = await getCloudHintState();
    expect(afterShown.lastShownAt).toEqual(expect.any(String));
    expect(afterShown.dismissedAt).toBeNull();
    await post('/api/settings/ai/cloud-hint', { event: 'dismissed' });
    const afterDismissed = await getCloudHintState();
    expect(afterDismissed.dismissedAt).toEqual(expect.any(String));
  });

  it.each([[{ event: 'clicked' }], [{}], [['shown']], [{ event: 5 }]])('400 invalid_body for %j', async (body) => {
    const res = await post('/api/settings/ai/cloud-hint', body);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_body');
  });
});

describe('GET /api/jarvis/status', () => {
  it('reports where Javi runs and the (hidden) cloud hint for a local setup', async () => {
    const res = await get('/api/jarvis/status');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ available: true, provider: 'ollama', ai: { kind: 'local', host: null }, cloudHint: { show: false, reason: null } });
  });

  it('reports the cloud host when cloud is active, and never a hint', async () => {
    await configureCloud();
    const res = await get('/api/jarvis/status');
    expect(res.body).toMatchObject({ available: true, provider: 'openai_compat', ai: { kind: 'cloud', host: CLOUD_HOST }, cloudHint: { show: false, reason: null } });
  });

  it('falls back to local in the status when consent is missing (paused)', async () => {
    await configureCloud({ consent: false });
    const res = await get('/api/jarvis/status');
    expect(res.body).toMatchObject({ provider: 'ollama', ai: { kind: 'local', host: null } });
  });
});
