// /api/profile and /api/settings/network contracts, plus profile storage behavior.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const h = vi.hoisted(() => ({ store: new Map(), down: false, invalid: false }));

vi.mock('../../loadEnv.js', () => ({}));
vi.mock('node-fetch', () => ({
  default: vi.fn(async (url) => ({
    ok: true,
    status: 200,
    headers: new Map(),
    text: async () =>
      String(url).startsWith('https://api.github.com/')
        ? JSON.stringify({
            tag_name: 'v99.0.0',
            draft: false,
            prerelease: false,
            published_at: '2030-01-01T00:00:00Z',
            body: "## What's new\n### New\n- A plain line",
            assets: [{ name: 'Burrow-Setup-x64.exe' }, { name: 'Burrow-Setup-arm64.exe' }, { name: 'SHA256SUMS.txt' }],
          })
        : JSON.stringify({
        version: '99.0.0',
        notes: 'New:\n- A plain line',
        pub_date: '2030-01-01T00:00:00Z',
        platforms: {
          'windows-x86_64': {
            signature: 'c2ln',
            url: 'https://github.com/ChristianMunoz31/burrow-releases/releases/download/v99.0.0/Burrow-Setup-x64.exe',
          },
          'windows-aarch64': {
            signature: 'c2ln',
            url: 'https://github.com/ChristianMunoz31/burrow-releases/releases/download/v99.0.0/Burrow-Setup-arm64.exe',
          },
        },
      }),
  })),
}));
vi.mock('../dataAccess.js', async () => {
  const { DbError } = await import('../db/index.js');
  const fail = () => {
    if (h.invalid) throw new DbError('invalid_value', 'x');
    if (h.down) throw Object.assign(new Error('Local database is unavailable.'), { status: 503 });
  };
  return {
    getState: vi.fn(async (key, fallback = null) => {
      fail();
      return h.store.has(key) ? h.store.get(key) : fallback;
    }),
    setState: vi.fn(async (key, value) => {
      fail();
      h.store.set(key, value);
      return { key, value };
    }),
  };
});

import fetch from 'node-fetch';
import { registerSettingsRoutes } from '../settingsRoutes.js';
import { __resetNetPolicyForTests, networkRequiredBody } from '../netPolicy.js';
import { __resetUpdateCacheForTests } from '../updateCheck.js';
import { isShellUpdaterAvailable } from '../desktop/shellChannel.js';
import { __resetProfileCacheForTests, getDisplayName, sanitizeDisplayName } from '../profile.js';

const app = (deps) => {
  const a = express();
  a.use(express.json());
  registerSettingsRoutes(a, deps);
  return a;
};

beforeEach(() => {
  h.store.clear();
  h.down = false;
  h.invalid = false;
  delete process.env.BURROW_NETWORK_OPTIN;
  __resetNetPolicyForTests();
  __resetProfileCacheForTests();
});

describe('GET /api/profile', () => {
  it('returns nulls for a fresh install', async () => {
    const res = await request(app()).get('/api/profile');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ displayName: null, onboardedAt: null });
    expect(res.headers['cache-control']).toBe('no-store');
  });
});

describe('PUT /api/profile', () => {
  it('sets a trimmed display name and stores it under app_state key profile', async () => {
    const res = await request(app()).put('/api/profile').send({ displayName: '  Sam  ' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ displayName: 'Sam', onboardedAt: null });
    expect(h.store.get('profile')).toEqual({ displayName: 'Sam', onboardedAt: null });
    expect((await request(app()).get('/api/profile')).body.displayName).toBe('Sam');
  });

  it('strips control characters and caps at 60 characters', async () => {
    const res = await request(app()).put('/api/profile').send({ displayName: `\u0000Sa\u0007m\n${'x'.repeat(100)}` });
    expect(res.body.displayName.startsWith('Sam')).toBe(true);
    expect(res.body.displayName).toHaveLength(60);
    expect([...res.body.displayName].every((c) => c.charCodeAt(0) > 31)).toBe(true);
  });

  it('turns an empty or blank name, and null, into null', async () => {
    await request(app()).put('/api/profile').send({ displayName: 'Sam' });
    for (const displayName of ['', '   ', '\u0001\u0002', null]) {
      const res = await request(app()).put('/api/profile').send({ displayName });
      expect(res.body.displayName).toBeNull();
    }
  });

  it('onboarded:true sets onboardedAt once and keeps the display name', async () => {
    await request(app()).put('/api/profile').send({ displayName: 'Sam' });
    const first = await request(app()).put('/api/profile').send({ onboarded: true });
    expect(first.status).toBe(200);
    expect(first.body.displayName).toBe('Sam');
    expect(Number.isNaN(Date.parse(first.body.onboardedAt))).toBe(false);
    const second = await request(app()).put('/api/profile').send({ onboarded: true });
    expect(second.body.onboardedAt).toBe(first.body.onboardedAt);
  });

  it.each([
    [{ displayName: 5 }],
    [{ displayName: ['a'] }],
    [{ displayName: {} }],
    [{ onboarded: false }],
    [{ onboarded: 'true' }],
    [[]],
  ])('400s on bad input %j', async (body) => {
    const res = await request(app()).put('/api/profile').send(body);
    expect(res.status).toBe(400);
    expect(h.store.has('profile')).toBe(false);
  });

  it('accepts an empty object and changes nothing', async () => {
    const res = await request(app()).put('/api/profile').send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ displayName: null, onboardedAt: null });
  });
});

describe('profile with storage unavailable', () => {
  it('503s with the storage-unavailable shape on GET and PUT', async () => {
    h.down = true;
    for (const res of [
      await request(app()).get('/api/profile'),
      await request(app()).put('/api/profile').send({ displayName: 'Sam' }),
    ]) {
      expect(res.status).toBe(503);
      expect(res.body).toEqual({ error: 'Local database is unavailable.' });
    }
  });

  it('maps an invalid-input data error to 400', async () => {
    h.invalid = true;
    const res = await request(app()).get('/api/profile');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid input' });
  });

  it('getDisplayName resolves to null instead of throwing', async () => {
    h.down = true;
    await expect(getDisplayName()).resolves.toBeNull();
  });
});

describe('getDisplayName / sanitizeDisplayName', () => {
  it('reads the stored name and caches it', async () => {
    h.store.set('profile', { displayName: 'Robin', onboardedAt: null });
    expect(await getDisplayName()).toBe('Robin');
    h.store.set('profile', { displayName: 'Changed', onboardedAt: null });
    expect(await getDisplayName()).toBe('Robin');
    __resetProfileCacheForTests();
    expect(await getDisplayName()).toBe('Changed');
  });

  it('sanitizes non-strings to null', () => {
    expect(sanitizeDisplayName(undefined)).toBeNull();
    expect(sanitizeDisplayName(12)).toBeNull();
    expect(sanitizeDisplayName(' ok ')).toBe('ok');
  });
});

describe('GET /api/settings/network', () => {
  it('lists the seven features, all off, in fixed order', async () => {
    const res = await request(app()).get('/api/settings/network');
    expect(res.status).toBe(200);
    expect(res.body.features.map((f) => f.id)).toEqual(['weather', 'oura', 'sheets', 'cloudAi', 'aiLan', 'updates', 'license']);
    expect(res.body.features.every((f) => f.enabled === false)).toBe(true);
    expect(res.body.features[0]).toMatchObject({ id: 'weather', label: 'Weather', hosts: ['api.open-meteo.com'] });
  });

  it('reflects BURROW_NETWORK_OPTIN pre-enables', async () => {
    process.env.BURROW_NETWORK_OPTIN = 'sheets';
    const res = await request(app()).get('/api/settings/network');
    expect(res.body.features.find((f) => f.id === 'sheets').enabled).toBe(true);
  });

  it('still answers (env only) when storage is down', async () => {
    h.down = true;
    const res = await request(app()).get('/api/settings/network');
    expect(res.status).toBe(200);
  });
});

describe('GET /api/settings/updates/check', () => {
  beforeEach(() => {
    __resetUpdateCacheForTests();
    fetch.mockClear();
  });

  it('403s with the opt-in contract while off and makes no request', async () => {
    const res = await request(app()).get('/api/settings/updates/check');
    expect(res.status).toBe(403);
    expect(res.body).toEqual(networkRequiredBody('updates'));
    expect(res.body.feature).toBe('updates');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('answers 200 { data } once enabled, with the status from GitHub', async () => {
    process.env.BURROW_NETWORK_OPTIN = 'updates';
    const res = await request(app({ licenseStatus: () => ({ proSource: null }), installSupported: () => false })).get(
      '/api/settings/updates/check',
    );
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.data).toMatchObject({
      status: 'available',
      latest: '99.0.0',
      url: 'https://github.com/ChristianMunoz31/burrow-releases/releases/tag/v99.0.0',
      notes: 'New:\n- A plain line',
      source: 'release',
      canInstall: false,
      canDownload: false,
      licenseImpact: 'free',
      updatesUntil: null,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe('https://api.github.com/repos/ChristianMunoz31/burrow-releases/releases/latest');
  });

  it('reads latest.json when this copy can install updates, and the releases API otherwise', async () => {
    process.env.BURROW_NETWORK_OPTIN = 'updates';
    const licenseStatus = () => ({ proSource: null });
    const manifestRes = await request(app({ licenseStatus, installSupported: () => true })).get('/api/settings/updates/check');
    expect(manifestRes.body.data).toMatchObject({ status: 'available', source: 'manifest', canInstall: true });
    expect(fetch.mock.calls[0][0]).toBe('https://github.com/ChristianMunoz31/burrow-releases/releases/latest/download/latest.json');
    __resetUpdateCacheForTests();
    fetch.mockClear();
    const releaseRes = await request(app({ licenseStatus, installSupported: () => false })).get('/api/settings/updates/check');
    expect(releaseRes.body.data).toMatchObject({ status: 'available', source: 'release', canInstall: false });
    expect(fetch.mock.calls[0][0]).toContain('https://api.github.com/');
  });

  it('answers dev_managed without the opt-in and without any request in Burrow Dev', async () => {
    const res = await request(app({ devBuild: () => true })).get('/api/settings/updates/check');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: { status: 'dev_managed' } });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('the Store answer wins over Dev and neither needs the opt-in', async () => {
    const res = await request(app({ storeBuild: () => true, devBuild: () => true })).get('/api/settings/updates/check');
    expect(res.body).toEqual({ data: { status: 'store_managed' } });
  });

  it('answers store_managed without the opt-in and without any request in the Microsoft Store build', async () => {
    const res = await request(app({ storeBuild: () => true })).get('/api/settings/updates/check');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: { status: 'store_managed' } });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(fetch).not.toHaveBeenCalled();
  });

  describe('canInstall, canDownload and licenseImpact', () => {
    const saved = { d: process.env.BURROW_DESKTOP, u: process.env.BURROW_SHELL_UPDATER, c: process.env.BURROW_CHANNEL };
    const license = (over = {}) => ({ proSource: 'license', license: { updatesUntil: '2029-01-01T00:00:00Z' }, ...over });
    const data = async (deps) => (await request(app(deps)).get('/api/settings/updates/check')).body.data;
    beforeEach(() => {
      process.env.BURROW_NETWORK_OPTIN = 'updates';
      delete process.env.BURROW_DESKTOP;
      delete process.env.BURROW_SHELL_UPDATER;
      delete process.env.BURROW_CHANNEL;
    });
    afterAll(() => {
      for (const [k, v] of [['BURROW_DESKTOP', saved.d], ['BURROW_SHELL_UPDATER', saved.u], ['BURROW_CHANNEL', saved.c]]) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });

    it('canInstall is true only in the desktop app with the shell updater env var on the stable channel', async () => {
      const licenseStatus = () => license();
      expect((await data({ licenseStatus })).canInstall).toBe(false);
      process.env.BURROW_DESKTOP = '1';
      __resetUpdateCacheForTests();
      expect((await data({ licenseStatus })).canInstall).toBe(false);
      process.env.BURROW_SHELL_UPDATER = '1';
      __resetUpdateCacheForTests();
      expect((await data({ licenseStatus })).canInstall).toBe(true);
      process.env.BURROW_SHELL_UPDATER = 'true';
      __resetUpdateCacheForTests();
      expect((await data({ licenseStatus })).canInstall).toBe(false);
      process.env.BURROW_SHELL_UPDATER = '1';
      delete process.env.BURROW_DESKTOP;
      __resetUpdateCacheForTests();
      expect((await data({ licenseStatus })).canInstall).toBe(false);
    });

    it('canInstall is false on the dev channel even with the env var', async () => {
      process.env.BURROW_DESKTOP = '1';
      process.env.BURROW_SHELL_UPDATER = '1';
      process.env.BURROW_CHANNEL = 'dev';
      expect(isShellUpdaterAvailable()).toBe(false);
    });

    it('canDownload follows the manual-download capability and is false by default outside the desktop app', async () => {
      const licenseStatus = () => license({ proSource: null });
      expect((await data({ licenseStatus })).canDownload).toBe(false);
      expect((await data({ licenseStatus, manualSupported: () => true })).canDownload).toBe(true);
      expect((await data({ licenseStatus, manualSupported: () => false })).canDownload).toBe(false);
    });

    it('licenseImpact is blocked for a paid license whose updates stop before the release', async () => {
      const d = await data({ licenseStatus: () => license() });
      expect(d).toMatchObject({ licenseImpact: 'blocked', updatesUntil: '2029-01-01T00:00:00Z' });
    });

    it('licenseImpact is included when the license covers the release, free for the trial and no license', async () => {
      const cases = [
        [() => license({ license: { updatesUntil: '2031-01-01T00:00:00Z' } }), 'included'],
        [() => license({ proSource: 'local_trial' }), 'free'],
        [() => ({ proSource: null, license: null }), 'free'],
      ];
      for (const [licenseStatus, impact] of cases) {
        __resetUpdateCacheForTests();
        expect(await data({ licenseStatus })).toMatchObject({ status: 'available', licenseImpact: impact });
      }
    });

    it('licenseImpact is unknown when the license state cannot be read', async () => {
      const d = await data({
        licenseStatus: () => {
          throw new Error('not initialised');
        },
      });
      expect(d).toMatchObject({ status: 'available', licenseImpact: 'unknown', updatesUntil: null });
    });

    it('is computed per request: a license change shows up without clearing the update cache', async () => {
      let status = license({ proSource: null });
      const deps = { licenseStatus: () => status };
      expect((await data(deps)).licenseImpact).toBe('free');
      status = license();
      expect((await data(deps)).licenseImpact).toBe('blocked');
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('adds nothing to current and unavailable results', async () => {
      fetch.mockResolvedValueOnce({ ok: false, status: 404, headers: new Map(), text: async () => '{}' });
      const d = await data({ licenseStatus: () => license() });
      expect(d).toMatchObject({ status: 'unavailable' });
      expect(d).not.toHaveProperty('canInstall');
      expect(d).not.toHaveProperty('canDownload');
      expect(d).not.toHaveProperty('licenseImpact');
    });
  });

  it('refresh=1 is ignored when the last upstream fetch was under 60 s ago', async () => {
    process.env.BURROW_NETWORK_OPTIN = 'updates';
    await request(app()).get('/api/settings/updates/check');
    await request(app()).get('/api/settings/updates/check');
    expect(fetch).toHaveBeenCalledTimes(1);
    const res = await request(app()).get('/api/settings/updates/check?refresh=1');
    expect(res.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('turns a 404 (private repo) into a 200 unavailable, not a 5xx', async () => {
    process.env.BURROW_NETWORK_OPTIN = 'updates';
    fetch.mockResolvedValueOnce({ ok: false, status: 404, headers: new Map(), text: async () => '{}' });
    const res = await request(app()).get('/api/settings/updates/check');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'unavailable', reason: 'not_found' });
  });
});

describe('PUT /api/settings/network', () => {
  it('enables and disables a feature and returns the same shape as GET', async () => {
    const on = await request(app()).put('/api/settings/network').send({ id: 'oura', enabled: true });
    expect(on.status).toBe(200);
    expect(on.body.features.find((f) => f.id === 'oura').enabled).toBe(true);
    const get = await request(app()).get('/api/settings/network');
    expect(get.body).toEqual(on.body);
    const off = await request(app()).put('/api/settings/network').send({ id: 'oura', enabled: false });
    expect(off.body.features.find((f) => f.id === 'oura').enabled).toBe(false);
  });

  it.each([
    [{ id: 'nope', enabled: true }],
    [{ id: 'weather', enabled: 'true' }],
    [{ id: 'weather', enabled: 1 }],
    [{ id: 'weather' }],
    [{ enabled: true }],
    [{ id: 5, enabled: true }],
    [[]],
  ])('400s on %j', async (body) => {
    const res = await request(app()).put('/api/settings/network').send(body);
    expect(res.status).toBe(400);
    expect(h.store.has('network.optIn')).toBe(false);
  });

  it('503s when storage is unavailable', async () => {
    h.down = true;
    const res = await request(app()).put('/api/settings/network').send({ id: 'weather', enabled: true });
    expect(res.status).toBe(503);
  });
});
