// Lemon Squeezy activate and deactivate end to end (docs/LICENSING.md 4.4, 10.3): injected fetch, synthetic
// responses, temp data dir, in-memory DB. node-fetch is mocked to throw: nothing reaches the network.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

vi.mock('node-fetch', () => ({
  default: vi.fn(async () => {
    throw new Error('real fetch must not be used');
  }),
}));

import { select } from '../../db/query.js';
import { ACTIVATION_FILE_NAME, ACTIVATION_STATE_KEY, LICENSE_KEY_SECRET_NAME } from '../../license/constants.js';
import { activateLicense, deactivateLicense, getLicenseStatus } from '../../license/index.js';
import { loadLicenseKey } from '../../license/licenseKeySecret.js';
import { SECRET_DEFS } from '../../secrets/registry.js';
import { LS_CREATED, LS_INSTANCE_ID, LS_KEY, LS_KEY_2, gumroadVerify, lsActivate, reply } from './fixtures/storeResponses.js';
import { GUMROAD_KEY } from './fixtures/storeResponses.js';
import { createHarness, DAY } from './helpers.js';

let h;
beforeEach(() => {
  h = createHarness();
  h.init();
});
afterEach(() => h.cleanup());

const activate = (key = LS_KEY, store) => activateLicense({ licenseKey: key, store });
const stored = () => JSON.parse(fs.readFileSync(path.join(h.dir, ACTIVATION_FILE_NAME), 'utf8'));
const dbRow = () => select('app_state', { columns: ['value'], where: { key: ACTIVATION_STATE_KEY }, db: h.db })[0]?.value;
const secretOpts = () => ({ dataDir: h.dir, env: {}, getDb: () => h.db });
const secretRows = () => select('app_secrets', { db: h.db }).filter((r) => r.name === LICENSE_KEY_SECRET_NAME);
const rejects = (promise, httpStatus, code) => expect(promise).rejects.toMatchObject({ name: 'LicenseError', httpStatus, code });
const expectNothingStored = () => {
  expect(fs.existsSync(path.join(h.dir, ACTIVATION_FILE_NAME))).toBe(false);
  expect(dbRow()).toBeUndefined();
};

describe('Lemon Squeezy activate', () => {
  it('sends one request with instance_name=Burrow and stores the record, instance id and encrypted key', async () => {
    h.fetch.mockResolvedValueOnce(reply(200, lsActivate()));
    const status = await activate();
    expect(h.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = h.fetch.mock.calls[0];
    expect(url).toBe('https://api.lemonsqueezy.com/v1/licenses/activate');
    expect(Object.fromEntries(init.body)).toEqual({ license_key: LS_KEY, instance_name: 'Burrow' });
    expect(init.headers).toEqual({
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'Burrow',
    });
    expect(init.redirect).toBe('manual');

    expect(stored()).toMatchObject({
      store: 'lemonsqueezy',
      productId: '67890',
      variantId: '1001',
      edition: 'standard',
      purchaseDate: '2026-09-30T14:02:11Z',
      updatesUntil: '2027-09-30T14:02:11Z',
      expiresAt: null,
      instanceId: LS_INSTANCE_ID,
      keyLast4: '4444',
      email: 'buyer@example.com',
      test: false,
    });
    expect(dbRow()).toEqual(stored());
    expect(status.license).toMatchObject({ store: 'lemonsqueezy', storeLabel: 'Lemon Squeezy', canDeactivate: true });
    expect(JSON.stringify(status)).not.toContain(LS_INSTANCE_ID);

    const rows = secretRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].last4).toBe('4444');
    expect(JSON.stringify(rows[0])).not.toContain(LS_KEY);
    expect(await loadLicenseKey(secretOpts())).toBe(LS_KEY);
  });

  it('keeps LICENSE_STORE_KEY out of the saved-secrets registry', () => {
    expect(SECRET_DEFS.map((d) => d.name)).not.toContain(LICENSE_KEY_SECRET_NAME);
  });

  it('a created_at with 6 decimals parses and floors to the second', async () => {
    h.fetch.mockResolvedValueOnce(reply(200, lsActivate({ license_key: { created_at: '2026-09-30T14:02:11.987654Z' } })));
    expect((await activate()).license.purchaseDate).toBe('2026-09-30T14:02:11Z');
    expect(LS_CREATED).toContain('.000000Z');
  });

  it.each([
    ['1001', 'standard', 365],
    ['1002', 'founding', 730],
    ['1003', 'family', 365],
  ])('variant %s is %s with updates for %i days and no expiry', async (variant, edition, days) => {
    h.fetch.mockResolvedValueOnce(reply(200, lsActivate({ meta: { variant_id: Number(variant) } })));
    const status = await activate();
    expect(status.license).toMatchObject({ edition, expiresAt: null });
    expect(Date.parse(status.license.updatesUntil) - Date.parse(status.license.purchaseDate)).toBe(days * DAY);
  });

  it.each([
    ['1004', 'student'],
    ['1005', 'nonprofit'],
  ])('variant %s is %s and yearly', async (variant, edition) => {
    h.fetch.mockResolvedValueOnce(reply(200, lsActivate({ meta: { variant_id: Number(variant) } })));
    const status = await activate();
    expect(status.license).toMatchObject({ edition, expiresAt: '2027-09-30T14:02:11Z', updatesUntil: '2027-09-30T14:02:11Z' });
  });

  it('expires_at shortens a yearly edition and is ignored for paid ones', async () => {
    h.fetch.mockResolvedValueOnce(
      reply(200, lsActivate({ license_key: { expires_at: '2026-12-01T00:00:00.000000Z' }, meta: { variant_id: 1004 } })),
    );
    expect((await activate()).license).toMatchObject({ expiresAt: '2026-12-01T00:00:00Z', updatesUntil: '2026-12-01T00:00:00Z' });
    h.fetch.mockResolvedValueOnce(reply(200, lsActivate({ license_key: { key: LS_KEY_2, expires_at: '2026-12-01T00:00:00.000000Z' } })));
    expect((await activate(LS_KEY_2)).license).toMatchObject({ edition: 'standard', expiresAt: null });
  });

  it('never calls /validate', async () => {
    h.fetch.mockResolvedValueOnce(reply(200, lsActivate()));
    await activate();
    h.fetch.mockResolvedValueOnce(reply(200, { deactivated: true }));
    await deactivateLicense();
    expect(h.fetch.mock.calls.map(([url]) => url).join(' ')).not.toContain('validate');
  });

  it('test_mode is refused on stable builds and accepted when allowed', async () => {
    h.fetch.mockResolvedValueOnce(reply(200, lsActivate({ license_key: { test_mode: true } })));
    await rejects(activate(), 422, 'test_purchase_not_allowed');
    expectNothingStored();
    h.init({ allowTest: true });
    h.fetch.mockResolvedValueOnce(reply(200, lsActivate({ license_key: { test_mode: true } })));
    const status = await activate();
    expect(status.license.test).toBe(true);
    expect(status.reasons).toContain('test_purchase');
  });

  it('a yearly key that already ended is refused license_expired and stores nothing', async () => {
    h.fetch.mockResolvedValueOnce(
      reply(200, lsActivate({ license_key: { created_at: '2025-01-01T00:00:00.000000Z' }, meta: { variant_id: 1004 } })),
    );
    await rejects(activate(), 422, 'license_expired');
    expectNothingStored();
    expect(secretRows()).toHaveLength(0);
  });
});

describe('Lemon Squeezy failures', () => {
  const failure = (over, httpStatus = 400) => reply(httpStatus, { activated: false, error: 'nope', ...over });
  it.each([
    ['disabled', failure({ license_key: { status: 'disabled' } }), 422, 'license_disabled'],
    ['expired at the store', failure({ license_key: { status: 'expired' } }), 422, 'license_expired_at_store'],
    ['limit by numbers', failure({ license_key: { activation_limit: 3, activation_usage: 3 } }), 422, 'activation_limit_reached'],
    ['limit by error text', failure({ error: 'This license key has reached the activation limit.' }), 422, 'activation_limit_reached'],
    ['unknown key (404)', reply(404, { activated: false, error: 'license_key not found.' }), 422, 'key_not_found'],
    ['429', reply(429, { error: 'slow down' }), 503, 'store_busy'],
    ['500', reply(500, { error: 'boom' }), 502, 'store_error'],
    ['a 422 that is not a known failure', failure({}, 422), 502, 'store_error'],
    ['non-JSON', reply(200, null, { raw: '<html>' }), 502, 'store_error'],
    ['redirect', reply(301, null), 502, 'store_error'],
    ['activated with a failing status', reply(500, lsActivate()), 502, 'store_error'],
    ['store id mismatch', reply(200, lsActivate({ meta: { store_id: 999 } })), 422, 'unknown_product'],
    ['product id mismatch', reply(200, lsActivate({ meta: { product_id: 999 } })), 422, 'unknown_product'],
    ['variant mismatch', reply(200, lsActivate({ meta: { variant_id: 4242 } })), 422, 'unknown_product'],
    ['a bad instance id', reply(200, lsActivate({ instance: { id: 'has spaces!' } })), 502, 'store_error'],
    ['a missing instance', reply(200, { ...lsActivate(), instance: null }), 502, 'store_error'],
    ['a bad created_at', reply(200, lsActivate({ license_key: { created_at: 'soon' } })), 502, 'store_error'],
    ['missing meta', reply(200, { ...lsActivate(), meta: null }), 502, 'store_error'],
  ])('%s', async (_name, response, httpStatus, code) => {
    h.fetch.mockResolvedValueOnce(response);
    await rejects(activate(), httpStatus, code);
    expectNothingStored();
    expect(secretRows()).toHaveLength(0);
  });

  it('a network failure is store_unreachable and keeps a previous activation', async () => {
    h.fetch.mockResolvedValueOnce(reply(200, lsActivate()));
    await activate();
    h.fetch.mockRejectedValueOnce(new Error('ENOTFOUND'));
    await rejects(activate(LS_KEY_2), 503, 'store_unreachable');
    expect(getLicenseStatus().license.keyLast4).toBe('4444');
  });

  it('never logs the key or the store text', async () => {
    h.fetch.mockResolvedValueOnce(reply(404, { activated: false, error: 'SECRET_STORE_TEXT' }));
    await activate().catch(() => {});
    expect(JSON.stringify(h.logs)).not.toContain(LS_KEY);
    expect(h.logs).toEqual(['license: activation failed (key_not_found)']);
  });
});

describe('Move to another computer (deactivate)', () => {
  beforeEach(async () => {
    h.fetch.mockResolvedValueOnce(reply(200, lsActivate()));
    await activate();
    h.fetch.mockClear();
  });

  it('releases the instance, writes the tombstone to both copies and clears the key secret', async () => {
    h.fetch.mockResolvedValueOnce(reply(200, { deactivated: true, error: null }));
    h.advance(DAY);
    const status = await deactivateLicense();
    const [url, init] = h.fetch.mock.calls[0];
    expect(url).toBe('https://api.lemonsqueezy.com/v1/licenses/deactivate');
    expect(Object.fromEntries(init.body)).toEqual({ license_key: LS_KEY, instance_id: LS_INSTANCE_ID });
    expect(status).toMatchObject({ state: 'free', pro: false, license: null });
    expect(stored()).toMatchObject({ v: 1, state: 'cleared', clearedAt: '2026-10-06T12:00:00Z' });
    expect(dbRow()).toEqual(stored());
    expect(secretRows()).toHaveLength(0);
  });

  it('treats a 404 as success: nothing is held at the store', async () => {
    h.fetch.mockResolvedValueOnce(reply(404, { deactivated: false, error: 'not found' }));
    expect((await deactivateLicense()).state).toBe('free');
    expect(stored().state).toBe('cleared');
  });

  it.each([
    ['network failure', () => h.fetch.mockRejectedValueOnce(new Error('ECONNRESET')), 503, 'store_unreachable'],
    ['429', () => h.fetch.mockResolvedValueOnce(reply(429, {})), 503, 'store_busy'],
    ['500', () => h.fetch.mockResolvedValueOnce(reply(500, {})), 502, 'store_error'],
    ['deactivated false', () => h.fetch.mockResolvedValueOnce(reply(200, { deactivated: false })), 502, 'store_error'],
  ])('%s keeps everything on this computer', async (_name, arrange, httpStatus, code) => {
    arrange();
    const err = await deactivateLicense().catch((e) => e);
    expect(err).toMatchObject({ httpStatus, code });
    if (code === 'store_unreachable') expect(err.publicMessage).toContain('your license is still active here');
    expect(getLicenseStatus()).toMatchObject({ state: 'pro', license: { keyLast4: '4444' } });
    expect(stored().state).toBe('active');
    expect(secretRows()).toHaveLength(1);
    expect(h.logs.at(-1)).toBe(`license: deactivation failed (${code})`);
  });

  it('no valid activation gives nothing_to_deactivate', async () => {
    h.fetch.mockResolvedValueOnce(reply(200, { deactivated: true }));
    await deactivateLicense();
    await rejects(deactivateLicense(), 409, 'nothing_to_deactivate');
  });

  it('a missing secret gives license_key_needed; the body key is accepted when it matches', async () => {
    db_clearSecret();
    await rejects(deactivateLicense(), 409, 'license_key_needed');
    await rejects(deactivateLicense({ licenseKey: LS_KEY_2 }), 422, 'key_mismatch');
    await rejects(deactivateLicense({ licenseKey: 'garbage' }), 422, 'key_mismatch');
    expect(h.fetch).not.toHaveBeenCalled();
    h.fetch.mockResolvedValueOnce(reply(200, { deactivated: true }));
    const status = await deactivateLicense({ licenseKey: ` ${LS_KEY.toUpperCase()} ` });
    expect(status.state).toBe('free');
    expect(Object.fromEntries(h.fetch.mock.calls[0][1].body).license_key).toBe(LS_KEY);
  });

  it('a non-string body key is invalid_request', async () => {
    await rejects(deactivateLicense({ licenseKey: 42 }), 400, 'invalid_request');
  });
});

describe('Gumroad cannot be moved', () => {
  it('deactivate_unsupported, and no request', async () => {
    h.fetch.mockResolvedValueOnce(reply(200, gumroadVerify()));
    await activate(GUMROAD_KEY);
    h.fetch.mockClear();
    await rejects(deactivateLicense(), 409, 'deactivate_unsupported');
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('activating a Gumroad key clears a retained Lemon Squeezy key secret', async () => {
    h.fetch.mockResolvedValueOnce(reply(200, lsActivate()));
    await activate();
    expect(secretRows()).toHaveLength(1);
    h.fetch.mockResolvedValueOnce(reply(200, gumroadVerify()));
    await activate(GUMROAD_KEY);
    expect(secretRows()).toHaveLength(0);
  });
});

function db_clearSecret() {
  h.db.prepare('DELETE FROM app_secrets WHERE name = ?').run(LICENSE_KEY_SECRET_NAME);
}
