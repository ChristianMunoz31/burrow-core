// End to end through the real routes (settings check, install, manual) with supertest. Only the outside world is
// faked: node-fetch (GitHub), the license status, the backup, the shell handoff and the audit writer. The channel
// rules are driven by the same env vars the real capability checks read (BURROW_DESKTOP, BURROW_SHELL_UPDATER,
// BURROW_CHANNEL, BURROW_DISTRIBUTION) and process.platform/arch, so a wrong default in any route shows up here.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const h = vi.hoisted(() => ({ store: new Map(), routes: new Map() }));

vi.mock('../../loadEnv.js', () => ({}));
vi.mock('../networkCall.js', async (orig) => ({ ...(await orig()), recordNetworkCall: vi.fn(async () => {}) }));
vi.mock('node-fetch', () => ({
  default: vi.fn(async (url) => {
    const handler = h.routes.get(String(url));
    if (!handler) throw new Error(`unexpected request: ${url}`);
    return handler();
  }),
}));
vi.mock('../dataAccess.js', () => ({
  getState: vi.fn(async (key, fallback = null) => (h.store.has(key) ? h.store.get(key) : fallback)),
  setState: vi.fn(async (key, value) => {
    h.store.set(key, value);
    return { key, value };
  }),
}));

import fetch from 'node-fetch';
import * as networkCall from '../networkCall.js';
import { __resetNetPolicyForTests } from '../netPolicy.js';
import { APP_VERSION, __resetUpdateCacheForTests } from '../updateCheck.js';
import { registerSettingsRoutes } from '../settingsRoutes.js';
import {
  INSTALL_PATH,
  MANUAL_PATH,
  registerManualDownloadRoute,
  registerUpdateInstallRoute,
  releaseUpdateInstallLease,
} from '../updateInstallRoutes.js';
import { manifest, respond } from './helpers/updateManifest.js';

const CHECK_PATH = '/api/settings/updates/check';
const BASE = 'https://github.com/ChristianMunoz31/burrow-releases/releases';
const MANIFEST_URL = `${BASE}/latest/download/latest.json`;
const API_URL = 'https://api.github.com/repos/ChristianMunoz31/burrow-releases/releases/latest';
const NEW = '99.0.0';
const SUMS_URL = `${BASE}/download/v${NEW}/SHA256SUMS.txt`;
const SHA = 'cd'.repeat(32);
const PUBLISHED = '2030-01-01T00:00:00Z';

const release = (version = NEW, over = {}) => ({
  tag_name: `v${version}`,
  draft: false,
  prerelease: false,
  published_at: PUBLISHED,
  body: "## What's new\n- A plain line",
  assets: [{ name: 'Burrow-Setup-x64.exe' }, { name: 'Burrow-Setup-arm64.exe' }, { name: 'SHA256SUMS.txt' }],
  ...over,
});

/** Serves the manifest, the releases API and the checksum file; `over` replaces any of the three. */
function serve({ version = NEW, manifestPubDate = PUBLISHED, releaseBody = release(version), sums } = {}) {
  h.routes.set(MANIFEST_URL, () => respond(200, manifest(version, { pub_date: manifestPubDate })));
  h.routes.set(API_URL, () => respond(200, releaseBody));
  h.routes.set(
    `${BASE}/download/v${version}/SHA256SUMS.txt`,
    () => respond(200, null, { raw: sums ?? `${SHA}  Burrow-Setup-x64.exe\n${SHA.replace(/cd/g, 'ef')}  Burrow-Setup-arm64.exe\n` }),
  );
}

const ENV_KEYS = ['BURROW_DESKTOP', 'BURROW_SHELL_UPDATER', 'BURROW_CHANNEL', 'BURROW_DISTRIBUTION', 'BURROW_NETWORK_OPTIN'];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const savedPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
const savedArch = Object.getOwnPropertyDescriptor(process, 'arch');
const host = (platform, arch) => {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  Object.defineProperty(process, 'arch', { value: arch, configurable: true });
};

/** A build: env vars plus host platform. */
const BUILDS = {
  stableUpdater: { env: { BURROW_DESKTOP: '1', BURROW_SHELL_UPDATER: '1' }, host: ['win32', 'x64'] },
  stableNoUpdaterX64: { env: { BURROW_DESKTOP: '1' }, host: ['win32', 'x64'] },
  stableNoUpdaterArm64: { env: { BURROW_DESKTOP: '1' }, host: ['win32', 'arm64'] },
  store: { env: { BURROW_DESKTOP: '1', BURROW_DISTRIBUTION: 'store' }, host: ['win32', 'x64'] },
  dev: { env: { BURROW_DESKTOP: '1', BURROW_SHELL_UPDATER: '1', BURROW_CHANNEL: 'dev' }, host: ['win32', 'x64'] },
  web: { env: {}, host: ['win32', 'x64'] },
};
const useBuild = (name, { optIn = true } = {}) => {
  const { env, host: h2 } = BUILDS[name];
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, env);
  if (optIn) process.env.BURROW_NETWORK_OPTIN = 'updates';
  host(...h2);
  __resetNetPolicyForTests();
  __resetUpdateCacheForTests();
};

const license = {
  free: () => ({ proSource: null, license: null }),
  trial: () => ({ proSource: 'local_trial', license: null }),
  lapsedOrNone: () => ({ proSource: null, license: { updatesUntil: '2020-01-01T00:00:00Z' } }),
  inside: () => ({ proSource: 'license', license: { updatesUntil: '2031-01-01T00:00:00Z' } }),
  boundary: () => ({ proSource: 'license', license: { updatesUntil: PUBLISHED } }),
  outside: () => ({ proSource: 'license', license: { updatesUntil: '2029-12-31T23:59:59Z' } }),
  unknownDate: () => ({ proSource: 'license', license: { updatesUntil: 'soon' } }),
  missingDate: () => ({ proSource: 'license', license: {} }),
  throws: () => {
    throw new Error('not initialised');
  },
};

/** The three real routes on one app. Backup and handoff are fakes that count calls. */
function build({ licenseStatus = license.free } = {}) {
  const spies = {
    createBackup: vi.fn(async () => ({ created: true, meta: { id: 'manual-1' } })),
    requestShellUpdate: vi.fn(() => ({ nonce: 'n' })),
  };
  const app = express();
  app.use(express.json());
  const pass = (_req, _res, next) => next();
  registerSettingsRoutes(app, { licenseStatus });
  registerUpdateInstallRoute(app, { ...spies, licenseStatus, limiter: pass });
  registerManualDownloadRoute(app, { createBackup: spies.createBackup, licenseStatus, limiter: pass });
  return { app, ...spies };
}

const check = (app, q = '') => request(app).get(`${CHECK_PATH}${q}`);
const post = (app, path, body = { version: NEW }) =>
  request(app).post(path).set('Content-Type', 'application/json').send(JSON.stringify(body));
const audited = () => networkCall.recordNetworkCall.mock.calls.map((c) => c.slice(0, 3));
const fetched = () => fetch.mock.calls.map((c) => String(c[0]));

beforeEach(() => {
  h.store.clear();
  h.routes.clear();
  fetch.mockClear();
  networkCall.recordNetworkCall.mockClear();
  releaseUpdateInstallLease();
  serve();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  Object.defineProperty(process, 'platform', savedPlatform);
  Object.defineProperty(process, 'arch', savedArch);
  __resetNetPolicyForTests();
});

describe('GET check: the per-channel matrix', () => {
  it('stable direct with the shell updater: manifest source, canInstall, no manual download', async () => {
    useBuild('stableUpdater');
    const res = await check(build().app);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      status: 'available',
      latest: NEW,
      source: 'manifest',
      canInstall: true,
      canDownload: false,
      licenseImpact: 'free',
    });
    expect(fetched()).toEqual([MANIFEST_URL]);
    expect(audited()).toEqual([['updates', 'https://github.com', 'ok']]);
  });

  it.each([
    ['win32 x64', 'stableNoUpdaterX64'],
    ['win32 arm64', 'stableNoUpdaterArm64'],
  ])('stable direct without the updater on %s: release source, canDownload, not canInstall', async (_label, name) => {
    useBuild(name);
    const res = await check(build().app);
    expect(res.body.data).toMatchObject({ status: 'available', source: 'release', canInstall: false, canDownload: true });
    expect(res.body.data.url).toBe(`${BASE}/tag/v${NEW}`);
    expect(fetched()).toEqual([API_URL]);
    expect(audited()).toEqual([['updates', 'https://api.github.com', 'ok']]);
  });

  it.each([
    ['macOS', 'darwin', 'arm64'],
    ['Linux', 'linux', 'x64'],
    ['an unusable Windows architecture', 'win32', 'ia32'],
  ])('stable direct without the updater on %s: notice only', async (_label, platform, arch) => {
    useBuild('stableNoUpdaterX64');
    host(platform, arch);
    const res = await check(build().app);
    expect(res.body.data).toMatchObject({ status: 'available', source: 'release', canInstall: false, canDownload: false });
  });

  it('Store: store_managed with zero fetch and zero audit rows even with updates ON', async () => {
    useBuild('store');
    expect(process.env.BURROW_NETWORK_OPTIN).toBe('updates');
    const res = await check(build().app);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: { status: 'store_managed' } });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(fetch).not.toHaveBeenCalled();
    expect(audited()).toEqual([]);
  });

  it('Store answers the same with updates OFF (never a 403) and ignores ?refresh=1', async () => {
    useBuild('store', { optIn: false });
    const res = await check(build().app, '?refresh=1');
    expect(res.body).toEqual({ data: { status: 'store_managed' } });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('Dev: dev_managed with zero fetch and zero audit rows even with updates ON and the updater env var set', async () => {
    useBuild('dev');
    const res = await check(build().app);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: { status: 'dev_managed' } });
    expect(fetch).not.toHaveBeenCalled();
    expect(audited()).toEqual([]);
  });

  it('Dev answers dev_managed with updates OFF too', async () => {
    useBuild('dev', { optIn: false });
    expect((await check(build().app)).body).toEqual({ data: { status: 'dev_managed' } });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('web (not desktop): release source, neither canInstall nor canDownload', async () => {
    useBuild('web');
    const res = await check(build().app);
    expect(res.body.data).toMatchObject({ status: 'available', source: 'release', canInstall: false, canDownload: false });
    expect(fetched()).toEqual([API_URL]);
    expect(audited()).toEqual([['updates', 'https://api.github.com', 'ok']]);
  });
});

describe('opt-in off', () => {
  it.each(['stableUpdater', 'stableNoUpdaterX64', 'web'])('403 network_opt_in_required on check, install and manual in %s, with zero fetch and zero audit', async (name) => {
    useBuild(name, { optIn: false });
    const { app, createBackup, requestShellUpdate } = build();
    for (const res of [await check(app), await post(app, INSTALL_PATH), await post(app, MANUAL_PATH)]) {
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ error: 'network_opt_in_required', feature: 'updates' });
    }
    expect(fetch).not.toHaveBeenCalled();
    expect(audited()).toEqual([]);
    expect(createBackup).not.toHaveBeenCalled();
    expect(requestShellUpdate).not.toHaveBeenCalled();
  });
});

describe('manual route: refused where it does not apply', () => {
  it.each([
    ['Store', 'store'],
    ['Burrow Dev', 'dev'],
    ['web', 'web'],
    ['stable with the shell updater on', 'stableUpdater'],
  ])('409 update_manual_unsupported in %s with no fetch, no backup and no audit', async (_label, name) => {
    useBuild(name);
    const { app, createBackup } = build();
    const res = await post(app, MANUAL_PATH);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: 'update_manual_unsupported', code: 'update_manual_unsupported' });
    expect(fetch).not.toHaveBeenCalled();
    expect(createBackup).not.toHaveBeenCalled();
    expect(audited()).toEqual([]);
  });

  it('409 update_manual_unsupported on a platform with no installer', async () => {
    useBuild('stableNoUpdaterX64');
    host('linux', 'x64');
    const { app } = build();
    expect((await post(app, MANUAL_PATH)).body.code).toBe('update_manual_unsupported');
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('install route: refused where it does not apply', () => {
  it.each([
    ['Store', 'store'],
    ['Burrow Dev', 'dev'],
    ['web', 'web'],
    ['stable without the shell updater', 'stableNoUpdaterX64'],
  ])('409 update_install_unsupported in %s with no fetch, no backup and no handoff', async (_label, name) => {
    useBuild(name);
    const { app, createBackup, requestShellUpdate } = build();
    const res = await post(app, INSTALL_PATH);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('update_install_unsupported');
    expect(fetch).not.toHaveBeenCalled();
    expect(createBackup).not.toHaveBeenCalled();
    expect(requestShellUpdate).not.toHaveBeenCalled();
  });
});

describe('happy paths through the real check', () => {
  it('install: manifest check, backup, handoff, then the started row; two audit rows in order', async () => {
    useBuild('stableUpdater');
    const { app, createBackup, requestShellUpdate } = build();
    const res = await post(app, INSTALL_PATH);
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ data: { status: 'handed_off', version: NEW, backupId: 'manual-1' } });
    expect(fetched()).toEqual([MANIFEST_URL]);
    expect(createBackup).toHaveBeenCalledTimes(1);
    expect(requestShellUpdate).toHaveBeenCalledWith(NEW);
    expect(networkCall.recordNetworkCall.mock.calls).toEqual([
      ['updates', 'https://github.com', 'ok'],
      ['updates', 'https://github.com', 'ok', { result: 'started', by: 'app' }],
    ]);
  });

  it('manual: release check (api.github.com row), checksum (github.com row), backup, pinned answer', async () => {
    useBuild('stableNoUpdaterX64');
    const { app, createBackup } = build();
    const res = await post(app, MANUAL_PATH);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      status: 'ready',
      version: NEW,
      arch: 'x64',
      fileName: 'Burrow-Setup-x64.exe',
      installerUrl: `${BASE}/download/v${NEW}/Burrow-Setup-x64.exe`,
      sha256: SHA,
      sumsUrl: SUMS_URL,
      backupId: 'manual-1',
    });
    expect(fetched()).toEqual([API_URL, SUMS_URL]);
    expect(audited()).toEqual([
      ['updates', 'https://api.github.com', 'ok'],
      ['updates', 'https://github.com', 'ok'],
    ]);
    expect(createBackup).toHaveBeenCalledTimes(1);
  });

  it('manual on arm64 returns the arm64 hash and file name', async () => {
    useBuild('stableNoUpdaterArm64');
    const res = await post(build().app, MANUAL_PATH);
    expect(res.body.data).toMatchObject({ arch: 'arm64', fileName: 'Burrow-Setup-arm64.exe', sha256: 'ef'.repeat(32) });
  });
});

describe('audit rows record failures as error', () => {
  it('a 404 on latest.json is one error row for github.com and a 200 unavailable', async () => {
    useBuild('stableUpdater');
    h.routes.set(MANIFEST_URL, () => respond(404, {}));
    const res = await check(build().app);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'unavailable', reason: 'not_found' });
    expect(audited()).toEqual([['updates', 'https://github.com', 'error']]);
  });

  it('a 403 rate limit from api.github.com is one error row for api.github.com', async () => {
    useBuild('web');
    h.routes.set(API_URL, () => respond(403, {}));
    const res = await check(build().app);
    expect(res.body.data).toMatchObject({ status: 'unavailable', reason: 'rate_limited' });
    expect(audited()).toEqual([['updates', 'https://api.github.com', 'error']]);
  });

  it('a cached answer writes no second row (one row per fetch)', async () => {
    useBuild('web');
    const { app } = build();
    await check(app);
    await check(app);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(audited()).toHaveLength(1);
  });

  it('manual: a missing checksum file is a 503 with an error row for github.com and no backup', async () => {
    useBuild('stableNoUpdaterX64');
    h.routes.set(SUMS_URL, () => respond(404, {}));
    const { app, createBackup } = build();
    const res = await post(app, MANUAL_PATH);
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('update_checksum_unavailable');
    expect(createBackup).not.toHaveBeenCalled();
    expect(audited()).toEqual([
      ['updates', 'https://api.github.com', 'ok'],
      ['updates', 'https://github.com', 'error'],
    ]);
  });

  it('install: an unreachable manifest is a 503 with an error row, no backup and no started row', async () => {
    useBuild('stableUpdater');
    h.routes.set(MANIFEST_URL, () => {
      throw new Error('ECONNRESET');
    });
    const { app, createBackup, requestShellUpdate } = build();
    const res = await post(app, INSTALL_PATH);
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('update_check_unavailable');
    expect(createBackup).not.toHaveBeenCalled();
    expect(requestShellUpdate).not.toHaveBeenCalled();
    expect(audited()).toEqual([['updates', 'https://github.com', 'error']]);
  });
});

describe('license gate matrix through the real check and both routes', () => {
  const allowed = ['free', 'trial', 'lapsedOrNone', 'inside', 'boundary'];
  const blocked = ['outside', 'unknownDate', 'missingDate', 'throws'];

  describe.each([
    ['install', 'stableUpdater', INSTALL_PATH, 202],
    ['manual', 'stableNoUpdaterX64', MANUAL_PATH, 200],
  ])('%s', (_name, buildName, path, okStatus) => {
    it.each(allowed)('allows %s', async (kind) => {
      useBuild(buildName);
      const { app, createBackup } = build({ licenseStatus: license[kind] });
      const res = await post(app, path);
      expect(res.status).toBe(okStatus);
      expect(createBackup).toHaveBeenCalledTimes(1);
    });

    it.each(blocked)('blocks %s with 409 update_license_window, no backup, no handoff, no started row', async (kind) => {
      useBuild(buildName);
      const { app, createBackup, requestShellUpdate } = build({ licenseStatus: license[kind] });
      const res = await post(app, path);
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ error: 'update_license_window', code: 'update_license_window' });
      expect(createBackup).not.toHaveBeenCalled();
      expect(requestShellUpdate).not.toHaveBeenCalled();
      expect(networkCall.recordNetworkCall.mock.calls.some((c) => c[3]?.result === 'started')).toBe(false);
      // Only the check itself may have touched the network: the manual route must not even fetch the checksum.
      expect(fetched().every((u) => u === MANIFEST_URL || u === API_URL)).toBe(true);
    });

    it('offers nothing (503, no backup) when the release date is unreadable', async () => {
      useBuild(buildName);
      h.routes.set(MANIFEST_URL, () => respond(200, manifest(NEW, { pub_date: 'not a date' })));
      h.routes.set(API_URL, () => respond(200, release(NEW, { published_at: 'not a date' })));
      const { app, createBackup } = build({ licenseStatus: license.inside });
      const res = await post(app, path);
      expect(res.status).toBe(503);
      expect(createBackup).not.toHaveBeenCalled();
    });
  });

  it('GET check reports the same impact the routes enforce (blocked, included, free, unknown)', async () => {
    useBuild('stableUpdater');
    const impacts = {};
    for (const kind of ['free', 'inside', 'outside', 'throws']) {
      __resetUpdateCacheForTests();
      impacts[kind] = (await check(build({ licenseStatus: license[kind] }).app)).body.data.licenseImpact;
    }
    expect(impacts).toEqual({ free: 'free', inside: 'included', outside: 'blocked', throws: 'unknown' });
  });

  it('manual blocks on a license whose window ended one second before the release', async () => {
    useBuild('stableNoUpdaterX64');
    const { app } = build({ licenseStatus: () => ({ proSource: 'license', license: { updatesUntil: '2029-12-31T23:59:59Z' } }) });
    expect((await post(app, MANUAL_PATH)).status).toBe(409);
  });
});

describe('no downgrade, prerelease and draft', () => {
  const OLD = '0.0.1';

  it.each([
    ['equal', APP_VERSION],
    ['older', OLD],
  ])('GET check with a %s release is current, never available', async (_label, version) => {
    useBuild('web');
    serve({ version, releaseBody: release(version) });
    const res = await check(build().app);
    expect(res.body.data.status).toBe('current');
    expect(res.body.data).not.toHaveProperty('canInstall');
    expect(res.body.data).not.toHaveProperty('canDownload');
  });

  it.each([
    ['equal', APP_VERSION],
    ['older', OLD],
  ])('install refuses a %s manifest version with update_not_available, no backup', async (_label, version) => {
    useBuild('stableUpdater');
    serve({ version });
    const { app, createBackup, requestShellUpdate } = build();
    const res = await post(app, INSTALL_PATH, { version });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('update_not_available');
    expect(createBackup).not.toHaveBeenCalled();
    expect(requestShellUpdate).not.toHaveBeenCalled();
  });

  it.each([
    ['equal', APP_VERSION],
    ['older', OLD],
  ])('manual refuses a %s release with update_not_available and fetches no checksum', async (_label, version) => {
    useBuild('stableNoUpdaterX64');
    serve({ version, releaseBody: release(version) });
    const { app, createBackup } = build();
    const res = await post(app, MANUAL_PATH, { version });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('update_not_available');
    expect(fetched()).toEqual([API_URL]);
    expect(createBackup).not.toHaveBeenCalled();
  });

  it('install and manual refuse a version that is not the newest one', async () => {
    useBuild('stableUpdater');
    const a = build();
    expect((await post(a.app, INSTALL_PATH, { version: '98.0.0' })).body.code).toBe('update_not_available');
    useBuild('stableNoUpdaterX64');
    const b = build();
    expect((await post(b.app, MANUAL_PATH, { version: '98.0.0' })).body.code).toBe('update_not_available');
    expect(a.createBackup).not.toHaveBeenCalled();
    expect(b.createBackup).not.toHaveBeenCalled();
  });

  it.each([
    ['a prerelease', { prerelease: true }],
    ['a draft', { draft: true }],
    ['a non-stable tag', { tag_name: `v${NEW}-beta.1` }],
    ['a release missing SHA256SUMS.txt', { assets: [{ name: 'Burrow-Setup-x64.exe' }, { name: 'Burrow-Setup-arm64.exe' }] }],
  ])('%s is never offered: check is unavailable, manual is 503 with no backup', async (_label, over) => {
    useBuild('stableNoUpdaterX64');
    h.routes.set(API_URL, () => respond(200, release(NEW, over)));
    const { app, createBackup } = build();
    const res = await check(app);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('unavailable');
    __resetUpdateCacheForTests();
    const manual = await post(app, MANUAL_PATH);
    expect(manual.status).toBe(503);
    expect(manual.body.code).toBe('update_check_unavailable');
    expect(createBackup).not.toHaveBeenCalled();
    expect(fetched().includes(SUMS_URL)).toBe(false);
  });
});
