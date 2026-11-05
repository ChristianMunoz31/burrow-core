import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { aiSettingsService } from '../aiSettingsService';
import { jsonResponse } from '../../test-utils/sseResponse';

const mockFetch = vi.fn();
beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
  mockFetch.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

const lastCall = () => {
  const [url, init] = mockFetch.mock.calls.at(-1);
  return { url, method: init.method, body: JSON.parse(init.body) };
};

describe('aiSettingsService cloud calls', () => {
  it('enableCloud posts the consent body to /cloud/enable and returns the payload', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: { cloud: { active: true } } }));
    const out = await aiSettingsService.enableCloud({
      version: 1,
      host: 'api.example.com',
      baseUrl: 'https://api.example.com/v1',
      acknowledgements: ['sends_data', 'pay_provider'],
    });
    expect(out).toEqual({ cloud: { active: true } });
    expect(lastCall()).toEqual({
      url: '/api/settings/ai/cloud/enable',
      method: 'POST',
      body: {
        version: 1,
        host: 'api.example.com',
        baseUrl: 'https://api.example.com/v1',
        acknowledgements: ['sends_data', 'pay_provider'],
      },
    });
  });

  it('disableCloud posts an empty body to /cloud/disable', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: { cloud: { active: false } } }));
    await aiSettingsService.disableCloud();
    expect(lastCall()).toEqual({ url: '/api/settings/ai/cloud/disable', method: 'POST', body: {} });
  });

  it('setCloudCategories puts the partial map under categories', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: {} }));
    await aiSettingsService.setCloudCategories({ journal: true });
    expect(lastCall()).toEqual({
      url: '/api/settings/ai/cloud-categories',
      method: 'PUT',
      body: { categories: { journal: true } },
    });
  });

  it('cloudHint posts the event', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: { cloudHint: { show: false, reason: null } } }));
    expect(await aiSettingsService.cloudHint('dismissed')).toEqual({ cloudHint: { show: false, reason: null } });
    expect(lastCall()).toEqual({ url: '/api/settings/ai/cloud-hint', method: 'POST', body: { event: 'dismissed' } });
  });

  it('keeps the error code and reason from a failed enable', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ error: 'host_changed', code: 'host_changed' }, 409));
    await expect(
      aiSettingsService.enableCloud({ version: 1, host: 'x.example.com', acknowledgements: [] }),
    ).rejects.toMatchObject({ code: 'host_changed', status: 409 });
    mockFetch.mockResolvedValueOnce(jsonResponse({ error: 'invalid_host', code: 'invalid_host', reason: 'https_required' }, 400));
    await expect(
      aiSettingsService.setCloud({ baseUrl: 'http://api.example.com', model: 'm', tokenParam: 'max_tokens' }),
    ).rejects.toMatchObject({ code: 'invalid_host', reason: 'https_required' });
  });
});
