// Turning cloud AI off: the exact order of operations, and that nothing can reach the cloud host
// afterwards, including a call that was already queued when the user turned it off. Fake cloud
// (api.example.com) and fake Ollama behind a mocked node-fetch; nothing real is contacted.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../loadEnv.js', () => ({}));
vi.mock('node-fetch', () => ({ default: vi.fn() }));

// Every step disableCloudAi() performs appends to `order` before running the real function.
const order = vi.hoisted(() => []);
vi.mock('../netPolicy.js', async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    setNetworkFeature: async (id, enabled) => {
      order.push(`optIn:${id}:${enabled}`);
      return real.setNetworkFeature(id, enabled);
    },
  };
});
vi.mock('../ai/settings.js', async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    updateAiSettings: async (patch) => {
      order.push(`provider:${patch.provider}`);
      return real.updateAiSettings(patch);
    },
  };
});
vi.mock('../ai/consent.js', async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    clearCloudConsent: async () => {
      order.push('consent:cleared');
      return real.clearCloudConsent();
    },
  };
});
vi.mock('../auditHook.js', async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    recordAudit: async (row) => {
      order.push(`audit:${row?.meta?.action ?? row?.feature}`);
      return real.recordAudit(row);
    },
  };
});

import fetch from 'node-fetch';
import { CLOUD_HOST, CLOUD_KEY, configureCloud, installCloudAndOllama, resetCloud } from './helpers/fakeCloud.js';
import { closeTestDb, createTestDb, resetDb } from './helpers/testDb.js';
import { __resetAiForTests, classifyAiError, getAiClient, isAiQueueFull, isCloudStillAllowed, withheldMessage } from '../ai/index.js';
import { getCloudConsent, updateCloudCategories } from '../ai/consent.js';
import { getAiSettings } from '../ai/settings.js';
import { disableCloudAi } from '../aiSettingsRoutes.js';
import { isEnabled } from '../netPolicy.js';
import { listAudit } from '../audit.js';

let db;
const saved = Object.fromEntries(['BURROW_AI', 'BURROW_AI_CONCURRENCY'].map((k) => [k, process.env[k]]));
const messages = [{ role: 'user', content: 'hello' }];
const scope = { categories: ['budget'] };
const cloudHits = () => fetch.mock.calls.filter(([url]) => new URL(String(url)).hostname === CLOUD_HOST);
const consentAudit = async () => (await listAudit({ limit: 50 })).entries.filter((e) => e.feature === 'cloud_ai_consent');

beforeAll(() => {
  delete process.env.BURROW_AI;
  delete process.env.BURROW_AI_CONCURRENCY;
  db = createTestDb();
});
afterAll(async () => {
  await resetCloud();
  closeTestDb(db);
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
beforeEach(async () => {
  resetDb(db);
  fetch.mockReset();
  order.length = 0;
  await resetCloud();
});
afterEach(() => {
  __resetAiForTests();
});

describe('disableCloudAi order of operations', () => {
  it('turns the opt-in off first, then the provider, then consent, and audits last', async () => {
    await configureCloud();
    installCloudAndOllama(fetch);
    order.length = 0; // configureCloud writes state through the same modules

    await disableCloudAi();

    expect(order).toEqual(['optIn:cloudAi:false', 'provider:ollama', 'consent:cleared', 'audit:disabled']);
  });

  it('leaves settings, consent and audit in the off state, and the next client is local', async () => {
    await configureCloud();
    installCloudAndOllama(fetch);
    expect(await isCloudStillAllowed()).toBe(true);

    await disableCloudAi();

    expect(await isEnabled('cloudAi')).toBe(false);
    expect((await getAiSettings()).provider).toBe('ollama');
    expect(await getCloudConsent()).toBeNull();
    expect(await isCloudStillAllowed()).toBe(false);
    expect((await consentAudit()).map((r) => r.meta)).toEqual([{ action: 'disabled' }]);

    const client = await getAiClient({ purpose: 'chat' });
    expect(client.isCloud).toBe(false);
    expect(client.provider).toBe('ollama');
    await client.complete({ messages, scope });
    expect(cloudHits()).toHaveLength(0);
  });

  // A single-slot queue: `first` holds the slot (its cloud request waits on the gate) and a second
  // call queues behind it, from the same client, which was built while cloud was configured.
  const holdFirstCall = async () => {
    await configureCloud();
    installCloudAndOllama(fetch);
    const answer = fetch.getMockImplementation();
    let openGate;
    const gate = new Promise((resolve) => {
      openGate = resolve;
    });
    const seen = []; // { host, auth } for every request
    fetch.mockImplementation(async (url, init) => {
      const host = new URL(String(url)).hostname;
      seen.push({ host, auth: init?.headers?.Authorization });
      if (host === CLOUD_HOST && seen.filter((r) => r.host === CLOUD_HOST).length === 1) await gate;
      return answer(url, init);
    });
    const client = await getAiClient({ purpose: 'chat' });
    expect(client.isCloud).toBe(true);
    const first = client.complete({ messages, scope: { categories: [] } });
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    const queued = client.complete({ messages, scope });
    const outcome = queued.then(
      (value) => ({ ok: true, value }),
      (err) => ({ ok: false, err }),
    );
    return { client, first, outcome, openGate, seen };
  };

  it('blocks a cloud call that was queued before the user turned cloud off', async () => {
    const { client, first, outcome: queuedOutcome, openGate, seen } = await holdFirstCall();

    await disableCloudAi();
    openGate();
    await first.catch(() => {});
    const outcome = await queuedOutcome;

    // Nothing more may be sent to the cloud host after the user turned it off.
    expect(seen.filter((r) => r.host === CLOUD_HOST)).toHaveLength(1);
    expect(outcome.ok).toBe(false);
    expect(outcome.err).toMatchObject({ code: 'cloud_disabled' });
    expect(outcome.err.categories).toEqual([]);
    // The refused call neither counts as a call nor as shared categories (audit rows stay truthful).
    expect(client.stats.calls).toBe(1);
    expect(client.dataReport().shared).toEqual([]);
    // The queue slot was released and a fresh local client works.
    expect(isAiQueueFull()).toBe(false);
    const local = await getAiClient({ purpose: 'chat' });
    expect(local.isCloud).toBe(false);
    await expect(local.complete({ messages, scope })).resolves.toMatchObject({ content: expect.any(String) });
  });

  it('never sends a queued call to the old host after the base URL changed and a new host was consented', async () => {
    const { first, outcome: queuedOutcome, openGate, seen } = await holdFirstCall();

    // The user switches A -> B: A's consent is cleared, B is consented, cloud stays on.
    await configureCloud({ baseUrl: 'https://api.other-example.com/v1' });
    openGate();
    await first.catch(() => {});
    const outcome = await queuedOutcome;

    expect(outcome.ok).toBe(false);
    expect(outcome.err).toMatchObject({ code: 'cloud_disabled' });
    expect(seen.filter((r) => r.host === CLOUD_HOST)).toHaveLength(1); // only the call already in flight
    expect(seen.filter((r) => r.host === 'api.other-example.com')).toHaveLength(0);
  });

  it('uses the fresh key for a queued call when the key was rotated on the same URL', async () => {
    const { first, outcome: queuedOutcome, openGate, seen } = await holdFirstCall();

    await configureCloud({ key: 'sk-test-rotated' });
    openGate();
    await first.catch(() => {});
    const outcome = await queuedOutcome;

    expect(outcome.ok).toBe(true);
    const cloud = seen.filter((r) => r.host === CLOUD_HOST);
    expect(cloud.map((r) => r.auth)).toEqual([`Bearer ${CLOUD_KEY}`, 'Bearer sk-test-rotated']);
  });

  it('refuses a queued call whose category was switched off while it waited, and sends nothing', async () => {
    const { client, first, outcome: queuedOutcome, openGate, seen } = await holdFirstCall();

    // The queued call was enforced with budget on; the user unticks it before the slot frees up.
    await updateCloudCategories({ budget: false });
    openGate();
    await first.catch(() => {});
    const outcome = await queuedOutcome;

    expect(seen.filter((r) => r.host === CLOUD_HOST)).toHaveLength(1); // only the call already in flight
    expect(outcome.ok).toBe(false);
    expect(outcome.err).toMatchObject({ code: 'cloud_scope_denied', categories: ['budget'] });
    expect(classifyAiError(outcome.err).message).toBe(withheldMessage(['budget']));
    expect(client.stats.calls).toBe(1);
    expect(client.dataReport().shared).toEqual([]);
    expect(isAiQueueFull()).toBe(false);
  });
});
