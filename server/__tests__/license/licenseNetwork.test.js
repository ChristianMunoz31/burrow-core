// The license request happens ONLY through POST activate and POST deactivate (docs/LICENSING.md 4.2, 20):
// status reads, the trial, init and getEntitlements never reach a store, and every refusal that happens
// before the network never turns the `license` feature on. Fetch is injected; node-fetch throws if used.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

vi.mock('node-fetch', () => ({
  default: vi.fn(async () => {
    throw new Error('real fetch must not be used');
  }),
}));

import nodeFetch from 'node-fetch';
import * as dataAccess from '../../dataAccess.js';
import { ACTIVATION_FILE_NAME } from '../../license/constants.js';
import {
  activateLicense,
  deactivateLicense,
  getEntitlements,
  getLicenseStatus,
  removeLicense,
  resetLicenseForTests,
} from '../../license/index.js';
import { NETWORK_FEATURES, __resetNetPolicyForTests, isEnabled, setNetworkFeature } from '../../netPolicy.js';
import { GUMROAD_KEY, LS_KEY, TEST_STORE_CONFIG, gumroadVerify, lsActivate, reply } from './fixtures/storeResponses.js';
import { createHarness } from './helpers.js';

let h;
beforeEach(() => {
  h = createHarness();
  h.init();
  nodeFetch.mockClear();
});
afterEach(() => {
  vi.restoreAllMocks();
  h.cleanup();
});

const licenseOn = () => isEnabled('license');
const expectOff = async () => {
  __resetNetPolicyForTests();
  expect(await licenseOn()).toBe(false);
};

describe('the license feature', () => {
  it('is listed last with both store hosts and is off by default', async () => {
    expect(NETWORK_FEATURES.at(-1).id).toBe('license');
    expect(NETWORK_FEATURES.at(-1).hosts).toEqual(['api.gumroad.com', 'api.lemonsqueezy.com']);
    await expectOff();
  });

  it('activate turns it on and asserts it before the request is made', async () => {
    let seenAtRequest = null;
    h.fetch.mockImplementationOnce(async () => {
      seenAtRequest = await licenseOn();
      return reply(200, gumroadVerify());
    });
    await activateLicense({ licenseKey: GUMROAD_KEY });
    expect(seenAtRequest).toBe(true);
    expect(await licenseOn()).toBe(true);
  });

  it('deactivate turns it on too, before its request', async () => {
    h.fetch.mockResolvedValueOnce(reply(200, lsActivate()));
    await activateLicense({ licenseKey: LS_KEY });
    await setNetworkFeature('license', false);
    let seenAtRequest = null;
    h.fetch.mockImplementationOnce(async () => {
      seenAtRequest = await licenseOn();
      return reply(200, { deactivated: true });
    });
    await deactivateLicense();
    expect(seenAtRequest).toBe(true);
  });

  it('a storage failure while turning it on is activation_write_failed and no request is made', async () => {
    vi.spyOn(dataAccess, 'setState').mockRejectedValue(new Error('disk full'));
    await expect(activateLicense({ licenseKey: GUMROAD_KEY })).rejects.toMatchObject({ httpStatus: 500, code: 'activation_write_failed' });
    expect(h.fetch).not.toHaveBeenCalled();
    expect(getLicenseStatus().state).toBe('free');
  });

  it('turning it off blocks nothing by itself: the next click turns it on again', async () => {
    h.fetch.mockResolvedValueOnce(reply(200, gumroadVerify()));
    await activateLicense({ licenseKey: GUMROAD_KEY });
    await setNetworkFeature('license', false);
    h.fetch.mockResolvedValueOnce(reply(200, gumroadVerify()));
    await activateLicense({ licenseKey: 'AAAAAAAA-BBBBBBBB-CCCCCCCC-DDDDDDDD' });
    expect(await licenseOn()).toBe(true);
  });
});

describe('refusals before the network never turn the feature on', () => {
  it('a malformed key', async () => {
    await expect(activateLicense({ licenseKey: 'garbage' })).rejects.toMatchObject({ code: 'invalid_key_format' });
    await expect(activateLicense({ licenseKey: GUMROAD_KEY, store: 'lemonsqueezy' })).rejects.toMatchObject({ code: 'invalid_key_format' });
    await expectOff();
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('an unconfigured store', async () => {
    h.init({ storeConfig: { ...TEST_STORE_CONFIG, GUMROAD: { ...TEST_STORE_CONFIG.GUMROAD, productId: null } } });
    await expect(activateLicense({ licenseKey: GUMROAD_KEY })).rejects.toMatchObject({ code: 'store_not_configured' });
    await expectOff();
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('a missing MAC key', async () => {
    h.keyOk = false;
    h.init();
    await expect(activateLicense({ licenseKey: GUMROAD_KEY })).rejects.toMatchObject({ code: 'activation_write_failed' });
    await expectOff();
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('a same-key re-activation', async () => {
    h.fetch.mockResolvedValueOnce(reply(200, gumroadVerify()));
    await activateLicense({ licenseKey: GUMROAD_KEY });
    await setNetworkFeature('license', false);
    h.fetch.mockClear();
    expect((await activateLicense({ licenseKey: GUMROAD_KEY })).state).toBe('pro');
    expect(h.fetch).not.toHaveBeenCalled();
    await expectOff();
  });

  it('a bad request shape and an in-flight conflict', async () => {
    await expect(activateLicense({ licenseKey: 7 })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(deactivateLicense({ licenseKey: 7 })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(deactivateLicense()).rejects.toMatchObject({ code: 'nothing_to_deactivate' });
    await expectOff();
  });

  it('deactivate refusals that need no request: Gumroad, a missing key, a wrong key', async () => {
    h.fetch.mockResolvedValueOnce(reply(200, gumroadVerify()));
    await activateLicense({ licenseKey: GUMROAD_KEY });
    await setNetworkFeature('license', false);
    await expect(deactivateLicense()).rejects.toMatchObject({ code: 'deactivate_unsupported' });
    await expectOff();
  });
});

describe('nothing else reaches a store', () => {
  const calls = () => [h.fetch, nodeFetch];
  const expectSilent = () => calls().forEach((f) => expect(f).not.toHaveBeenCalled());

  it('init with a stored activation, status reads and getEntitlements make no call, even with the feature on', async () => {
    h.fetch.mockResolvedValueOnce(reply(200, gumroadVerify()));
    await activateLicense({ licenseKey: GUMROAD_KEY });
    expect(await licenseOn()).toBe(true);
    h.fetch.mockClear();
    for (let i = 0; i < 3; i += 1) {
      resetLicenseForTests();
      h.init();
      getLicenseStatus();
      getEntitlements();
    }
    expectSilent();
  });

  it('the auto-started trial and Remove from this computer make no call and leave the feature as it was', async () => {
    h.init({ autoStartTrial: true });
    expect(getLicenseStatus().trial.state).toBe('active');
    await removeLicense();
    expectSilent();
    await expectOff();
  });

  it('even the stored LICENSE_STORE_KEY is never used outside an explicit Move', async () => {
    h.fetch.mockResolvedValueOnce(reply(200, lsActivate()));
    await activateLicense({ licenseKey: LS_KEY });
    h.fetch.mockClear();
    resetLicenseForTests();
    h.init();
    getLicenseStatus();
    await removeLicense();
    expectSilent();
  });
});

describe('the default transport and the mock base URL', () => {
  it('without an injected fetch the request goes through node-fetch (mocked here to fail) and is store_unreachable', async () => {
    h.init({ fetchImpl: undefined });
    await expect(activateLicense({ licenseKey: GUMROAD_KEY })).rejects.toMatchObject({ httpStatus: 503, code: 'store_unreachable' });
    expect(nodeFetch).toHaveBeenCalledTimes(1);
    expect(nodeFetch.mock.calls[0][0]).toBe('https://api.gumroad.com/v2/licenses/verify');
    expect(fs.existsSync(path.join(h.dir, ACTIVATION_FILE_NAME))).toBe(false);
  });

  it('a loopback http BURROW_LICENSE_STORE_BASE_URL replaces the origin, and netPolicy still applies', async () => {
    h.init({ env: { BURROW_LICENSE_STORE_BASE_URL: 'http://127.0.0.1:45999' } });
    h.fetch.mockResolvedValueOnce(reply(200, gumroadVerify()));
    await activateLicense({ licenseKey: GUMROAD_KEY });
    expect(h.fetch.mock.calls[0][0]).toBe('http://127.0.0.1:45999/v2/licenses/verify');
    expect(await licenseOn()).toBe(true);
    h.fetch.mockResolvedValueOnce(reply(200, lsActivate()));
    await activateLicense({ licenseKey: LS_KEY });
    expect(h.fetch.mock.calls[1][0]).toBe('http://127.0.0.1:45999/v1/licenses/activate');
    h.fetch.mockResolvedValueOnce(reply(200, { deactivated: true }));
    await deactivateLicense();
    expect(h.fetch.mock.calls[2][0]).toBe('http://127.0.0.1:45999/v1/licenses/deactivate');
  });

  it.each([
    ['https', 'https://127.0.0.1:45999'],
    ['a LAN host', 'http://192.168.0.9:45999'],
    ['credentials', 'http://u:p@127.0.0.1:45999'],
  ])('an unacceptable override (%s) is ignored with one log line', async (_name, url) => {
    h.init({ env: { BURROW_LICENSE_STORE_BASE_URL: url } });
    h.fetch.mockResolvedValueOnce(reply(200, gumroadVerify()));
    await activateLicense({ licenseKey: GUMROAD_KEY });
    expect(h.fetch.mock.calls[0][0]).toBe('https://api.gumroad.com/v2/licenses/verify');
    expect(h.logs.filter((m) => m === 'license: store base URL override ignored')).toHaveLength(1);
  });

  it('the override is ignored in desktop mode', async () => {
    h.init({ env: { BURROW_LICENSE_STORE_BASE_URL: 'http://127.0.0.1:45999', BURROW_DESKTOP: '1' } });
    h.fetch.mockResolvedValueOnce(reply(200, gumroadVerify()));
    await activateLicense({ licenseKey: GUMROAD_KEY });
    expect(h.fetch.mock.calls[0][0]).toBe('https://api.gumroad.com/v2/licenses/verify');
  });

  it('BURROW_LICENSE_STORE_TEST=1 accepts a test purchase in a source run', async () => {
    h.init({ env: { BURROW_LICENSE_STORE_TEST: '1' }, allowTest: undefined });
    h.fetch.mockResolvedValueOnce(reply(200, gumroadVerify({ purchase: { test: true } })));
    expect((await activateLicense({ licenseKey: GUMROAD_KEY })).license.test).toBe(true);
  });

  it('a test purchase stays refused in desktop mode even with BURROW_LICENSE_STORE_TEST=1', async () => {
    h.init({ env: { BURROW_LICENSE_STORE_TEST: '1', BURROW_DESKTOP: '1' }, allowTest: undefined });
    h.fetch.mockResolvedValueOnce(reply(200, gumroadVerify({ purchase: { test: true } })));
    await expect(activateLicense({ licenseKey: GUMROAD_KEY })).rejects.toMatchObject({ code: 'test_purchase_not_allowed' });
  });
});
