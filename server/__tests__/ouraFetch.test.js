// fetchOura: day clamping, next_token pagination (page cap), per-request timeout signal,
// and timeout tagging. node-fetch is mocked; no network.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('node-fetch', () => ({ default: vi.fn() }));

import fetch from 'node-fetch';
import { fetchOura } from '../integrations.js';

const okJson = (body) => ({ ok: true, status: 200, json: async () => body });
const startDate = (url) => new URL(url).searchParams.get('start_date');
const endDate = (url) => new URL(url).searchParams.get('end_date');
const spanDays = (url) => Math.round((Date.parse(endDate(url)) - Date.parse(startDate(url))) / 86400000) + 1;

beforeEach(() => {
  fetch.mockReset();
  fetch.mockImplementation(async () => okJson({ data: [] }));
});

describe('fetchOura days clamp', () => {
  it.each([
    [undefined, 14],
    [Number.NaN, 14],
    ['junk', 14],
    [0, 14],
    [-5, 1],
    [1, 1],
    [62, 62],
    [500, 90],
    [7.9, 7],
  ])('days=%s requests a %i day window', async (days, expected) => {
    await fetchOura('tok', { days });
    expect(fetch).toHaveBeenCalled();
    expect(spanDays(fetch.mock.calls[0][0])).toBe(expected);
  });

  it('without a token throws not_configured and makes no request', async () => {
    await expect(fetchOura('', { days: Number.NaN })).rejects.toMatchObject({ code: 'not_configured', status: 503 });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('fetchOura pagination and timeout', () => {
  it('follows next_token and merges pages', async () => {
    fetch.mockImplementation(async (url) => {
      const u = new URL(url);
      if (!u.pathname.endsWith('/daily_readiness')) return okJson({ data: [] });
      if (u.searchParams.get('next_token') === 'abc') return okJson({ data: [{ day: '2026-01-02', score: 70 }] });
      return okJson({ data: [{ day: '2026-01-01', score: 80 }], next_token: 'abc' });
    });
    const out = await fetchOura('tok', { days: 14 });
    expect(out.days.map((d) => [d.day, d.readiness])).toEqual([
      ['2026-01-01', 80],
      ['2026-01-02', 70],
    ]);
  });

  it('stops after 5 pages even if the API keeps returning a token', async () => {
    fetch.mockImplementation(async () => okJson({ data: [], next_token: 'again' }));
    await fetchOura('tok', { days: 14 });
    expect(fetch).toHaveBeenCalledTimes(4 * 5);
  });

  it('passes an abort signal to every request', async () => {
    await fetchOura('tok', { days: 14 });
    for (const call of fetch.mock.calls) expect(call[1].signal).toBeInstanceOf(AbortSignal);
  });

  it('tags a timed-out request so the route can answer 504', async () => {
    fetch.mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    await expect(fetchOura('tok', { days: 14 })).rejects.toMatchObject({ code: 'timeout', name: 'TimeoutError' });
  });

  it('rethrows an abort mid-body on a 2xx as a timeout instead of an empty page', async () => {
    fetch.mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      },
    }));
    await expect(fetchOura('tok', { days: 14 })).rejects.toMatchObject({ code: 'timeout', name: 'TimeoutError' });
  });

  it('still falls back to an empty body for junk JSON, and for a non-ok body', async () => {
    fetch.mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('bad json');
      },
    }));
    const out = await fetchOura('tok', { days: 14 });
    expect(out.days).toEqual([]);
    fetch.mockImplementation(async () => ({
      ok: false,
      status: 500,
      json: async () => {
        throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      },
    }));
    await expect(fetchOura('tok', { days: 14 })).rejects.toMatchObject({ status: 500 });
  });

  it('shares one 15s deadline across all pages: aborting it aborts every request signal', async () => {
    const original = AbortSignal.timeout.bind(AbortSignal);
    const deadline = new AbortController();
    const spy = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => (ms === 15000 ? deadline.signal : original(ms)));
    try {
      fetch.mockImplementation(async () => okJson({ data: [], next_token: 'again' }));
      await fetchOura('tok', { days: 14 });
      expect(spy.mock.calls.filter(([ms]) => ms === 15000)).toHaveLength(1);
      expect(spy.mock.calls.filter(([ms]) => ms === 8000).length).toBe(4 * 5);
      const signals = fetch.mock.calls.map((c) => c[1].signal);
      expect(signals.every((s) => !s.aborted)).toBe(true);
      deadline.abort();
      expect(signals.every((s) => s.aborted)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('keeps the upstream status on an HTTP failure', async () => {
    fetch.mockImplementation(async () => ({ ok: false, status: 401, json: async () => ({ detail: 'bad token' }) }));
    await expect(fetchOura('tok', { days: 14 })).rejects.toMatchObject({ status: 401 });
  });
});
