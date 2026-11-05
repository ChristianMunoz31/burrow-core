import { afterEach, describe, expect, it, vi } from 'vitest';
import { transactionImportService } from '../transactionImportService';

const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const ROWS = [{ date: '2026-05-01', merchant: 'Coffee Shop', amount: -4.5, category: 'Other' }];
const RESULT = { received: 1, inserted: 1, duplicates: 0, duplicateIndexes: [], dryRun: false };

afterEach(() => vi.unstubAllGlobals());

describe('transactionImportService.importRows', () => {
  it('POSTs the commit to /api/transactions/import with rows, source and fileName', async () => {
    const fetchMock = vi.fn(async () => json(200, { data: RESULT }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      transactionImportService.importRows({ rows: ROWS, source: 'file', fileName: 'bank.csv' }),
    ).resolves.toEqual(RESULT);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/transactions/import');
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual({ rows: ROWS, source: 'file', fileName: 'bank.csv' });
  });

  it('adds ?dryRun=1 for a preview and omits fileName when absent', async () => {
    const fetchMock = vi.fn(async () => json(200, { data: { ...RESULT, dryRun: true } }));
    vi.stubGlobal('fetch', fetchMock);
    const res = await transactionImportService.importRows({ rows: ROWS, source: 'sheet', dryRun: true });
    expect(res.dryRun).toBe(true);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/transactions/import?dryRun=1');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ rows: ROWS, source: 'sheet' });
  });

  it.each([
    ['invalid_request', /could not use that request/],
    ['invalid_rows', /Some rows were not accepted/],
    ['too_many_rows', /more than 5,000/],
    ['too_large', /too big/],
    ['rate_limited', /Wait a minute/],
    ['not_configured', /not set up/],
    ['server_error', /Something went wrong on our side/],
  ])('maps %s to plain copy and never shows the server error text', async (code, pattern) => {
    vi.stubGlobal('fetch', vi.fn(async () => json(400, { error: 'raw server text', code })));
    const err = await transactionImportService.importRows({ rows: ROWS, source: 'file' }).catch((e) => e);
    expect(err.message).toMatch(pattern);
    expect(err.message).not.toMatch(/raw server text/);
    expect(err.code).toBe(code);
    expect(err.status).toBe(400);
  });

  it('keeps details for invalid_rows and falls back for unknown codes and bodies', async () => {
    const details = [{ index: 0, field: 'date' }];
    vi.stubGlobal('fetch', vi.fn(async () => json(400, { code: 'invalid_rows', details })));
    const a = await transactionImportService.importRows({ rows: ROWS, source: 'file' }).catch((e) => e);
    expect(a.details).toEqual(details);

    vi.stubGlobal('fetch', vi.fn(async () => json(500, { code: 'brand_new' })));
    const b = await transactionImportService.importRows({ rows: ROWS, source: 'file' }).catch((e) => e);
    expect(b.message).toMatch(/nothing was imported/);

    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 502, json: async () => Promise.reject(new Error('x')) })));
    const c = await transactionImportService.importRows({ rows: ROWS, source: 'file' }).catch((e) => e);
    expect(c.message).toMatch(/nothing was imported/);
    expect(c.status).toBe(502);
  });

  it('treats a 200 without data as a failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(200, {})));
    await expect(transactionImportService.importRows({ rows: ROWS, source: 'file' })).rejects.toThrow(
      /nothing was imported/,
    );
  });

  it('reports an unreachable server', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))));
    await expect(transactionImportService.importRows({ rows: ROWS, source: 'file' })).rejects.toThrow(
      /could not be reached/,
    );
  });
});
