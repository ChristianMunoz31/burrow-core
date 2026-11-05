// /api/license through the real server.js app, with injected clock, fetch, build info and store config
// (docs/LICENSING.md 10). node-fetch is mocked to throw: no request reaches a store.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';

vi.mock('../../../loadEnv.js', () => ({}));
vi.mock('node-fetch', () => ({
  default: vi.fn(async () => {
    throw new Error('real fetch must not be used');
  }),
}));

import { select } from '../../db/query.js';
import { ACTIVATION_FILE_NAME, ACTIVATION_STATE_KEY, LICENSE_KEY_SECRET_NAME } from '../../license/constants.js';
import { resetLicenseForTests } from '../../license/index.js';
import { GUMROAD_KEY, LS_INSTANCE_ID, LS_KEY, gumroadVerify, GUMROAD_FREE_PRODUCT_ID, queueGumroad, lsActivate, reply } from './fixtures/storeResponses.js';
import { createHarness, DAY, T0 } from './helpers.js';
import { TEST_STORE_CONFIG } from './fixtures/storeResponses.js';

const ENV_KEYS = ['SECRETS_ENCRYPTION_KEY', 'APP_PASSWORD', 'AUTH_SECRET', 'BURROW_DESKTOP'];
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
afterAll(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

let app;
let h;
let ipCounter = 0;
// The rate limiter keys on the client IP; every test gets its own so budgets never leak between tests.
const ip = () => `10.${Math.floor(ipCounter / 250)}.${ipCounter++ % 250}.7`;
let clientIp;

beforeAll(async () => {
  for (const k of ENV_KEYS) delete process.env[k];
  app = (await import('../../../server.js')).default;
});

beforeEach(() => {
  h = createHarness();
  h.init();
  clientIp = ip();
});
afterEach(() => h.cleanup());

const get = () => request(app).get('/api/license').set('X-Forwarded-For', clientIp);
const send = (method, url, body) => {
  const req = request(app)[method](url).set('X-Forwarded-For', clientIp);
  return body === undefined ? req : req.send(body);
};
const activate = (body) => send('post', '/api/license/activate', body);
const deactivate = (body) => send('post', '/api/license/deactivate', body);
const gumroadOnce = (purchase = {}, uses = 1) => queueGumroad(h.fetch, { uses, purchase });
const dbRow = () => select('app_state', { columns: ['value'], where: { key: ACTIVATION_STATE_KEY }, db: h.db })[0]?.value;
const secretRows = () => select('app_secrets', { db: h.db }).filter((r) => r.name === LICENSE_KEY_SECRET_NAME);
const FORBIDDEN = /keyHash|instanceId|"mac"|productId|variantId/;

describe('GET /api/license', () => {
  it('answers the free state with the documented shape, stores and no-store', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({
      state: 'free',
      pro: false,
      edition: null,
      reasons: ['no_license'],
      message: expect.stringContaining('Burrow Free'),
      invalidReason: null,
      license: null,
      trialDaysLeft: null,
      build: { date: '2026-10-05T12:00:00Z', source: 'git', version: expect.any(String) },
      clock: { rollbackDetected: false },
      licenseState: 'free',
      proSource: null,
      trial: { state: 'available', startedAt: null, endsAt: null, daysLeft: null, remindToday: false, notice: null },
      perks: { founderBackground: false },
      stores: [
        { id: 'gumroad', label: 'Gumroad', configured: true },
        { id: 'lemonsqueezy', label: 'Lemon Squeezy', configured: true },
      ],
      purchaseUrl: null,
      supportContact: 'support@example.com',
    });
    expect(res.body.message).not.toContain('—');
  });

  it('shows the stored activation view and never keyHash, instanceId, mac, ids or the key', async () => {
    gumroadOnce();
    const res = await activate({ licenseKey: GUMROAD_KEY });
    const status = (await get()).body;
    expect(status).toEqual(res.body);
    expect(status.license).toEqual({
      store: 'gumroad',
      storeLabel: 'Gumroad',
      edition: 'standard',
      purchaseDate: '2026-09-30T14:02:11Z',
      updatesUntil: '2027-09-30T14:02:11Z',
      expiresAt: null,
      activatedAt: '2026-10-05T12:00:00Z',
      email: 'buyer@example.com',
      keyLast4: '3333',
      test: false,
      canDeactivate: false,
    });
    expect((await get()).text).not.toMatch(FORBIDDEN);
    expect((await get()).text).not.toContain(GUMROAD_KEY);
  });

  it('reports a Lemon Squeezy activation without its instance id', async () => {
    h.fetch.mockResolvedValueOnce(reply(200, lsActivate()));
    const res = await activate({ licenseKey: LS_KEY });
    expect(res.status).toBe(200);
    expect(res.body.license).toMatchObject({ store: 'lemonsqueezy', canDeactivate: true });
    expect(res.text).not.toMatch(FORBIDDEN);
    expect(res.text).not.toContain(LS_INSTANCE_ID);
    expect(res.text).not.toContain(LS_KEY);
  });

  it('reports each state: pro, update_window_passed, expired, clock_issue, invalid', async () => {
    gumroadOnce({ product_id: GUMROAD_FREE_PRODUCT_ID, variants: '(Student)' });
    await activate({ licenseKey: GUMROAD_KEY });
    expect((await get()).body).toMatchObject({ state: 'pro', pro: true, edition: 'student' });

    h.clock.t = Date.parse('2027-10-10T00:00:00Z');
    h.clock.m += 400 * DAY;
    expect((await get()).body).toMatchObject({ state: 'expired', pro: false, edition: 'student' });

    h.clock.t = T0 + 5 * DAY; // set back beyond 48 h while the yearly license is still in date on this clock
    expect((await get()).body).toMatchObject({ state: 'clock_issue', pro: false, clock: { rollbackDetected: true } });

    // update_window_passed: a build newer than updatesUntil
    h.clock = { t: T0, m: 1000 };
    resetLicenseForTests();
    h.init({ buildInfo: { buildDate: Date.parse('2027-12-01T00:00:00Z'), buildDateIso: '2027-12-01T00:00:00Z', source: 'git', version: '0.1.0' } });
    h.clock.t = Date.parse('2027-12-02T00:00:00Z');
    h.clock.m += 100 * DAY;
    gumroadOnce();
    expect((await activate({ licenseKey: 'AAAAAAAA-BBBBBBBB-CCCCCCCC-DDDDDDDD' })).body).toMatchObject({
      state: 'update_window_passed',
      pro: false,
      edition: 'standard',
      reasons: ['update_window_passed'],
    });

    // invalid: both copies edited
    const file = path.join(h.dir, ACTIVATION_FILE_NAME);
    const edited = { ...JSON.parse(fs.readFileSync(file, 'utf8')), edition: 'founding' };
    fs.writeFileSync(file, JSON.stringify(edited));
    h.db.prepare('UPDATE app_state SET value = ? WHERE key = ?').run(JSON.stringify(edited), ACTIVATION_STATE_KEY);
    resetLicenseForTests();
    h.init();
    expect((await get()).body).toMatchObject({ state: 'invalid', invalidReason: 'tampered', license: null, pro: false });
  });

  it('a test purchase shows the test flag and the advisory', async () => {
    h.init({ allowTest: true });
    gumroadOnce({ test: true });
    const res = await activate({ licenseKey: GUMROAD_KEY });
    expect(res.body.license.test).toBe(true);
    expect(res.body.reasons).toContain('test_purchase');
  });

  it('shows the seller fallback contact as null while it is empty', async () => {
    const empty = (await import('../../license/storeConfig.js')).buildStoreConfig({});
    h.init({ storeConfig: empty });
    const body = (await get()).body;
    expect(body.supportContact).toBeNull();
    expect(body.stores.every((s) => s.configured === false)).toBe(true);
  });
});

describe('GET /api/license purchaseUrl', () => {
  const URL_ = 'https://cdmunoz98.gumroad.com/l/burrow';
  it('is the configured store page, with no store request', async () => {
    h.init({ storeConfig: { ...TEST_STORE_CONFIG, GUMROAD_PURCHASE_URL: URL_, LEMON_SQUEEZY_PURCHASE_URL: null } });
    expect((await get()).body.purchaseUrl).toBe(URL_);
    expect(h.fetch).not.toHaveBeenCalled();
  });
  it('prefers Gumroad over Lemon Squeezy and falls back to the next configured store', async () => {
    const ls = 'https://example.test/ls';
    h.init({ storeConfig: { ...TEST_STORE_CONFIG, GUMROAD_PURCHASE_URL: URL_, LEMON_SQUEEZY_PURCHASE_URL: ls } });
    expect((await get()).body.purchaseUrl).toBe(URL_);
    h.init({ storeConfig: { ...TEST_STORE_CONFIG, GUMROAD_PURCHASE_URL: null, LEMON_SQUEEZY_PURCHASE_URL: ls } });
    expect((await get()).body.purchaseUrl).toBe(ls);
  });
  it('is null when unset or when the store is not configured', async () => {
    h.init({ storeConfig: { ...TEST_STORE_CONFIG, GUMROAD_PURCHASE_URL: null } });
    expect((await get()).body.purchaseUrl).toBeNull();
    const empty = (await import('../../license/storeConfig.js')).buildStoreConfig({ gumroad: { proPurchaseUrl: URL_ } });
    h.init({ storeConfig: empty });
    expect((await get()).body.purchaseUrl).toBeNull();
  });
});

describe('POST /api/license/activate', () => {
  it('200 with the new status and no-store', async () => {
    gumroadOnce();
    const res = await activate({ licenseKey: ` ${GUMROAD_KEY.toLowerCase()} `, store: 'gumroad' });
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toMatchObject({ state: 'pro', pro: true, edition: 'standard', proSource: 'license', licenseState: 'pro' });
  });

  it('the same key again is 200 with no store request', async () => {
    gumroadOnce();
    await activate({ licenseKey: GUMROAD_KEY });
    h.fetch.mockClear();
    const res = await activate({ licenseKey: GUMROAD_KEY });
    expect(res.status).toBe(200);
    expect(h.fetch).not.toHaveBeenCalled();
  });

  const S = 'support@example.com';
  it.each([
    [
      'invalid_key_format (no store)',
      { licenseKey: 'not a key' },
      null,
      400,
      "That doesn't look like a license key. Copy the key from your purchase email or receipt and paste it here.",
    ],
    [
      'invalid_key_format (store named)',
      { licenseKey: LS_KEY, store: 'gumroad' },
      null,
      400,
      "That doesn't look like a Gumroad license key. Check that you picked the store you bought from, then paste the key from your receipt.",
    ],
    [
      'key_not_found',
      { licenseKey: GUMROAD_KEY },
      reply(404, { success: false, message: 'LEAK-ME' }),
      422,
      "Gumroad doesn't recognize this key for Burrow Pro. Check that you copied the whole key from your Burrow Pro receipt and picked the store you bought from. If you downloaded the free version of Burrow, you don't need a key: Pro keys come from Burrow Pro.",
    ],
    [
      'license_disabled',
      { licenseKey: GUMROAD_KEY },
      reply(404, { success: false, message: 'This license key has been disabled. LEAK-ME' }),
      422,
      `This license key has been turned off by the seller. Email ${S} to sort it out.`,
    ],
    [
      'purchase_refunded',
      { licenseKey: GUMROAD_KEY },
      reply(200, gumroadVerify({ purchase: { refunded: true } })),
      422,
      `This purchase was refunded or disputed, so its key can't be activated. If you think that's a mistake, email ${S}.`,
    ],
    [
      'uses_exceeded',
      { licenseKey: GUMROAD_KEY },
      reply(200, gumroadVerify({ uses: 4 })),
      422,
      `This key has already been activated as many times as it allows. Email ${S} and ask them to reset your activations, then click Activate again.`,
    ],
    [
      'unknown_product',
      { licenseKey: GUMROAD_KEY },
      reply(200, gumroadVerify({ purchase: { product_id: 'other' } })),
      422,
      `This key isn't for Burrow Pro. Check your receipt for the Burrow key, or email ${S}.`,
    ],
    [
      'test_purchase_not_allowed',
      { licenseKey: GUMROAD_KEY },
      reply(200, gumroadVerify({ purchase: { test: true } })),
      422,
      'This is a test purchase key. Test keys only work in developer builds of Burrow. Use the key from your real purchase.',
    ],
    [
      'activation_limit_reached',
      { licenseKey: LS_KEY },
      reply(400, { activated: false, error: 'This license key has reached the activation limit. LEAK-ME' }),
      422,
      `This key is already active on as many computers as it allows. On a computer you no longer use, open Settings > License and click Move to another computer, then try again here. If you can't reach that computer, email ${S}.`,
    ],
    [
      'license_expired_at_store',
      { licenseKey: LS_KEY },
      reply(400, { activated: false, license_key: { status: 'expired' } }),
      422,
      `Lemon Squeezy says this license key has ended. If you think that's a mistake, email ${S}.`,
    ],
    [
      'license_expired',
      { licenseKey: LS_KEY },
      reply(200, lsActivate({ license_key: { created_at: '2025-01-01T00:00:00.000000Z' }, meta: { variant_id: 1004 } })),
      422,
      "This license has already ended, so it can't turn Pro on. If you have a newer key, paste it here and click Activate.",
    ],
    [
      'store_error',
      { licenseKey: GUMROAD_KEY },
      reply(500, { success: false, message: 'LEAK-ME' }),
      502,
      `Gumroad sent an answer Burrow couldn't use. Try again in a few minutes. If it keeps happening, email ${S}.`,
    ],
    ['store_busy', { licenseKey: GUMROAD_KEY }, reply(429, {}), 503, 'Gumroad is busy right now. Wait a minute, then try again.'],
  ])('%s', async (code, body, response, httpStatus, message) => {
    if (response) h.fetch.mockResolvedValue(response);
    const res = await activate(body);
    expect(res.status).toBe(httpStatus);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.error).toBe(code.split(' ')[0]);
    expect(res.body.message).toBe(message);
    expect(res.text).not.toContain('LEAK-ME');
    expect(res.text).not.toContain(GUMROAD_KEY);
    if (code === 'license_expired') expect(res.body.detail).toEqual({ endedAt: expect.stringMatching(/^2026-.*Z$/) });
    else expect(res.body.detail).toBeUndefined();
    expect((await get()).body.state).toBe('free');
  });

  it('store_unreachable is 503 with the activate copy', async () => {
    h.fetch.mockRejectedValueOnce(new Error('ENOTFOUND'));
    const res = await activate({ licenseKey: GUMROAD_KEY });
    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      error: 'store_unreachable',
      message: "Burrow couldn't reach Gumroad. Check your internet connection, then click Activate again. Nothing was changed on this computer.",
    });
  });

  it('store_not_configured is 503 while the owner file is empty', async () => {
    h.init({ storeConfig: (await import('../../license/storeConfig.js')).buildStoreConfig({}) });
    const res = await activate({ licenseKey: GUMROAD_KEY });
    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      error: 'store_not_configured',
      message: "This version of Burrow can't activate Gumroad licenses yet. Update Burrow, or email the seller (the contact address is on your receipt) for help.",
    });
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('activation_write_failed is 500 when there is no MAC key, before any request', async () => {
    h.keyOk = false;
    h.init();
    const res = await activate({ licenseKey: GUMROAD_KEY });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      error: 'activation_write_failed',
      message: "Burrow couldn't save your license on this computer. Check that the data folder can be written to, then click Activate again.",
    });
    expect(h.fetch).not.toHaveBeenCalled();
  });

  describe('invalid_request', () => {
    const expectInvalid = (res) => {
      expect(res.status).toBe(400);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body).toEqual({
        error: 'invalid_request',
        message: "Burrow couldn't read that request. Reload the page and try again.",
      });
      expect(h.fetch).not.toHaveBeenCalled();
    };

    it.each([
      ['an array body', [GUMROAD_KEY]],
      ['a string body', JSON.stringify(GUMROAD_KEY)],
      ['an empty body', {}],
      ['a numeric key', { licenseKey: 42 }],
      ['a null key', { licenseKey: null }],
      ['an unknown store', { licenseKey: GUMROAD_KEY, store: 'paypal' }],
      ['a non-string store', { licenseKey: GUMROAD_KEY, store: 7 }],
    ])('%s', async (_name, body) => {
      const req = request(app).post('/api/license/activate').set('X-Forwarded-For', clientIp);
      expectInvalid(await (typeof body === 'string' ? req.set('Content-Type', 'application/json').send(body) : req.send(body)));
    });

    it('a JSON parse error on this route', async () => {
      const res = await request(app)
        .post('/api/license/activate')
        .set('X-Forwarded-For', clientIp)
        .set('Content-Type', 'application/json')
        .send(`{"licenseKey": "${GUMROAD_KEY}`);
      expectInvalid(res);
      expect(res.text).not.toContain(GUMROAD_KEY);
    });
  });

  it('409 activation_in_progress while another call is in flight, then works again', async () => {
    let release;
    h.fetch.mockImplementationOnce(() => new Promise((resolve) => (release = () => resolve(reply(200, gumroadVerify())))));
    const first = activate({ licenseKey: GUMROAD_KEY }).then((r) => r);
    await vi.waitFor(() => expect(h.fetch).toHaveBeenCalledTimes(1));
    const second = await activate({ licenseKey: 'AAAAAAAA-BBBBBBBB-CCCCCCCC-DDDDDDDD' });
    expect(second.status).toBe(409);
    expect(second.body).toEqual({
      error: 'activation_in_progress',
      message: 'Burrow is already contacting the store. Wait for it to finish.',
    });
    const blockedDeactivate = await deactivate({});
    expect(blockedDeactivate.status).toBe(409);
    expect(blockedDeactivate.body.error).toBe('activation_in_progress');
    release();
    expect((await first).status).toBe(200);
    gumroadOnce();
    expect((await activate({ licenseKey: 'AAAAAAAA-BBBBBBBB-CCCCCCCC-DDDDDDDD' })).status).toBe(200);
  });

  it('429 rate_limited after 10 activate or deactivate calls in the window, shared between both routes', async () => {
    for (let i = 0; i < 6; i += 1) expect((await activate({ licenseKey: 'nope' })).status).toBe(400);
    for (let i = 0; i < 4; i += 1) expect((await deactivate({})).status).toBe(409);
    const res = await activate({ licenseKey: 'nope' });
    expect(res.status).toBe(429);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({
      error: 'rate_limited',
      code: 'rate_limited',
      message: 'Too many activation attempts. Wait 15 minutes, then try again.',
    });
    expect((await deactivate({})).status).toBe(429);
    // reads and the notice dismissal are not counted against it
    expect((await get()).status).toBe(200);
    expect((await send('post', '/api/license/trial/notice', { notice: 'welcome' })).status).not.toBe(429);
    expect((await send('delete', '/api/license')).status).toBe(200);
    expect(h.fetch).not.toHaveBeenCalled();
  });
});

describe('POST /api/license/deactivate', () => {
  it('409 nothing_to_deactivate with no activation', async () => {
    const res = await deactivate({});
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'nothing_to_deactivate', message: "There's no license on this computer to move." });
  });

  it('409 deactivate_unsupported for Gumroad, with no request', async () => {
    gumroadOnce();
    await activate({ licenseKey: GUMROAD_KEY });
    h.fetch.mockClear();
    const res = await deactivate();
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: 'deactivate_unsupported',
      message:
        "Gumroad licenses can't be moved from inside Burrow. Click Remove from this computer, then email support@example.com to reset your activations so you can activate on your new computer.",
    });
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('releases a Lemon Squeezy activation: 200 with the free status, tombstone, secret cleared', async () => {
    h.fetch.mockResolvedValueOnce(reply(200, lsActivate()));
    await activate({ licenseKey: LS_KEY });
    expect(secretRows()).toHaveLength(1);
    h.fetch.mockResolvedValueOnce(reply(200, { deactivated: true }));
    const res = await deactivate();
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toMatchObject({ state: 'free', pro: false, license: null });
    expect(dbRow()).toMatchObject({ state: 'cleared' });
    expect(secretRows()).toHaveLength(0);
  });

  it('503 store_unreachable keeps the license, with the deactivate copy', async () => {
    h.fetch.mockResolvedValueOnce(reply(200, lsActivate()));
    await activate({ licenseKey: LS_KEY });
    h.fetch.mockRejectedValueOnce(new Error('offline'));
    const res = await deactivate();
    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      error: 'store_unreachable',
      message: "Burrow couldn't reach Lemon Squeezy, so your license is still active here. Check your internet connection, then try again.",
    });
    expect((await get()).body.state).toBe('pro');
  });

  it('license_key_needed, key_mismatch and a matching body key', async () => {
    h.fetch.mockResolvedValueOnce(reply(200, lsActivate()));
    await activate({ licenseKey: LS_KEY });
    h.db.prepare('DELETE FROM app_secrets WHERE name = ?').run(LICENSE_KEY_SECRET_NAME);
    const needed = await deactivate({});
    expect(needed.status).toBe(409);
    expect(needed.body).toEqual({
      error: 'license_key_needed',
      message: 'Burrow needs your license key to release this computer. Paste the key from your receipt, then click Move to another computer again.',
    });
    const mismatch = await deactivate({ licenseKey: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' });
    expect(mismatch.status).toBe(422);
    expect(mismatch.body).toEqual({
      error: 'key_mismatch',
      message: "That key doesn't match the license on this computer. Paste the same key you activated with.",
    });
    h.fetch.mockResolvedValueOnce(reply(200, { deactivated: true }));
    expect((await deactivate({ licenseKey: LS_KEY })).status).toBe(200);
  });

  it('400 invalid_request for a non-object or non-string key', async () => {
    for (const body of [[1], { licenseKey: 5 }]) {
      const res = await deactivate(body);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_request');
    }
    const parse = await request(app)
      .post('/api/license/deactivate')
      .set('X-Forwarded-For', clientIp)
      .set('Content-Type', 'application/json')
      .send('{"licenseKey": ');
    expect(parse.status).toBe(400);
    expect(parse.body.error).toBe('invalid_request');
  });
});

describe('DELETE /api/license', () => {
  it('removes the activation with no network, writes the tombstone, clears the secret and is idempotent', async () => {
    h.fetch.mockResolvedValueOnce(reply(200, lsActivate()));
    await activate({ licenseKey: LS_KEY });
    h.fetch.mockClear();
    const res = await send('delete', '/api/license');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toMatchObject({ state: 'free', pro: false, license: null });
    expect(h.fetch).not.toHaveBeenCalled();
    expect(dbRow()).toMatchObject({ v: 1, state: 'cleared' });
    expect(JSON.parse(fs.readFileSync(path.join(h.dir, ACTIVATION_FILE_NAME), 'utf8')).state).toBe('cleared');
    expect(secretRows()).toHaveLength(0);
    expect((await send('delete', '/api/license')).status).toBe(200);
    expect((await get()).body.state).toBe('free');
  });

  it('500 activation_write_failed when neither copy can be written', async () => {
    gumroadOnce();
    await activate({ licenseKey: GUMROAD_KEY });
    // the MAC key disappears and the stored copies cannot be re-read: the tombstone cannot be signed
    h.keyOk = false;
    const res = await send('delete', '/api/license');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('activation_write_failed');
  });
});

describe('the reverse trial and the removed file route', () => {
  const dismiss = (notice) => send('post', '/api/license/trial/notice', notice === undefined ? {} : { notice });

  it('POST /api/license/trial no longer exists: the /api 404', async () => {
    h.init({ autoStartTrial: true });
    const res = await send('post', '/api/license/trial');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'not_found' });
  });

  it('a fresh data folder is on the 14-day trial from the first status read, with the welcome notice', async () => {
    h.init({ autoStartTrial: true });
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toMatchObject({
      state: 'trial',
      pro: true,
      edition: 'trial',
      trialDaysLeft: 14,
      licenseState: 'free',
      proSource: 'local_trial',
      license: null,
      trial: { state: 'active', startedAt: '2026-10-05T12:00:00Z', endsAt: '2026-10-19T12:00:00Z', daysLeft: 14, remindToday: false, notice: 'welcome' },
    });
  });

  it('POST /api/license/trial/notice: 200 with the status, the notice stops, no-store', async () => {
    h.init({ autoStartTrial: true });
    const res = await dismiss('welcome');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toMatchObject({ state: 'trial', trial: { state: 'active', notice: null } });
    expect((await get()).body.trial.notice).toBeNull();
  });

  it.each([[undefined], [null], [42], ['bogus'], ['WELCOME'], [['welcome']]])('POST /api/license/trial/notice with notice %j is 400 invalid_request', async (notice) => {
    h.init({ autoStartTrial: true });
    const res = await send('post', '/api/license/trial/notice', { notice });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_request');
    expect((await get()).body.trial.notice).toBe('welcome');
  });

  it('POST /api/license/trial/notice with a non-object or malformed body is 400', async () => {
    h.init({ autoStartTrial: true });
    expect((await send('post', '/api/license/trial/notice', [])).status).toBe(400);
    const bad = await request(app)
      .post('/api/license/trial/notice')
      .set('X-Forwarded-For', clientIp)
      .set('Content-Type', 'application/json')
      .send('{"notice":');
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('invalid_request');
  });

  it('an activation overrides a running trial: pro via the license and no notice', async () => {
    h.init({ autoStartTrial: true });
    gumroadOnce();
    const res = await activate({ licenseKey: GUMROAD_KEY });
    expect(res.body).toMatchObject({ state: 'pro', proSource: 'license', licenseState: 'pro' });
    expect(res.body.trial).toMatchObject({ state: 'active', notice: null });
  });

  it('removing a license keeps the trial', async () => {
    h.init({ autoStartTrial: true });
    gumroadOnce();
    await activate({ licenseKey: GUMROAD_KEY });
    const res = await send('delete', '/api/license');
    expect(res.body).toMatchObject({ state: 'trial', proSource: 'local_trial' });
  });

  it('the old POST /api/license (file install) falls through to the /api 404', async () => {
    const res = await send('post', '/api/license', { license: '{}' });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'not_found' });
    const big = await send('post', '/api/license', { license: 'x'.repeat(3_000_000) });
    expect(big.body.error).not.toBe('license_too_large');
  });
});

describe('the license never locks data and stays out of the generic stores', () => {
  it('data routes answer normally in an expired state', async () => {
    gumroadOnce({ product_id: GUMROAD_FREE_PRODUCT_ID, variants: '(Student)' });
    await activate({ licenseKey: GUMROAD_KEY });
    h.clock.t = Date.parse('2027-10-10T00:00:00Z');
    h.clock.m += 400 * DAY;
    expect((await get()).body.state).toBe('expired');
    expect((await send('get', '/api/transactions')).status).toBe(200);
    expect((await send('get', '/api/export')).status).not.toBe(402);
  });

  it('PUT /api/state/license.activation, license.trial and license.clock are refused with 403', async () => {
    for (const key of ['license.activation', 'license.trial', 'license.clock']) {
      const res = await send('put', `/api/state/${key}`, { value: { v: 1 } });
      expect(res.status).toBe(403);
    }
    expect(dbRow()).toBeUndefined();
  });

  it('GET /api/state and the data browser never return the license.activation row', async () => {
    gumroadOnce();
    await activate({ licenseKey: GUMROAD_KEY });
    expect(dbRow()).toBeDefined();
    const state = await send('get', '/api/state');
    expect(state.status).toBe(200);
    expect(Object.keys(state.body)).not.toContain('license.activation');
    expect(state.text).not.toContain('buyer@example.com');
    const table = await send('get', '/api/data/tables/app_state?pageSize=100');
    expect(table.status).toBe(200);
    expect(table.body.rows.map((r) => r.key)).not.toContain('license.activation');
    expect(table.text).not.toContain('buyer@example.com');
    const overview = await send('get', '/api/data/tables/app_state/overview');
    expect(overview.text).not.toContain('buyer@example.com');
  });

  it('/api/secrets never lists or reveals LICENSE_STORE_KEY', async () => {
    h.fetch.mockResolvedValueOnce(reply(200, lsActivate()));
    await activate({ licenseKey: LS_KEY });
    expect(secretRows()).toHaveLength(1);
    const res = await send('get', '/api/secrets');
    expect(res.status).toBe(200);
    expect(res.text).not.toContain(LICENSE_KEY_SECRET_NAME);
    expect(res.text).not.toContain(LS_KEY);
    const write = await send('put', `/api/secrets/${LICENSE_KEY_SECRET_NAME}`, { value: 'x'.repeat(40) });
    expect(write.status).toBeGreaterThanOrEqual(400);
    expect(secretRows()).toHaveLength(1);
  });
});
