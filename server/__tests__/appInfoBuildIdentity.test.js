// GET /api/app/info commit + buildDate: populated and null cases.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const commitMock = vi.hoisted(() => vi.fn());
vi.mock('../runtime.js', async (importOriginal) => ({ ...(await importOriginal()), getCommit: commitMock }));

import { getBuildDate, registerAppInfoRoutes, resetBuildDateForTests } from '../appInfoRoutes.js';

const ISO = '2026-10-05T12:00:00Z';
let tmp;

const makeApp = () => {
  const app = express();
  registerAppInfoRoutes(app);
  return app;
};

const writeInfo = () =>
  fs.writeFileSync(
    path.join(tmp, 'burrow-build-info.json'),
    JSON.stringify({ formatVersion: 1, buildDate: ISO, source: 'git', version: '0.1.0', channel: 'stable' }),
  );

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-appinfo-'));
  process.env.BURROW_DIST_DIR = tmp;
  resetBuildDateForTests();
});

afterEach(() => {
  delete process.env.BURROW_DIST_DIR;
  resetBuildDateForTests();
  fs.rmSync(tmp, { recursive: true, force: true });
  commitMock.mockReset();
  vi.restoreAllMocks();
});

describe('GET /api/app/info build identity', () => {
  it('returns the commit and ISO build date when both are known', async () => {
    writeInfo();
    commitMock.mockReturnValue('abc1234');
    const res = await request(makeApp()).get('/api/app/info');
    expect(res.status).toBe(200);
    expect(res.body.data.commit).toBe('abc1234');
    expect(res.body.data.buildDate).toBe(ISO);
    expect(Object.keys(res.body.data).sort()).toEqual(['buildDate', 'channel', 'commit', 'dataDir', 'dataFolderWarning', 'dataLocation', 'desktop', 'devTools', 'distribution', 'proModule', 'version']);
    expect(res.body.data.distribution).toBe('direct');
  });

  it('reports the store distribution when the build is the Microsoft Store flavor', async () => {
    vi.stubEnv('BURROW_DISTRIBUTION', 'store');
    commitMock.mockReturnValue(null);
    const res = await request(makeApp()).get('/api/app/info');
    expect(res.body.data.distribution).toBe('store');
    vi.unstubAllEnvs();
  });

  it('returns explicit nulls (not omitted keys) when neither is known', async () => {
    commitMock.mockReturnValue(null);
    const res = await request(makeApp()).get('/api/app/info');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('commit', null);
    expect(res.body.data).toHaveProperty('buildDate', null);
  });

  it('returns null buildDate for a corrupt build-info file, keeping the commit', async () => {
    fs.writeFileSync(path.join(tmp, 'burrow-build-info.json'), '{not json');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    commitMock.mockReturnValue('abc1234');
    const res = await request(makeApp()).get('/api/app/info');
    expect(res.body.data.buildDate).toBeNull();
    expect(res.body.data.commit).toBe('abc1234');
  });

  it('caches the build date, including null, until reset', () => {
    expect(getBuildDate()).toBeNull();
    writeInfo();
    expect(getBuildDate()).toBeNull();
    resetBuildDateForTests();
    expect(getBuildDate()).toBe(ISO);
  });
});
