import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { licenseService } from '../licenseService';

const json = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: 'x',
  json: async () => body,
});

let fetchMock;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('licenseService', () => {
  it('GETs the status', async () => {
    fetchMock.mockResolvedValue(json(200, { state: 'free' }));
    await expect(licenseService.get()).resolves.toEqual({ state: 'free' });
    expect(fetchMock.mock.calls[0][0]).toBe('/api/license');
  });

  it('has no file install any more', () => {
    expect(licenseService.install).toBeUndefined();
  });

  it('activate POSTs { licenseKey, store } to /license/activate', async () => {
    fetchMock.mockResolvedValue(json(200, { state: 'pro' }));
    await expect(licenseService.activate({ licenseKey: 'K', store: 'gumroad' })).resolves.toEqual({ state: 'pro' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/license/activate');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ licenseKey: 'K', store: 'gumroad' });
  });

  it('activate omits store when none is given', async () => {
    fetchMock.mockResolvedValue(json(200, { state: 'pro' }));
    await licenseService.activate({ licenseKey: 'K' });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ licenseKey: 'K' });
  });

  it('deactivate POSTs an empty body, or the key when given', async () => {
    fetchMock.mockResolvedValue(json(200, { state: 'free' }));
    await licenseService.deactivate();
    expect(fetchMock.mock.calls[0][0]).toBe('/api/license/deactivate');
    expect(fetchMock.mock.calls[0][1].method).toBe('POST');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({});
    await licenseService.deactivate({ licenseKey: 'K' });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ licenseKey: 'K' });
  });

  it('DELETEs the license', async () => {
    fetchMock.mockResolvedValue(json(200, { state: 'free' }));
    await licenseService.remove();
    expect(fetchMock.mock.calls[0][0]).toBe('/api/license');
    expect(fetchMock.mock.calls[0][1].method).toBe('DELETE');
  });

  it('POSTs the trial notice to dismiss', async () => {
    fetchMock.mockResolvedValue(json(200, { state: 'trial' }));
    await licenseService.dismissTrialNotice('welcome');
    expect(fetchMock.mock.calls[0][0]).toBe('/api/license/trial/notice');
    expect(fetchMock.mock.calls[0][1].method).toBe('POST');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ notice: 'welcome' });
  });

  it('has no manual trial start any more', () => {
    expect(licenseService.startTrial).toBeUndefined();
  });

  it('maps a store error to status, code and the server message', async () => {
    fetchMock.mockResolvedValue(json(422, { error: 'uses_exceeded', message: 'Email help@example.test.' }));
    await expect(licenseService.activate({ licenseKey: 'K' })).rejects.toMatchObject({
      status: 422,
      code: 'uses_exceeded',
      message: 'Email help@example.test.',
    });
  });

  it('keeps detail on license_expired', async () => {
    fetchMock.mockResolvedValue(
      json(422, { error: 'license_expired', message: 'Ended.', detail: { endedAt: '2026-01-01T00:00:00Z' } }),
    );
    await expect(licenseService.activate({ licenseKey: 'K' })).rejects.toMatchObject({
      code: 'license_expired',
      detail: { endedAt: '2026-01-01T00:00:00Z' },
    });
  });

  it('reads the code of a rate_limited body', async () => {
    fetchMock.mockResolvedValue(json(429, { error: 'rate_limited', code: 'rate_limited', message: 'Wait.' }));
    await expect(licenseService.activate({ licenseKey: 'K' })).rejects.toMatchObject({
      status: 429,
      code: 'rate_limited',
    });
  });

  it('never surfaces the HTTP status text as the message when the server sent none', async () => {
    fetchMock.mockResolvedValue(json(503, { error: 'store_unreachable' }));
    await expect(licenseService.activate({ licenseKey: 'K' })).rejects.toMatchObject({
      status: 503,
      code: 'store_unreachable',
      message: '',
    });
  });

  it('survives a non-JSON error body', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Server Error',
      json: async () => {
        throw new Error('bad json');
      },
    });
    await expect(licenseService.get()).rejects.toMatchObject({ status: 500 });
  });
});
