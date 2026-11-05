import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useJaviInbox } from '../useJaviInbox';
import { answerInbox, inboxState, resetInbox } from '../../test-utils/javiInbox.js';

const item = (id, page) => ({ id, kind: page ? 'page' : id, page, to: '/', label: `${id} label`, at: '2026-10-09T10:00:00.000Z' });
const ITEMS = [
  item('page:todos', 'todos'),
  item('page:notes', 'notes'),
  item('page:budget', 'budget'),
  item('page:calendar', 'calendar'),
  item('folders', null),
];

let fetchMock;
let client;
beforeEach(() => {
  resetInbox();
  inboxState.items = ITEMS.map((i) => ({ ...i }));
  fetchMock = vi.fn((url, init) => answerInbox(url, init));
  vi.stubGlobal('fetch', fetchMock);
  client = new QueryClient();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const wrapper = ({ children }) => createElement(QueryClientProvider, { client }, children);
const mount = (props) => renderHook((p) => useJaviInbox(p), { initialProps: props, wrapper });
const posts = () => fetchMock.mock.calls.filter(([url]) => url === '/api/jarvis/inbox/read');
const gets = () => fetchMock.mock.calls.filter(([url]) => url === '/api/jarvis/inbox');

describe('useJaviInbox', () => {
  it('counts every unread item except the current page; count === rows.length', async () => {
    const { result } = mount({ pageKey: 'todos' });
    await waitFor(() => expect(result.current.items).toHaveLength(5));
    expect(result.current.rows.map((r) => r.id)).toEqual(['page:notes', 'page:budget', 'page:calendar', 'folders']);
    expect(result.current.count).toBe(result.current.rows.length);
  });

  it('a page change moves the excluded item to the new page', async () => {
    const { result, rerender } = mount({ pageKey: 'calendar' });
    await waitFor(() => expect(result.current.items).toHaveLength(5));
    expect(result.current.rows.map((r) => r.id)).toEqual(['page:todos', 'page:notes', 'page:budget', 'folders']);
    rerender({ pageKey: 'budget' });
    expect(result.current.rows.map((r) => r.id)).toEqual(['page:todos', 'page:notes', 'page:calendar', 'folders']);
  });

  it('a page change sends exactly one JSON POST { ids: [] } and no GET; neither carries the page', async () => {
    const { result, rerender } = mount({ pageKey: 'todos' });
    await waitFor(() => expect(result.current.items).toHaveLength(5));
    expect(posts()).toHaveLength(1);
    expect(posts()[0][1]).toMatchObject({ method: 'POST', headers: { 'Content-Type': 'application/json' } });
    expect(JSON.parse(posts()[0][1].body)).toEqual({ ids: [] });
    const getsBefore = gets().length;
    rerender({ pageKey: 'notes' });
    await waitFor(() => expect(posts()).toHaveLength(2));
    expect(JSON.parse(posts()[1][1].body)).toEqual({ ids: [] });
    expect(gets()).toHaveLength(getsBefore);
    for (const [url] of gets()) expect(url).toBe('/api/jarvis/inbox');
  });

  it('a re-render with the same page sends nothing', async () => {
    const { result, rerender } = mount({ pageKey: 'todos' });
    await waitFor(() => expect(result.current.items).toHaveLength(5));
    const n = fetchMock.mock.calls.length;
    rerender({ pageKey: 'todos' });
    expect(fetchMock.mock.calls.length).toBe(n);
  });

  it('markRead sends listed ids, drops unknown ones, and sets the server list from the answer', async () => {
    const { result } = mount({ pageKey: 'todos' });
    await waitFor(() => expect(result.current.items).toHaveLength(5));
    const before = posts().length;
    act(() => result.current.markRead(['page:nope', 'briefing']));
    expect(posts()).toHaveLength(before);
    act(() => result.current.markRead(['page:notes', 'briefing']));
    await waitFor(() => expect(result.current.items).toHaveLength(4));
    expect(JSON.parse(posts().at(-1)[1].body)).toEqual({ ids: ['page:notes'] });
  });

  it('markRead with unfiltered sends the ids as given', async () => {
    inboxState.items = [];
    const { result } = mount({ pageKey: 'todos' });
    await waitFor(() => expect(posts()).toHaveLength(1));
    act(() => result.current.markRead(['folders'], { unfiltered: true }));
    await waitFor(() => expect(posts()).toHaveLength(2));
    expect(JSON.parse(posts()[1][1].body).ids).toEqual(['folders']);
  });

  it('refetches on window focus only when the data is older than 60 s, with no polling', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { result } = mount({ pageKey: 'todos' });
    await waitFor(() => expect(result.current.items).toHaveLength(5));
    const query = client.getQueryCache().find({ queryKey: ['jarvis-inbox'] });
    expect(query.options.staleTime).toBe(60_000);
    expect(query.options.refetchInterval).toBeUndefined();
    expect(query.isStaleByTime(60_000)).toBe(false);
    vi.setSystemTime(Date.now() + 61_000);
    expect(query.isStaleByTime(60_000)).toBe(true);
  });

  it('only the newest POST answer writes the cache, even when an older one lands last', async () => {
    const { result, rerender } = mount({ pageKey: 'todos' });
    await waitFor(() => expect(result.current.items).toHaveLength(5));
    let releaseSlow;
    const json = (items) => ({ ok: true, json: async () => ({ data: { items } }) });
    fetchMock.mockImplementationOnce(() => new Promise((resolve) => (releaseSlow = () => resolve(json(ITEMS)))));
    fetchMock.mockImplementationOnce(async () => json([ITEMS[0]]));
    rerender({ pageKey: 'notes' });
    rerender({ pageKey: 'budget' });
    await waitFor(() => expect(result.current.items).toHaveLength(1));
    // React Query batches cache notifications on a timer: let them flush before asserting nothing changed.
    await act(async () => {
      releaseSlow();
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(result.current.items.map((i) => i.id)).toEqual(['page:todos']);
  });

  describe('current-page notice (owner decision 2026-10-10)', () => {
    const DATA = [{ id: 't1' }];

    it('adds 1 when the current page has data and is unseen; the strip still lists other pages only', async () => {
      inboxState.unseen = ['todos', 'notes'];
      const { result } = mount({ pageKey: 'todos', pageData: DATA });
      await waitFor(() => expect(result.current.ready).toBe(true));
      expect(result.current.rows.map((r) => r.id)).toEqual(['page:notes', 'page:budget', 'page:calendar', 'folders']);
      expect(result.current.count).toBe(result.current.rows.length + 1);
    });

    it('adds nothing without page data, or when the page is seen', async () => {
      inboxState.unseen = ['todos'];
      const { result, rerender } = mount({ pageKey: 'todos', pageData: null });
      await waitFor(() => expect(result.current.ready).toBe(true));
      expect(result.current.count).toBe(result.current.rows.length);
      rerender({ pageKey: 'notes', pageData: DATA });
      await waitFor(() => expect(posts()).toHaveLength(2));
      expect(result.current.count).toBe(result.current.rows.length);
    });

    it('markRead sends an unseen page id that is not listed, and the answer clears the notice', async () => {
      inboxState.items = [];
      inboxState.unseen = ['health'];
      const { result } = mount({ pageKey: 'health', pageData: DATA });
      await waitFor(() => expect(result.current.count).toBe(1));
      act(() => result.current.markRead(['page:health', 'page:todos']));
      await waitFor(() => expect(result.current.count).toBe(0));
      expect(JSON.parse(posts().at(-1)[1].body)).toEqual({ ids: ['page:health'] });
    });

    it('a data change on a seen page asks again after a short wait; an own edit then shows 1', async () => {
      inboxState.items = [];
      const { result, rerender } = mount({ pageKey: 'budget', pageData: DATA });
      await waitFor(() => expect(posts()).toHaveLength(1));
      expect(result.current.count).toBe(0);
      inboxState.unseen = ['budget'];
      rerender({ pageKey: 'budget', pageData: [{ id: 't1' }, { id: 't2' }] });
      expect(posts()).toHaveLength(1);
      await waitFor(() => expect(posts()).toHaveLength(2), { timeout: 3000 });
      await waitFor(() => expect(result.current.count).toBe(1));
    });

    it('a lazy page registering one render after the route change adds no request; empty -> first record does', async () => {
      inboxState.items = [];
      const { rerender } = mount({ pageKey: 'budget', pageData: DATA });
      await waitFor(() => expect(posts()).toHaveLength(1));
      // Separate renders, like a real navigation: the route first (no page registered yet), the page's signal after.
      rerender({ pageKey: 'notes', pageData: null });
      await waitFor(() => expect(posts()).toHaveLength(2));
      rerender({ pageKey: 'notes', pageData: [{ id: 'n1' }] });
      await new Promise((r) => setTimeout(r, 1300));
      expect(posts()).toHaveLength(2);
      // Registered with no records (false), then a first record: that is a data change.
      rerender({ pageKey: 'todos', pageData: null });
      await waitFor(() => expect(posts()).toHaveLength(3));
      rerender({ pageKey: 'todos', pageData: false });
      rerender({ pageKey: 'todos', pageData: [{ id: 't1' }] });
      await waitFor(() => expect(posts()).toHaveLength(4), { timeout: 3000 });
    });

    it('a burst of data changes is one request, and a page change never adds a data request', async () => {
      inboxState.items = [];
      const { rerender } = mount({ pageKey: 'budget', pageData: DATA });
      await waitFor(() => expect(posts()).toHaveLength(1));
      rerender({ pageKey: 'budget', pageData: [1] });
      rerender({ pageKey: 'budget', pageData: [2] });
      rerender({ pageKey: 'notes', pageData: [3] });
      await waitFor(() => expect(posts()).toHaveLength(2));
      await new Promise((r) => setTimeout(r, 1300));
      expect(posts()).toHaveLength(2);
    });
  });
});
