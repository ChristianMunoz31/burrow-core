// A refused Pro attempt must not vanish when the entitlements then flip to Free, the panel keeps
// focus on a live Pro-to-Free switch, and only one upsell shows at a time.
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
vi.mock('../../../hooks/useEntitlements', async () => (await import('../../../test-utils/entitlements.js')).entitlementsModule());
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
import {
  FREE_STATE,
  refreshEntitlementsMock,
  resetEntitlementsState,
  setEntitlementsState,
} from '../../../test-utils/entitlements.js';

// ProGateNotice delegates to ProTrialPrompt for an ended trial, which reads the license status.
const license = vi.hoisted(() => ({ status: null }));
vi.mock('../../../hooks/useLicense', () => ({ useLicense: () => ({ status: license.status }) }));
const FREE_LICENSE = {
  state: 'update_window_passed',
  pro: false,
  license: null,
  proSource: null,
  purchaseUrl: 'https://example.com/buy-burrow-pro',
  trial: { state: 'ended' },
};

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
const notice = () => document.querySelector('[data-capability="javi_conversation"]');
const hintText = /Ask follow-up questions with Pro./;
const proText = /This is a Burrow Pro feature/;

beforeAll(async () => {
  await import('../JaviPanel');
}, 30000);

beforeEach(() => {
  vi.stubGlobal('fetch', routedFetch);
  mockFetch.mockReset();
  jarvisFetch.mockReset();
  mockFetch.mockResolvedValue(ok('**Advice** here'));
  license.status = FREE_LICENSE;
  refreshEntitlementsMock.mockClear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  resetEntitlementsState();
});

allowSlowSuite();

describe('Free upsell', () => {
  it('shows the notice without the passive hint when a palette question was blocked', async () => {
    setEntitlementsState(FREE_STATE);
    render(view());
    act(() => openJavi({ prompt: 'what is due today' }));
    await screen.findByText('Advice');
    await waitFor(() => expect(notice()).toBeInTheDocument());
    expect(screen.getByText(proText)).toBeInTheDocument();
    expect(screen.queryByText(hintText)).not.toBeInTheDocument();
  });

  it('shows the passive hint alone when nothing was blocked', async () => {
    setEntitlementsState(FREE_STATE);
    const user = userEvent.setup();
    render(view());
    await user.click(bar());
    await screen.findByText('Advice');
    expect(screen.getByText(hintText)).toBeInTheDocument();
    expect(screen.queryByText(proText)).not.toBeInTheDocument();
  });

  it('clears the blocked-question notice when the page changes', async () => {
    setEntitlementsState(FREE_STATE);
    const user = userEvent.setup();
    render(view());
    act(() => openJavi({ prompt: 'what is due today' }));
    await waitFor(() => expect(notice()).toBeInTheDocument());

    await user.click(screen.getByRole('link', { name: 'to habits' }));
    await waitFor(() => expect(screen.queryByText(proText)).not.toBeInTheDocument());
    expect(notice()).not.toBeInTheDocument();
  });
});
