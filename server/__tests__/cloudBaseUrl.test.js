// SSRF protection for the cloud endpoint: validateCloudBaseUrl at save time, and the
// connect-time guarded lookup on the cloud https agent (DNS rebinding). No real DNS or network.
import https from 'node:https';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('node-fetch', () => ({ default: vi.fn() }));

import fetch from 'node-fetch';
import { CLOUD_HOST, CLOUD_KEY, SENTINELS } from './helpers/fakeCloud.js';
import { __setCloudDnsLookupForTests, cloudHttpsAgent, guardedLookup, isBlockedHostname, isPublicIp } from '../ai/cloudGuard.js';
import { validateCloudBaseUrl, validateEndpointUrl } from '../ai/settings.js';
import { chatCompletionsUrl } from '../ai/providers/openaiCompat.js';
import { chatWithTools } from '../ai/llmClient.js';

afterEach(() => {
  __setCloudDnsLookupForTests();
  fetch.mockReset();
});

describe('isPublicIp', () => {
  it.each([
    '0.0.0.0',
    '0.1.2.3',
    '10.0.0.1',
    '10.255.255.255',
    '100.64.0.1',
    '100.127.255.255',
    '127.0.0.1',
    '127.255.255.254',
    '169.254.169.254',
    '172.16.0.1',
    '172.31.255.255',
    '192.0.0.8',
    '192.0.2.1',
    '192.168.1.1',
    '198.18.0.1',
    '198.19.255.255',
    '198.51.100.7',
    '203.0.113.9',
    '224.0.0.1',
    '239.255.255.255',
    '240.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    'febf::1',
    'ff02::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:10.1.2.3',
    '::ffff:a9fe:a9fe',
    '::ffff:192.168.0.1',
    '64:ff9b::7f00:1',
    '64:ff9b::808:808',
    '2001:db8::1',
    '2001:0:4136:e378:8000:63bf:3fff:fdd2',
    '2002:7f00:1::1',
    '[::1]',
    'not an ip',
    '',
    'example.com',
  ])('refuses %s', (addr) => {
    expect(isPublicIp(addr)).toBe(false);
  });

  it.each(['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.15.255.255', '172.32.0.1', '100.63.255.255', '100.128.0.1', '169.253.1.1', '198.17.255.255', '198.20.0.1', '223.255.255.255', '2606:4700:4700::1111', '2a00:1450:4009:81f::200e', '::ffff:8.8.8.8', '::ffff:808:808'])(
    'accepts %s',
    (addr) => {
      expect(isPublicIp(addr)).toBe(true);
    },
  );

  it('refuses anything that is not a string', () => {
    for (const v of [null, undefined, 5, {}, ['8.8.8.8']]) expect(isPublicIp(v)).toBe(false);
  });
});

describe('isBlockedHostname', () => {
  it.each([
    'localhost',
    'LOCALHOST',
    'localhost.',
    'api.localhost',
    'a.b.localhost',
    'db.internal',
    'metadata.google.internal',
    'printer.local',
    'nas.lan',
    'router.home.arpa',
    'home.arpa',
    'intranet',
    'api',
    '',
    '127.0.0.1',
    '[::1]',
    '10.1.1.1',
  ])('blocks %s', (name) => {
    expect(isBlockedHostname(name)).toBe(true);
  });

  it.each(['api.example.com', 'API.Example.COM.', 'api.openai.com', 'localhost.example.com', 'internal.example.com', 'local.example.org', '8.8.8.8'])('allows %s', (name) => {
    expect(isBlockedHostname(name)).toBe(false);
  });

  it('blocks non-strings', () => {
    expect(isBlockedHostname(undefined)).toBe(true);
    expect(isBlockedHostname(7)).toBe(true);
  });
});

describe('validateCloudBaseUrl', () => {
  it('accepts a public https URL with a path and returns the normalised parts', () => {
    expect(validateCloudBaseUrl('https://api.example.com/v1')).toEqual({ ok: true, url: 'https://api.example.com/v1', origin: 'https://api.example.com', hostname: 'api.example.com' });
    expect(validateCloudBaseUrl('  https://API.Example.com/v1/  ')).toMatchObject({ ok: true, url: 'https://api.example.com/v1', hostname: 'api.example.com' });
    expect(validateCloudBaseUrl('https://api.example.com')).toMatchObject({ ok: true, url: 'https://api.example.com' });
    expect(validateCloudBaseUrl('https://api.example.com:8443/openai/v1')).toMatchObject({ ok: true, hostname: 'api.example.com' });
    expect(validateCloudBaseUrl('https://8.8.8.8/v1')).toMatchObject({ ok: true, hostname: '8.8.8.8' });
    expect(validateCloudBaseUrl('https://[2606:4700:4700::1111]/v1')).toMatchObject({ ok: true });
  });

  it.each([
    [undefined, 'not_a_string'],
    [null, 'not_a_string'],
    [5, 'not_a_string'],
    ['', 'length'],
    ['   ', 'length'],
    [`https://${'a'.repeat(250)}.com/v1`, 'length'],
    ['https://api.example.com/v1?key=1', 'query_or_hash'],
    ['https://api.example.com/v1?', 'query_or_hash'],
    ['https://api.example.com/v1#frag', 'query_or_hash'],
    ['https://api.example.com/v 1', 'query_or_hash'],
    ['not a url', 'query_or_hash'],
    ['https://', 'unparseable'],
    ['ftp://api.example.com/v1', 'protocol'],
    ['file:///etc/passwd', 'protocol'],
    ['javascript:alert(1)', 'protocol'],
    ['https://user:pw@api.example.com/v1', 'credentials'],
    ['https://user@api.example.com/v1', 'credentials'],
    ['http://api.example.com/v1', 'https_required'],
  ])('rejects %j as %s', (raw, reason) => {
    expect(validateCloudBaseUrl(raw)).toEqual({ ok: false, reason });
  });

  it.each([
    'https://127.0.0.1/v1',
    'https://127.0.0.1:8443/v1',
    'https://127.1/v1',
    'https://2130706433/v1',
    'https://0x7f000001/v1',
    'https://0177.0.0.1/v1',
    'https://0.0.0.0/v1',
    'https://[::]/v1',
    'https://[::1]/v1',
    'https://[::ffff:127.0.0.1]/v1',
    'https://[::ffff:7f00:1]/v1',
    'https://[64:ff9b::7f00:1]/v1',
    'https://10.0.0.5/v1',
    'https://172.16.5.5/v1',
    'https://192.168.1.10/v1',
    'https://100.64.0.1/v1',
    'https://169.254.169.254/latest/meta-data',
    'https://[fe80::1]/v1',
    'https://[fd00::1]/v1',
    'http://127.0.0.1:11434',
    'http://169.254.169.254/v1',
  ])('rejects the private address %s as private_address', (raw) => {
    expect(validateCloudBaseUrl(raw)).toEqual({ ok: false, reason: 'private_address' });
  });

  it.each([
    'https://localhost/v1',
    'https://LOCALHOST:3000/v1',
    'https://localhost./v1',
    'https://api.localhost/v1',
    'https://db.internal/v1',
    'https://printer.local/v1',
    'https://nas.lan/v1',
    'https://router.home.arpa/v1',
    'https://intranet/v1',
    'https://ollama/v1',
    'http://localhost:11434',
  ])('rejects the local name %s as local_name', (raw) => {
    expect(validateCloudBaseUrl(raw)).toEqual({ ok: false, reason: 'local_name' });
  });

  it('never keeps a dot-dot segment: the URL parser resolves it before the path is stored', () => {
    for (const raw of ['https://api.example.com/v1/../admin', 'https://api.example.com/v1/%2e%2e/admin', 'https://api.example.com/v1/%2E%2E/%2e/admin']) {
      const v = validateCloudBaseUrl(raw);
      if (v.ok) expect(v.url).not.toMatch(/\.\.|%2e/i);
    }
  });

  it('pins the WHATWG normalisation that makes the numeric loopback spellings dotted', () => {
    expect(new URL('https://2130706433/').hostname).toBe('127.0.0.1');
    expect(new URL('https://0x7f000001/').hostname).toBe('127.0.0.1');
    expect(new URL('https://0177.0.0.1/').hostname).toBe('127.0.0.1');
    expect(new URL('https://127.1/').hostname).toBe('127.0.0.1');
    expect(new URL('https://[::ffff:127.0.0.1]/').hostname).toBe('[::ffff:7f00:1]');
  });

  it('leaves the Ollama host validator alone: loopback http still passes there', () => {
    expect(validateEndpointUrl('http://127.0.0.1:11434')).toMatchObject({ ok: true, loopback: true });
    expect(validateEndpointUrl('http://192.168.1.20:11434')).toMatchObject({ ok: true, loopback: false });
  });
});

describe('guardedLookup (connect-time check)', () => {
  const resolver = (answers, err = null) =>
    vi.fn((hostname, opts, cb) => {
      queueMicrotask(() => (err ? cb(err) : cb(null, answers)));
    });
  const run = (hostname, opts = {}) => new Promise((resolve) => guardedLookup(hostname, opts, (...args) => resolve(args)));

  it('passes a public answer through, in both the single and the all shape', async () => {
    const fn = resolver([{ address: '93.184.216.34', family: 4 }]);
    __setCloudDnsLookupForTests(fn);
    expect(await run(CLOUD_HOST)).toEqual([null, '93.184.216.34', 4]);
    expect(await run(CLOUD_HOST, { all: true })).toEqual([null, [{ address: '93.184.216.34', family: 4 }]]);
    // The resolver is always asked for every answer so none can hide behind the first.
    expect(fn.mock.calls.every(([, opts]) => opts.all === true)).toBe(true);
  });

  it.each([
    ['loopback', '127.0.0.1'],
    ['private', '10.0.0.8'],
    ['metadata', '169.254.169.254'],
    ['IPv6 loopback', '::1'],
    ['IPv4-mapped loopback', '::ffff:127.0.0.1'],
    ['unique local', 'fd00::5'],
  ])('refuses a public-looking name that resolves to %s (DNS rebinding)', async (_label, address) => {
    __setCloudDnsLookupForTests(resolver([{ address, family: address.includes(':') ? 6 : 4 }]));
    const [err] = await run('api.example.com');
    expect(err).toMatchObject({ code: 'ECLOUDPRIVATE' });
  });

  it('refuses when ANY answer is private, even if the first is public', async () => {
    __setCloudDnsLookupForTests(
      resolver([
        { address: '93.184.216.34', family: 4 },
        { address: '192.168.1.5', family: 4 },
      ]),
    );
    expect((await run('api.example.com', { all: true }))[0]).toMatchObject({ code: 'ECLOUDPRIVATE' });
  });

  it('refuses an empty answer and a blocked name without resolving at all', async () => {
    const fn = resolver([]);
    __setCloudDnsLookupForTests(fn);
    expect((await run('api.example.com'))[0]).toMatchObject({ code: 'ECLOUDPRIVATE' });
    fn.mockClear();
    expect((await run('localhost'))[0]).toMatchObject({ code: 'ECLOUDPRIVATE' });
    expect((await run('db.internal'))[0]).toMatchObject({ code: 'ECLOUDPRIVATE' });
    expect(fn).not.toHaveBeenCalled();
  });

  it('passes a resolver error through unchanged', async () => {
    const boom = Object.assign(new Error('nope'), { code: 'ENOTFOUND' });
    __setCloudDnsLookupForTests(resolver(null, boom));
    expect((await run('api.example.com'))[0]).toBe(boom);
  });

  it('accepts the callback as the second argument', async () => {
    __setCloudDnsLookupForTests(resolver([{ address: '8.8.8.8', family: 4 }]));
    const out = await new Promise((resolve) => guardedLookup('api.example.com', (...args) => resolve(args)));
    expect(out).toEqual([null, '8.8.8.8', 4]);
  });
});

describe('the cloud https agent', () => {
  it('is a shared keep-alive agent whose lookup is the guarded one', () => {
    const agent = cloudHttpsAgent();
    expect(agent).toBeInstanceOf(https.Agent);
    expect(cloudHttpsAgent()).toBe(agent);
    expect(agent.options.lookup).toBe(guardedLookup);
    expect(agent.keepAlive).toBe(true);
  });

  it('the cloud transport passes that agent on every request and keeps refusing redirects', async () => {
    fetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }), headers: { get: () => null } });
    await chatWithTools({ url: chatCompletionsUrl('https://api.example.com/v1'), baseURL: 'https://api.example.com/v1', apiKey: CLOUD_KEY, model: 'm', messages: [{ role: 'user', content: 'x' }] });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://api.example.com/v1/chat/completions');
    expect(init.agent).toBe(cloudHttpsAgent());
    expect(init.redirect).toBe('error');
  });

  it('a refused private address surfaces as "unavailable" and never echoes provider text or the key', async () => {
    fetch.mockRejectedValue(Object.assign(new Error(`request to https://api.example.com failed, reason: ${SENTINELS.memory}`), { code: 'ECLOUDPRIVATE', name: 'FetchError' }));
    const err = await chatWithTools({ url: 'https://api.example.com/v1/chat/completions', baseURL: 'https://api.example.com/v1', apiKey: CLOUD_KEY, model: 'm', messages: [] }).catch((e) => e);
    expect(err).toMatchObject({ code: 'unavailable', provider: 'openai_compat' });
    expect(err.message).toBe('Cloud AI request failed');
    expect(err.message).not.toContain(SENTINELS.memory);
    expect(err.message).not.toContain(CLOUD_KEY);
  });
});
