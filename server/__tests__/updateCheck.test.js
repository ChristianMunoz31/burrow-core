// Update check: semver compare in code, GitHub response handling, cache, and the opt-in gate.
// node-fetch is mocked and every request goes through an injected fetchImpl: no network.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ store: new Map() }));

vi.mock('../../loadEnv.js', () => ({}));
vi.mock('../networkCall.js', async (orig) => ({ ...(await orig()), recordNetworkCall: vi.fn(async () => {}) }));
vi.mock('node-fetch', () => ({ default: vi.fn(async () => { throw new Error('real fetch must not be used'); }) }));
vi.mock('../dataAccess.js', () => ({
  getState: vi.fn(async (key, fallback = null) => (h.store.has(key) ? h.store.get(key) : fallback)),
  setState: vi.fn(async (key, value) => {
    h.store.set(key, value);
    return { key, value };
  }),
}));

import fetch from 'node-fetch';
import { NetworkOptInError, __resetNetPolicyForTests, setNetworkFeature } from '../netPolicy.js';
import {
  APP_VERSION,
  LATEST_MANIFEST_URL,
  RELEASES_PAGE,
  RELEASE_API_URL,
  UPDATE_REDIRECT_HOSTS,
  UPDATE_REPO,
  __resetUpdateCacheForTests,
  checkForUpdate,
  compareSemver,
  fetchInstallerChecksum,
  fetchLatestManifest,
  installerUrl,
  licenseImpactFor,
  parseLatestRelease,
  parseSums,
  releaseNotesText,
  sumsUrl,
} from '../updateCheck.js';
import * as networkCall from '../networkCall.js';
import { manifest, redirectTo, respond } from './helpers/updateManifest.js';

const stub = (...responses) => {
  const fn = vi.fn();
  for (const r of responses) fn.mockImplementationOnce(async () => r);
  return fn;
};

beforeEach(async () => {
  h.store.clear();
  delete process.env.BURROW_NETWORK_OPTIN;
  __resetNetPolicyForTests();
  __resetUpdateCacheForTests();
  fetch.mockClear();
  await setNetworkFeature('updates', true);
});

describe('compareSemver', () => {
  it.each([
    ['1.2.3', '1.2.3', 0],
    ['v1.2.3', '1.2.3', 0],
    ['1.2.4', '1.2.3', 1],
    ['1.10.0', '1.9.0', 1],
    ['0.9.9', '1.0.0', -1],
    ['2.0.0', '1.99.99', 1],
    ['1.0.0-beta.1', '1.0.0', -1],
    ['1.0.0', '1.0.0-rc.1', 1],
    ['1.0.0-beta.2', '1.0.0-beta.10', -1],
    ['1.0.0-alpha', '1.0.0-beta', -1],
  ])('%s vs %s is %i', (a, b, expected) => {
    expect(compareSemver(a, b)).toBe(expected);
  });

  it.each([['1.2'], ['latest'], [''], ['1.2.3.4'], [null], [undefined], [12]])('null for invalid %j', (bad) => {
    expect(compareSemver(bad, '1.0.0')).toBeNull();
    expect(compareSemver('1.0.0', bad)).toBeNull();
  });

  it('reads APP_VERSION from package.json', () => {
    expect(compareSemver(APP_VERSION, APP_VERSION)).toBe(0);
  });
});

describe('checkForUpdate (stable, latest.json)', () => {
  it('reports available for a newer release with its notes, releases-tag url and pub_date', async () => {
    const fetchImpl = stub(respond(200, manifest('1.2.0')));
    const s = await checkForUpdate({ fetchImpl, currentVersion: '1.1.0' });
    expect(s).toMatchObject({
      status: 'available',
      current: '1.1.0',
      latest: '1.2.0',
      url: `${RELEASES_PAGE}/tag/v1.2.0`,
      publishedAt: '2030-01-01T00:00:00Z',
      channel: 'stable',
      notes: 'New:\n- A plain line',
    });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://github.com/ChristianMunoz31/burrow-releases/releases/latest/download/latest.json');
    expect(url).toBe(LATEST_MANIFEST_URL);
    expect(init.redirect).toBe('manual');
    expect(init.size).toBe(64 * 1024);
    expect(init.headers).toEqual({ Accept: 'application/json', 'User-Agent': 'Burrow' });
    expect(Object.keys(init.headers)).not.toContain('Authorization');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('asks the PUBLIC burrow-releases repo and never the releases API', async () => {
    expect(UPDATE_REPO).toBe('ChristianMunoz31/burrow-releases');
    const fetchImpl = stub(respond(200, manifest()));
    await checkForUpdate({ fetchImpl, currentVersion: '1.1.0' });
    expect(fetchImpl.mock.calls.map((c) => c[0])).toEqual([LATEST_MANIFEST_URL]);
    expect(RELEASES_PAGE).toBe('https://github.com/ChristianMunoz31/burrow-releases/releases');
  });

  it('records one audit row for the host github.com per check', async () => {
    networkCall.recordNetworkCall.mockClear();
    await checkForUpdate({ fetchImpl: stub(respond(200, manifest())), currentVersion: '1.1.0' });
    expect(networkCall.recordNetworkCall).toHaveBeenCalledTimes(1);
    expect(networkCall.recordNetworkCall).toHaveBeenCalledWith('updates', 'https://github.com', 'ok');
  });

  it('reports current when equal or when local is newer', async () => {
    expect((await checkForUpdate({ fetchImpl: stub(respond(200, manifest())), currentVersion: '1.2.0' })).status).toBe('current');
    const newer = await checkForUpdate({ fetchImpl: stub(respond(200, manifest())), currentVersion: '1.3.0', refresh: true });
    expect(newer).toMatchObject({ status: 'current', latest: '1.2.0', current: '1.3.0' });
    expect(newer).not.toHaveProperty('notes');
  });

  it('maps 404 to not_found, 403 and 429 to rate_limited, other statuses to bad_response', async () => {
    const cases = [[404, 'not_found'], [403, 'rate_limited'], [429, 'rate_limited'], [500, 'bad_response']];
    for (const [status, reason] of cases) {
      __resetUpdateCacheForTests();
      const s = await checkForUpdate({ fetchImpl: stub(respond(status, {})), currentVersion: '1.0.0' });
      expect(s).toMatchObject({ status: 'unavailable', reason });
    }
  });

  it('maps an abort to timeout and any other throw to network, and records them as failed', async () => {
    const abort = vi.fn(async () => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }); });
    expect(await checkForUpdate({ fetchImpl: abort, currentVersion: '1.0.0' })).toMatchObject({ reason: 'timeout' });
    __resetUpdateCacheForTests();
    networkCall.recordNetworkCall.mockClear();
    const down = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    expect(await checkForUpdate({ fetchImpl: down, currentVersion: '1.0.0' })).toMatchObject({ reason: 'network' });
    expect(networkCall.recordNetworkCall).toHaveBeenCalledWith('updates', 'https://github.com', 'error');
  });

  it('really times out a hanging request through the abort signal', async () => {
    const hanging = vi.fn(
      (url, { signal }) =>
        new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason));
        }),
    );
    const s = await checkForUpdate({ fetchImpl: hanging, currentVersion: '1.0.0', timeoutMs: 20 });
    expect(s).toMatchObject({ status: 'unavailable', reason: 'timeout' });
  });

  it('caches results, and refresh bypasses the cache once the last fetch is over 60 s old', async () => {
    const t0 = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(t0);
    try {
      const fetchImpl = vi.fn(async () => respond(200, manifest()));
      await checkForUpdate({ fetchImpl, currentVersion: '1.0.0' });
      await checkForUpdate({ fetchImpl, currentVersion: '1.0.0' });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      clock.mockReturnValue(t0 + 61_000);
      await checkForUpdate({ fetchImpl, currentVersion: '1.0.0', refresh: true });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      clock.mockRestore();
    }
  });

  it('ignores refresh when the last upstream fetch was under 60 s ago', async () => {
    const t0 = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(t0);
    try {
      const fetchImpl = vi.fn(async () => respond(200, manifest()));
      await checkForUpdate({ fetchImpl, currentVersion: '1.0.0' });
      clock.mockReturnValue(t0 + 30_000);
      const again = await checkForUpdate({ fetchImpl, currentVersion: '1.0.0', refresh: true });
      expect(again.status).toBe('available');
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      clock.mockRestore();
    }
  });

  it('shares one in-flight request between concurrent calls', async () => {
    let open;
    const gate = new Promise((resolve) => {
      open = resolve;
    });
    const fetchImpl = vi.fn(async () => {
      await gate;
      return respond(200, manifest());
    });
    const calls = [1, 2, 3].map(() => checkForUpdate({ fetchImpl, currentVersion: '1.0.0', refresh: true }));
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    open();
    const results = await Promise.all(calls);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(results[1]).toBe(results[0]);
    expect(results[2]).toBe(results[0]);
  });

  it('caches an unavailable result too (shorter)', async () => {
    const fetchImpl = vi.fn(async () => respond(404, {}));
    await checkForUpdate({ fetchImpl, currentVersion: '1.0.0' });
    await checkForUpdate({ fetchImpl, currentVersion: '1.0.0' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('throws NetworkOptInError before any fetch while the feature is off', async () => {
    await setNetworkFeature('updates', false);
    const fetchImpl = vi.fn();
    await expect(checkForUpdate({ fetchImpl })).rejects.toBeInstanceOf(NetworkOptInError);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('is gated even when a cached result exists', async () => {
    const fetchImpl = vi.fn(async () => respond(200, manifest()));
    await checkForUpdate({ fetchImpl, currentVersion: '1.0.0' });
    await setNetworkFeature('updates', false);
    await expect(checkForUpdate({ fetchImpl, currentVersion: '1.0.0' })).rejects.toBeInstanceOf(NetworkOptInError);
  });
});

describe('manifest redirects', () => {
  const ASSET = 'https://release-assets.githubusercontent.com/github-production-release-asset/1/latest.json?sig=x';

  it('lists exactly the three allowed hosts', () => {
    expect(UPDATE_REDIRECT_HOSTS).toEqual(['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com']);
  });

  it.each([
    ['github.com', 'https://github.com/ChristianMunoz31/burrow-releases/releases/download/v1.2.0/latest.json'],
    ['release-assets.githubusercontent.com', ASSET],
    ['objects.githubusercontent.com', 'https://objects.githubusercontent.com/github-production-release-asset/1/latest.json'],
  ])('follows a redirect to %s', async (_host, location) => {
    const fetchImpl = stub(redirectTo(location), respond(200, manifest()));
    const res = await fetchLatestManifest({ fetchImpl });
    expect(res).toMatchObject({ ok: true, manifest: { version: '1.2.0' } });
    expect(fetchImpl.mock.calls.map((c) => c[0])).toEqual([LATEST_MANIFEST_URL, location]);
    for (const [, init] of fetchImpl.mock.calls) expect(init.redirect).toBe('manual');
  });

  it('follows a chain of three redirects and resolves a relative location', async () => {
    const fetchImpl = stub(redirectTo('/a'), redirectTo(ASSET, 307), redirectTo('https://objects.githubusercontent.com/x', 301), respond(200, manifest()));
    const res = await fetchLatestManifest({ fetchImpl });
    expect(res.ok).toBe(true);
    expect(fetchImpl.mock.calls[1][0]).toBe('https://github.com/a');
  });

  it.each([
    ['another host', 'https://evil.example/latest.json'],
    ['a lookalike host', 'https://github.com.evil.example/latest.json'],
    ['a prefix lookalike', 'https://evil-github.com/latest.json'],
    ['http', 'http://github.com/ChristianMunoz31/x'],
    ['an explicit port', 'https://github.com:8443/ChristianMunoz31/x'],
    ['userinfo', `https://user:pw${'@'}github.com/x`],
    ['another scheme', 'file:///C:/x'],
    ['an empty location', ''],
  ])('refuses a redirect to %s as bad_response and fetches nothing more', async (_label, location) => {
    const fetchImpl = vi.fn(async () => redirectTo(location));
    const res = await fetchLatestManifest({ fetchImpl });
    expect(res).toEqual({ ok: false, reason: 'bad_response' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const s = await checkForUpdate({ fetchImpl: vi.fn(async () => redirectTo(location)), currentVersion: '1.0.0' });
    expect(s).toMatchObject({ status: 'unavailable', reason: 'bad_response' });
  });

  it('gives up after more than 3 redirects', async () => {
    const fetchImpl = vi.fn(async () => redirectTo(ASSET));
    const res = await fetchLatestManifest({ fetchImpl });
    expect(res).toEqual({ ok: false, reason: 'bad_response' });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });
});

describe('manifest validation', () => {
  const bad = async (body, opts) => {
    __resetUpdateCacheForTests();
    const s = await checkForUpdate({ fetchImpl: stub(typeof body === 'string' ? respond(200, null, { raw: body }) : respond(200, body)), currentVersion: '1.0.0', ...opts });
    expect(s).toMatchObject({ status: 'unavailable', reason: 'bad_response' });
  };
  const withPlatform = (key, over) => {
    const m = manifest();
    m.platforms[key] = over === null ? undefined : { ...m.platforms[key], ...over };
    return m;
  };

  it.each(['2.0.0-rc.1', '2.0', 'v2.0.0', '02.0.0', '2.0.0+build', 'latest', '1234567890.0.0', '1.2.1234567890'])('rejects the version %s', async (version) => {
    await bad(manifest(version));
  });

  it('rejects a non-string or missing version and a bad pub_date', async () => {
    await bad(manifest('1.2.0', { version: 120 }));
    await bad(manifest('1.2.0', { version: undefined }));
    await bad(manifest('1.2.0', { pub_date: 'soon' }));
    await bad(manifest('1.2.0', { pub_date: undefined }));
  });

  it('rejects an installer URL for another tag, repo, arch, host or scheme', async () => {
    const other = 'https://github.com/ChristianMunoz31';
    await bad(withPlatform('windows-x86_64', { url: installerUrl('9.9.9', 'x64') }));
    await bad(withPlatform('windows-x86_64', { url: `${other}/other-repo/releases/download/v1.2.0/Burrow-Setup-x64.exe` }));
    await bad(withPlatform('windows-x86_64', { url: installerUrl('1.2.0', 'arm64') }));
    await bad(withPlatform('windows-aarch64', { url: installerUrl('1.2.0', 'x64') }));
    await bad(withPlatform('windows-x86_64', { url: 'https://evil.example/Burrow-Setup-x64.exe' }));
    await bad(withPlatform('windows-x86_64', { url: installerUrl('1.2.0', 'x64').replace('https', 'http') }));
    await bad(withPlatform('windows-x86_64', { url: `${installerUrl('1.2.0', 'x64')}?x=1` }));
    await bad(withPlatform('windows-x86_64', { url: undefined }));
  });

  it('rejects a missing platform and a bad signature', async () => {
    await bad(withPlatform('windows-x86_64', null));
    await bad(withPlatform('windows-aarch64', null));
    await bad({ ...manifest(), platforms: [] });
    await bad({ ...manifest(), platforms: undefined });
    await bad(withPlatform('windows-x86_64', { signature: '' }));
    await bad(withPlatform('windows-x86_64', { signature: 42 }));
    await bad(withPlatform('windows-aarch64', { signature: 'a'.repeat(4097) }));
  });

  it('accepts a signature of exactly 4096 characters', async () => {
    const m = withPlatform('windows-x86_64', { signature: 'a'.repeat(4096) });
    const s = await checkForUpdate({ fetchImpl: stub(respond(200, m)), currentVersion: '1.0.0' });
    expect(s.status).toBe('available');
  });

  it('rejects non-JSON, a non-object body, an array and an oversized body', async () => {
    await bad('<html>nope</html>');
    await bad('[]');
    await bad('null');
    await bad(JSON.stringify({ ...manifest(), pad: 'x'.repeat(70 * 1024) }));
    __resetUpdateCacheForTests();
    const declared = { ...respond(200, manifest()), headers: new Map([['content-length', String(70 * 1024)]]) };
    expect(await checkForUpdate({ fetchImpl: stub(declared), currentVersion: '1.0.0' })).toMatchObject({ reason: 'bad_response' });
  });

  it('rejects notes that are not a string, and treats missing or null notes as none', async () => {
    await bad(manifest('1.2.0', { notes: 42 }));
    await bad(manifest('1.2.0', { notes: { a: 1 } }));
    for (const notes of [undefined, null]) {
      __resetUpdateCacheForTests();
      const s = await checkForUpdate({ fetchImpl: stub(respond(200, manifest('1.2.0', { notes }))), currentVersion: '1.0.0' });
      expect(s).toMatchObject({ status: 'available', notes: null });
    }
  });
});

describe('notes sanitizing', () => {
  const notesOf = async (notes) => {
    __resetUpdateCacheForTests();
    const s = await checkForUpdate({ fetchImpl: stub(respond(200, manifest('1.2.0', { notes }))), currentVersion: '1.0.0' });
    return s.notes;
  };

  it('keeps text and newlines, turns CRLF into LF and strips every other C0 control character (tabs too)', async () => {
    expect(await notesOf('Fixed:\r\n- One\u0000\u0007\u001b[31m\r\n- Two\ttabbed')).toBe('Fixed:\n- One[31m\n- Twotabbed');
  });

  it('keeps markup and links as plain characters (the UI renders text only)', async () => {
    expect(await notesOf('<script>x</script> [a](https://evil.example)')).toBe('<script>x</script> [a](https://evil.example)');
  });

  it('strips C1 controls, zero-width and bidi marks, the word joiner and the BOM', async () => {
    expect(await notesOf('a\u0085b\u009Fc\u200Bd\u200Fe\u202Af\u202Eg\u2060h\u2069i\uFEFFj')).toBe('abcdefghij');
    expect(await notesOf('\u202E\u200B')).toBeNull();
  });

  it('strips the Arabic letter mark, line and paragraph separators and interlinear annotation marks', async () => {
    expect(await notesOf('a\u061Cb\u2028c\u2029d\uFFF9e\uFFFAf\uFFFBg')).toBe('abcdefg');
    expect(await notesOf('\u2028\u2029\uFFFA')).toBeNull();
  });

  it('caps at 2000 characters, else null', async () => {
    expect(await notesOf('a'.repeat(2000))).toBe('a'.repeat(2000));
    expect(await notesOf('a'.repeat(2001))).toBeNull();
  });

  it('gives null for empty or whitespace-only notes', async () => {
    expect(await notesOf('')).toBeNull();
    expect(await notesOf(' \n\u0000 ')).toBeNull();
  });
});

describe('licenseImpactFor', () => {
  const avail = { status: 'available', channel: 'stable', publishedAt: '2030-06-01T00:00:00Z' };
  const lic = (updatesUntil, proSource = 'license') => ({ proSource, license: { updatesUntil } });

  it('blocks a paid license released after updatesUntil, by one second', () => {
    expect(licenseImpactFor(avail, lic('2030-01-01T00:00:00Z'))).toEqual({
      licenseImpact: 'blocked',
      updatesUntil: '2030-01-01T00:00:00Z',
    });
    expect(licenseImpactFor(avail, lic('2030-05-31T23:59:59Z')).licenseImpact).toBe('blocked');
  });

  it('includes a release published at the same instant as updatesUntil, or before it', () => {
    expect(licenseImpactFor(avail, lic('2030-06-01T00:00:00Z'))).toEqual({
      licenseImpact: 'included',
      updatesUntil: '2030-06-01T00:00:00Z',
    });
    expect(licenseImpactFor(avail, lic('2031-01-01T00:00:00Z')).licenseImpact).toBe('included');
  });

  it.each([
    ['the trial', lic('2030-01-01T00:00:00Z', 'local_trial')],
    ['no pro source (free, lapsed or expired)', lic('2030-01-01T00:00:00Z', null)],
    ['no license status', null],
    ['an undefined license status', undefined],
  ])('is free for %s', (_label, license) => {
    expect(licenseImpactFor(avail, license)).toEqual({ licenseImpact: 'free', updatesUntil: null });
  });

  it.each([
    ['no license record', avail, { proSource: 'license', license: null }],
    ['a bad updatesUntil', avail, lic('soon')],
    ['no updatesUntil', avail, lic(undefined)],
    ['no publish date', { ...avail, publishedAt: null }, lic('2030-01-01T00:00:00Z')],
    ['a bad publish date', { ...avail, publishedAt: 'soon' }, lic('2030-01-01T00:00:00Z')],
  ])('is unknown for %s', (_label, status, license) => {
    expect(licenseImpactFor(status, license).licenseImpact).toBe('unknown');
  });

  it('keeps the updatesUntil string when only the release date is bad', () => {
    expect(licenseImpactFor({ ...avail, publishedAt: 'soon' }, lic('2030-01-01T00:00:00Z'))).toEqual({
      licenseImpact: 'unknown',
      updatesUntil: '2030-01-01T00:00:00Z',
    });
  });

  it.each([
    ['the dev channel', { ...avail, channel: 'dev' }],
    ['a current status', { status: 'current' }],
    ['no status', null],
  ])('is null for %s', (_label, status) => {
    expect(licenseImpactFor(status, lic('2030-01-01T00:00:00Z'))).toEqual({ licenseImpact: null, updatesUntil: null });
  });
});

const release = (over = {}) => ({
  tag_name: 'v1.2.0',
  draft: false,
  prerelease: false,
  published_at: '2030-01-01T00:00:00Z',
  body: "## What's new\n### New\n- A plain line\n",
  assets: [{ name: 'Burrow-Setup-x64.exe' }, { name: 'Burrow-Setup-arm64.exe' }, { name: 'SHA256SUMS.txt' }],
  ...over,
});

describe('parseLatestRelease', () => {
  it('accepts a published stable release with both installers and the checksum file', () => {
    expect(parseLatestRelease(release())).toEqual({ version: '1.2.0', pubDate: '2030-01-01T00:00:00Z', notes: 'New:\n- A plain line' });
  });

  it('ignores asset urls in the response', () => {
    const assets = release().assets.map((a) => ({ ...a, browser_download_url: 'https://evil.example/x' }));
    expect(parseLatestRelease(release({ assets }))).not.toBeNull();
  });

  it.each([
    ['a draft', { draft: true }],
    ['a prerelease', { prerelease: true }],
    ['a two-part tag', { tag_name: 'v1.2' }],
    ['a prerelease tag', { tag_name: 'v1.2.3-beta' }],
    ['a tag without v', { tag_name: '1.2.3' }],
    ['a non-string tag', { tag_name: 12 }],
    ['a bad date', { published_at: 'soon' }],
    ['no date', { published_at: undefined }],
    ['no x64 installer', { assets: [{ name: 'Burrow-Setup-arm64.exe' }, { name: 'SHA256SUMS.txt' }] }],
    ['no arm64 installer', { assets: [{ name: 'Burrow-Setup-x64.exe' }, { name: 'SHA256SUMS.txt' }] }],
    ['no checksum file', { assets: [{ name: 'Burrow-Setup-x64.exe' }, { name: 'Burrow-Setup-arm64.exe' }] }],
    ['assets that are not an array', { assets: {} }],
  ])('rejects %s', (_label, over) => {
    expect(parseLatestRelease(release(over))).toBeNull();
  });

  it.each([[null], [[]], ['x'], [undefined]])('rejects %j', (raw) => {
    expect(parseLatestRelease(raw)).toBeNull();
  });
});

describe('releaseNotesText', () => {
  it('keeps only the What\'s new section and stops at the next ## heading', () => {
    const body = "Intro line\n## What's new\n### New\n- One\n* Two\n## Install\n- Not this\n";
    expect(releaseNotesText(body)).toBe('New:\n- One\n- Two');
  });

  it('accepts a curly apostrophe and any case in the heading', () => {
    expect(releaseNotesText('## WHAT\u2019S NEW\n- Hi')).toBe('- Hi');
  });

  it('turns links into their text and removes bare urls and emphasis marks', () => {
    const body = "## What's new\n- See [the notes](https://evil.example/x) and ![pic](https://evil.example/p.png)\n- Visit https://evil.example now **bold** __also__ `code`";
    const text = releaseNotesText(body);
    expect(text).toBe('- See the notes and pic\n- Visit  now bold also code');
    expect(text).not.toContain('http');
  });

  it('drops blank lines and gives null when there is no heading or nothing under it', () => {
    expect(releaseNotesText("## What's new\n\n\n- A\n\n- B")).toBe('- A\n- B');
    expect(releaseNotesText('## Other\n- A')).toBeNull();
    expect(releaseNotesText("## What's new\n## Next")).toBeNull();
    expect(releaseNotesText(null)).toBeNull();
  });

  it('cuts at a line boundary within 2000 characters', () => {
    const line = `- ${'a'.repeat(98)}`;
    const text = releaseNotesText(`## What's new\n${Array.from({ length: 40 }, () => line).join('\n')}`);
    expect(text.length).toBeLessThanOrEqual(2000);
    expect(text.split('\n').every((l) => l === line)).toBe(true);
    expect(text.split('\n')).toHaveLength(19);
  });

  it('removes www links, any scheme:// text and empty reference-style link definitions', () => {
    const body = [
      "## What's new",
      '- Visit www.evil.example/path now',
      '- Get ftp://evil.example/x or HTTPS://EVIL.example and custom+app://x/y',
      '- See [the guide][1] for more',
      '[1]: https://evil.example/guide',
      '[2]: www.evil.example',
      '- Plain line',
    ].join('\n');
    const text = releaseNotesText(body);
    expect(text).toBe('- Visit  now\n- Get  or  and\n- See the guide for more\n- Plain line');
    expect(text).not.toMatch(/evil|www|:\/\//i);
  });

  it('removes bidi and control characters', () => {
    expect(releaseNotesText("## What's new\n- a\u202Eb\u0007c\u200Bd")).toBe('- abcd');
  });
});

describe('checkForUpdate (stable, releases API source)', () => {
  const run = (response, over = {}) =>
    checkForUpdate({ fetchImpl: stub(response), currentVersion: '1.1.0', source: 'release', ...over });

  it('reports available with the pinned releases-tag url, the notes and source release', async () => {
    const fetchImpl = stub(respond(200, release()));
    const s = await checkForUpdate({ fetchImpl, currentVersion: '1.1.0', source: 'release' });
    expect(s).toMatchObject({
      status: 'available',
      latest: '1.2.0',
      url: `${RELEASES_PAGE}/tag/v1.2.0`,
      publishedAt: '2030-01-01T00:00:00Z',
      channel: 'stable',
      source: 'release',
      notes: 'New:\n- A plain line',
    });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.github.com/repos/ChristianMunoz31/burrow-releases/releases/latest');
    expect(url).toBe(RELEASE_API_URL);
    expect(init.redirect).toBe('manual');
    expect(init.size).toBe(256 * 1024);
    expect(init.headers).toEqual({ Accept: 'application/vnd.github+json', 'User-Agent': 'Burrow' });
  });

  it('reports current when equal and when the local version is newer (no downgrade)', async () => {
    expect((await run(respond(200, release()), { currentVersion: '1.2.0' })).status).toBe('current');
    const older = await run(respond(200, release()), { currentVersion: '1.3.0', refresh: true });
    expect(older).toMatchObject({ status: 'current', latest: '1.2.0', source: 'release' });
  });

  it.each([
    [404, 'not_found'],
    [403, 'rate_limited'],
    [429, 'rate_limited'],
    [500, 'bad_response'],
    [301, 'bad_response'],
    [302, 'bad_response'],
  ])('maps HTTP %i to %s', async (status, reason) => {
    expect(await run(respond(status, {}))).toMatchObject({ status: 'unavailable', reason });
  });

  it('refuses an oversized body, invalid JSON and an invalid release', async () => {
    expect(await run(respond(200, {}, { headers: { 'content-length': String(300 * 1024) } }))).toMatchObject({ reason: 'bad_response' });
    __resetUpdateCacheForTests();
    expect(await run(respond(200, {}, { raw: 'x'.repeat(256 * 1024 + 1) }))).toMatchObject({ reason: 'bad_response' });
    __resetUpdateCacheForTests();
    expect(await run(respond(200, {}, { raw: '{nope' }))).toMatchObject({ reason: 'bad_response' });
    __resetUpdateCacheForTests();
    expect(await run(respond(200, release({ prerelease: true })))).toMatchObject({ reason: 'bad_response' });
  });

  it('maps a timeout and a network error', async () => {
    const abort = vi.fn(async () => {
      throw Object.assign(new Error('x'), { name: 'TimeoutError' });
    });
    expect(await checkForUpdate({ fetchImpl: abort, currentVersion: '1.1.0', source: 'release' })).toMatchObject({ reason: 'timeout' });
    __resetUpdateCacheForTests();
    const down = vi.fn(async () => {
      throw new Error('ECONNRESET');
    });
    expect(await checkForUpdate({ fetchImpl: down, currentVersion: '1.1.0', source: 'release' })).toMatchObject({ reason: 'network' });
  });

  it('audits the host api.github.com, once, as error on a network failure', async () => {
    networkCall.recordNetworkCall.mockClear();
    await run(respond(200, release()));
    expect(networkCall.recordNetworkCall).toHaveBeenCalledTimes(1);
    expect(networkCall.recordNetworkCall).toHaveBeenCalledWith('updates', 'https://api.github.com', 'ok');
    networkCall.recordNetworkCall.mockClear();
    __resetUpdateCacheForTests();
    await checkForUpdate({
      fetchImpl: vi.fn(async () => {
        throw new Error('down');
      }),
      currentVersion: '1.1.0',
      source: 'release',
    });
    expect(networkCall.recordNetworkCall).toHaveBeenCalledWith('updates', 'https://api.github.com', 'error');
  });

  it('audits a refused or unfollowed 3xx as error, never ok', async () => {
    for (const status of [301, 302, 307]) {
      networkCall.recordNetworkCall.mockClear();
      __resetUpdateCacheForTests();
      const s = await checkForUpdate({
        fetchImpl: vi.fn(async () => redirectTo('https://evil.example/x', status)),
        currentVersion: '1.1.0',
        source: 'release',
      });
      expect(s).toMatchObject({ status: 'unavailable', reason: 'bad_response' });
      expect(networkCall.recordNetworkCall).toHaveBeenCalledTimes(1);
      expect(networkCall.recordNetworkCall).toHaveBeenCalledWith('updates', 'https://api.github.com', 'error');
    }
  });

  it('keeps the two sources in separate cache slots', async () => {
    const manifestFetch = stub(respond(200, manifest('1.2.0')));
    const releaseFetch = stub(respond(200, release({ tag_name: 'v1.5.0' })));
    const a = await checkForUpdate({ fetchImpl: manifestFetch, currentVersion: '1.1.0', source: 'manifest' });
    const b = await checkForUpdate({ fetchImpl: releaseFetch, currentVersion: '1.1.0', source: 'release' });
    expect(a).toMatchObject({ latest: '1.2.0', source: 'manifest' });
    expect(b).toMatchObject({ latest: '1.5.0', source: 'release' });
    expect(manifestFetch).toHaveBeenCalledTimes(1);
    expect(releaseFetch).toHaveBeenCalledTimes(1);
  });

  it('the default source is the manifest', async () => {
    const fetchImpl = stub(respond(200, manifest('1.2.0')));
    expect(await checkForUpdate({ fetchImpl, currentVersion: '1.1.0' })).toMatchObject({ source: 'manifest' });
    expect(fetchImpl.mock.calls[0][0]).toBe(LATEST_MANIFEST_URL);
  });
});

describe('parseSums', () => {
  const sha = (c) => c.repeat(64);

  it('reads the line for the file name, lowercased, text and binary markers, CRLF', () => {
    const text = `${sha('A')} *Burrow-Setup-x64.exe\r\n${sha('b')}  Burrow-Setup-arm64.exe\r\n`;
    expect(parseSums(text, 'Burrow-Setup-x64.exe')).toBe(sha('a'));
    expect(parseSums(text, 'Burrow-Setup-arm64.exe')).toBe(sha('b'));
  });

  it('is null for a missing file, a duplicate line, a short or non-hex hash, and a non-string', () => {
    expect(parseSums(`${sha('a')}  Other.exe\n`, 'Burrow-Setup-x64.exe')).toBeNull();
    expect(parseSums(`${sha('a')}  Burrow-Setup-x64.exe\n${sha('b')}  Burrow-Setup-x64.exe\n`, 'Burrow-Setup-x64.exe')).toBeNull();
    expect(parseSums(`${'a'.repeat(63)}  Burrow-Setup-x64.exe\n`, 'Burrow-Setup-x64.exe')).toBeNull();
    expect(parseSums(`${'g'.repeat(64)}  Burrow-Setup-x64.exe\n`, 'Burrow-Setup-x64.exe')).toBeNull();
    expect(parseSums(`${sha('a')}  sub/Burrow-Setup-x64.exe\n`, 'Burrow-Setup-x64.exe')).toBeNull();
    expect(parseSums(null, 'Burrow-Setup-x64.exe')).toBeNull();
  });
});

describe('fetchInstallerChecksum', () => {
  const sums = (extra = '') => `${'a'.repeat(64)}  Burrow-Setup-x64.exe\n${'b'.repeat(64)}  Burrow-Setup-arm64.exe\n${extra}`;
  const SUMS = 'https://github.com/ChristianMunoz31/burrow-releases/releases/download/v1.2.0/SHA256SUMS.txt';
  const text = (body) => respond(200, null, { raw: body });

  it('fetches only the pinned SHA256SUMS.txt and returns the sha for the arch', async () => {
    const fetchImpl = stub(text(sums()));
    expect(await fetchInstallerChecksum({ version: '1.2.0', arch: 'x64', fetchImpl })).toEqual({ ok: true, sha256: 'a'.repeat(64) });
    expect(fetchImpl.mock.calls[0][0]).toBe(SUMS);
    expect(fetchImpl.mock.calls[0][0]).toBe(sumsUrl('1.2.0'));
    expect(fetchImpl.mock.calls[0][1].size).toBe(4096);
    expect(fetchImpl.mock.calls[0][1].headers).toEqual({ Accept: 'text/plain', 'User-Agent': 'Burrow' });
    expect(await fetchInstallerChecksum({ version: '1.2.0', arch: 'arm64', fetchImpl: stub(text(sums())) })).toEqual({
      ok: true,
      sha256: 'b'.repeat(64),
    });
  });

  it('follows a redirect to the release-assets host and writes one audit row for github.com', async () => {
    networkCall.recordNetworkCall.mockClear();
    const fetchImpl = stub(
      redirectTo('https://release-assets.githubusercontent.com/x/SHA256SUMS.txt?sig=1'),
      text(sums()),
    );
    expect(await fetchInstallerChecksum({ version: '1.2.0', arch: 'x64', fetchImpl })).toMatchObject({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(networkCall.recordNetworkCall).toHaveBeenCalledTimes(1);
    expect(networkCall.recordNetworkCall).toHaveBeenCalledWith('updates', 'https://github.com', 'ok');
  });

  it('refuses a redirect to any other host, scheme or port', async () => {
    for (const to of ['https://evil.example/SHA256SUMS.txt', 'http://github.com/x', 'https://github.com:8443/x', 'https://user:pw'+'@github.com/x']) {
      const fetchImpl = stub(redirectTo(to));
      expect(await fetchInstallerChecksum({ version: '1.2.0', arch: 'x64', fetchImpl })).toEqual({ ok: false, reason: 'bad_response' });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  it('fails for a missing line, a duplicate line, an oversized body, 404, and a network error', async () => {
    const x64 = (fetchImpl) => fetchInstallerChecksum({ version: '1.2.0', arch: 'x64', fetchImpl });
    expect(await x64(stub(text(`${'b'.repeat(64)}  Burrow-Setup-arm64.exe\n`)))).toEqual({ ok: false, reason: 'bad_response' });
    expect(await x64(stub(text(sums(`${'c'.repeat(64)}  Burrow-Setup-x64.exe\n`))))).toEqual({ ok: false, reason: 'bad_response' });
    expect(await x64(stub(text('a'.repeat(4097))))).toEqual({ ok: false, reason: 'bad_response' });
    expect(await x64(stub(respond(404, {})))).toEqual({ ok: false, reason: 'not_found' });
    const down = vi.fn(async () => {
      throw new Error('x');
    });
    expect(await x64(down)).toEqual({ ok: false, reason: 'network' });
  });

  it('audits a refused redirect and an endless redirect chain as error, a followed one as ok', async () => {
    networkCall.recordNetworkCall.mockClear();
    const refused = stub(redirectTo('https://evil.example/SHA256SUMS.txt'));
    expect(await fetchInstallerChecksum({ version: '1.2.0', arch: 'x64', fetchImpl: refused })).toEqual({ ok: false, reason: 'bad_response' });
    expect(networkCall.recordNetworkCall).toHaveBeenLastCalledWith('updates', 'https://github.com', 'error');
    const endless = vi.fn(async () => redirectTo('https://github.com/again'));
    expect(await fetchInstallerChecksum({ version: '1.2.0', arch: 'x64', fetchImpl: endless })).toEqual({ ok: false, reason: 'bad_response' });
    expect(networkCall.recordNetworkCall).toHaveBeenLastCalledWith('updates', 'https://github.com', 'error');
    networkCall.recordNetworkCall.mockClear();
    await fetchInstallerChecksum({ version: '1.2.0', arch: 'x64', fetchImpl: stub(text(sums())) });
    expect(networkCall.recordNetworkCall).toHaveBeenLastCalledWith('updates', 'https://github.com', 'ok');
  });

  it('records error as the audit result on a network failure', async () => {
    networkCall.recordNetworkCall.mockClear();
    await fetchInstallerChecksum({
      version: '1.2.0',
      arch: 'x64',
      fetchImpl: vi.fn(async () => {
        throw new Error('x');
      }),
    });
    expect(networkCall.recordNetworkCall).toHaveBeenCalledWith('updates', 'https://github.com', 'error');
  });

  it.each([
    ['a bad arch', { version: '1.2.0', arch: 'ia32' }],
    ['a prerelease version', { version: '1.2.0-rc.1', arch: 'x64' }],
    ['a path-like version', { version: '../1.2.0', arch: 'x64' }],
    ['no version', { arch: 'x64' }],
  ])('makes no request and no audit row for %s', async (_label, args) => {
    networkCall.recordNetworkCall.mockClear();
    const fetchImpl = vi.fn();
    expect(await fetchInstallerChecksum({ ...args, fetchImpl })).toEqual({ ok: false, reason: 'bad_request' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(networkCall.recordNetworkCall).not.toHaveBeenCalled();
  });

  it('throws NetworkOptInError while updates is off, with no request', async () => {
    await setNetworkFeature('updates', false);
    const fetchImpl = vi.fn();
    await expect(fetchInstallerChecksum({ version: '1.2.0', arch: 'x64', fetchImpl })).rejects.toBeInstanceOf(NetworkOptInError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
