// Work that started before an erase and finishes after it must write nothing: the daily briefing (direct
// and scheduled), a Javi run whose client left, parked Javi writes and the data-browser overview cache.
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// Pro is on for this file (the Pro gate itself is covered in proGating.test.js).
vi.mock('../../loadEnv.js', () => ({}));
vi.mock('node-fetch', () => ({ default: vi.fn() }));
vi.mock('../dataAccess.js', async (orig) => {
  const actual = await orig();
  return { ...actual, appendMessage: vi.fn(actual.appendMessage) };
});
vi.mock('../integrations.js', async (orig) => ({
  ...(await orig()),
  fetchOura: vi.fn(async () => ({ days: [] })),
  fetchWeather: vi.fn(async () => ({})),
}));

import { __resetLockForTests } from '../backup/lock.js';
import { clearOverviewCache, registerDataBrowserRoutes } from '../dataBrowserRoutes.js';
import * as dataAccess from '../dataAccess.js';
import { eraseAllData } from '../erase/eraseService.js';
import { stopScheduler } from '../scheduler.js';
import { cleanupBackupEnv } from './helpers/backupEnv.js';
import { freshDb, seedEverything } from './helpers/eraseEnv.js';

const NOW = new Date('2026-10-05T12:30:00.000Z');
const erase = (opts = {}) => eraseAllData({ now: () => NOW, ...opts });

beforeEach(() => {
  freshDb();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  stopScheduler();
  __resetLockForTests();
  cleanupBackupEnv();
  vi.restoreAllMocks();
  dataAccess.appendMessage.mockClear();
});

describe('caches that describe the old data', () => {
  it('the data-browser overview cache is empty after the erase', async () => {
    seedEverything();
    const app = express();
    registerDataBrowserRoutes(app);
    clearOverviewCache();
    const before = await request(app).get('/api/data/tables/transactions/overview');
    expect(before.body.sampled).toBeGreaterThan(0);
    await erase();
    const after = await request(app).get('/api/data/tables/transactions/overview');
    expect(after.status).toBe(200);
    expect(after.body.sampled).toBe(0);
  });
});
