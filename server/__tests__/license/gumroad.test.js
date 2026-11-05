// Gumroad activation end to end through activateLicense (docs/LICENSING.md 4.1, 4.3): injected fetch,
// synthetic responses, temp data dir, in-memory DB. node-fetch is mocked to throw: nothing reaches the network.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

vi.mock('node-fetch', () => ({
  default: vi.fn(async () => {
    throw new Error('real fetch must not be used');
  }),
}));

import { select } from '../../db/query.js';
import { ACTIVATION_FILE_NAME, ACTIVATION_STATE_KEY } from '../../license/constants.js';
import { activateLicense, getLicenseStatus } from '../../license/index.js';
import { resolveGumroadEdition } from '../../license/stores/gumroad.js';
import { GUMROAD, GUMROAD_MAX_USES } from '../../license/storeConfig.js';
import { GUMROAD_FREE_PRODUCT_ID, GUMROAD_KEY, GUMROAD_KEY_2, GUMROAD_PRODUCT_ID, SALE, TEST_STORE_CONFIG, WRONG_PRODUCT, gumroadVerify, queueGumroad, reply } from './fixtures/storeResponses.js';
import { createHarness, DAY } from './helpers.js';

let h;
beforeEach(() => {
  h = createHarness();
  h.init();
});
afterEach(() => h.cleanup());

const activate = (key = GUMROAD_KEY, store) => activateLicense({ licenseKey: key, store });
const stored = () => JSON.parse(fs.readFileSync(path.join(h.dir, ACTIVATION_FILE_NAME), 'utf8'));
const dbRow = () => select('app_state', { columns: ['value'], where: { key: ACTIVATION_STATE_KEY }, db: h.db })[0]?.value;
const expectNothingStored = () => {
  expect(fs.existsSync(path.join(h.dir, ACTIVATION_FILE_NAME))).toBe(false);
  expect(dbRow()).toBeUndefined();
  expect(getLicenseStatus().state).toBe('free');
};
const rejects = async (promise, httpStatus, code) =>
  expect(promise).rejects.toMatchObject({ name: 'LicenseError', httpStatus, code });

describe('Gumroad verify success', () => {
  it('sends exactly one request with the documented URL, form, headers and options', async () => {
    h.fetch.mockResolvedValueOnce(reply(200, gumroadVerify()));
    await activate();
    expect(h.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = h.fetch.mock.calls[0];
    expect(url).toBe('https://api.gumroad.com/v2/licenses/verify');
    expect(init.method).toBe('POST');
    expect(Object.fromEntries(init.body)).toEqual({
      product_id: GUMROAD_PRODUCT_ID,
      license_key: GUMROAD_KEY,
      increment_uses_count: 'true',
    });
    expect(init.headers).toEqual({
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'Burrow',
    });
    expect(init.redirect).toBe('manual');
    expect(init.size).toBe(65_536);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('normalizes the pasted key (whitespace, case) before sending and hashing', async () => {
    h.fetch.mockResolvedValueOnce(reply(200, gumroadVerify()));
    await activate(`  ${GUMROAD_KEY_2.toLowerCase().replace(/-/g, '- ')}\n`);
    expect(Object.fromEntries(h.fetch.mock.calls[0][1].body).license_key).toBe(GUMROAD_KEY_2);
  });

  it('stores the record in both copies and returns the status', async () => {
    h.fetch.mockResolvedValueOnce(reply(200, gumroadVerify()));
    const status = await activate();
    const record = stored();
    expect(record).toMatchObject({
      v: 1,
      state: 'active',
      store: 'gumroad',
      productId: GUMROAD_PRODUCT_ID,
      variantId: null,
      edition: 'standard',
      purchaseDate: SALE,
      updatesUntil: '2027-09-30T14:02:11Z',
      expiresAt: null,
      activatedAt: '2026-10-05T12:00:00Z',
      keyLast4: '3333',
      email: 'buyer@example.com',
      instanceId: null,
      test: false,
    });
    expect(record.keyHash).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(record.mac).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(dbRow()).toEqual(record);
    expect(JSON.stringify(record)).not.toContain(GUMROAD_KEY);
    expect(status).toMatchObject({
      state: 'pro',
      pro: true,
      edition: 'standard',
      license: {
        store: 'gumroad',
        storeLabel: 'Gumroad',
        edition: 'standard',
        purchaseDate: SALE,
        updatesUntil: '2027-09-30T14:02:11Z',
        expiresAt: null,
        keyLast4: '3333',
        test: false,
        canDeactivate: false,
      },
    });
  });

  it('sends increment_uses_count once per real activation and makes no request for the same key again', async () => {
    h.fetch.mockResolvedValue(reply(200, gumroadVerify()));
    await activate();
    expect(h.fetch).toHaveBeenCalledTimes(1);
    const again = await activate(` ${GUMROAD_KEY.toLowerCase()} `);
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(again.state).toBe('pro');
  });

  it('a different key replaces the stored activation', async () => {
    h.fetch.mockResolvedValueOnce(reply(200, gumroadVerify()));
    await activate();
    h.fetch.mockResolvedValueOnce(reply(200, gumroadVerify({ purchase: { variants: '(Family)', email: 'second@example.com' } })));
    const status = await activate(GUMROAD_KEY_2);
    expect(h.fetch).toHaveBeenCalledTimes(2);
    expect(status.license).toMatchObject({ edition: 'family', email: 'second@example.com', keyLast4: 'DDDD' });
    expect(stored().edition).toBe('family');
  });

  it('an unusable store email is stored as null', async () => {
    h.fetch.mockResolvedValueOnce(reply(200, gumroadVerify({ purchase: { email: 'a\u0000b@example.com' } })));
    expect((await activate()).license.email).toBeNull();
  });
});

describe('Gumroad refusals store nothing', () => {
  it.each([
    ['refunded', { refunded: true }],
    ['chargebacked', { chargebacked: true }],
    ['disputed', { disputed: true }],
    ['disputed, dispute lost', { disputed: true, dispute_won: false }],
  ])('%s gives purchase_refunded', async (_name, purchase) => {
    h.fetch.mockResolvedValueOnce(reply(200, gumroadVerify({ purchase })));
    await rejects(activate(), 422, 'purchase_refunded');
    expectNothingStored();
  });

  it('a disputed purchase that was won is accepted', async () => {
    h.fetch.mockResolvedValueOnce(reply(200, gumroadVerify({ purchase: { disputed: true, dispute_won: true } })));
    expect((await activate()).state).toBe('pro');
  });

  it('a test purchase is refused on stable builds and accepted when allowed, with the advisory', async () => {
    h.fetch.mockResolvedValueOnce(reply(200, gumroadVerify({ purchase: { test: true } })));
    await rejects(activate(), 422, 'test_purchase_not_allowed');
    expectNothingStored();

    h.init({ allowTest: true });
    h.fetch.mockResolvedValueOnce(reply(200, gumroadVerify({ purchase: { test: true } })));
    const status = await activate();
    expect(stored().test).toBe(true);
    expect(status.license.test).toBe(true);
    expect(status.reasons).toContain('test_purchase');
  });

  it('a product id mismatch is unknown_product', async () => {
    h.fetch.mockResolvedValueOnce(reply(200, gumroadVerify({ purchase: { product_id: 'someone_else' } })));
    await rejects(activate(), 422, 'unknown_product');
    expectNothingStored();
  });

  it.each([['an unknown version', '(Platinum)'], ['no version', '']])('%s is unknown_product', async (_n, variants) => {
    h.fetch.mockResolvedValueOnce(reply(200, gumroadVerify({ purchase: { variants } })));
    await rejects(activate(), 422, 'unknown_product');
  });

  it('imported_customer (no purchase object) is store_error', async () => {
    h.fetch.mockResolvedValueOnce(reply(200, { success: true, uses: 1, imported_customer: { email: 'x@example.com' } }));
    await rejects(activate(), 502, 'store_error');
    expectNothingStored();
  });

  it('an unparseable purchase date is store_error', async () => {
    h.fetch.mockResolvedValueOnce(reply(200, gumroadVerify({ purchase: { sale_timestamp: 'yesterday', created_at: 'also bad' } })));
    await rejects(activate(), 502, 'store_error');
  });

  it('falls back to created_at when sale_timestamp is missing', async () => {
    h.fetch.mockResolvedValueOnce(reply(200, gumroadVerify({ purchase: { sale_timestamp: undefined, created_at: '2026-09-01T00:00:00Z' } })));
    expect((await activate()).license.purchaseDate).toBe('2026-09-01T00:00:00Z');
  });

  it.each([
    ['uses missing', undefined],
    ['uses zero', 0],
    ['uses fractional', 1.5],
    ['uses a string', '1'],
  ])('%s is store_error', async (_n, uses) => {
    h.fetch.mockResolvedValueOnce(reply(200, { ...gumroadVerify(), uses }));
    await rejects(activate(), 502, 'store_error');
  });
});

describe('Gumroad uses limit with slack', () => {
  it.each([
    ['Standard', 'standard', 3],
    ['Founding', 'founding', 3],
    ['Family', 'family', 10],
  ])('%s: uses at the limit is accepted, limit + 1 is uses_exceeded', async (variant, edition, limit) => {
    h.fetch.mockResolvedValueOnce(reply(200, gumroadVerify({ uses: limit, purchase: { variants: `(${variant})` } })));
    expect((await activate()).edition).toBe(edition);
    h.fetch.mockResolvedValueOnce(reply(200, gumroadVerify({ uses: limit + 1, purchase: { variants: `(${variant})` } })));
    await rejects(activate(GUMROAD_KEY_2), 422, 'uses_exceeded');
    // the earlier activation is kept
    expect(stored().edition).toBe(edition);
  });

  it.each([
    ['Student', 'student'],
    ['Nonprofit', 'nonprofit'],
  ])('%s (free product) gets the free edition limit of 3', async (version, edition) => {
    const purchase = { product_id: GUMROAD_FREE_PRODUCT_ID, variants: `(${version})` };
    expect(GUMROAD_MAX_USES[edition]).toBe(3);
    queueGumroad(h.fetch, { uses: 3, purchase });
    expect((await activate()).edition).toBe(edition);
    queueGumroad(h.fetch, { uses: 4, purchase });
    await rejects(activate(GUMROAD_KEY_2), 422, 'uses_exceeded');
  });
});

describe('Gumroad two-product activation', () => {
  const bodyOf = (call) => Object.fromEntries(call[1].body);

  it.each([
    ['Standard', 'standard'],
    ['Founding', 'founding'],
    ['Family', 'family'],
  ])('main product, %s: one request', async (version, edition) => {
    h.fetch.mockResolvedValueOnce(reply(200, gumroadVerify({ purchase: { variants: `(${version})` } })));
    expect((await activate()).edition).toBe(edition);
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(bodyOf(h.fetch.mock.calls[0]).product_id).toBe(GUMROAD_PRODUCT_ID);
  });

  it.each([
    ['Student', 'student'],
    ['Nonprofit', 'nonprofit'],
  ])('free product, %s: a 404 on the main product, then success on the second (2 requests)', async (version, edition) => {
    queueGumroad(h.fetch, { purchase: { product_id: GUMROAD_FREE_PRODUCT_ID, variants: `(${version})` } });
    expect((await activate()).edition).toBe(edition);
    expect(h.fetch).toHaveBeenCalledTimes(2);
    const [first, second] = h.fetch.mock.calls.map(bodyOf);
    expect(first).toMatchObject({ product_id: GUMROAD_PRODUCT_ID, increment_uses_count: 'true' });
    expect(second).toMatchObject({ product_id: GUMROAD_FREE_PRODUCT_ID, license_key: GUMROAD_KEY, increment_uses_count: 'true' });
    expect(stored().productId).toBe(GUMROAD_FREE_PRODUCT_ID);
  });

  it('both products answering 404 is key_not_found after exactly two requests', async () => {
    h.fetch.mockResolvedValue(reply(404, WRONG_PRODUCT));
    await rejects(activate(), 422, 'key_not_found');
    expect(h.fetch).toHaveBeenCalledTimes(2);
    expectNothingStored();
  });

  it.each([
    ['429', reply(429, {}), 503, 'store_busy'],
    ['500', reply(500, { success: false }), 502, 'store_error'],
    ['404 disabled', reply(404, { success: false, message: 'This license key has been disabled.' }), 422, 'license_disabled'],
  ])('%s on the main product stops without a second request', async (_n, response, httpStatus, code) => {
    h.fetch.mockResolvedValueOnce(response);
    await rejects(activate(), httpStatus, code);
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });

  it('a network failure on the main product makes no second request', async () => {
    h.fetch.mockRejectedValueOnce(Object.assign(new Error('reset'), { code: 'ECONNRESET' }));
    await rejects(activate(), 503, 'store_unreachable');
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });

  it('a non-404 failure on the second product is classified as usual', async () => {
    h.fetch.mockResolvedValueOnce(reply(404, WRONG_PRODUCT)).mockResolvedValueOnce(reply(429, {}));
    await rejects(activate(), 503, 'store_busy');
    expect(h.fetch).toHaveBeenCalledTimes(2);
    expectNothingStored();
  });

  it('with no free product configured, the 404 is final after one request', async () => {
    h.init({ storeConfig: { ...TEST_STORE_CONFIG, GUMROAD: { ...TEST_STORE_CONFIG.GUMROAD, freeProductId: null } } });
    h.fetch.mockResolvedValue(reply(404, WRONG_PRODUCT));
    await rejects(activate(), 422, 'key_not_found');
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });

  it('a free-product version outside its map, or none, is unknown_product', async () => {
    queueGumroad(h.fetch, { purchase: { product_id: GUMROAD_FREE_PRODUCT_ID, variants: '(Standard)' } });
    await rejects(activate(), 422, 'unknown_product');
    h.init({ storeConfig: { ...TEST_STORE_CONFIG, GUMROAD: { ...TEST_STORE_CONFIG.GUMROAD, freeDefaultEdition: null } } });
    queueGumroad(h.fetch, { purchase: { product_id: GUMROAD_FREE_PRODUCT_ID, variants: '' } });
    await rejects(activate(GUMROAD_KEY_2), 422, 'unknown_product');
    expectNothingStored();
  });

  it('the free-license product with empty variants resolves to the default edition, student, yearly', async () => {
    queueGumroad(h.fetch, { purchase: { product_id: GUMROAD_FREE_PRODUCT_ID, variants: '' } });
    const status = await activate();
    expect(h.fetch).toHaveBeenCalledTimes(2);
    expect(status.license).toMatchObject({ edition: 'student', expiresAt: '2027-09-30T14:02:11Z' });
  });

  it('an unknown non-empty version on the free-license product stays unknown_product despite the default', async () => {
    queueGumroad(h.fetch, { purchase: { product_id: GUMROAD_FREE_PRODUCT_ID, variants: '(Standard)' } });
    await rejects(activate(), 422, 'unknown_product');
  });

  it('the Pro product with empty variants is unknown_product (no default there)', async () => {
    h.fetch.mockResolvedValueOnce(reply(200, gumroadVerify({ purchase: { variants: '' } })));
    await rejects(activate(), 422, 'unknown_product');
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });

  it('a Student version on the main product is unknown_product', async () => {
    h.fetch.mockResolvedValueOnce(reply(200, gumroadVerify({ purchase: { variants: '(Student)' } })));
    await rejects(activate(), 422, 'unknown_product');
  });

  it('a response whose product id is not the one asked is unknown_product', async () => {
    h.fetch
      .mockResolvedValueOnce(reply(404, WRONG_PRODUCT))
      .mockResolvedValueOnce(reply(200, gumroadVerify({ purchase: { product_id: GUMROAD_PRODUCT_ID } })));
    await rejects(activate(), 422, 'unknown_product');
  });
});

describe('Gumroad failures', () => {
  it.each([
    ['404 not found', reply(404, { success: false, message: 'That license does not exist for the provided product.' }), 422, 'key_not_found'],
    ['404 disabled', reply(404, { success: false, message: 'This license key has been disabled.' }), 422, 'license_disabled'],
    ['404 without a body', reply(404, null, { raw: '<html>' }), 422, 'key_not_found'],
    ['429', reply(429, { success: false }), 503, 'store_busy'],
    ['500', reply(500, { success: false, message: 'boom' }), 502, 'store_error'],
    ['400', reply(400, { success: false }), 502, 'store_error'],
    ['non-JSON 200', reply(200, null, { raw: 'not json' }), 502, 'store_error'],
    ['JSON array 200', reply(200, [1, 2]), 502, 'store_error'],
    ['success false 200', reply(200, { success: false }), 502, 'store_error'],
    ['oversized body', reply(200, null, { raw: `{"success":true,"x":"${'a'.repeat(70_000)}"}` }), 502, 'store_error'],
    ['oversized content-length', reply(200, gumroadVerify(), { headers: { 'content-length': '999999' } }), 502, 'store_error'],
    ['redirect', reply(302, null, { headers: { location: 'https://example.com' } }), 502, 'store_error'],
  ])('%s', async (_name, response, httpStatus, code) => {
    h.fetch.mockResolvedValue(response);
    await rejects(activate(), httpStatus, code);
    expectNothingStored();
  });

  it('a network failure and a timeout are store_unreachable with a friendly message and nothing stored', async () => {
    h.fetch.mockRejectedValueOnce(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));
    await expect(activate()).rejects.toMatchObject({ httpStatus: 503, code: 'store_unreachable' });
    expectNothingStored();
    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    h.fetch.mockRejectedValueOnce(timeout);
    const err = await activate().catch((e) => e);
    expect(err).toMatchObject({ httpStatus: 503, code: 'store_unreachable' });
    expect(err.publicMessage).toContain('Nothing was changed on this computer');
    expectNothingStored();
  });

  it('a body read that times out is store_unreachable', async () => {
    h.fetch.mockResolvedValueOnce({
      status: 200,
      headers: new Map(),
      text: async () => {
        throw Object.assign(new Error('timeout'), { name: 'TimeoutError' });
      },
    });
    await rejects(activate(), 503, 'store_unreachable');
  });

  it('never logs or returns the key, the response body or the store message', async () => {
    const spies = ['log', 'warn', 'error', 'info'].map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    h.fetch.mockResolvedValue(reply(404, { success: false, message: 'SECRET_STORE_MESSAGE for 00000000-11111111-22222222-33333333' }));
    const err = await activate().catch((e) => e);
    const everything = JSON.stringify([h.logs, spies.map((s) => s.mock.calls), err.publicMessage, err.detail ?? null]);
    for (const needle of [GUMROAD_KEY, 'SECRET_STORE_MESSAGE', 'license_key']) expect(everything).not.toContain(needle);
    expect(h.logs).toEqual(['license: activation failed (key_not_found)']);
    spies.forEach((s) => s.mockRestore());
  });
});

describe('Gumroad yearly editions', () => {
  it('a student purchase expires 365 days after the sale', async () => {
    queueGumroad(h.fetch, { purchase: { product_id: GUMROAD_FREE_PRODUCT_ID, variants: '(Student)' } });
    const status = await activate();
    expect(status.license).toMatchObject({ edition: 'student', expiresAt: '2027-09-30T14:02:11Z', updatesUntil: '2027-09-30T14:02:11Z' });
  });

  it('an already ended yearly key is refused license_expired with endedAt and nothing stored', async () => {
    const sale = new Date(Date.parse(SALE) - 400 * DAY).toISOString().slice(0, 19) + 'Z';
    queueGumroad(h.fetch, { purchase: { product_id: GUMROAD_FREE_PRODUCT_ID, variants: '(Nonprofit)', sale_timestamp: sale } });
    const err = await activate().catch((e) => e);
    expect(err).toMatchObject({ httpStatus: 422, code: 'license_expired', detail: { endedAt: expect.stringMatching(/^2026-.*Z$/) } });
    expectNothingStored();
  });
});

describe('resolveGumroadEdition', () => {
  const pro = GUMROAD.variantEditions;
  const free = GUMROAD.freeVariantEditions;

  it('reads versions from the parenthesised string, per product map', () => {
    expect(resolveGumroadEdition({ variants: '(Founding)' }, pro)).toBe('founding');
    expect(resolveGumroadEdition({ variants: '(Founding, Blue)' }, pro)).toBe('founding');
    expect(resolveGumroadEdition({ variants: '(Blue, Family)' }, pro)).toBe('family');
    expect(resolveGumroadEdition({ variants: 'Standard' }, pro)).toBe('standard');
    expect(resolveGumroadEdition({ variants: '(Student)' }, free)).toBe('student');
    expect(resolveGumroadEdition({ variants: '(Nonprofit)' }, free)).toBe('nonprofit');
    expect(resolveGumroadEdition({ variants: '(Student)' }, pro)).toBeNull();
  });

  it('matches version names exactly, case-sensitively, and never through prototype keys', () => {
    expect(resolveGumroadEdition({ variants: '(standard)' }, pro)).toBeNull();
    expect(resolveGumroadEdition({ variants: '(constructor)' }, pro)).toBeNull();
    expect(resolveGumroadEdition({ variants: '(Platinum)' }, pro)).toBeNull();
    expect(resolveGumroadEdition({ variants: ['Standard'] }, pro)).toBeNull();
  });

  it('an empty or absent version never resolves', () => {
    for (const variants of ['', '()', undefined, null]) expect(resolveGumroadEdition({ variants }, pro)).toBeNull();
    expect(resolveGumroadEdition({}, pro)).toBeNull();
  });
});
