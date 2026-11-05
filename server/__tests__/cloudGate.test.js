// The cloud gate: no cloud request is possible without ALL of the cloudAi opt-in, a current
// consent record for the base URL host, a saved key, base URL and model, and a valid public
// https base URL. Every miss falls back to local Ollama, never the reverse, and makes no request
// to the cloud host.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../loadEnv.js', () => ({}));
vi.mock('node-fetch', () => ({ default: vi.fn() }));

import fetch from 'node-fetch';
import { installFakeOllama } from './helpers/fakeOllama.js';
import { CLOUD_BASE_URL, CLOUD_HOST, configureCloud, installCloudAndOllama, resetCloud } from './helpers/fakeCloud.js';
import { __resetAiForTests, describeAi, getAiClient, getAiStatus } from '../ai/index.js';
import { AI_SETTINGS_KEY } from '../ai/settings.js';
import { NETWORK_STATE_KEY, __resetNetPolicyForTests } from '../netPolicy.js';
import { setState } from '../dataAccess.js';
import { CLOUD_CONSENT_KEY } from '../ai/consent.js';

const touchedCloud = () => fetch.mock.calls.some(([url]) => String(url).includes(CLOUD_HOST));

beforeEach(async () => {
  fetch.mockReset();
  await resetCloud();
});
afterAll(resetCloud);

describe('the fully configured cloud', () => {
  it('uses the cloud provider, reports kind cloud with the hostname, and applies the saved categories', async () => {
    await configureCloud({ categories: { journal: true } });
    installCloudAndOllama(fetch);
    const client = await getAiClient({ purpose: 'chat' });
    expect(client.provider).toBe('openai_compat');
    expect(client.isCloud).toBe(true);
    expect(client.ai).toEqual({ kind: 'cloud', host: CLOUD_HOST });
    expect(client.policy.allows('journal')).toBe(true);
    expect(client.policy.allows('health')).toBe(false);
    expect(client.policy.allows('memory')).toBe(false);
  });

  it('describeAi and getAiStatus report the cloud as active', async () => {
    await configureCloud();
    installCloudAndOllama(fetch);
    expect(await describeAi('tools')).toMatchObject({ available: true, provider: 'openai_compat', ai: { kind: 'cloud', host: CLOUD_HOST }, cloudHint: { show: false, reason: null } });
    const status = await getAiStatus();
    expect(status.effectiveProvider).toBe('openai_compat');
    expect(status.cloud).toMatchObject({
      optIn: true,
      keySaved: true,
      baseUrl: CLOUD_BASE_URL,
      host: CLOUD_HOST,
      model: 'cloud-model',
      ready: true,
      consent: { current: true, host: CLOUD_HOST, version: 1 },
      consentVersion: 1,
      active: true,
    });
    expect(JSON.stringify(status)).not.toContain('sk-test-fake');
  });
});

describe('every missing piece falls back to local and never touches the cloud host', () => {
  const cases = [
    ['the cloudAi opt-in is off', { optIn: false }],
    ['there is no consent record', { consent: false }],
    ['the consent is for an older version', { consent: { version: 0, host: CLOUD_HOST, acceptedAt: '2026-01-01T00:00:00.000Z', acknowledgements: ['sends_data', 'pay_provider'] } }],
    ['the consent is for another host', { consent: { version: 1, host: 'other.example.com', acceptedAt: '2026-01-01T00:00:00.000Z', acknowledgements: ['sends_data', 'pay_provider'] } }],
    ['the consent record is malformed', { consent: { version: 'one', host: 5 } }],
    ['there is no saved key', { key: null }],
    ['there is no model', { model: null }],
    ['the provider is ollama', { provider: 'ollama' }],
    ['the base URL is plain http', { baseUrl: `http://${CLOUD_HOST}/v1` }],
    ['the base URL is loopback', { baseUrl: 'https://127.0.0.1/v1' }],
    ['the base URL is localhost', { baseUrl: 'https://localhost:8443/v1' }],
    ['the base URL is a private address', { baseUrl: 'https://10.0.0.5/v1' }],
    ['the base URL is a metadata address', { baseUrl: 'https://169.254.169.254/v1' }],
    ['the base URL is a local name', { baseUrl: 'https://printer.local/v1' }],
    ['the base URL has no model path but a query', { baseUrl: `https://${CLOUD_HOST}/v1?key=1` }],
  ];

  it.each(cases)('when %s', async (_label, overrides) => {
    await configureCloud(overrides);
    installCloudAndOllama(fetch);
    const client = await getAiClient({ purpose: 'chat' });
    expect(client.provider).toBe('ollama');
    expect(client.ai).toEqual({ kind: 'local', host: null });
    const status = await getAiStatus();
    expect(status.effectiveProvider).toBe('ollama');
    expect(status.cloud.active).toBe(false);
    await client.complete({ messages: [{ role: 'user', content: 'hi' }] });
    expect(touchedCloud()).toBe(false);
  });

  it('when BURROW_NETWORK_OPTIN=cloudAi is the only thing set (no consent record)', async () => {
    await configureCloud({ optIn: false, consent: false });
    await setState(NETWORK_STATE_KEY, {});
    process.env.BURROW_NETWORK_OPTIN = 'cloudAi';
    __resetNetPolicyForTests();
    __resetAiForTests();
    installCloudAndOllama(fetch);
    expect((await getAiClient({ purpose: 'chat' })).provider).toBe('ollama');
    expect((await getAiStatus()).cloud).toMatchObject({ optIn: true, keySaved: true, active: false, consent: { current: false } });
    expect(touchedCloud()).toBe(false);
  });

  it('when consent exists for the host but the opt-in env says nothing (stored false wins)', async () => {
    await configureCloud();
    await setState(NETWORK_STATE_KEY, { cloudAi: false });
    __resetNetPolicyForTests();
    installCloudAndOllama(fetch);
    expect((await getAiClient({ purpose: 'chat' })).provider).toBe('ollama');
  });

  it('when consent storage cannot be read, local wins', async () => {
    await configureCloud();
    await setState(CLOUD_CONSENT_KEY, 'garbage');
    installCloudAndOllama(fetch);
    expect((await getAiClient({ purpose: 'chat' })).provider).toBe('ollama');
  });

  it('a stored loopback or private base URL is dropped when settings are read', async () => {
    await configureCloud();
    await setState(AI_SETTINGS_KEY, { provider: 'openai_compat', cloud: { baseUrl: 'https://192.168.1.10/v1', model: 'cloud-model' } });
    installCloudAndOllama(fetch);
    const status = await getAiStatus();
    expect(status.cloud.baseUrl).toBeNull();
    expect(status.cloud.ready).toBe(false);
    expect((await getAiClient({ purpose: 'chat' })).provider).toBe('ollama');
  });

  it('allowCloud: false never returns the cloud client, even fully configured', async () => {
    await configureCloud();
    installCloudAndOllama(fetch);
    expect((await getAiClient({ purpose: 'chat', allowCloud: false })).provider).toBe('ollama');
    expect(touchedCloud()).toBe(false);
  });

  it('a broken cloud setup with no Ollama running reports unavailable instead of going to the cloud', async () => {
    await configureCloud({ consent: false });
    installFakeOllama(fetch, { down: true });
    await expect(getAiClient({ purpose: 'chat' })).rejects.toMatchObject({ code: 'ollama_unavailable' });
    expect(touchedCloud()).toBe(false);
  });
});

describe('the consent follows the host', () => {
  it('consent for one base URL does not cover a different path on the same host', async () => {
    await configureCloud();
    await setState(AI_SETTINGS_KEY, { provider: 'openai_compat', cloud: { baseUrl: `https://${CLOUD_HOST}/other/v2`, model: 'cloud-model' } });
    installCloudAndOllama(fetch);
    expect((await getAiClient({ purpose: 'chat' })).provider).toBe('ollama');
  });

  it('the same consent does not cover a lookalike host', async () => {
    await configureCloud();
    await setState(AI_SETTINGS_KEY, { provider: 'openai_compat', cloud: { baseUrl: `https://${CLOUD_HOST}.evil.example/v1`, model: 'cloud-model' } });
    installCloudAndOllama(fetch);
    expect((await getAiClient({ purpose: 'chat' })).provider).toBe('ollama');
  });
});

describe('Ollama on the network (aiLan) is local for enforcement', () => {
  it('reports kind lan with the hostname and lets every category through', async () => {
    await setState(AI_SETTINGS_KEY, { ollamaHost: 'http://192.0.2.50:11434' });
    await setState(NETWORK_STATE_KEY, { aiLan: true });
    __resetNetPolicyForTests();
    __resetAiForTests();
    const fake = installFakeOllama(fetch);
    const client = await getAiClient({ purpose: 'chat' });
    expect(client.ai).toEqual({ kind: 'lan', host: '192.0.2.50' });
    expect(client.isCloud).toBe(false);
    expect([...client.policy.allowed]).toHaveLength(11);
    const secret = 'SENTINEL_LAN_journal_text';
    await client.complete({ messages: [{ role: 'user', content: secret }] });
    expect(JSON.stringify(fake.chatBodies[0])).toContain(secret);
  });

  it('plain local Ollama reports kind local with no host', async () => {
    installFakeOllama(fetch);
    const client = await getAiClient({ purpose: 'chat' });
    expect(client.ai).toEqual({ kind: 'local', host: null });
    expect((await describeAi('chat')).ai).toEqual({ kind: 'local', host: null });
  });

  it('describeAi on failure reports a local source and no hint', async () => {
    installFakeOllama(fetch, { down: true });
    expect(await describeAi('chat')).toMatchObject({ available: false, ai: { kind: 'local', host: null }, cloudHint: { show: false, reason: null } });
  });
});
