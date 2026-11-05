// ci:always-run
// Burrow is free for everyone (docs/adr/0002-free-for-everyone.md): no license API, no license network feature, no tier
// gate. Every route of the private module answers 501 pro_not_included in a core-only build (never 403), multi-turn
// Javi advice is not refused, server/pro.js exports only the contract names, and nothing under server/ imports a removed
// licensing module. Core test: it never installs the private module, so it behaves the same with and without pro/.
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';

vi.mock('../../loadEnv.js', () => ({}));
vi.mock('node-fetch', () => ({ default: vi.fn() }));
vi.mock('../javi/advisorService.js', () => ({ generateAdvice: vi.fn(), streamAdvice: vi.fn() }));

import fetch from 'node-fetch';
import { generateAdvice } from '../javi/advisorService.js';
import { installFakeOllama } from './helpers/fakeOllama.js';
import { __resetAiForTests } from '../ai/index.js';
import { cleanupBackupEnv, resetBackupEnv } from './helpers/backupEnv.js';
import * as proModule from '../pro.js';
import { MSG_PRO_NOT_INCLUDED, PRO_FEATURES } from '../pro.js';
import { PRO_ROUTES } from '../proRoutes.js';
import { NETWORK_FEATURES } from '../netFeatures.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

let app;
let ip = 0;
const nextIp = () => `198.51.100.${(ip += 1) % 250}`;
const post = (url, body, headers = {}) => request(app).post(url).set('X-Forwarded-For', nextIp()).set(headers).send(body);
const call = (method, url) => request(app)[method](url).set('X-Forwarded-For', nextIp());

const saved = Object.fromEntries(['APP_PASSWORD', 'AUTH_SECRET', 'SECRETS_ENCRYPTION_KEY', 'BURROW_AI'].map((k) => [k, process.env[k]]));

beforeAll(async () => {
  for (const k of Object.keys(saved)) delete process.env[k];
  app = (await import('../../server.js')).default;
});
afterAll(() => {
  cleanupBackupEnv();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
beforeEach(() => {
  resetBackupEnv();
  __resetAiForTests();
  fetch.mockReset();
  installFakeOllama(fetch);
  generateAdvice.mockReset();
  delete process.env.BURROW_AI;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

const concretePath = (p) => p.replace(':token', '0'.repeat(32)).replace(':id', '00000000-0000-4000-8000-000000000000');

describe('there is no license API', () => {
  it.each([
    ['get', '/api/license'],
    ['post', '/api/license/activate'],
    ['post', '/api/license/deactivate'],
    ['delete', '/api/license'],
    ['post', '/api/license/trial/notice'],
    ['get', '/api/dev/license'],
  ])('%s %s answers 404 not_found', async (method, url) => {
    const res = await call(method, url);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'not_found' });
  });

  it('the network registry has no license feature and no store host', async () => {
    expect(NETWORK_FEATURES.map((f) => f.id)).not.toContain('license');
    const hosts = NETWORK_FEATURES.flatMap((f) => f.hosts);
    expect(hosts).not.toContain('api.gumroad.com');
    expect(hosts).not.toContain('api.lemonsqueezy.com');
    const res = await call('get', '/api/settings/network');
    expect(res.status).toBe(200);
    expect(res.body.features.map((f) => f.id)).not.toContain('license');
  });

  it('Erase all my data no longer takes a removeLicense option and the update API has no license window', () => {
    const erase = fs.readFileSync(path.join(ROOT, 'server', 'eraseRoutes.js'), 'utf8');
    expect(erase).not.toContain('removeLicense');
    for (const file of ['updateCheck.js', 'updateInstallRoutes.js', 'settingsRoutes.js']) {
      const text = fs.readFileSync(path.join(ROOT, 'server', file), 'utf8');
      expect(text, file).not.toMatch(/update_license_window|licenseImpact|updatesUntil/);
    }
  });
});

describe('Javi advice has no tier gate', () => {
  const BASE = { page: 'todos', context: '{}' };
  const MSGS = [{ role: 'user', content: 'and then?' }];

  it.each([
    ['non-empty messages', { ...BASE, messages: MSGS }],
    ['a history key', { ...BASE, history: MSGS }],
    ['a thread id', { ...BASE, threadId: 'a' }],
  ])('multi-turn advice (%s) is not refused with 403', async (_label, body) => {
    generateAdvice.mockResolvedValue({ content: '- Do the thing', model: 'm1', provider: 'ollama' });
    const res = await post('/api/jarvis/advice', body);
    expect(res.status).not.toBe(403);
    expect(res.body.error).not.toBe('pro_required');
  });

  it('a follow-up with messages is answered like any advice request', async () => {
    generateAdvice.mockResolvedValue({ content: '- Do the thing', model: 'm1', provider: 'ollama' });
    const res = await post('/api/jarvis/advice', { ...BASE, messages: MSGS });
    expect(res.status).toBe(200);
    expect(res.body.data.content).toBe('- Do the thing');
    expect(generateAdvice).toHaveBeenCalledTimes(1);
  });
});

describe('the module routes in a core-only build', () => {
  it('lists exactly the eight registered capabilities', () => {
    expect(Object.keys(PRO_FEATURES).sort()).toEqual(
      ['briefings', 'explain', 'folder_auto_rescan', 'folder_qa', 'folder_report', 'javi_characters', 'javi_conversation', 'javi_tools'].sort(),
    );
    for (const feature of Object.values(PRO_FEATURES)) expect(Object.keys(feature)).toEqual(['label']);
    expect(Object.isFrozen(PRO_FEATURES)).toBe(true);
  });

  it.each(Object.values(PRO_ROUTES).map((r) => [r.id, r.path, r.feature]))(
    '%s (POST %s) answers 501 pro_not_included, never 403, before any model call or stream',
    async (_id, routePath, feature) => {
      const res = await post(concretePath(routePath), {}, { Accept: 'text/event-stream' });
      expect(res.status).toBe(501);
      expect(res.headers['content-type']).toMatch(/application\/json/);
      expect(res.headers['content-type']).not.toMatch(/event-stream/);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body).toEqual({ error: 'pro_not_included', code: 'pro_not_included', feature, message: MSG_PRO_NOT_INCLUDED });
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each(Object.values(PRO_ROUTES).map((r) => [r.id, r.path]))('%s is not affected by BURROW_AI=0 or a bad body', async (_id, routePath) => {
    process.env.BURROW_AI = '0';
    const res = await post(concretePath(routePath), { prompt: 5, windowDays: 'x' });
    expect(res.status).toBe(501);
    expect(res.body.error).toBe('pro_not_included');
  });

  it('the fixed copy never offers to buy or upgrade', () => {
    expect(MSG_PRO_NOT_INCLUDED).toBe('This build of Burrow does not include this feature. The official Burrow app includes it at no cost.');
    expect(MSG_PRO_NOT_INCLUDED).not.toMatch(/\b(?:buy|upgrade|trial|license|price|Pro)\b/i);
  });

  it('turning the daily folder re-scan on is not gated by the build either (the scheduler simply has no job without the module)', async () => {
    const res = await call('patch', '/api/folders/00000000-0000-4000-8000-000000000000').send({ autoRescan: true });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('folder_not_found');
  });
});

describe('server/pro.js', () => {
  it('exports only PRO_FEATURES, MSG_PRO_NOT_INCLUDED and sendProNotIncluded', () => {
    expect(Object.keys(proModule).sort()).toEqual(['MSG_PRO_NOT_INCLUDED', 'PRO_FEATURES', 'sendProNotIncluded']);
  });

  it('sendProNotIncluded refuses an unknown feature id', () => {
    expect(() => proModule.sendProNotIncluded('nope')).toThrow(/Unknown Pro feature/);
    expect(typeof proModule.sendProNotIncluded('explain')).toBe('function');
  });
});

describe('nothing imports a removed licensing module', () => {
  const KEPT_LICENSE_FILES = new Set(['buildInfo.js', 'channelSeam.js', 'constants.js']);
  const REMOVED_NAMES =
    /\b(?:getEntitlements|getLicenseStatus|initLicense|activateLicense|deactivateLicense|removeLicense|dismissTrialNotice|installLicenseDevHook|requirePro|requireProWhen|assertPro|proAccess|isProEnabled|ProRequiredError|MSG_PRO_REQUIRED|MSG_NEWER_LICENSE|NEWER_LICENSE_REASON|licenseImpactFor)\b/;

  function sourceFiles(dir) {
    const out = [];
    // devtools/ is never part of the public core export (docs/OPEN_CORE.md), so a missing folder scans as empty there.
    if (!fs.existsSync(dir)) return out;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...sourceFiles(full));
      else if (/\.(?:js|mjs|cjs)$/.test(entry.name)) out.push(full);
    }
    return out;
  }

  const files = [path.join(ROOT, 'server.js'), ...sourceFiles(path.join(ROOT, 'server')), ...sourceFiles(path.join(ROOT, 'scripts')), ...sourceFiles(path.join(ROOT, 'devtools', 'server'))];
  const rel = (f) => path.relative(ROOT, f).split(path.sep).join('/');

  it('the server/license folder keeps only the build-channel files', () => {
    expect(fs.readdirSync(path.join(ROOT, 'server', 'license')).sort()).toEqual([...KEPT_LICENSE_FILES].sort());
    expect(fs.existsSync(path.join(ROOT, 'server', 'licenseRoutes.js'))).toBe(false);
    expect(fs.existsSync(path.join(ROOT, 'config', 'store.json'))).toBe(false);
    expect(fs.existsSync(path.join(ROOT, 'scripts', 'checks', 'storeConfig.js'))).toBe(false);
    expect(fs.existsSync(path.join(ROOT, 'scripts', 'lib', 'evalTrial.js'))).toBe(false);
    expect(fs.existsSync(path.join(ROOT, 'server', '__tests__', 'helpers', 'pro.js'))).toBe(false);
  });

  it('no file under server/, scripts/ or devtools/server imports a licensing module other than the kept ones', () => {
    const offenders = [];
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      for (const m of text.matchAll(/(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"]([^'"]*license[^'"]*)['"]/g)) {
        const spec = m[1].replaceAll('\\', '/');
        const base = spec.split('/').pop();
        if (/^(?:\.\.?\/)+(?:server\/)?license\//.test(spec) && KEPT_LICENSE_FILES.has(base)) continue;
        // scripts/license/writeBuildInfo.js is the build-date script of the release pipeline, not licensing code.
        if (base === 'writeBuildInfo.js') continue;
        offenders.push(`${rel(file)} -> ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no server source names a removed gate or licensing function', () => {
    const offenders = files
      .filter((f) => !rel(f).endsWith('server/__tests__/freeForEveryone.test.js'))
      .filter((f) => REMOVED_NAMES.test(fs.readFileSync(f, 'utf8')))
      .map(rel);
    // scripts/desktop/buildSidecar.js and workerBundle.js name a build-time "requirePro" option (the private module is
    // compiled in or not); it is a build flag, not a gate.
    expect(offenders.filter((f) => !/^scripts\/(?:desktop|release|checks)\//.test(f))).toEqual([]);
  });
});
