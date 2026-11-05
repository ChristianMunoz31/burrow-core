import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { downloadExport } from '../exportService';

const zipResponse = (bytes = [1, 2, 3, 4], headers = {}) =>
  new Response(new Uint8Array(bytes), { status: 200, headers: { 'X-Export-Complete': '1', ...headers } });
const errorResponse = (status, body) => new Response(JSON.stringify(body), { status });

describe('downloadExport', () => {
  let click;
  beforeEach(() => {
    URL.createObjectURL = vi.fn(() => 'blob:x');
    URL.revokeObjectURL = vi.fn();
    click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('uses the filename from Content-Disposition and returns the byte count and completeness', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        zipResponse([1, 2, 3, 4], { 'Content-Disposition': 'attachment; filename="burrow-export-2026-01-02.zip"' }),
      ),
    );
    const out = await downloadExport();
    expect(out).toEqual({
      filename: 'burrow-export-2026-01-02.zip',
      bytes: 4,
      complete: true,
      tooLarge: [],
      parts: 1,
    });
    expect(fetch).toHaveBeenCalledWith('/api/export', { method: 'POST', signal: undefined });
    expect(click).toHaveBeenCalledTimes(1);
  });

  it('reports incomplete when the server flags it', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(zipResponse([1], { 'X-Export-Complete': '0' })));
    expect((await downloadExport()).complete).toBe(false);
  });

  it('falls back to a default filename', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(zipResponse([1])));
    expect((await downloadExport()).filename).toMatch(/^burrow-export-\d{4}-\d{2}-\d{2}\.zip$/);
  });

  it('hides the link and revokes the blob URL after 30 seconds', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(zipResponse([1])));
    let hidden;
    click.mockImplementation(function recordHidden() {
      hidden = this.hidden;
    });
    await downloadExport();
    expect(hidden).toBe(true);
    vi.advanceTimersByTime(29_999);
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:x');
  });

  it.each([
    [429, { error: 'raw server text', code: 'rate_limited' }, 'Too many exports. Try again in a few minutes.'],
    [429, {}, 'Too many exports. Try again in a few minutes.'],
    [401, { error: 'Unauthorized' }, 'Your session expired. Sign in again and retry.'],
    [403, { error: 'x', code: 'auth_required' }, 'Export requires sign-in to be enabled.'],
    [403, {}, 'Export requires sign-in to be enabled.'],
    [503, { error: 'x', code: 'not_configured' }, "Export needs Burrow's data file, which can't be opened. Try restarting Burrow."],
    [500, { error: 'SELECT secret FROM boom', code: 'server_error' }, 'Export failed. Try again.'],
  ])('maps status %s %j to a user-safe message', async (status, body, message) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(errorResponse(status, body)));
    await expect(downloadExport()).rejects.toMatchObject({ message });
    expect(click).not.toHaveBeenCalled();
  });

  it('maps a network failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await expect(downloadExport()).rejects.toMatchObject({
      message: "Couldn't reach the server. Check your connection and try again.",
    });
  });

  it('exports one ZIP per table, one at a time, when the full export is too large', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const calls = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init) => {
        const body = init.body ? JSON.parse(init.body) : null;
        calls.push(body);
        if (!body) return errorResponse(413, { error: 'big', code: 'export_too_large', tables: ['a', 'b', 'c'] });
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 1));
        inFlight -= 1;
        if (body.tables[0] === 'b') return errorResponse(413, { code: 'export_too_large' });
        return zipResponse([1, 2], { 'Content-Disposition': `attachment; filename="x-${body.tables[0]}.zip"` });
      }),
    );
    const out = await downloadExport();
    expect(calls).toEqual([null, { tables: ['a'] }, { tables: ['b'] }, { tables: ['c'] }]);
    expect(maxInFlight).toBe(1);
    expect(click).toHaveBeenCalledTimes(2);
    expect(out).toMatchObject({ complete: false, tooLarge: ['b'], parts: 2, bytes: 4 });
  });

  it('reports complete after a fully successful per-table fallback', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init) =>
        init.body ? zipResponse([1]) : errorResponse(413, { code: 'export_too_large', tables: ['a', 'b'] }),
      ),
    );
    expect(await downloadExport()).toMatchObject({ complete: true, tooLarge: [], parts: 2 });
  });

  it('stops the fallback and surfaces a mapped error when a part is rate limited', async () => {
    const fetchMock = vi.fn(async (_url, init) =>
      init.body ? errorResponse(429, { code: 'rate_limited' }) : errorResponse(413, { code: 'export_too_large', tables: ['a', 'b'] }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await expect(downloadExport()).rejects.toMatchObject({ message: 'Too many exports. Try again in a few minutes.' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('reports how many files were saved when the fallback stops partway', async () => {
    const fetchMock = vi.fn(async (_url, init) => {
      if (!init.body) return errorResponse(413, { code: 'export_too_large', tables: ['a', 'b', 'c'] });
      return init.body.includes('"b"') ? errorResponse(429, { code: 'rate_limited' }) : zipResponse([1]);
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(downloadExport()).rejects.toMatchObject({
      message: 'Too many exports. Try again in a few minutes.',
      savedParts: 1,
      totalParts: 3,
    });
  });

  it('does not save when aborted while the download is in flight', async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        controller.abort();
        return zipResponse([1]);
      }),
    );
    await expect(downloadExport({ signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(click).not.toHaveBeenCalled();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
});
