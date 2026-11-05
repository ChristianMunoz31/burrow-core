import { afterEach, describe, expect, it, vi } from 'vitest';
import { IMPORT_MAX_BYTES, importExportZip } from '../importService';

const DATA = {
  dryRun: true,
  tables: [{ id: 'notes', received: 2, inserted: 1, updated: 1, skipped: 0 }],
  totals: { received: 2, inserted: 1, updated: 1, skipped: 0 },
};

const jsonResponse = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const zip = (size = 4) => new File([new Uint8Array(size)], 'export.zip', { type: 'application/zip' });

afterEach(() => vi.unstubAllGlobals());

describe('importExportZip', () => {
  it('posts the raw ZIP with ?dryRun=1 and unwraps the data envelope', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { data: DATA }));
    vi.stubGlobal('fetch', fetchMock);
    const file = zip();
    const result = await importExportZip(file, { dryRun: true });
    expect(result).toEqual(DATA);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/import?dryRun=1');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Content-Type': 'application/zip' });
    expect(init.body).toBe(file);
  });

  it('omits the dry-run flag for a real import', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { data: { ...DATA, dryRun: false } }));
    vi.stubGlobal('fetch', fetchMock);
    await importExportZip(zip());
    expect(fetchMock.mock.calls[0][0]).toBe('/api/import');
  });

  it('rejects an oversize file without calling the server', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const big = { size: IMPORT_MAX_BYTES + 1 };
    await expect(importExportZip(big)).rejects.toThrow('too large to restore here');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [429, { error: 'x', code: 'rate_limited' }, 'Too many imports. Try again in a few minutes.'],
    [401, { error: 'Unauthorized' }, 'Your session expired. Sign in again and retry.'],
    [403, { error: 'x', code: 'auth_required' }, 'Import requires sign-in to be enabled.'],
    [503, { error: 'x', code: 'not_configured' }, "Burrow can't open your data file. Try restarting Burrow."],
    [413, { error: 'x', code: 'import_too_large' }, 'This file is too large to restore here.'],
    [400, { error: 'The file is not a valid export archive.', code: 'invalid_archive' }, 'The file is not a valid export archive.'],
    [500, { error: 'SELECT secret FROM boom', code: 'server_error' }, 'Import failed. Try again.'],
  ])('maps status %s %j to a user-safe message', async (status, body, message) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(status, body)));
    await expect(importExportZip(zip())).rejects.toThrow(message);
  });

  it('reports a network failure and passes aborts through', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await expect(importExportZip(zip())).rejects.toThrow("Couldn't reach the server");
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(Object.assign(new Error('x'), { name: 'AbortError' })));
    await expect(importExportZip(zip())).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('rejects a malformed success body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, { data: {} })));
    await expect(importExportZip(zip())).rejects.toThrow('Import failed. Try again.');
  });
});
