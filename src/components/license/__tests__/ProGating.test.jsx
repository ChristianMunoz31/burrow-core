// Pro entry points in the UI, core build (PRO_UI_INCLUDED false, Free UI for everyone): a free user sees
// ProTrialPrompt in place of the Pro action (Javi typed questions, Explain), a 403 pro_required from the
// server shows the same prompt (never a raw error), and page advice is never blocked. A user who has Pro
// gets the fixed "not included in this build" sentence. The Pro UI halves live in
// pro/ui/__tests__/ProGating.pro.test.jsx. Uses the real useEntitlements on a mocked license service.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import JaviPanel from '../../javi/JaviPanel';
import CrossInsightsCard from '../../home/CrossInsightsCard';
import Onboarding from '../../onboarding/Onboarding';
import { ToastProvider } from '../../../contexts/ToastContext';
import { EMPTY_AGENT } from '../../javi/timeline';
import { useEntitlements } from '../../../hooks/useEntitlements';

const h = vi.hoisted(() => ({ briefing: {}, insights: {} }));

vi.mock('../../../services/licenseService', () => ({
  licenseService: { get: vi.fn(), dismissTrialNotice: vi.fn() },
}));
vi.mock('../../../hooks/useJarvisStatus', () => ({
  useJarvisStatus: () => ({ status: null, loading: false, error: null }),
}));
vi.mock('../../../hooks/useBriefing', () => ({ useBriefing: () => h.briefing }));
vi.mock('../../../hooks/useCrossInsights', () => ({ useCrossInsights: () => h.insights }));
vi.mock('../../../services/profileService', () => ({
  profileService: { get: vi.fn(async () => ({ displayName: null, onboardedAt: null })), update: vi.fn() },
}));
vi.mock('../../../services/stateService', () => ({
  stateService: { get: vi.fn(async () => undefined), getAll: vi.fn(async () => ({})), put: vi.fn(async () => undefined) },
}));
vi.mock('../../../services/aiSettingsService', () => ({
  aiSettingsService: { setup: vi.fn(async () => ({ ollama: 'missing', models: [], ready: false, canPull: false })), pull: vi.fn() },
}));
import { licenseService } from '../../../services/licenseService';

const trial = (state) => ({ state, startedAt: null, endsAt: null, daysLeft: null, remindToday: false });
const FREE = { state: 'free', pro: false, edition: null, proSource: null, trial: trial('available'), perks: { founderBackground: false } };
const TRIAL_ACTIVE = { ...FREE, state: 'trial', pro: true, proSource: 'local_trial', trial: trial('active') };
const LICENSED = { ...FREE, state: 'pro', pro: true, edition: 'standard', proSource: 'license' };
const WINDOW_PASSED = { ...FREE, state: 'update_window_passed', trial: trial('ended'), purchaseUrl: 'https://example.com/buy' };

const PROMPT = /This is a Burrow Pro feature/;
const NOT_INCLUDED = /This build of Burrow does not include Burrow Pro features\./;
const capability = (name) => document.querySelector(`[data-capability="${name}"]`);

function mount(ui) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter>{ui}</MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const panel = (over = {}) => {
  const props = {
    id: 'p',
    pageKey: 'todos',
    pageLabel: 'Todos',
    thread: { messages: [], status: 'idle', error: null },
    suggestions: ['What is due soon?'],
    agent: EMPTY_AGENT,
    onSend: vi.fn(),
    onSuggestion: vi.fn(),
    onNewAdvice: vi.fn(),
    onRetry: vi.fn(),
    onClose: vi.fn(),
    ...over,
  };
  return { props, ui: <JaviPanel {...props} /> };
};

const insight = {
  id: 'sleep_dining',
  n: 24,
  rho: -0.42,
  r: -0.4,
  groupA: { label: 'under 7h', days: 9, mean: 18.5 },
  groupB: { label: '7h or more', days: 15, mean: 13.4 },
  effectPct: 38,
  effectAbs: 5.1,
  unit: 'usd',
  text: 'Text for sleep_dining.',
};

beforeEach(() => {
  licenseService.get.mockReset();
  h.briefing = {
    briefing: { digest: 'You have two todos today.', generatedAt: '2026-10-05T08:00:00.000Z', ai: { kind: 'local', host: null }, withheld: [] },
    loading: false,
    error: null,
    refreshing: false,
    refreshError: null,
    refreshUnavailable: false,
    refreshProRequired: false,
    refreshReason: null,
    refresh: vi.fn().mockResolvedValue(undefined),
  };
  h.insights = { loading: false, result: { status: 'ok', insights: [insight], windowDays: 60, coverage: {}, missing: [] } };
});
afterEach(cleanup);

describe('useEntitlements', () => {
  function Probe() {
    const e = useEntitlements();
    return <p>{JSON.stringify({ known: e.known, pro: e.pro, trial: e.trial?.state ?? null })}</p>;
  }

  it('is unknown while loading, then reflects the license status', async () => {
    licenseService.get.mockResolvedValue(TRIAL_ACTIVE);
    mount(<Probe />);
    expect(screen.getByText(/"known":false,"pro":false/)).toBeInTheDocument();
    expect(await screen.findByText(/"known":true,"pro":true/)).toHaveTextContent('"trial":"active"');
  });

  it('stays unknown (never Pro) when the status fails to load', async () => {
    licenseService.get.mockRejectedValue(new Error('401'));
    mount(<Probe />);
    await waitFor(() => expect(licenseService.get).toHaveBeenCalled());
    expect(screen.getByText(/"known":false,"pro":false/)).toBeInTheDocument();
  });
});

describe('Javi typed questions (tools path)', () => {
  it('a free user has no composer or chips, and page advice still works', async () => {
    licenseService.get.mockResolvedValue(FREE);
    const user = userEvent.setup();
    const { props, ui } = panel();
    mount(ui);
    await waitFor(() => expect(licenseService.get).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Message Javi' })).toBeNull());
    expect(screen.queryByRole('button', { name: 'What is due soon?' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Get insight' }));
    expect(props.onNewAdvice).toHaveBeenCalled();
    expect(props.onSend).not.toHaveBeenCalled();
  });

  it('a user who has Pro still gets the Free panel in a build without the Pro UI', async () => {
    licenseService.get.mockResolvedValue(LICENSED);
    const { props, ui } = panel();
    mount(ui);
    await waitFor(() => expect(licenseService.get).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByRole('textbox', { name: 'Message Javi' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'What is due soon?' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Get insight' })).toBeInTheDocument();
    expect(props.onSend).not.toHaveBeenCalled();
  });

  it('a free user whose trial window passed sees the card and the hint, and no composer', async () => {
    licenseService.get.mockResolvedValue(WINDOW_PASSED);
    const card = { id: 'a1', role: 'assistant', content: 'Your one insight', auto: true, at: 1 };
    const { props, ui } = panel({ thread: { messages: [card], status: 'idle', error: null } });
    mount(ui);
    await waitFor(() => expect(licenseService.get).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Message Javi' })).toBeNull());
    expect(screen.getByText('Your one insight')).toBeInTheDocument();
    expect(await screen.findByText(/Ask follow-up questions with Pro./)).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: /Buy Burrow Pro/ })).toHaveAttribute('href', 'https://example.com/buy');
    expect(screen.queryByRole('button', { name: 'What is due soon?' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Start a new conversation with Javi' })).toBeNull();
    expect(screen.queryByText(PROMPT)).toBeNull();
    expect(props.onSend).not.toHaveBeenCalled();
  });

  it('a 403 pro_required on a follow-up shows the javi_conversation prompt, never the raw error', async () => {
    licenseService.get.mockResolvedValue(WINDOW_PASSED);
    const { ui } = panel({
      thread: {
        messages: [],
        status: 'error',
        error: { message: 'raw advice text', code: 'pro_required', retryAfterMs: null, at: 1 },
        lastRequestMessages: [{ role: 'user', content: 'hi' }],
      },
    });
    mount(ui);
    await waitFor(() => expect(capability('javi_conversation')).toBeInTheDocument());
    expect(capability('javi_conversation')).toHaveTextContent(PROMPT);
    expect(screen.queryByText(/raw advice text/)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('shows the prompt, not a raw error, for a 403 pro_required from the server', async () => {
    licenseService.get.mockResolvedValue(FREE);
    const { ui } = panel({
      agent: { ...EMPTY_AGENT, error: 'This is a Burrow Pro feature. raw server text', errorCode: 'pro_required' },
    });
    mount(ui);
    await waitFor(() => expect(capability('javi_tools')).toBeInTheDocument());
    expect(screen.queryByText(/raw server text/)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('briefing (shown in the Javi card on Home, never in the panel)', () => {
  it('the panel shows no briefing on Home, even for Pro', async () => {
    licenseService.get.mockResolvedValue(LICENSED);
    mount(panel({ pageKey: 'home', pageLabel: 'Home' }).ui);
    await waitFor(() => expect(licenseService.get).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByText('You have two todos today.')).toBeNull();
    expect(screen.queryByRole('button', { name: /briefing/i })).toBeNull();
  });
});

describe('insights Explain', () => {
  it('a free user keeps the findings and gets the prompt instead of an Explain call', async () => {
    licenseService.get.mockResolvedValue(FREE);
    const user = userEvent.setup();
    mount(<CrossInsightsCard />);
    await waitFor(() => expect(licenseService.get).toHaveBeenCalled());
    expect(screen.getByText('Text for sleep_dining.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Explain' }));
    await waitFor(() => expect(capability('explain')).toBeInTheDocument());
  });

  it('a user who has Pro gets the not-included sentence, with no Explain call and no trial prompt', async () => {
    licenseService.get.mockResolvedValue(TRIAL_ACTIVE);
    const user = userEvent.setup();
    mount(<CrossInsightsCard />);
    await waitFor(() => expect(licenseService.get).toHaveBeenCalled());
    await user.click(screen.getByRole('button', { name: 'Explain' }));
    await waitFor(() => expect(capability('explain')).toBeInTheDocument());
    expect(capability('explain')).toHaveTextContent(NOT_INCLUDED);
    expect(capability('explain')).not.toHaveTextContent(PROMPT);
  });
});

describe('onboarding', () => {
  it('never shows a Pro prompt, even for a free user', async () => {
    licenseService.get.mockResolvedValue(FREE);
    mount(<Onboarding />);
    await screen.findByRole('dialog', { name: 'Welcome to Burrow' });
    await waitFor(() => expect(licenseService.get).not.toHaveBeenCalled());
    expect(document.querySelector('[data-capability]')).toBeNull();
    expect(screen.queryByText(PROMPT)).toBeNull();
  });
});
