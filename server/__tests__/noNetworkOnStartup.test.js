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

  it('with a stored license activation and BURROW_NETWORK_OPTIN=license, startup and GET /api/license make no license call', async () => {
    // The first boot created secrets.key in the data dir. Sign a file copy of an activation with it, as a
    // previous session would have left behind (the database copy is repaired from it at startup).
    const { loadOrCreateKeyFile } = await import('../secrets/keyFile.js');
    const { createActivationStore, keyHashOf, deriveKeyHashKey } = await import('../license/activationStore.js');
    const loaded = loadOrCreateKeyFile({ dir: dataDir });
    expect(loaded.ok).toBe(true);
    const store = createActivationStore({ dataDir, getDb: () => null, loadKey: () => loaded });
    const record = store.save({
      store: 'lemonsqueezy',
      productId: '67890',
      variantId: '1001',
      edition: 'standard',
      purchaseDate: '2026-09-30T14:02:11Z',
      updatesUntil: '2027-09-30T14:02:11Z',
      expiresAt: null,
      activatedAt: '2026-10-05T12:00:00Z',
      keyHash: keyHashOf(deriveKeyHashKey(loaded.key), 'lemonsqueezy', '00000000-1111-2222-3333-444444444444'),
      keyLast4: '4444',
      email: 'buyer@example.com',
      instanceId: 'a1b2c3d4-0000-1111-2222-333344445555',
      test: false,
    });
    expect(record).not.toBeNull();

    process.env.BURROW_NETWORK_OPTIN = 'license';
    fetchStub.mockClear();
    connectSpy.mockClear();
    const { startServer } = await import('../../server.js');
    const { server, url, stop } = await startServer({ port: 0, host: '127.0.0.1' });
    try {
      expect(server.listening).toBe(true);
      const res = await request(url).get('/api/license');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ edition: 'standard', license: { store: 'lemonsqueezy', keyLast4: '4444' } });
      expect(res.body.state).not.toBe('invalid');
      expect(connectSpy).toHaveBeenCalled();
    } finally {
      await stop();
      delete process.env.BURROW_NETWORK_OPTIN;
    }

    expect(fetchStub).not.toHaveBeenCalled();
    const outbound = connectSpy.mock.calls.map((args) => targetOf(args)).filter((t) => !t.ipc && !LOOPBACK.has(t.host));
    expect(outbound).toEqual([]);
  });
});
