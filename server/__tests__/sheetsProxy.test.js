// Google Sheets CSV proxy: opt-in gate, timeout signal, redirect hop allowlist, size cap.
// node-fetch is stubbed; nothing here touches the network.
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import { Readable } from 'node:stream';

vi.mock('../../loadEnv.js', () => ({}));
const fetchMock = vi.hoisted(() => vi.fn());
vi.mock('node-fetch', () => ({ default: fetchMock }));

let app;
let netPolicy;
const saved = { enc: process.env.SECRETS_ENCRYPTION_KEY, optin: process.env.BURROW_NETWORK_OPTIN };
afterAll(() => {
  if (saved.enc === undefined) delete process.env.SECRETS_ENCRYPTION_KEY;
  else process.env.SECRETS_ENCRYPTION_KEY = saved.enc;
  if (saved.optin === undefined) delete process.env.BURROW_NETWORK_OPTIN;
  else process.env.BURROW_NETWORK_OPTIN = saved.optin;
});

beforeAll(async () => {
  delete process.env.SECRETS_ENCRYPTION_KEY;
  delete process.env.APP_PASSWORD;
  delete process.env.AUTH_SECRET;
  app = (await import('../../server.js')).default;
  netPolicy = await import('../netPolicy.js');
});

beforeEach(() => {
  fetchMock.mockReset();
  process.env.BURROW_NETWORK_OPTIN = 'sheets';
  netPolicy.__resetNetPolicyForTests();
});

const URL_OK = 'https://docs.google.com/spreadsheets/d/e/abc/pub?output=csv';
const get = (url = URL_OK, ip = '198.51.100.1') =>
  request(app).get('/api/sheets/csv').set('X-Forwarded-For', ip).query({ url });
const csvResponse = (body, init = {}) => ({
  ok: true,
  status: 200,
  headers: new Map(),
  text: async () => body,
  ...init,
});
const redirect = (location) => ({ ok: false, status: 302, headers: new Map([['location', location]]) });

describe('/api/sheets/csv', () => {
  it('is a registered, default-off network feature', async () => {
    const list = await netPolicy.listNetworkFeatures();
    const sheets = list.features.find((f) => f.id === 'sheets');
    expect(sheets).toMatchObject({ label: 'Google Sheets import', hosts: ['docs.google.com', '*.googleusercontent.com'] });
    delete process.env.BURROW_NETWORK_OPTIN;
    netPolicy.__resetNetPolicyForTests();
    expect(await netPolicy.isEnabled('sheets')).toBe(false);
  });

  it('403 network_opt_in_required while the feature is off, with no fetch', async () => {
    delete process.env.BURROW_NETWORK_OPTIN;
    netPolicy.__resetNetPolicyForTests();
    const res = await get(URL_OK, '198.51.100.2');
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: 'network_opt_in_required', feature: 'sheets' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns the CSV and passes a timeout signal with redirect: manual', async () => {
    fetchMock.mockResolvedValueOnce(csvResponse('a,b\n1,2\n'));
    const res = await get(URL_OK, '198.51.100.3');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ csv: 'a,b\n1,2\n' });
    const opts = fetchMock.mock.calls[0][1];
    expect(opts.redirect).toBe('manual');
    expect(opts.signal).toBeInstanceOf(AbortSignal);
  });

  it('sends Cache-Control: no-store on success and on errors', async () => {
    fetchMock.mockResolvedValueOnce(csvResponse('a\n1\n'));
    const ok = await get(URL_OK, '198.51.100.20');
    expect(ok.status).toBe(200);
    expect(ok.headers['cache-control']).toBe('no-store');
    const bad = await get('https://evil.example.com/x.csv', '198.51.100.21');
    expect(bad.status).toBe(400);
    expect(bad.headers['cache-control']).toBe('no-store');
    delete process.env.BURROW_NETWORK_OPTIN;
    netPolicy.__resetNetPolicyForTests();
    const denied = await get(URL_OK, '198.51.100.22');
    expect(denied.status).toBe(403);
    expect(denied.headers['cache-control']).toBe('no-store');
  });

  it('follows a redirect to *.googleusercontent.com', async () => {
    fetchMock
      .mockResolvedValueOnce(redirect('https://doc-0c-abc-sheets.googleusercontent.com/export/x.csv'))
      .mockResolvedValueOnce(csvResponse('x\n'));
    const res = await get(URL_OK, '198.51.100.4');
    expect(res.status).toBe(200);
    expect(fetchMock.mock.calls[1][0]).toBe('https://doc-0c-abc-sheets.googleusercontent.com/export/x.csv');
  });

  it.each([
    'http://doc-0c.googleusercontent.com/x.csv',
    'https://evil.example.com/x.csv',
    'https://googleusercontent.com.evil.com/x.csv',
    'https://169.254.169.254/latest/meta-data',
  ])('rejects a redirect hop to %s', async (target) => {
    fetchMock.mockResolvedValueOnce(redirect(target));
    const res = await get(URL_OK, '198.51.100.5');
    expect(res.status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not accept googleusercontent.com as the initial URL', async () => {
    const res = await get('https://doc-0c.googleusercontent.com/x.csv', '198.51.100.6');
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('413 when content-length exceeds the cap', async () => {
    fetchMock.mockResolvedValueOnce(csvResponse('x', { headers: new Map([['content-length', String(6 * 1024 * 1024)]]) }));
    const res = await get(URL_OK, '198.51.100.7');
    expect(res.status).toBe(413);
  });

  it('413 when a streamed body exceeds the cap', async () => {
    const big = Buffer.alloc(1024 * 1024, 97);
    const body = Readable.from(Array.from({ length: 6 }, () => big));
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, headers: new Map(), body });
    const res = await get(URL_OK, '198.51.100.8');
    expect(res.status).toBe(413);
  });

  it('504 on timeout, with a generic body', async () => {
    fetchMock.mockRejectedValueOnce(Object.assign(new Error('secret detail'), { name: 'TimeoutError' }));
    const res = await get(URL_OK, '198.51.100.9');
    expect(res.status).toBe(504);
    expect(JSON.stringify(res.body)).not.toContain('secret');
  });

  it('502 with a generic body on other failures', async () => {
    fetchMock.mockRejectedValueOnce(new Error('connect ECONNREFUSED 10.0.0.1'));
    const res = await get(URL_OK, '198.51.100.10');
    expect(res.status).toBe(502);
    expect(JSON.stringify(res.body)).not.toContain('10.0.0.1');
  });
});
