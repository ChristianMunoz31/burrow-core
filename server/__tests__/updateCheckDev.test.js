// Update check per channel: which GitHub endpoint is asked, which releases count, ordering, and the
// stable path staying exactly as it was. node-fetch is mocked; every request goes through fetchImpl.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ store: new Map() }));

vi.mock('../../loadEnv.js', () => ({}));
vi.mock('node-fetch', () => ({ default: vi.fn(async () => { throw new Error('real fetch must not be used'); }) }));
vi.mock('../dataAccess.js', () => ({
  getState: vi.fn(async (key, fallback = null) => (h.store.has(key) ? h.store.get(key) : fallback)),
  setState: vi.fn(async (key, value) => {
    h.store.set(key, value);
    return { key, value };
  }),
}));

import { __resetNetPolicyForTests, setNetworkFeature } from '../netPolicy.js';
import { manifest } from './helpers/updateManifest.js';
import {
  DEV_RELEASES_PAGE as RELEASES_PAGE,
  DEV_UPDATE_REPO as UPDATE_REPO,
  LATEST_MANIFEST_URL as LATEST_URL,
  __resetUpdateCacheForTests,
  checkForUpdate,
} from '../updateCheck.js';

const LIST_URL = `https://api.github.com/repos/${UPDATE_REPO}/releases?per_page=20`;

const respond = (status, body, { raw, headers } = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: new Map(Object.entries(headers ?? {})),
  text: async () => raw ?? JSON.stringify(body),
});

/** A well-formed Burrow Dev pre-release. */
const dev = (stamp, sha, over = {}) => ({
  tag_name: `dev-${stamp}-${sha}`,
  name: `Burrow Dev 0.2.0-dev.${stamp}.${sha}`,
  draft: false,
  prerelease: true,
  html_url: `${RELEASES_PAGE}/tag/dev-${stamp}-${sha}`,
  published_at: `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T10:00:00Z`,
  body: 'secret release notes must never be forwarded',
  ...over,
});
const CURRENT = '0.2.0-dev.20261001.aaaaaaa';
const run = (fetchImpl, over = {}) => checkForUpdate({ fetchImpl, channel: 'dev', currentVersion: CURRENT, ...over });
const listing = (...releases) => vi.fn(async () => respond(200, releases));

beforeEach(async () => {
  h.store.clear();
  delete process.env.BURROW_NETWORK_OPTIN;
  __resetNetPolicyForTests();
  __resetUpdateCacheForTests();
  await setNetworkFeature('updates', true);
});

describe('endpoints per channel', () => {
  it('stable asks the latest.json manifest only, never the releases API', async () => {
    const fetchImpl = vi.fn(async () => respond(200, manifest('9.9.9')));
    const res = await checkForUpdate({ fetchImpl, channel: 'stable', currentVersion: '0.1.0' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, options] = fetchImpl.mock.calls[0];
    expect(url).toBe(LATEST_URL);
    expect(options.redirect).toBe('manual');
    expect(options.headers).toEqual({ Accept: 'application/json', 'User-Agent': 'Burrow' });
    expect(url).not.toContain('api.github.com');
    expect(res).toMatchObject({ status: 'available', latest: '9.9.9', channel: 'stable' });
  });

  it('the default channel is stable', async () => {
    const fetchImpl = vi.fn(async () => respond(200, manifest('0.0.1')));
    await checkForUpdate({ fetchImpl, currentVersion: '1.0.0' });
    expect(fetchImpl.mock.calls.map((c) => c[0])).toEqual([LATEST_URL]);
  });

  it('stable never accepts a pre-release or a Burrow Dev version from the manifest', async () => {
    for (const version of ['2.0.0-rc.1', '0.2.0-dev.20261005.abc1234']) {
      __resetUpdateCacheForTests();
      const fetchImpl = vi.fn(async () => respond(200, manifest(version)));
      const res = await checkForUpdate({ fetchImpl, channel: 'stable', currentVersion: '0.1.0' });
      expect(res).toMatchObject({ status: 'unavailable', reason: 'bad_response', channel: 'stable' });
      expect(fetchImpl.mock.calls.map((c) => c[0])).toEqual([LATEST_URL]);
    }
  });

  it('dev asks the list endpoint only, never /latest', async () => {
    const fetchImpl = listing(dev('20261005', 'abc1234'));
    await run(fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, options] = fetchImpl.mock.calls[0];
    expect(url).toBe(LIST_URL);
    expect(url).not.toContain('/latest');
    expect(options.redirect).toBe('manual');
    expect(options.headers).toEqual({ Accept: 'application/vnd.github+json', 'User-Agent': 'Burrow' });
  });

  it('the cache is per channel and version', async () => {
    const fetchImpl = listing(dev('20261005', 'abc1234'));
    await run(fetchImpl);
    await run(fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const stableFetch = vi.fn(async () => respond(200, manifest('0.1.0')));
    const res = await checkForUpdate({ fetchImpl: stableFetch, channel: 'stable', currentVersion: CURRENT });
    expect(stableFetch).toHaveBeenCalledTimes(1);
    expect(res.channel).toBe('stable');
  });
});

describe('dev release filtering', () => {
  const none = (res) => expect(res).toMatchObject({ status: 'unavailable', reason: 'not_found', channel: 'dev' });

  it.each([
    ['a stable release', { ...dev('20261005', 'abc1234'), tag_name: 'v0.2.0', prerelease: false, name: 'v0.2.0' }],
    ['a stable-looking pre-release tag', { ...dev('20261005', 'abc1234'), tag_name: 'v0.3.0-rc.1' }],
    ['a draft', dev('20261005', 'abc1234', { draft: true })],
    ['a non-prerelease', dev('20261005', 'abc1234', { prerelease: false })],
    ['a missing name', dev('20261005', 'abc1234', { name: undefined })],
    ['a bad name', dev('20261005', 'abc1234', { name: 'Burrow 0.2.0-dev.20261005.abc1234' })],
    ['a name with extra text', dev('20261005', 'abc1234', { name: 'Burrow Dev 0.2.0-dev.20261005.abc1234 extra' })],
    ['a name that is not a dev version', dev('20261005', 'abc1234', { name: 'Burrow Dev 0.2.0' })],
    ['a name whose sha disagrees with the tag', dev('20261005', 'abc1234', { name: 'Burrow Dev 0.2.0-dev.20261005.def5678' })],
    ['a name whose date disagrees with the tag', dev('20261005', 'abc1234', { name: 'Burrow Dev 0.2.0-dev.20261006.abc1234' })],
    ['an uppercase sha tag', dev('20261005', 'abc1234', { tag_name: 'dev-20261005-ABC1234' })],
    ['a non-object entry', 'dev-20261005-abc1234'],
    ['null', null],
  ])('ignores %s', async (_label, entry) => {
    none(await run(listing(entry)));
  });

  it('an empty list is not_found', async () => {
    none(await run(listing()));
  });

  it('keeps valid entries next to invalid ones', async () => {
    const res = await run(listing(dev('20261006', 'bbbbbbb', { draft: true }), dev('20261005', 'abc1234'), { tag_name: 'v1.0.0' }));
    expect(res).toMatchObject({ status: 'available', latest: '0.2.0-dev.20261005.abc1234' });
  });
});

describe('dev ordering and comparison', () => {
  it('picks the newest by published_at', async () => {
    const res = await run(
      listing(
        dev('20261003', 'ccccccc', { published_at: '2026-10-03T00:00:00Z' }),
        dev('20261005', 'abc1234', { published_at: '2026-10-05T00:00:00Z' }),
        dev('20261004', 'ddddddd', { published_at: '2026-10-04T00:00:00Z' }),
      ),
    );
    expect(res.latest).toBe('0.2.0-dev.20261005.abc1234');
  });

  it('breaks a published_at tie by the date in the version', async () => {
    const same = '2026-10-05T00:00:00Z';
    const res = await run(
      listing(dev('20261003', 'ccccccc', { published_at: same }), dev('20261004', 'ddddddd', { published_at: same })),
    );
    expect(res.latest).toBe('0.2.0-dev.20261004.ddddddd');
  });

  it('treats a missing published_at as oldest', async () => {
    const res = await run(listing(dev('20261009', 'eeeeeee', { published_at: undefined }), dev('20261005', 'abc1234')));
    expect(res.latest).toBe('0.2.0-dev.20261005.abc1234');
  });

  it('available: newer date, with url, publishedAt and no release text', async () => {
    const res = await run(listing(dev('20261005', 'abc1234')));
    expect(res).toMatchObject({
      status: 'available',
      current: CURRENT,
      latest: '0.2.0-dev.20261005.abc1234',
      url: `${RELEASES_PAGE}/tag/dev-20261005-abc1234`,
      publishedAt: '2026-10-05T10:00:00Z',
      channel: 'dev',
    });
    expect(JSON.stringify(res)).not.toContain('secret release notes');
  });

  it('falls back to the releases page for a foreign html_url', async () => {
    const res = await run(listing(dev('20261005', 'abc1234', { html_url: 'https://evil.example/x' })));
    expect(res.url).toBe(RELEASES_PAGE);
  });

  it('current: same sha', async () => {
    const res = await run(listing(dev('20261001', 'aaaaaaa')));
    expect(res).toMatchObject({ status: 'current', latest: CURRENT, channel: 'dev' });
  });

  it('current: newest is an older date of the same core', async () => {
    const res = await run(listing(dev('20260929', 'bbbbbbb')));
    expect(res.status).toBe('current');
  });

  it('current: newest has a lower core version', async () => {
    const lower = dev('20261005', 'abc1234', { name: 'Burrow Dev 0.1.5-dev.20261005.abc1234' });
    expect((await run(listing(lower))).status).toBe('current');
  });

  it('available: a higher core version even with an older date', async () => {
    const higher = dev('20260929', 'abc1234', { name: 'Burrow Dev 0.3.0-dev.20260929.abc1234' });
    expect((await run(listing(higher))).status).toBe('available');
  });

  it('available: same core and date, different sha', async () => {
    const res = await run(listing(dev('20261001', 'bbbbbbb')));
    expect(res.status).toBe('available');
  });

  it('available: a source checkout (not a dev version) is behind the newest dev release', async () => {
    const res = await run(listing(dev('20261005', 'abc1234')), { currentVersion: '0.1.0' });
    expect(res).toMatchObject({ status: 'available', current: '0.1.0' });
  });
});

describe('dev failures resolve, never throw', () => {
  it.each([
    [404, 'not_found'],
    [403, 'rate_limited'],
    [429, 'rate_limited'],
    [500, 'bad_response'],
  ])('status %i is %s', async (status, reason) => {
    const res = await run(vi.fn(async () => respond(status, {})));
    expect(res).toMatchObject({ status: 'unavailable', reason, channel: 'dev', current: CURRENT });
  });

  it('a body that is not an array is bad_response', async () => {
    expect((await run(vi.fn(async () => respond(200, dev('20261005', 'abc1234'))))).reason).toBe('bad_response');
  });

  it('invalid JSON is bad_response', async () => {
    expect((await run(vi.fn(async () => respond(200, null, { raw: '[{' })))).reason).toBe('bad_response');
  });

  it('an oversized declared body is bad_response', async () => {
    const big = vi.fn(async () => respond(200, [], { headers: { 'content-length': String(2 * 1024 * 1024) } }));
    expect((await run(big)).reason).toBe('bad_response');
  });

  it('an oversized actual body is bad_response', async () => {
    const big = vi.fn(async () => respond(200, null, { raw: `[${' '.repeat(1024 * 1024 + 1)}]` }));
    expect((await run(big)).reason).toBe('bad_response');
  });

  it('a list over the stable cap but under the list cap is accepted', async () => {
    const pad = Array.from({ length: 3000 }, (_, i) => ({ id: i, body: 'x'.repeat(100) }));
    const res = await run(vi.fn(async () => respond(200, [...pad, dev('20261005', 'abc1234')])));
    expect(res.status).toBe('available');
  });

  it('a network error and a timeout', async () => {
    expect((await run(vi.fn(async () => { throw new Error('down'); }))).reason).toBe('network');
    __resetUpdateCacheForTests();
    const timeout = vi.fn(async () => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }); });
    expect((await run(timeout)).reason).toBe('timeout');
  });
});
