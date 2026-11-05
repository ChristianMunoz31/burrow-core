import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
vi.mock('../../../hooks/useEntitlements', async () => (await import('../../../test-utils/entitlements.js')).entitlementsModule());
import { act, cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import userEvent from '@testing-library/user-event';
import { Link, MemoryRouter, useLocation } from 'react-router-dom';
import JaviPanel from '../JaviPanel';
import JaviMessage from '../JaviMessage';
import JaviAdvisor from '../JaviAdvisor';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { errorWaitMs } from '../retryWait';
import { PageContextProvider, usePageContext } from '../../../contexts/PageContextContext';
import { resolveJaviPageKey } from '../../../constants/javiPages';

// The panel reads Javi's source from the status query; these tests are not about that.
vi.mock('../../../hooks/useJarvisStatus', () => ({
  useJarvisStatus: () => ({ status: null, loading: false, error: null }),
}));

const mockFetch = vi.fn();
const ok = (content) => ({
  ok: true,
  status: 200,
  json: async () => ({ data: { content, model: 'm', provider: 'p' } }),
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function panelProps(error) {
  return {
    id: 'p',
    pageKey: 'todos',
    pageLabel: 'Todos',
    thread: {
      messages: [{ id: 'm1', role: 'user', content: 'hi' }],
      status: 'error',
      error,
      lastRequestMessages: [{ role: 'user', content: 'hi' }],
    },
    suggestions: [],
    onSend: vi.fn(),
    onNewAdvice: vi.fn(),
    onRetry: vi.fn(),
    onClose: vi.fn(),
  };
}

describe('S1 shared retry wait', () => {
  it('uses the 30s default for rate-limit codes without retryAfterMs, none for others', () => {
    const at = 1000;
    expect(errorWaitMs({ code: 'rate_limited', at }, at)).toBe(30000);
    expect(errorWaitMs({ code: 'provider_rate_limited', retryAfterMs: null, at }, at)).toBe(30000);
    expect(errorWaitMs({ code: 'rate_limited', retryAfterMs: 5000, at }, at)).toBe(5000);
    expect(errorWaitMs({ code: 'upstream', at }, at)).toBe(0);
  });

  it('disables Retry in the panel for a rate-limit error without retryAfterMs', () => {
    render(
      <JaviPanel
        {...panelProps({ message: 'Slow down', code: 'rate_limited', retryAfterMs: null, at: Date.now() })}
      />,
    );
    expect(screen.getByRole('button', { name: /try again in/i })).toBeDisabled();
  });
});

describe('S2 countdown a11y', () => {
  it('keeps role=alert on the message only and the button outside it', () => {
    render(
      <JaviPanel
        {...panelProps({ message: 'Slow down', code: 'rate_limited', retryAfterMs: null, at: Date.now() })}
      />,
    );
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Slow down');
    const btn = screen.getByRole('button', { name: /try again in/i });
    expect(alert).not.toContainElement(btn);
    expect(btn).toHaveAccessibleName(/^Try again in \d+s$/);
  });

  it('only runs the interval while a wait is open', () => {
    const spy = vi.spyOn(globalThis, 'setInterval');
    const { unmount } = render(
      <JaviPanel {...panelProps({ message: 'Boom', code: 'upstream', retryAfterMs: null, at: Date.now() })} />,
    );
    const secondTicks = () => spy.mock.calls.filter(([, ms]) => ms === 1000).length;
    expect(secondTicks()).toBe(0);
    expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled();
    unmount();
    render(
      <JaviPanel {...panelProps({ message: 'Slow', code: 'rate_limited', retryAfterMs: null, at: Date.now() })} />,
    );
    expect(secondTicks()).toBe(1);
    spy.mockRestore();
  });
});

const queryClient = new QueryClient();

function Harness({ visible = true }) {
  const { pathname } = useLocation();
  const key = resolveJaviPageKey(pathname);
  return (
    <QueryClientProvider client={queryClient}>
      <PageContextProvider>
        <FakePage />
        <Link to="/habits">to habits</Link>
        <JaviAdvisor pageKey={key} visible={visible && key !== null} autoAdvise />
      </PageContextProvider>
    </QueryClientProvider>
  );
}

let pageLoading = false;
function FakePage() {
  usePageContext('todos', () => (pageLoading ? { status: 'loading' } : { open: 3 }));
  return null;
}

const mount = (props = {}) =>
  render(
    <MemoryRouter initialEntries={['/todos']}>
      <Harness {...props} />
    </MemoryRouter>,
  );

// The toast offset is a CSS rule now (`:root:has(...)`); jsdom cannot evaluate :has(),
// so the rule text is asserted.
describe('S3 toast offset rule', () => {
  const flat = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8').replace(/\s+/g, ' ');
  it('lifts toasts above the shown Javi bar or the open window', () => {
    expect(flat).toContain(':root:has(.glass-javi-bar:not(:where(.hidden)), .glass-javi) { --javi-toast-offset: 3.5rem; }');
    expect(flat).not.toContain('glass-javi-fab');
  });
  it('moves them left of the window on desktop and above the sheet on narrow screens', () => {
    expect(flat).toContain(
      '@media (min-width: 640px) { :root:has(.glass-javi) { --javi-toast-offset: 1rem; --javi-toast-right: 26rem; } }',
    );
    expect(flat).toContain('@media (max-width: 639.98px) { :root:has(.glass-javi) { --javi-toast-offset: calc(85dvh + 0.5rem); } }');
  });
  it('JaviAdvisor no longer writes the variables from JS', () => {
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockResolvedValue(ok('advice'));
    mount();
    expect(document.documentElement.style.getPropertyValue('--javi-toast-offset')).toBe('');
  });
});

describe('N2 pageKey change cancels pending auto-advice', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockReset();
    mockFetch.mockResolvedValue(ok('advice'));
  });

  it('does not request advice for the new page once the poll resumes', async () => {
    pageLoading = true;
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole('button', { name: 'Javi, AI helper' }));
    await user.click(screen.getByRole('link', { name: 'to habits' }));
    pageLoading = false;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 1200));
    });
    expect(mockFetch.mock.calls.filter(([url]) => String(url).startsWith('/api/jarvis/advice'))).toEqual([]);
  });
});

describe('JaviMessage polish', () => {
  it('renders dollars intact, strips dashes, and labels the speaker for screen readers', () => {
    const { container } = render(
      <>
        <JaviMessage role="user" content="how am I doing?" />
        <JaviMessage role="assistant" content={'You spent $1,234.56 — over budget, $50–$75 range'} />
      </>,
    );
    const text = container.textContent;
    expect(text).toContain('$1,234.56');
    expect(text).toContain('$50-$75');
    expect(text).not.toMatch(/[–—]/);
    expect(text).toContain('You said: how am I doing?');
    expect(text).toContain('Javi said: ');
  });
});

describe('JaviPanel live region', () => {
  const thread = (messages, status = 'idle') => ({ messages, status, error: null, lastRequestMessages: null });
  const props = (t) => ({ ...panelProps(null), thread: t });

  it('stays silent on a page switch even when the other thread already has a reply', () => {
    const reply = (id, content) => thread([{ id, role: 'assistant', content }]);
    const { rerender } = render(<JaviPanel {...props(reply('a1', 'Page A advice'))} />);
    expect(screen.getByRole('status')).toHaveTextContent('');
    rerender(<JaviPanel {...props(reply('b1', 'Page B advice'))} pageKey="habits" pageLabel="Habits" />);
    expect(screen.getByRole('status')).toHaveTextContent('');
  });

  it('announces the one insight after loading, stripped of markdown and prefixed', () => {
    // The Free card shows the Buy Pro hint, which reads the license through the query client.
    const client = new QueryClient();
    const wrap = (p) => (
      <QueryClientProvider client={client}>
        <JaviPanel {...p} />
      </QueryClientProvider>
    );
    const { rerender } = render(wrap(props(thread([], 'loading'))));
    expect(screen.getByRole('status')).toHaveTextContent('Javi is thinking');
    rerender(wrap(props(thread([{ id: 'a', role: 'assistant', auto: true, content: '- **Rent** is `$800` > budget' }]))));
    expect(screen.getByRole('status').textContent).toBe('Javi said: Rent is $800 budget');
  });

  it('describes the dialog with the page label', () => {
    render(<JaviPanel {...props(thread([]))} />);
    expect(screen.getByRole('dialog')).toHaveAccessibleDescription('About Todos');
  });
});
