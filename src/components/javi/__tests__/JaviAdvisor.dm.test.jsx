import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import userEvent from '@testing-library/user-event';
import { Link, MemoryRouter, useLocation } from 'react-router-dom';
import { useEffect, useState } from 'react';
import JaviAdvisor from '../JaviAdvisor';
import { PageContextProvider, usePageContext } from '../../../contexts/PageContextContext';
import { resolveJaviBarPageKey } from '../../../constants/javiPages';
import { allowSlowSuite } from '../../../test-utils/slowSuite';
import { answerInbox, inboxState, resetInbox } from '../../../test-utils/javiInbox.js';
import { jsonResponse } from '../../../test-utils/sseResponse';

// The DM layer of JaviAdvisor: Alt+J, the inbox read marks, the stale-on-open rule, the briefing row to Home,
// strip rows that open Javi on another page, the folders read event and the new-items status.
const adviceFetch = vi.fn();
const routed = (url, init) => {
  const inbox = answerInbox(url, init);
  if (inbox) return inbox;
  const path = String(url);
  if (path === '/api/jarvis/conversations') return Promise.resolve(jsonResponse({ id: 'conv-1' }));
  if (path.startsWith('/api/jarvis/advice')) return adviceFetch(url, init);
  return Promise.resolve(jsonResponse({}));
};
const ok = (content) => ({ ok: true, status: 200, json: async () => ({ data: { content, model: 'm', provider: 'p' } }) });
const adviceUrls = () => adviceFetch.mock.calls.map(([u]) => String(u));
const pageItem = (page) => ({
  id: `page:${page}`,
  kind: 'page',
  page,
  to: `/${page}`,
  label: `${page[0].toUpperCase()}${page.slice(1)} changed since your last insight`,
  at: '2026-10-09T10:00:00.000Z',
});

function Pages() {
  usePageContext('todos', () => ({ open: 3 }));
  usePageContext('calendar', () => ({ events: 1 }));
  usePageContext('home', () => ({ widgets: [] }));
  return null;
}

let client;
function Harness({ showButton = true, autoAdvise = true }) {
  const { pathname } = useLocation();
  const key = resolveJaviBarPageKey(pathname);
  return (
    <QueryClientProvider client={client}>
      <PageContextProvider>
        <Pages />
        <main>
          <Link to="/calendar">to calendar</Link>
          <Link to="/bookmarks">to bookmarks</Link>
          <input aria-label="page field" />
        </main>
        <JaviAdvisor pageKey={key} visible={key !== null} showLauncher={showButton} autoAdvise={autoAdvise} />
      </PageContextProvider>
    </QueryClientProvider>
  );
}
const mount = (path = '/todos', props = {}) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Harness {...props} />
    </MemoryRouter>,
  );
const bar = () => screen.getByRole('button', { name: /^Javi, AI helper/ });
const altJ = (target = document.body, extra = {}) =>
  fireEvent.keyDown(target, { key: 'j', code: 'KeyJ', altKey: true, ...extra });

beforeEach(() => {
  resetInbox();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  adviceFetch.mockReset();
  adviceFetch.mockResolvedValue(ok('Fresh insight'));
  vi.stubGlobal('fetch', vi.fn(routed));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

allowSlowSuite();

describe('panel chunk loading', () => {
  it('shows only the sr-only Loading Javi status, no dialog box, while the panel chunk loads', async () => {
    mount('/todos', { autoAdvise: false });
    act(() => bar().click());
    expect(screen.getByText('Loading Javi')).toHaveClass('sr-only');
    // The clicked bar is hidden while the window is open, so the status holds focus instead of <body>.
    expect(document.activeElement).toBe(screen.getByText('Loading Javi'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await screen.findByRole('dialog', { name: 'Javi' }, { timeout: 10000 });
  }, 20000);
});

describe('Alt+J', () => {
  it('opens the window like a bar click', async () => {
    mount('/todos', { autoAdvise: false });
    altJ();
    expect(await screen.findByRole('dialog', { name: 'Javi' })).toBeInTheDocument();
  });

  it('works with the bar hidden, and the header button then closes instead of collapsing', async () => {
    mount('/todos', { autoAdvise: false, showButton: false });
    altJ();
    expect(await screen.findByRole('dialog', { name: 'Javi' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close Javi' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Collapse Javi' })).not.toBeInTheDocument();
  });

  it.each([
    ['in a text field', () => altJ(screen.getByLabelText('page field'))],
    ['with a key repeat', () => altJ(document.body, { repeat: true })],
    ['with Ctrl', () => altJ(document.body, { ctrlKey: true })],
    ['with Shift', () => altJ(document.body, { shiftKey: true })],
    ['with Meta', () => altJ(document.body, { metaKey: true })],
    [
      'with AltGraph',
      () => {
        const e = new KeyboardEvent('keydown', { key: 'j', code: 'KeyJ', altKey: true, bubbles: true });
        e.getModifierState = (k) => k === 'AltGraph';
        document.body.dispatchEvent(e);
      },
    ],
    [
      'while a modal is open',
      () => {
        const modal = document.createElement('div');
        modal.setAttribute('aria-modal', 'true');
        document.body.appendChild(modal);
        altJ();
        modal.remove();
      },
    ],
  ])('is ignored %s', async (_name, press) => {
    mount('/todos', { autoAdvise: false });
    press();
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByText('Loading Javi')).not.toBeInTheDocument();
  });

  it('with the panel open and focus outside it, moves focus into the panel', async () => {
    mount('/todos', { autoAdvise: false });
    altJ();
    const dialog = await screen.findByRole('dialog', { name: 'Javi' });
    await waitFor(() => expect(dialog).toContainElement(document.activeElement));
    screen.getByRole('link', { name: 'to bookmarks' }).focus();
    altJ(document.activeElement);
    await waitFor(() => expect(dialog).toContainElement(document.activeElement));
  });
});

describe('inbox and the open rule', () => {
  it('a page change never requests advice until Javi is opened', async () => {
    const user = userEvent.setup();
    inboxState.items = [pageItem('calendar')];
    mount('/todos');
    await user.click(screen.getByRole('link', { name: 'to calendar' }));
    await new Promise((r) => setTimeout(r, 50));
    expect(adviceFetch).not.toHaveBeenCalled();
  });

  it('opening marks the page read', async () => {
    const user = userEvent.setup();
    inboxState.items = [pageItem('todos')];
    mount('/todos', { autoAdvise: false });
    await waitFor(() => expect(inboxState.posts.length).toBeGreaterThan(0));
    await user.click(bar());
    await waitFor(() => expect(inboxState.posts.some((p) => p.ids.includes('page:todos'))).toBe(true));
  });

  it('a stale page item asks for one fresh insight on open, even with an insight in memory', async () => {
    const user = userEvent.setup();
    mount('/todos');
    await user.click(bar());
    await screen.findByText('Fresh insight');
    expect(adviceUrls()).toEqual(['/api/jarvis/advice']);
    await user.click(screen.getByRole('button', { name: 'Collapse Javi' }));
    // The page changed elsewhere meanwhile.
    inboxState.items = [pageItem('todos')];
    await act(async () => {
      await client.refetchQueries({ queryKey: ['jarvis-inbox'] });
    });
    await user.click(bar());
    await waitFor(() => expect(adviceUrls()).toEqual(['/api/jarvis/advice', '/api/jarvis/advice?fresh=1']));
  });

  it('a briefing row closes Javi, goes to Home (no Javi window there) and focuses the main content', async () => {
    const user = userEvent.setup();
    inboxState.items = [{ id: 'briefing', kind: 'briefing', page: 'home', to: '/', label: "Today's briefing is ready", at: '2026-10-09T10:00:00.000Z' }];
    mount('/todos', { autoAdvise: false });
    await user.click(bar());
    await user.click(await screen.findByRole('button', { name: "Today's briefing is ready" }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /^Javi, AI helper/ })).not.toBeInTheDocument();
    expect(document.activeElement.tagName).toBe('MAIN');
    expect(adviceFetch).not.toHaveBeenCalled();
    // Read on the click itself: the Javi card that would mark it may be hidden on Home.
    expect(inboxState.posts.some((p) => p.ids.includes('briefing'))).toBe(true);
  });

  it('a strip row navigates, opens with auto-advice on the new page and keeps focus inside the dialog', async () => {
    const user = userEvent.setup();
    inboxState.items = [pageItem('calendar')];
    mount('/todos', { autoAdvise: true });
    await user.click(bar());
    const row = await screen.findByRole('button', { name: 'Calendar changed since your last insight' });
    adviceFetch.mockResolvedValue(ok('Calendar insight'));
    const callsBefore = adviceFetch.mock.calls.length;
    await user.click(row);
    await screen.findByText('Calendar insight');
    expect(adviceFetch.mock.calls.length).toBe(callsBefore + 1);
    expect(JSON.parse(adviceFetch.mock.calls.at(-1)[1].body).page).toBe('calendar');
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'Javi' })).toContainElement(document.activeElement));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Collapse Javi' }));
  });

  it('a folders row closes Javi and focuses the main content', async () => {
    const user = userEvent.setup();
    inboxState.items = [{ id: 'folders', kind: 'folders', page: null, to: '/folders', label: 'A folder summary is ready', at: '2026-10-09T10:00:00.000Z', count: 1 }];
    mount('/todos', { autoAdvise: false });
    await user.click(bar());
    await user.click(await screen.findByRole('button', { name: 'A folder summary is ready' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(document.activeElement.tagName).toBe('MAIN');
  });

  it('javi:inbox-read sends folders even when it is not in the cached list', async () => {
    mount('/todos', { autoAdvise: false });
    await waitFor(() => expect(inboxState.posts.length).toBe(1));
    act(() => window.dispatchEvent(new CustomEvent('javi:inbox-read', { detail: ['folders'] })));
    await waitFor(() => expect(inboxState.posts.at(-1).ids).toEqual(['folders']));
  });
});

describe('new-items status', () => {
  const status = () => within(document.body).getAllByRole('status').find((el) => !el.closest('[role="dialog"]') && el.textContent !== 'Loading Javi');
  const bump = async (items) => {
    inboxState.items = items;
    await act(async () => {
      await client.refetchQueries({ queryKey: ['jarvis-inbox'] });
    });
  };

  it('stays quiet on the first load and speaks only a rise, then clears after 5 s', async () => {
    inboxState.items = [pageItem('calendar')];
    mount('/todos', { autoAdvise: false });
    await screen.findByRole('button', { name: 'Javi, AI helper, 1 new for you' });
    expect(status()).toHaveTextContent('');
    await bump([pageItem('calendar'), pageItem('bookmarks')]);
    await waitFor(() => expect(status()).toHaveTextContent('Javi: 2 new for you'));
    await waitFor(() => expect(status()).toHaveTextContent(''), { timeout: 7000 });
  }, 15000);

  it('says nothing on a decrease or a refetch with the same items', async () => {
    inboxState.items = [pageItem('calendar'), pageItem('bookmarks')];
    mount('/todos', { autoAdvise: false });
    await screen.findByRole('button', { name: 'Javi, AI helper, 2 new for you' });
    await bump([pageItem('calendar'), pageItem('bookmarks')]);
    await bump([pageItem('calendar')]);
    await new Promise((r) => setTimeout(r, 50));
    expect(status()).toHaveTextContent('');
  });

  it('is not rendered without the bar', async () => {
    inboxState.items = [pageItem('calendar')];
    mount('/todos', { autoAdvise: false, showButton: false });
    await waitFor(() => expect(inboxState.gets).toBeGreaterThan(0));
    expect(screen.queryAllByRole('status')).toHaveLength(0);
  });
});

// Review fixes 2026-10-11: a lazy page registers its data signal one render after the route changes, the Back button
// is the same node as the disabled placeholder on Home, and Javi can open before the first inbox answer.
describe('lazy page data, refocus and an early open', () => {
  const DATA = [{ id: 'e1' }];
  const lazy = { set: null };
  const setLazy = (v) => lazy.set(v);
  // Stands in for a lazy page: mounted (and registering) only when the test says so, one render after the route.
  function LazyPage({ pageKey }) {
    const [state, setState] = useState({ shown: false, data: undefined });
    useEffect(() => {
      lazy.set = setState;
    }, []);
    return state.shown ? <Registers pageKey={pageKey} data={state.data} /> : null;
  }
  function Registers({ pageKey, data }) {
    usePageContext(pageKey, () => ({ items: 1 }), data);
    return null;
  }
  function LazyHarness({ showButton = true }) {
    const { pathname } = useLocation();
    const key = resolveJaviBarPageKey(pathname);
    return (
      <QueryClientProvider client={client}>
        <PageContextProvider>
          <LazyPage key={key} pageKey={key} />
          <main>
            <Link to="/calendar">to calendar</Link>
            <button type="button">Back</button>
          </main>
          <JaviAdvisor pageKey={key} visible={key !== null} showLauncher={showButton} autoAdvise={false} />
        </PageContextProvider>
      </QueryClientProvider>
    );
  }
  const mountLazy = (path, props = {}) =>
    render(
      <MemoryRouter initialEntries={[path]}>
        <LazyHarness {...props} />
      </MemoryRouter>,
    );
  const status = () => within(document.body).getAllByRole('status').find((el) => !el.closest('[role="dialog"]') && el.textContent !== 'Loading Javi');

  it.each([
    ['registers with its data', [{ shown: true, data: DATA }]],
    ['registers empty, then its data loads', [{ shown: true, data: undefined }, { shown: true, data: DATA }]],
  ])('the current-page notice joining after a navigation is not spoken (page %s); a real rise still is', async (_n, steps) => {
    const user = userEvent.setup();
    inboxState.items = [pageItem('bookmarks')];
    inboxState.unseen = ['calendar'];
    mountLazy('/todos');
    await screen.findByRole('button', { name: 'Javi, AI helper, 1 new for you' });
    await user.click(screen.getByRole('link', { name: 'to calendar' }));
    await waitFor(() => expect(inboxState.posts.length).toBe(2));
    // Separate renders, like a lazy page: the route first, the page's signal after.
    for (const step of steps) act(() => setLazy(step));
    await screen.findByRole('button', { name: 'Javi, AI helper, 2 new for you' });
    await new Promise((r) => setTimeout(r, 2300));
    expect(status()).toHaveTextContent('');
    inboxState.items = [pageItem('bookmarks'), pageItem('notes')];
    await act(async () => {
      await client.refetchQueries({ queryKey: ['jarvis-inbox'] });
    });
    await waitFor(() => expect(status()).toHaveTextContent('Javi: 3 new for you'), { timeout: 4000 });
  }, 15000);

  it.each([
    ['disabled', (el) => el.setAttribute('disabled', '')],
    ['inside aria-hidden', (el) => el.setAttribute('aria-hidden', 'true')],
  ])('closing returns focus to the main content when the opener turned %s meanwhile', async (_n, change) => {
    const user = userEvent.setup();
    mountLazy('/todos', { showButton: false });
    const back = screen.getByRole('button', { name: 'Back' });
    back.focus();
    altJ(back);
    await screen.findByRole('dialog', { name: 'Javi' });
    change(back);
    await user.click(screen.getByRole('button', { name: 'Close Javi' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(document.activeElement.tagName).toBe('MAIN');
  });

  it('opening before the first inbox answer still marks the page read once it lands', async () => {
    let release;
    const gate = new Promise((r) => (release = r));
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, init) => {
        if (String(url).startsWith('/api/jarvis/inbox')) await gate;
        return routed(url, init);
      }),
    );
    inboxState.unseen = ['todos'];
    mountLazy('/todos');
    act(() => setLazy({ shown: true, data: DATA }));
    act(() => bar().click());
    await screen.findByRole('dialog', { name: 'Javi' });
    release();
    await waitFor(() => expect(inboxState.posts.some((p) => p.ids.includes('page:todos'))).toBe(true));
  });
});
