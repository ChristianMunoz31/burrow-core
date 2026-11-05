// With default settings, the real startup path (startServer: security checks, database open and
// migrate, listen, scheduler) plus the scheduler's jobs must make zero outbound connections.
// Guarded at two levels: a stubbed fetch, and a spy on net.Socket.prototype.connect, which every
// http/https/tls client (including named ESM imports and node-fetch) ends up calling.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';

vi.mock('../../loadEnv.js', () => ({}));
vi.mock('node-fetch', () => ({ default: vi.fn() }));

const NETWORK_ENV = [
  'GROQ_API_KEY',
  'BEDROCK_API_KEY',
  'OPENAI_API_KEY',
  'OURA_TOKEN',
  'WEATHER_LAT',
  'WEATHER_LON',
  'APP_PASSWORD',
  'AUTH_SECRET',
  'SECRETS_ENCRYPTION_KEY',
  'BURROW_NETWORK_OPTIN',
  'BURROW_HOST',
  'BURROW_PORT',
  'BURROW_SCHEDULER',
];

const saved = {};
let dataDir;
let fetchStub;
let connectSpy;

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost', '::ffff:127.0.0.1']);

/** Normalizes the argument shapes of Socket#connect to the target host (undefined for IPC paths). */
function targetOf(args) {
  const [first, second] = args;
  const normalized = Array.isArray(first) ? first[0] : first;
  if (normalized && typeof normalized === 'object') {
    if (typeof normalized.path === 'string') return { ipc: true };
    return { host: normalized.host ?? 'localhost' };
  }
  if (typeof first === 'string' && Number.isNaN(Number(first))) return { ipc: true };
  return { host: typeof second === 'string' ? second : 'localhost' };
}

beforeAll(async () => {
  const { SECRET_NAMES } = await import('../secrets/registry.js');
  for (const name of [...NETWORK_ENV, ...SECRET_NAMES]) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-startup-'));
  saved.BURROW_TEST_DATA_DIR = process.env.BURROW_TEST_DATA_DIR;
  saved.BURROW_DATA_DIR = process.env.BURROW_DATA_DIR;
  process.env.BURROW_TEST_DATA_DIR = dataDir;
  process.env.BURROW_DATA_DIR = dataDir;

  fetchStub = vi.fn(() => {
    throw new Error('outbound fetch attempted');
  });
  vi.stubGlobal('fetch', fetchStub);
  connectSpy = vi.spyOn(net.Socket.prototype, 'connect');
});

afterAll(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch {
    /* Windows EBUSY: leak tmp */
  }
});

describe('startup network silence', () => {
  it('boots via startServer with default env and makes no non-loopback connection', async () => {
    const { startServer } = await import('../../server.js');
    const { startScheduler, stopScheduler } = await import('../scheduler.js');

    const { server, url, stop } = await startServer({ port: 0, host: '127.0.0.1' });
    try {
      expect(server.listening).toBe(true);

      // Run the scheduler's jobs now (prune immediately, briefing about 1 ms from now) with the real
      // default AI check: with no key configured the briefing must not reach any provider.
      stopScheduler();
      const soon = new Date();
      soon.setMinutes(59, 59, 999);
      startScheduler({ pruneDelayMs: 0, briefingHour: (soon.getHours() + 1) % 24, now: () => soon });
      await new Promise((resolve) => setTimeout(resolve, 150));

      // A real loopback request proves the spy is live (and that the server answers).
      const res = await request(url).get('/api/profile');
      expect(res.status).toBeLessThan(500);
      expect(connectSpy).toHaveBeenCalled();
    } finally {
      await stop();
    }

    expect(fetchStub).not.toHaveBeenCalled();
    const targets = connectSpy.mock.calls.map((args) => targetOf(args));
    const outbound = targets.filter((t) => !t.ipc && !LOOPBACK.has(t.host));
    expect(outbound).toEqual([]);
    expect(fs.existsSync(path.join(dataDir, 'burrow.db'))).toBe(true);
  });

  it('with every network feature on and legacy license files in the data folder, startup makes no outbound call and /api/license does not exist', async () => {
    // Older versions left license files behind. Nothing reads them, and no store is ever contacted.
    const { loadOrCreateKeyFile } = await import('../secrets/keyFile.js');
    expect(loadOrCreateKeyFile({ dir: dataDir }).ok).toBe(true);
    for (const name of ['license-activation.json', 'license-trial.json', 'license-clock.json']) {
      fs.writeFileSync(path.join(dataDir, name), JSON.stringify({ legacy: true }));
    }

    process.env.BURROW_NETWORK_OPTIN = 'weather,oura,sheets,cloudAi,aiLan,updates';
    fetchStub.mockClear();
    connectSpy.mockClear();
    const { startServer } = await import('../../server.js');
    const { server, url, stop } = await startServer({ port: 0, host: '127.0.0.1' });
    try {
      expect(server.listening).toBe(true);
      const res = await request(url).get('/api/license');
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'not_found' });
    } finally {
      await stop();
      delete process.env.BURROW_NETWORK_OPTIN;
    }

    expect(fetchStub).not.toHaveBeenCalled();
    const outbound = connectSpy.mock.calls.map((args) => targetOf(args)).filter((t) => !t.ipc && !LOOPBACK.has(t.host));
    expect(outbound).toEqual([]);
  });
});
