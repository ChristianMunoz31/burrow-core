// The Pro module seam (docs/adr/0001-open-core-split.md 3.2-3.8): the loader with an injected importer, the install
// rollback, registration closing, the route table and the core gates every registration passes. Core test: it never
// imports pro/ and never installs the real module, so it behaves the same with and without pro/.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../license/index.js', async (importOriginal) => (await import('./helpers/pro.js')).mockLicenseModule(importOriginal));
vi.mock('../../loadEnv.js', () => ({}));

import { FREE, PRO, resetPro, setEntitlements } from './helpers/pro.js';
import { closeTestDb, createTestDb, resetDb } from './helpers/testDb.js';
import {
  PRO_API_VERSION,
  PRO_GATE,
  loadProExtensions,
  proModuleActive,
  proSlotRouter,
  resetProExtensionsForTests,
  setFolderRouteHelpers,
} from '../proExtensions.js';
import { PRO_ROUTES, PRO_SLOTS } from '../proRoutes.js';
import { MSG_PRO_NOT_INCLUDED, PRO_FEATURES } from '../pro.js';
import { BUTLER_CHARACTER, characterText, registerCharacterTexts, resetCharacterTextsForTests } from '../javi/characters.js';
import { runDataResetHooks } from '../dataGeneration.js';
import { registerAppInfoRoutes } from '../appInfoRoutes.js';
import { isProExtensionNotFound } from '../proExtensionsLoader.js';
import { importProExtension as importNone } from '../proExtensionsLoader.none.js';

const log = vi.fn();
const sentinel = (tag) => (_req, res) => res.status(299).json({ tag });

/** A module whose install adds a sentinel handler for every route and records the ctx it got. */
function fakeModule(overrides = {}) {
  const seen = {};
  return {
    seen,
    module: {
      name: 'fake-pro',
      apiVersion: PRO_API_VERSION,
      available: () => true,
      install(ctx) {
        seen.ctx = ctx;
        for (const id of Object.keys(PRO_ROUTES)) ctx.routes.add({ id, handlers: [sentinel(id)] });
      },
      ...overrides,
    },
  };
}

const fakeFolderHelpers = () => ({
  handle: (fn) => async (req, res) => fn(req, res),
  send: (res, code) => res.status(400).json({ error: code }),
  folderOr404: () => ({ id: 'x' }),
  aiLimiter: (_req, _res, next) => next(),
  requireJson: (req, res, next) => (req.is('application/json') ? next() : res.status(415).json({ error: 'unsupported_media_type' })),
  isPlainBody: (b) => b !== null && typeof b === 'object' && !Array.isArray(b),
});

function slotApp() {
  const app = express();
  app.use(express.json());
  for (const slot of PRO_SLOTS) app.use(proSlotRouter(slot));
  app.use('/api', (_req, res) => res.status(404).json({ error: 'not_found' }));
  return app;
}

const concretePath = (path) => path.replace(':token', '00000000000000000000000000000000').replace(':id', '00000000-0000-4000-8000-000000000000');

let db;
beforeAll(() => {
  db = createTestDb();
});
beforeEach(() => {
  resetDb(db);
  resetProExtensionsForTests();
  resetPro();
  log.mockReset();
  setFolderRouteHelpers(fakeFolderHelpers());
});
afterEach(() => {
  resetProExtensionsForTests();
  resetPro();
});
afterAll(() => closeTestDb(db));

describe('route table', () => {
  it('lists the six Pro routes with used features, known slots and the frozen paths', () => {
    expect(Object.keys(PRO_ROUTES).sort()).toEqual(
      ['folders.ask', 'folders.report', 'insights.explain', 'jarvis.action', 'jarvis.briefingRefresh', 'jarvis.run'].sort(),
    );
    for (const route of Object.values(PRO_ROUTES)) {
      expect(PRO_FEATURES[route.feature]?.used).toBe(true);
      expect(PRO_SLOTS).toContain(route.slot);
      expect(route.method).toBe('post');
      expect(Object.isFrozen(route)).toBe(true);
    }
    expect(PRO_ROUTES['jarvis.run'].path).toBe('/api/jarvis');
    expect(PRO_ROUTES['folders.ask'].pre).toEqual(['aiLimiter', 'requireJson']);
    expect(PRO_ROUTES['jarvis.action'].ai).toEqual({ purpose: 'tools', enabledOnly: true });
  });
});

describe('loader trio', () => {
  it('the none loader returns null', async () => {
    expect(await importNone()).toBeNull();
  });
  it('recognizes only the not-found error of the Pro entry', () => {
    expect(isProExtensionNotFound({ code: 'ERR_MODULE_NOT_FOUND', url: 'file:///C:\\repo\\pro\\server\\index.js' })).toBe(true);
    expect(isProExtensionNotFound({ code: 'ERR_MODULE_NOT_FOUND', message: "Cannot find package 'x' imported from /repo/pro/server/a.js" })).toBe(false);
    expect(isProExtensionNotFound({ code: 'EACCES', message: 'pro/server/index.js' })).toBe(false);
  });
});

describe('loadProExtensions', () => {
  it('null importer: false, no log, not active', async () => {
    expect(await loadProExtensions({ importer: async () => null, log })).toBe(false);
    expect(log).not.toHaveBeenCalled();
    expect(proModuleActive()).toBe(false);
  });

  it('a throwing importer logs a code only', async () => {
    const err = Object.assign(new Error('C:\\secret\\path'), { code: 'EBOOM' });
    expect(await loadProExtensions({ importer: async () => { throw err; }, log })).toBe(false);
    expect(log).toHaveBeenCalledWith('pro extensions: failed to load (EBOOM)');
  });

  it.each([
    ['no name', { name: undefined }],
    ['apiVersion mismatch', { apiVersion: 2 }],
    ['no install', { install: 'x' }],
    ['no available', { available: null }],
  ])('refuses a bad shape (%s)', async (_label, over) => {
    const { module } = fakeModule(over);
    expect(await loadProExtensions({ importer: async () => module, log })).toBe(false);
    expect(log).toHaveBeenCalledWith('pro extensions: incompatible module');
  });

  it('available must return exactly true', async () => {
    const { module, seen } = fakeModule({ available: () => 1 });
    expect(await loadProExtensions({ importer: async () => module, log })).toBe(false);
    expect(seen.ctx).toBeUndefined();
  });

  it('an install that throws rolls every registry back', async () => {
    const reset = vi.fn();
    const { module } = fakeModule({
      install(ctx) {
        ctx.routes.add({ id: 'jarvis.run', handlers: [sentinel('run')] });
        ctx.javi.registerCharacters({ valet: { ...BUTLER_CHARACTER, line: 'registered valet' } });
        ctx.onDataReset(reset);
        throw Object.assign(new Error('x'), { code: 'EINSTALL' });
      },
    });
    expect(await loadProExtensions({ importer: async () => module, log })).toBe(false);
    expect(log).toHaveBeenCalledWith('pro extensions: install failed (EINSTALL)');
    expect(proModuleActive()).toBe(false);
    runDataResetHooks();
    expect(reset).not.toHaveBeenCalled();
    setEntitlements(PRO);
    const res = await request(slotApp()).post('/api/jarvis').send({});
    expect(res.status).toBe(501);
  });

  it('an install that returns a thenable is a failure', async () => {
    const { module } = fakeModule({ install: () => Promise.resolve() });
    expect(await loadProExtensions({ importer: async () => module, log })).toBe(false);
    expect(log).toHaveBeenCalledWith('pro extensions: install failed (async_install)');
  });

  it('is idempotent and closes registration after install', async () => {
    const importer = vi.fn(async () => fakeModule().module);
    const [a, b] = await Promise.all([loadProExtensions({ importer, log }), loadProExtensions({ importer, log })]);
    expect(a && b).toBe(true);
    expect(await loadProExtensions({ importer, log })).toBe(true);
    expect(importer).toHaveBeenCalledTimes(1);
    expect(proModuleActive()).toBe(true);
  });

  it('every ctx method throws once install returned', async () => {
    const { module, seen } = fakeModule();
    await loadProExtensions({ importer: async () => module, log });
    const { ctx } = seen;
    expect(ctx.apiVersion).toBe(PRO_API_VERSION);
    expect(() => ctx.routes.add({ id: 'jarvis.run', handlers: [sentinel('x')] })).toThrow('pro registration closed');
    expect(() => ctx.folders.routeHelpers()).toThrow('pro registration closed');
    expect(() => ctx.folders.setJobHooks({})).toThrow('pro registration closed');
    expect(() => ctx.scheduler.register('briefing', async () => {})).toThrow('pro registration closed');
    expect(() => ctx.javi.registerCharacters({})).toThrow('pro registration closed');
    expect(() => ctx.onDataReset(() => {})).toThrow('pro registration closed');
  });

  it('routes.add refuses an unknown id, a duplicate, empty handlers and a non-function', async () => {
    const errors = [];
    const { module } = fakeModule({
      install(ctx) {
        const tryAdd = (arg) => {
          try {
            ctx.routes.add(arg);
          } catch (e) {
            errors.push(e.message);
          }
        };
        tryAdd({ id: 'nope', handlers: [sentinel('x')] });
        tryAdd({ id: 'jarvis.run', handlers: [] });
        tryAdd({ id: 'jarvis.run', handlers: ['x'] });
        ctx.routes.add({ id: 'jarvis.run', handlers: [sentinel('x')] });
        tryAdd({ id: 'jarvis.run', handlers: [sentinel('x')] });
        expect(() => ctx.scheduler.register('nope', async () => {})).toThrow();
      },
    });
    expect(await loadProExtensions({ importer: async () => module, log })).toBe(true);
    expect(errors).toHaveLength(4);
  });
});

describe('gates', () => {
  it('every installed route carries a PRO_GATE first layer with the table feature', async () => {
    await loadProExtensions({ importer: async () => fakeModule().module, log });
    for (const route of Object.values(PRO_ROUTES)) {
      const outer = proSlotRouter(route.slot);
      const pro = outer.stack[0].handle;
      const layer = pro.stack.find((l) => l.route?.path === route.path);
      expect(layer, route.id).toBeTruthy();
      expect(layer.route.stack[0].handle[PRO_GATE]).toBe(route.feature);
    }
  });

  it('no module: every path answers 403 for Free and 501 for Pro', async () => {
    const app = slotApp();
    for (const route of Object.values(PRO_ROUTES)) {
      setEntitlements(FREE);
      const free = await request(app).post(concretePath(route.path)).set('Content-Type', 'application/json').send({});
      expect(free.status, route.id).toBe(403);
      expect(free.body).toMatchObject({ error: 'pro_required', feature: route.feature });
      setEntitlements(PRO);
      const pro = await request(app).post(concretePath(route.path)).set('Content-Type', 'application/json').send({});
      expect(pro.status, route.id).toBe(501);
      expect(pro.body).toEqual({ error: 'pro_not_included', code: 'pro_not_included', feature: route.feature, message: MSG_PRO_NOT_INCLUDED });
      expect(pro.headers['cache-control']).toBe('no-store');
    }
  });

  it('with a module: Free gets 403, Pro reaches the handler; requireJson runs before validators', async () => {
    await loadProExtensions({ importer: async () => fakeModule().module, log });
    const app = slotApp();
    setEntitlements(FREE);
    expect((await request(app).post('/api/insights/explain').send({})).status).toBe(403);
    setEntitlements(PRO);
    const ok = await request(app).post('/api/insights/explain').send({});
    expect(ok.status).toBe(299);
    expect(ok.body.tag).toBe('insights.explain');
    const ask = await request(app).post(concretePath(PRO_ROUTES['folders.ask'].path)).set('Content-Type', 'text/plain').send('x');
    expect(ask.status).toBe(415);
  });

  it('AI off answers 503 before the handler of an AI route', async () => {
    const saved = process.env.BURROW_AI;
    process.env.BURROW_AI = '0';
    try {
      await loadProExtensions({ importer: async () => fakeModule().module, log });
      const res = await request(slotApp()).post('/api/jarvis/briefing/refresh').send({});
      expect(res.status).toBe(503);
      expect(res.body.error).toBe('ai_not_configured');
    } finally {
      if (saved === undefined) delete process.env.BURROW_AI;
      else process.env.BURROW_AI = saved;
    }
  });
});

describe('/api/app/info proModule', () => {
  it('follows proModuleActive', async () => {
    const app = express();
    registerAppInfoRoutes(app);
    expect((await request(app).get('/api/app/info')).body.data.proModule).toBe(false);
    await loadProExtensions({ importer: async () => fakeModule().module, log });
    expect((await request(app).get('/api/app/info')).body.data.proModule).toBe(true);
  });
});

describe('core hosts', () => {
  it('characters: a registered text is used, an unregistered id reads as the butler', () => {
    resetCharacterTextsForTests();
    registerCharacterTexts({ concierge: { ...BUTLER_CHARACTER, line: 'registered concierge' } });
    expect(characterText('concierge').line).toBe('registered concierge');
    expect(() => registerCharacterTexts({ butler: BUTLER_CHARACTER })).toThrow();
    expect(() => registerCharacterTexts({ valet: { line: 'x' } })).toThrow();
    resetCharacterTextsForTests();
  });

  it('ctx.onDataReset forwards to the data reset until rollback', async () => {
    const fn = vi.fn();
    await loadProExtensions({
      importer: async () => fakeModule({ install: (ctx) => ctx.onDataReset(fn) }).module,
      log,
    });
    runDataResetHooks();
    expect(fn).toHaveBeenCalledTimes(1);
    resetProExtensionsForTests();
    runDataResetHooks();
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
