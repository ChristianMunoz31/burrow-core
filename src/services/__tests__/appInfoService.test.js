import { afterEach, describe, expect, it, vi } from 'vitest';
import { getAppInfo } from '../appInfoService';

const respond = (body, init = {}) =>
  vi.fn().mockResolvedValue({
    ok: init.ok ?? true,
    status: init.status ?? 200,
    statusText: init.statusText ?? 'OK',
    json: init.json ?? (async () => body),
  });

afterEach(() => vi.unstubAllGlobals());

describe('getAppInfo', () => {
  it('returns the data object from /api/app/info', async () => {
    const data = { version: '0.1.0', channel: 'stable', desktop: true };
    const fetchMock = respond({ data });
    vi.stubGlobal('fetch', fetchMock);
    await expect(getAppInfo()).resolves.toEqual(data);
    expect(fetchMock).toHaveBeenCalledWith('/api/app/info', { cache: 'no-store' });
  });

  it('throws an API error with the status when the answer is not ok', async () => {
    vi.stubGlobal('fetch', respond({ message: 'Nope.' }, { ok: false, status: 500, statusText: 'Server Error' }));
    await expect(getAppInfo()).rejects.toMatchObject({ message: 'Nope.', status: 500 });
  });

  it('throws when the body is malformed', async () => {
    vi.stubGlobal('fetch', respond({ data: null }));
    await expect(getAppInfo()).rejects.toThrow('The app info answer was not understood.');
  });

  it('throws when the body is not JSON', async () => {
    vi.stubGlobal(
      'fetch',
      respond(null, {
        json: async () => {
          throw new SyntaxError('bad');
        },
      }),
    );
    await expect(getAppInfo()).rejects.toThrow('The app info answer was not understood.');
  });
});
