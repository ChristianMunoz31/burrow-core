// ci:always-run
// The dev extension seam (server/devExtensions.js): nothing turns the developer tools on unless an importer hands
// back a valid, available extension; install happens once; a plain server.js import has no developer routes and
// reports devTools false. Tests inject `importer`; they never rely on the devtools/ tree being present or absent.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../../loadEnv.js', () => ({}));
vi.mock('node-fetch', () => ({ default: vi.fn() }));

import { isExtensionNotFound } from '../devExtensionsLoader.js';
import { devExtensionRouter, devToolsActive, loadDevExtensions, resetDevExtensionsForTests } from '../devExtensions.js';

const ENV_KEYS = ['APP_PASSWORD', 'AUTH_SECRET', 'SECRETS_ENCRYPTION_KEY', 'BURROW_AI'];
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

afterEach(() => {
  resetDevExtensionsForTests();
  vi.unstubAllGlobals();
});

afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/** An express app with the same two pieces server.js has around the seam: the extension router and the /api 404. */
function seamApp() {
  const app = express();
  app.use(express.json());
  app.use(devExtensionRouter());
  app.use('/api', (_req, res) => res.status(404).json({ error: 'not_found' }));
  return app;
}

function fakeExtension({ available = true } = {}) {
  const install = vi.fn((router) => {
    router.get('/api/dev/ping', (_req, res) => res.json({ ok: true }));
  });
  return { name: 'fake', available: vi.fn(() => available), install };
}

// The core policy mirrors devtools/server/policy.js; these seams say "unbundled source checkout" unless a test overrides them.
const load = (importer, extra = {}) =>
  loadDevExtensions({ env: {}, log: () => {}, importer, release: false, checkout: true, ...extra });

describe('loadDevExtensions refuses', () => {
  it('a missing extension (the importer finds nothing)', async () => {
    expect(await load(async () => null)).toBe(false);
    expect(devToolsActive()).toBe(false);
    const res = await request(seamApp()).get('/api/dev/status');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'not_found' });
  });

  it('an extension that says it is not available, without installing it', async () => {
    const ext = fakeExtension({ available: false });
    expect(await load(async () => ext)).toBe(false);
    expect(ext.install).not.toHaveBeenCalled();
    expect(devToolsActive()).toBe(false);
    expect((await request(seamApp()).get('/api/dev/ping')).status).toBe(404);
  });

  it('an availability answer that is not exactly true', async () => {
    const ext = { name: 'fake', available: () => 'yes', install: vi.fn() };
    expect(await load(async () => ext)).toBe(false);
    expect(ext.install).not.toHaveBeenCalled();
  });

  it.each([
    ['no install', { available: () => true }],
    ['no available', { install: () => {} }],
    ['not an object', 'extension'],
    ['an empty object', {}],
  ])('an invalid shape (%s)', async (_name, shape) => {
    expect(await load(async () => shape)).toBe(false);
    expect(devToolsActive()).toBe(false);
  });

  it('an importer that throws, with one log line and no crash', async () => {
    const log = vi.fn();
    expect(await load(async () => { throw new Error('boom'); }, { log })).toBe(false);
    expect(log).toHaveBeenCalledTimes(1);
    expect(devToolsActive()).toBe(false);
  });

  it('everything when the developer tools are compiled out, without even calling the importer', async () => {
    vi.stubGlobal('__BURROW_DEV_TOOLS__', false);
    const importer = vi.fn(async () => fakeExtension());
    expect(await load(importer)).toBe(false);
    expect(importer).not.toHaveBeenCalled();
    expect(devToolsActive()).toBe(false);
  });
});

describe('loadDevExtensions core policy', () => {
  it.each([
    ['not a source checkout (zip, Docker)', { release: false, checkout: false }],
    ['a release build on the stable channel', { release: true, devChannel: false, checkout: true }],
  ])('does not even import the extension for %s', async (_name, seams) => {
    const ext = fakeExtension();
    const importer = vi.fn(async () => ext);
    expect(await load(importer, seams)).toBe(false);
    expect(importer).not.toHaveBeenCalled();
    expect(ext.install).not.toHaveBeenCalled();
    expect(devToolsActive()).toBe(false);
    expect((await request(seamApp()).get('/api/dev/ping')).status).toBe(404);
  });

  it('installs in a release build on the Dev channel, even without a checkout', async () => {
    const ext = fakeExtension();
    expect(await load(async () => ext, { release: true, devChannel: true, checkout: false })).toBe(true);
    expect(devToolsActive()).toBe(true);
  });
});

describe('loadDevExtensions failures', () => {
  it('logs only the error code when loading fails', async () => {
    const log = vi.fn();
    const err = Object.assign(new Error('D:\\work\\secret'), { code: 'ERR_X' });
    expect(await load(async () => { throw err; }, { log })).toBe(false);
    expect(log).toHaveBeenCalledWith('dev extensions: failed to load (ERR_X)');
  });

  it('survives available() throwing', async () => {
    const log = vi.fn();
    const ext = { name: 'fake', available: () => { throw new Error('nope'); }, install: vi.fn() };
    expect(await load(async () => ext, { log })).toBe(false);
    expect(ext.install).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
    expect(devToolsActive()).toBe(false);
  });

  it('rolls back when install() throws: router emptied, not active', async () => {
    const ext = {
      name: 'fake',
      available: () => true,
      install: vi.fn((router) => {
        router.get('/api/dev/half', (_req, res) => res.json({ ok: true }));
        throw new Error('half installed');
      }),
    };
    expect(await load(async () => ext)).toBe(false);
    expect(devExtensionRouter().stack).toHaveLength(0);
    expect(devToolsActive()).toBe(false);
    expect((await request(seamApp()).get('/api/dev/half')).status).toBe(404);
  });
});

describe('isExtensionNotFound', () => {
  it.each([
    ['posix url', { code: 'ERR_MODULE_NOT_FOUND', url: 'file:///repo/devtools/server/index.js' }],
    ['windows message', { code: 'ERR_MODULE_NOT_FOUND', message: "Cannot find module 'C:\\repo\\devtools\\server\\index.js' imported from C:\\repo\\server\\devExtensionsLoader.js" }],
  ])('recognizes a missing extension (%s)', (_n, err) => {
    expect(isExtensionNotFound(err)).toBe(true);
  });

  it('rejects other errors and other missing modules', () => {
    expect(isExtensionNotFound({ code: 'ERR_MODULE_NOT_FOUND', message: "Cannot find package 'x' imported from C:\\repo\\devtools\\server\\other.js" })).toBe(false);
    expect(isExtensionNotFound({ code: 'EACCES', message: 'devtools/server/index.js' })).toBe(false);
    expect(isExtensionNotFound(null)).toBe(false);
  });
});

describe('loadDevExtensions installs', () => {
  it('an available extension once, into the shared router, and reports it active', async () => {
    const ext = fakeExtension();
    const env = { MARK: '1' };
    expect(await load(async () => ext, { env })).toBe(true);
    expect(ext.available).toHaveBeenCalledWith(env);
    expect(ext.install).toHaveBeenCalledTimes(1);
    expect(ext.install.mock.calls[0][0]).toBe(devExtensionRouter());
    expect(ext.install.mock.calls[0][1]).toMatchObject({ env });
    expect(devToolsActive()).toBe(true);
    const res = await request(seamApp()).get('/api/dev/ping');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('is idempotent, also for calls that overlap', async () => {
    const ext = fakeExtension();
    const importer = vi.fn(async () => ext);
    const results = await Promise.all([load(importer), load(importer)]);
    expect(results).toEqual([true, true]);
    expect(await load(importer)).toBe(true);
    expect(ext.install).toHaveBeenCalledTimes(1);
    expect(importer).toHaveBeenCalledTimes(1);
  });

  it('forgets everything on reset: inactive, router empty', async () => {
    await load(async () => fakeExtension());
    resetDevExtensionsForTests();
    expect(devToolsActive()).toBe(false);
    expect((await request(seamApp()).get('/api/dev/ping')).status).toBe(404);
  });
});

describe('server.js without a loaded extension', () => {
  let app;
  beforeAll(async () => {
    for (const k of ENV_KEYS) delete process.env[k];
    app = (await import('../../server.js')).default;
  }, 60_000);

  it('answers 404 not_found on /api/dev/status', async () => {
    const res = await request(app).get('/api/dev/status').set('X-Forwarded-For', '198.51.100.7');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'not_found' });
  });

  it('reports devTools false on /api/app/info', async () => {
    const res = await request(app).get('/api/app/info').set('X-Forwarded-For', '198.51.100.8');
    expect(res.status).toBe(200);
    expect(res.body.data.devTools).toBe(false);
  });
});
