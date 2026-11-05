// recordNetworkCall and recordNetworkCallCoalesced never throw to callers.
import { describe, it, expect, vi, beforeEach } from 'vitest';

beforeEach(() => {
  vi.resetModules();
  vi.doUnmock('../netPolicy.js');
  vi.doUnmock('../auditHook.js');
});

describe('network call writers never throw', () => {
  it('survives a rejected netPolicy import', async () => {
    vi.doMock('../netPolicy.js', () => {
      throw new Error('load failed');
    });
    const { recordNetworkCall, recordNetworkCallCoalesced } = await import('../networkCall.js');
    await expect(recordNetworkCall('weather', 'https://api.open-meteo.com', 'ok')).resolves.toBeUndefined();
    await expect(recordNetworkCallCoalesced('weather', 'https://api.open-meteo.com', 'ok')).resolves.toBeUndefined();
  });

  it('survives a throwing audit sink', async () => {
    const recordAudit = vi.fn(() => {
      throw new Error('sink failed');
    });
    vi.doMock('../auditHook.js', () => ({ recordAudit }));
    vi.doMock('../netPolicy.js', () => ({ isFeatureId: () => true }));
    const { recordNetworkCall, recordNetworkCallCoalesced } = await import('../networkCall.js');
    await expect(recordNetworkCall('weather', 'https://api.open-meteo.com', 'ok')).resolves.toBeUndefined();
    await expect(recordNetworkCallCoalesced('weather', 'https://api.open-meteo.com', 'ok')).resolves.toBeUndefined();
    expect(recordAudit).toHaveBeenCalled();
  });
});
