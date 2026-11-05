// A core-only build has no typed questions: a palette question sends nothing and the panel says the feature
// is not included, with nothing to buy or start. Advice itself works.
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import userEvent from '@testing-library/user-event';
import { Link, MemoryRouter, useLocation } from 'react-router-dom';
import JaviAdvisor from '../JaviAdvisor';
import { openJavi } from '../openJavi';
import { jsonResponse } from '../../../test-utils/sseResponse';
import { PageContextProvider, usePageContext } from '../../../contexts/PageContextContext';
import { resolveJaviPageKey } from '../../../constants/javiPages';
import { allowSlowSuite } from '../../../test-utils/slowSuite';
import { answerInbox } from '../../../test-utils/javiInbox.js';
import { PRO_NOT_INCLUDED_COPY } from '../../../constants/proFeatures';

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
function FakePage() {
  usePageContext('todos', () => ({ open: 3 }));
  return null;
}

const queryClient = new QueryClient();

function Harness() {
  const { pathname } = useLocation();
  const key = resolveJaviPageKey(pathname);
  return (
    <QueryClientProvider client={queryClient}>
      <PageContextProvider>
        <FakePage />
        <nav>
          <Link to="/habits">to habits</Link>
        </nav>
        <JaviAdvisor pageKey={key} visible={key !== null} autoAdvise />
      </PageContextProvider>
    </QueryClientProvider>
  );
}

const view = () => (
  <MemoryRouter initialEntries={['/todos']}>
    <Harness />
  </MemoryRouter>
);
const bar = () => screen.getByRole('button', { name: 'Javi, AI helper' });
const notice = () => document.querySelector('[data-reason="pro_not_included"]');

beforeAll(async () => {
  await import('../JaviPanel');
}, 30000);

beforeEach(() => {
  vi.stubGlobal('fetch', routedFetch);
  mockFetch.mockReset();
  jarvisFetch.mockReset();
  mockFetch.mockResolvedValue(ok('**Advice** here'));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

allowSlowSuite();

describe('Not included in this build', () => {
  it('shows the not-included notice when a palette question was blocked, and still gives the advice', async () => {
    render(view());
    act(() => openJavi({ prompt: 'what is due today' }));
    await screen.findByText('Advice');
    await waitFor(() => expect(notice()).toBeInTheDocument());
    expect(screen.getByText(PRO_NOT_INCLUDED_COPY)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /buy/i })).not.toBeInTheDocument();
  });

  it('shows no notice and no hint when nothing was blocked', async () => {
    const user = userEvent.setup();
    render(view());
    await user.click(bar());
    await screen.findByText('Advice');
    expect(notice()).not.toBeInTheDocument();
    expect(screen.getByRole('dialog').textContent).not.toMatch(/\bpro\b|buy|upgrade|licen[sc]e|trial/i);
  });

  it('clears the blocked-question notice when the page changes', async () => {
    const user = userEvent.setup();
    render(view());
    act(() => openJavi({ prompt: 'what is due today' }));
    await waitFor(() => expect(notice()).toBeInTheDocument());

    await user.click(screen.getByRole('link', { name: 'to habits' }));
    await waitFor(() => expect(notice()).not.toBeInTheDocument());
  });
});
