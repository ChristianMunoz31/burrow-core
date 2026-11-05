import '@testing-library/jest-dom/vitest';
import { StrictMode } from 'react';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import userEvent from '@testing-library/user-event';
import { Link, MemoryRouter, useLocation } from 'react-router-dom';
import JaviAdvisor from '../JaviAdvisor';
import { openJavi } from '../openJavi';
import { jsonResponse } from '../../../test-utils/sseResponse';
import { PageContextProvider, usePageContext } from '../../../contexts/PageContextContext';
import { resolveJaviPageKey } from '../../../constants/javiPages';
import { allowSlowSuite } from '../../../test-utils/slowSuite';
import { answerInbox, resetInbox } from '../../../test-utils/javiInbox.js';
import { PRO_NOT_INCLUDED_COPY } from '../../../constants/proFeatures';

// mockFetch serves page advice (and anything else); typed questions go to /api/jarvis, served by
// jarvisFetch; conversation creation is answered inline.
const mockFetch = vi.fn();
const jarvisFetch = vi.fn();
const routedFetch = (url, init) => {
  const inboxAnswer = answerInbox(url, init);
  if (inboxAnswer) return inboxAnswer;
  const path = String(url);
  if (path === '/api/jarvis/conversations') return Promise.resolve(jsonResponse({ id: 'conv-1' }));
  if (path === '/api/jarvis' || path.startsWith('/api/jarvis/actions/')) return jarvisFetch(url, init);
  return mockFetch(url, init);
};

const ok = (content) => ({
  ok: true,
  status: 200,
  json: async () => ({ data: { content, model: 'm', provider: 'p' } }),
});

let pageLoading = false;
function FakePage() {
  usePageContext('todos', () => (pageLoading ? { status: 'loading' } : { open: 3 }));
  return null;
}

const queryClient = new QueryClient();

function Harness({ autoAdvise = true, showButton = true }) {
  const { pathname } = useLocation();
  const key = resolveJaviPageKey(pathname);
  return (
    <QueryClientProvider client={queryClient}>
      <PageContextProvider>
        <FakePage />
        <nav>
          <Link to="/habits">to habits</Link>
          <Link to="/todos">to todos</Link>
          <Link to="/nowhere">to nowhere</Link>
        </nav>
        <button type="button">outside control</button>
        <JaviAdvisor pageKey={key} visible={showButton && key !== null} autoAdvise={autoAdvise} />
      </PageContextProvider>
    </QueryClientProvider>
  );
}

const mount = (props = {}, path = '/todos', strict = false) => {
  const tree = (
    <MemoryRouter initialEntries={[path]}>
      <Harness {...props} />
    </MemoryRouter>
  );
  return render(strict ? <StrictMode>{tree}</StrictMode> : tree);
};

const bar = () => screen.getByRole('button', { name: 'Javi, AI helper' });
const flush = () => new Promise((r) => setTimeout(r, 0));

// JaviPanel is React.lazy-loaded. Warm the module once so the first test that opens the
// panel doesn't pay its (markdown/highlight) import cost inside a 5s findBy wait; under
// parallel jsdom workers that cold import intermittently exceeded the wait.
beforeAll(async () => {
  await import('../JaviPanel');
}, 30000);

beforeEach(() => {
  pageLoading = false;
  resetInbox();
  queryClient.removeQueries({ queryKey: ['jarvis-inbox'] });
  vi.stubGlobal('fetch', routedFetch);
  mockFetch.mockReset();
  jarvisFetch.mockReset();
  mockFetch.mockResolvedValue(ok('**Advice** here'));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// Heavy render-and-wait suite: raise the time limits so a busy machine does not trip them.
allowSlowSuite();

describe('Javi bar', () => {
  it('has the fixed accessible name and no aria-controls while collapsed', () => {
    mount();
    expect(screen.getByRole('button', { name: 'Javi, AI helper' })).toBeInTheDocument();
    expect(bar()).not.toHaveAttribute('aria-controls');
    expect(bar().className).not.toMatch(/\bhidden\b/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('sets aria-controls and is hidden (not a tab stop) while the window is open', async () => {
    const user = userEvent.setup();
    mount({ autoAdvise: false });
    await user.click(bar());
    expect(bar()).toHaveAttribute('aria-controls');
    expect(bar().className).toMatch(/\bhidden\b/);
    expect(bar().className).not.toMatch(/\bflex\b/);
    await screen.findByRole('dialog', {}, { timeout: 5000 });
    expect(bar()).toHaveAttribute('aria-haspopup', 'dialog');
    expect(document.getElementById(bar().getAttribute('aria-controls'))).toBeInTheDocument();
    // The test timeout must exceed the 5s findBy wait above, or a slow lazy mount under
    // full-suite load trips Vitest's default 5s test timeout first.
  }, 15000);

  it('is not rendered when not visible or on a hidden route', () => {
    mount({ showButton: false });
    expect(screen.queryByRole('button', { name: 'Javi, AI helper' })).not.toBeInTheDocument();
    cleanup();
    mount({}, '/nowhere');
    expect(screen.queryByRole('button', { name: 'Javi, AI helper' })).not.toBeInTheDocument();
  });

  it('is a fixed bar docked to the bottom edge, above content, below modals, at most 3rem plus the safe area tall', () => {
    mount();
    const cls = bar().className.split(/\s+/);
    expect(cls).toEqual(expect.arrayContaining(['fixed', 'z-40', 'bottom-0', 'rounded-t-2xl', 'border-b-0', 'min-h-12']));
    expect(cls).toContain('pb-[env(safe-area-inset-bottom)]');
    // No fixed or larger height: the tallest child is the 2rem avatar, so the bar stays at 3rem plus the safe area.
    expect(cls.filter((c) => /^(h|min-h|max-h)-/.test(c))).toEqual(['min-h-12']);
  });
});

describe('panel', () => {
  it('opens as a non-modal dialog, focuses Close, closes on Escape and returns focus', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(bar());
    expect(bar()).toHaveAttribute('aria-expanded', 'true');
    const dialog = await screen.findByRole('dialog', { name: 'Javi' }, { timeout: 5000 });
    expect(dialog).not.toHaveAttribute('aria-modal');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Collapse Javi' })).toHaveFocus());
    expect(screen.getByRole('button', { name: 'outside control' })).toBeEnabled();

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(bar()).toHaveAttribute('aria-expanded', 'false');
    expect(bar()).toHaveFocus();
  });

  it('the collapse button behaves the same', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(bar());
    await screen.findByRole('dialog', {}, { timeout: 5000 });
    await user.click(screen.getByRole('button', { name: 'Collapse Javi' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(bar()).toHaveFocus();
  });

  it('only uses motion-safe animation classes', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(bar());
    const dialog = await screen.findByRole('dialog', {}, { timeout: 5000 });
    expect(dialog.className).toMatch(/motion-safe:animate-overlay-in/);
    expect(dialog.className).not.toMatch(/(^|\s)animate-/);
  });
});

describe('auto-advice', () => {
  it('fires exactly once per open (StrictMode, rerenders, navigation while open)', async () => {
    const user = userEvent.setup();
    mount({}, '/todos', true);
    await user.click(bar());
    await screen.findByText('Advice');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toEqual({
      page: 'todos',
      context: expect.stringContaining('"open":3'),
      messages: [],
    });
    await user.click(screen.getByRole('link', { name: 'to habits' }));
    await flush();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Get insight' })).toBeInTheDocument();
  });

  it('reopening a page with history adds no request; an empty page adds one', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(bar());
    await screen.findByText('Advice');
    await user.click(screen.getByRole('button', { name: 'Collapse Javi' }));
    await user.click(bar());
    await screen.findByText('Advice');
    expect(mockFetch).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: 'Collapse Javi' }));
    await user.click(screen.getByRole('link', { name: 'to habits' }));
    await user.click(bar());
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
    expect(JSON.parse(mockFetch.mock.calls[1][1].body).page).toBe('habits');
  });

  it('waits for page data to finish loading before using the once-per-open advice', async () => {
    const user = userEvent.setup();
    pageLoading = true;
    mount();
    await user.click(bar());
    await screen.findByRole('dialog', {}, { timeout: 5000 });
    await new Promise((r) => setTimeout(r, 900));
    expect(mockFetch).not.toHaveBeenCalled();
    pageLoading = false;
    await screen.findByText('Advice', {}, { timeout: 3000 });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(mockFetch.mock.calls[0][1].body).context).toContain('"open":3');
    await new Promise((r) => setTimeout(r, 900));
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('does not re-fire on reopen while a rate-limit window is still open', async () => {
    const user = userEvent.setup();
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
      json: async () => ({ error: 'Slow down', code: 'rate_limited', retryAfterMs: 60000 }),
    });
    mount();
    await user.click(bar());
    await screen.findByRole('alert');
    expect(screen.getByRole('button', { name: /Try again in \d+s/ })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Collapse Javi' }));
    await user.click(bar());
    await screen.findByRole('dialog', {}, { timeout: 5000 });
    await flush();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('does nothing automatically when the setting is off', async () => {
    const user = userEvent.setup();
    mount({ autoAdvise: false });
    await user.click(bar());
    await user.click(await screen.findByRole('button', { name: 'Get insight' }));
    await screen.findByText('Advice');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('opening with auto-advise off makes no request', async () => {
    const user = userEvent.setup();
    mount({ autoAdvise: false });
    await user.click(bar());
    await screen.findByRole('dialog', {}, { timeout: 5000 });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('closes without a request when the page becomes hidden', async () => {
    const user = userEvent.setup();
    mount({ autoAdvise: false });
    await user.click(bar());
    await screen.findByRole('dialog', {}, { timeout: 5000 });
    await user.click(screen.getByRole('link', { name: 'to nowhere' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await user.click(screen.getByRole('link', { name: 'to todos' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('errors', () => {
  it('shows the server error with Retry, and clears it on success', async () => {
    const user = userEvent.setup();
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
      json: async () => ({
        error: 'Too many requests, please try again later.',
        code: 'rate_limited',
        retryAfterMs: 0,
      }),
    });
    mount();
    await user.click(bar());
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("Javi couldn't answer (error 429). Try again.");
    // Quiet style: no border box around Retry.
    expect(screen.getByRole('button', { name: 'Retry' })).not.toHaveClass('border');
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByText('Advice');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});

describe('401', () => {
  it('shows a friendly session-expired message', async () => {
    const user = userEvent.setup();
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({ error: 'Unauthorized' }) });
    mount();
    await user.click(bar());
    expect(await screen.findByRole('alert')).toHaveTextContent('Session expired. Please sign in again.');
  });
});

describe('markdown safety', () => {
  it('shows the hostname after links and renders non-http links as plain text', async () => {
    const user = userEvent.setup();
    mockFetch.mockResolvedValue(
      ok('[a](https://example.com/x) and [b](javascript:alert(1)) and [c](mailto:x@y.io)'),
    );
    mount();
    await user.click(bar());
    const link = await screen.findByRole('link', { name: 'a' });
    expect(link).toHaveAttribute('rel', 'noopener noreferrer nofollow');
    expect(link.parentElement).toHaveTextContent('a (example.com)');
    const links = within(screen.getByRole('dialog')).getAllByRole('link');
    // The model's own links: only the http one is live. The extra link is the Report mailto (policy 11.16).
    const modelHttp = links.filter((l) => l.getAttribute('href').startsWith('http'));
    expect(modelHttp).toHaveLength(1);
    expect(links.filter((l) => l.getAttribute('href').startsWith('mailto:'))).toHaveLength(1);
    expect(screen.getByText('b')).toBeInTheDocument();
  });

  it('drops images and opens links safely', async () => {
    const user = userEvent.setup();
    mockFetch.mockResolvedValue(ok('![x](http://evil.example/?q=1)\n\n[link](https://example.com)'));
    mount();
    await user.click(bar());
    const link = await screen.findByRole('link', { name: 'link' });
    expect(link).toHaveAttribute('target', '_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
    expect(document.querySelector('img')).toBeNull();
  });
});

describe('javi:open event (command palette)', () => {
  it('without a prompt it just opens, and auto-advice still runs once', async () => {
    mount({ autoAdvise: true });
    act(() => openJavi());
    await screen.findByText('Advice');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(jarvisFetch).not.toHaveBeenCalled();
  });

  it('without the module the question is not sent and there is no composer', async () => {
    mount({ autoAdvise: false });
    act(() => openJavi({ prompt: 'what is due today' }));
    await screen.findByRole('dialog');
    expect(screen.queryByRole('textbox', { name: 'Message Javi' })).not.toBeInTheDocument();
    expect(jarvisFetch).not.toHaveBeenCalled();
  });

  it('is ignored when Javi is not available', async () => {
    mount({ showButton: false });
    act(() => openJavi({ prompt: 'hello' }));
    await act(async () => {
      await flush();
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(jarvisFetch).not.toHaveBeenCalled();
  });

});

describe('Core-only build: advice without the module', () => {
  const chipName = 'What should I tackle first?';
  const proNotice = () => screen.queryByText(PRO_NOT_INCLUDED_COPY);
  const fetchSpy = vi.fn(routedFetch);
  // Every request that is not the single-shot advice call (typed questions, conversations, actions). The inbox and
  // the briefing read run no model and are not Javi requests.
  const jarvisCallsOtherThanAdvice = () =>
    fetchSpy.mock.calls
      .map(([url]) => String(url))
      .filter((u) => u.startsWith('/api/jarvis') && u !== '/api/jarvis/advice' && !u.startsWith('/api/jarvis/inbox') && u !== '/api/jarvis/briefing');
  const adviceBodies = () =>
    fetchSpy.mock.calls.filter(([url]) => String(url) === '/api/jarvis/advice').map(([, init]) => JSON.parse(init.body));

  beforeEach(() => {
    fetchSpy.mockClear();
    vi.stubGlobal('fetch', fetchSpy);
  });

  it('shows the card with no composer or New conversation, no upgrade hint and no link to buy anything', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(bar());
    await screen.findByText('Advice');
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start a new conversation with Javi' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send' })).not.toBeInTheDocument();
    expect(screen.getByRole('dialog').textContent).not.toMatch(/\bpro\b|buy|upgrade|licen[sc]e|trial/i);
    expect(proNotice()).not.toBeInTheDocument();
    expect(adviceBodies()).toEqual([{ page: 'todos', context: expect.any(String), messages: [] }]);
    expect(jarvisCallsOtherThanAdvice()).toEqual([]);
  });

  it('a follow-up chip sends an advice follow-up, which is core code in every build', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(bar());
    await screen.findByText('Advice');
    mockFetch.mockResolvedValueOnce(ok('**Follow-up** answer'));
    await user.click(screen.getByRole('button', { name: chipName }));
    await screen.findByText('Follow-up');
    const bodies = adviceBodies();
    expect(bodies).toHaveLength(2);
    expect(bodies[1].messages.at(-1)).toMatchObject({ role: 'user', content: chipName });
    expect(jarvisCallsOtherThanAdvice()).toEqual([]);
  });

  it('puts focus on Close, not a composer', async () => {
    const user = userEvent.setup();
    mount({ autoAdvise: false });
    await user.click(bar());
    await screen.findByRole('dialog', {}, { timeout: 5000 });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Collapse Javi' })).toHaveFocus());
  });

  it('shows the empty state when auto-advice is off, and Get advice loads the card', async () => {
    const user = userEvent.setup();
    mount({ autoAdvise: false });
    await user.click(bar());
    expect(await screen.findByText(/Want a quick insight about Todos\?/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Get insight' }));
    await screen.findByText('Advice');
    expect(adviceBodies()).toHaveLength(1);
    expect(adviceBodies()[0].messages).toEqual([]);
  });

  it('Refresh replaces the card instead of adding another', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(bar());
    await screen.findByText('Advice');
    mockFetch.mockResolvedValueOnce(ok('**Second** take'));
    await user.click(screen.getByRole('button', { name: 'Get a new insight for this page' }));
    await screen.findByText('Second');
    expect(screen.queryByText('Advice')).not.toBeInTheDocument();
    expect(screen.getAllByText('Second')).toHaveLength(1);
    // Refresh is the same request with ?fresh=1 (the server skips its cache), still a single-shot body.
    const adviceCalls = fetchSpy.mock.calls.filter(([url]) => String(url).startsWith('/api/jarvis/advice'));
    expect(adviceCalls.map(([url]) => String(url))).toEqual(['/api/jarvis/advice', '/api/jarvis/advice?fresh=1']);
    expect(adviceCalls.map(([, init]) => JSON.parse(init.body).messages)).toEqual([[], []]);
  });

  it('the automatic card asks for the plain URL; Refresh asks for ?fresh=1 (so the server skips its cache)', async () => {
    const user = userEvent.setup();
    mount({}, '/todos', true);
    await user.click(bar());
    await screen.findByText('Advice');
    mockFetch.mockResolvedValueOnce(ok('**Second** take'));
    await user.click(screen.getByRole('button', { name: 'Get a new insight for this page' }));
    await screen.findByText('Second');
    expect(mockFetch.mock.calls.map((c) => c[0]).filter((u) => String(u).startsWith('/api/jarvis/advice'))).toEqual(['/api/jarvis/advice', '/api/jarvis/advice?fresh=1']);
  });

  it('closing the panel aborts the advice request still in flight', async () => {
    const user = userEvent.setup();
    let signal;
    mockFetch.mockImplementationOnce(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          signal = init.signal;
          init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        }),
    );
    mount();
    await user.click(bar());
    await waitFor(() => expect(signal).toBeDefined());
    expect(signal.aborted).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Collapse Javi' }));
    expect(signal.aborted).toBe(true);
  });

  it('a palette question sends no typed or follow-up request, still loads the card, and shows the not-included notice', async () => {
    mount({ autoAdvise: true });
    act(() => openJavi({ prompt: 'what is due today' }));
    await screen.findByRole('dialog');
    await screen.findByText('Advice');
    expect(jarvisFetch).not.toHaveBeenCalled();
    expect(jarvisCallsOtherThanAdvice()).toEqual([]);
    const bodies = adviceBodies();
    expect(bodies).toHaveLength(1);
    expect(bodies.every((b) => b.messages.length === 0)).toBe(true);
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(proNotice()).toBeInTheDocument();
    expect(document.querySelector('[data-reason="pro_not_included"]')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('a palette question while the panel is already open shows the notice and sends nothing', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(bar());
    await screen.findByText('Advice');
    expect(proNotice()).not.toBeInTheDocument();
    fetchSpy.mockClear();
    act(() => openJavi({ prompt: 'what is due today' }));
    await waitFor(() => expect(proNotice()).toBeInTheDocument());
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(jarvisFetch).not.toHaveBeenCalled();
  });

  it('the palette notice is cleared on close and does not return on reopen', async () => {
    const user = userEvent.setup();
    mount();
    act(() => openJavi({ prompt: 'what is due today' }));
    await screen.findByText('Advice');
    expect(proNotice()).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Collapse Javi' }));
    await user.click(bar());
    await screen.findByRole('dialog', {}, { timeout: 5000 });
    await screen.findByText('Advice');
    expect(proNotice()).not.toBeInTheDocument();
  });

  it('the palette notice belongs to the page it was asked on', async () => {
    const user = userEvent.setup();
    mount();
    act(() => openJavi({ prompt: 'what is due today' }));
    await screen.findByText('Advice');
    expect(proNotice()).toBeInTheDocument();
    await user.click(screen.getByRole('link', { name: 'to habits' }));
    await waitFor(() => expect(proNotice()).not.toBeInTheDocument());
  });

  it('a palette question without a prompt shows no notice', async () => {
    mount();
    act(() => openJavi());
    await screen.findByText('Advice');
    expect(proNotice()).not.toBeInTheDocument();
  });
});
