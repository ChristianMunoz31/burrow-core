// GET /api/app/info: version, channel, desktop flag, commit (short SHA or null), buildDate (string or null); no-store.
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { registerAppInfoRoutes } from '../appInfoRoutes.js';
import { getAppVersion } from '../runtime.js';

const makeApp = () => {
  const app = express();
  registerAppInfoRoutes(app);
  return app;
};

afterEach(() => {
  delete process.env.BURROW_CHANNEL;
  delete process.env.BURROW_DESKTOP;
});

describe('GET /api/app/info', () => {
  it('answers the stable shape by default', async () => {
    const res = await request(makeApp()).get('/api/app/info');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const { data } = res.body;
    expect(Object.keys(res.body)).toEqual(['data']);
    expect(Object.keys(data).sort()).toEqual(['buildDate', 'channel', 'commit', 'dataDir', 'dataFolderWarning', 'dataLocation', 'desktop', 'devTools', 'distribution', 'proModule', 'version']);
    expect(data).toMatchObject({ version: getAppVersion(), channel: 'stable', distribution: 'direct', dataLocation: 'appdata', desktop: false });
    expect(data.commit === null || (typeof data.commit === 'string' && /^[0-9a-f]{7}$/.test(data.commit))).toBe(true);
    expect(data.buildDate === null || typeof data.buildDate === 'string').toBe(true);
  });

  it('reports the dev channel and desktop mode', async () => {
    process.env.BURROW_CHANNEL = 'dev';
    process.env.BURROW_DESKTOP = '1';
    const res = await request(makeApp()).get('/api/app/info');
    expect(res.body.data.channel).toBe('dev');
    expect(res.body.data.desktop).toBe(true);
    expect(typeof res.body.data.version).toBe('string');
  });
});

describe('GET /api/app/info devTools flag', () => {
  const infoApp = (opts) => {
    const app = express();
    registerAppInfoRoutes(app, opts);
    return app;
  };

  it('is true when the injected flag says a developer extension is installed', async () => {
    const res = await request(infoApp({ devTools: () => true })).get('/api/app/info');
    expect(res.status).toBe(200);
    expect(res.body.data.devTools).toBe(true);
  });

  it('is false when it is not, as a boolean', async () => {
    const res = await request(infoApp({ devTools: () => false })).get('/api/app/info');
    expect(res.body.data.devTools).toBe(false);
  });

  it('is a strict boolean even for a truthy non-boolean', async () => {
    const res = await request(infoApp({ devTools: () => 'yes' })).get('/api/app/info');
    expect(res.body.data.devTools).toBe(false);
  });

  it('defaults to false: nothing installs a developer extension under a plain import', async () => {
    const res = await request(infoApp()).get('/api/app/info');
    expect(res.body.data.devTools).toBe(false);
  });

  it('keeps the other fields and no-store', async () => {
    const res = await request(infoApp({ devTools: () => false })).get('/api/app/info');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(Object.keys(res.body.data).sort()).toEqual(['buildDate', 'channel', 'commit', 'dataDir', 'dataFolderWarning', 'dataLocation', 'desktop', 'devTools', 'distribution', 'proModule', 'version']);
  });
});
