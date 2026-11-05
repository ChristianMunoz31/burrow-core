import { afterEach, describe, expect, it, vi } from 'vitest';
import { auditService } from '../auditService';
import { GENERIC_ERROR } from '../../utils/apiError';

const respond = (body, init = {}) =>
  vi.fn().mockResolvedValue({
    ok: init.ok ?? true,
    status: init.status ?? 200,
    statusText: init.statusText ?? 'OK',
    json: async () => body,
  });

afterEach(() => vi.unstubAllGlobals());

describe('auditService.list', () => {
  it('requests /api/audit with the default limit, no cursor, and no-store', async () => {
    const fetchMock = respond({ data: { entries: [], nextBefore: null, available: true } });
    vi.stubGlobal('fetch', fetchMock);
    await auditService.list();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/audit?limit=50');
    expect(init).toMatchObject({ cache: 'no-store' });
  });

  it('percent-encodes the "+" in a timestamptz cursor so the offset round-trips', async () => {
    const fetchMock = respond({ data: { entries: [], nextBefore: null, available: true } });
    vi.stubGlobal('fetch', fetchMock);
    const cursor = '2026-01-01T00:00:00.123456+00:00';
    await auditService.list({ before: cursor, limit: 25 });
    const requested = fetchMock.mock.calls[0][0];
    const url = new URL(requested, 'http://localhost');
    expect(requested).toContain('%2B00%3A00');
    expect(requested).not.toMatch(/\+00/);
    expect(url.searchParams.get('before')).toBe(cursor);
    expect(url.searchParams.get('limit')).toBe('25');
  });

  it('omits before when it is null or empty', async () => {
    const fetchMock = respond({ data: { entries: [], nextBefore: null, available: true } });
    vi.stubGlobal('fetch', fetchMock);
    await auditService.list({ before: null });
    await auditService.list({ before: '' });
    for (const call of fetchMock.mock.calls) expect(call[0]).not.toContain('before');
  });

  it('unwraps the { data } envelope', async () => {
    const data = { entries: [{ id: '1' }], nextBefore: 'x', available: true };
    vi.stubGlobal('fetch', respond({ data }));
    await expect(auditService.list()).resolves.toEqual(data);
  });

  it('passes available:false through unchanged', async () => {
    const data = { entries: [], nextBefore: null, available: false, reason: 'schema_missing' };
    vi.stubGlobal('fetch', respond({ data }));
    await expect(auditService.list()).resolves.toEqual(data);
  });

  it('throws an Error with status and code but never the raw error string', async () => {
    vi.stubGlobal(
      'fetch',
      respond({ error: 'Invalid query', code: 'invalid_query' }, { ok: false, status: 400, statusText: 'Bad Request' }),
    );
    await expect(auditService.list()).rejects.toMatchObject({
      message: GENERIC_ERROR,
      status: 400,
      code: 'invalid_query',
    });
  });

  it('uses the generic message, never statusText, when the error body is not JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        json: async () => {
          throw new Error('not json');
        },
      }),
    );
    await expect(auditService.list()).rejects.toMatchObject({ message: GENERIC_ERROR, status: 401 });
  });

  it('passes the abort signal through to fetch', async () => {
    const fetchMock = respond({ data: { entries: [], nextBefore: null, available: true } });
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    await auditService.list({ signal: controller.signal });
    expect(fetchMock.mock.calls[0][1].signal).toBe(controller.signal);
  });

  it.each([
    ['an empty object body', {}],
    ['a null body', null],
    ['a missing entries array', { data: { nextBefore: null, available: true } }],
    ['non-array entries', { data: { entries: 'nope', nextBefore: null, available: true } }],
    ['a null data', { data: null }],
  ])('throws on %s instead of returning undefined', async (_name, body) => {
    vi.stubGlobal('fetch', respond(body));
    await expect(auditService.list()).rejects.toThrow(/Unexpected response/);
  });

  it('reads a null or non-object error body defensively', async () => {
    vi.stubGlobal('fetch', respond(null, { ok: false, status: 500, statusText: 'Server Error' }));
    await expect(auditService.list()).rejects.toMatchObject({ message: GENERIC_ERROR, status: 500, code: undefined });
  });
});
