// Core build (PRO_UI_INCLUDED false): the tier hints (Pro pill + description) on Free, and ProGateNotice for
// lapsed licenses. The stale-Pro-cache re-read flows (Explain, Javi typed questions, briefing refresh) are Pro UI
// and live in pro/ui/__tests__/ProRefresh.pro.test.jsx.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import CrossInsightsCard from '../../home/CrossInsightsCard';
import ProGateNotice from '../ProGateNotice';
import { ProPill, ProPillDescription } from '../ProPill';
import { ToastProvider } from '../../../contexts/ToastContext';

const h = vi.hoisted(() => ({ insights: {} }));

vi.mock('../../../services/licenseService', () => ({
  licenseService: { get: vi.fn(), dismissTrialNotice: vi.fn() },
}));
vi.mock('../../../hooks/useCrossInsights', () => ({ useCrossInsights: () => h.insights }));
import { licenseService } from '../../../services/licenseService';

const trial = (state) => ({ state, startedAt: null, endsAt: null, daysLeft: null, remindToday: false, notice: null });
const FREE = {
  state: 'free',
  pro: false,
  edition: null,
  proSource: null,
  license: null,
  trial: trial('ended'),
  perks: { founderBackground: false },
  purchaseUrl: 'https://example.test/burrow',
};
const LICENSED = { ...FREE, state: 'pro', pro: true, edition: 'standard', proSource: 'license', license: { keyLast4: '1234' } };
const LAPSED = { ...FREE, state: 'expired', license: { keyLast4: '1234' } };
const CLOCK = { ...FREE, state: 'clock_issue' };


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
  h.insights = { loading: false, result: { status: 'ok', insights: [insight], windowDays: 60, coverage: {}, missing: [] } };
});
afterEach(cleanup);

describe('tier hints on Free', () => {
  it('Explain carries a Pro description and stays clickable', async () => {
    licenseService.get.mockResolvedValue(FREE);
    mount(<CrossInsightsCard />);
    const explain = await screen.findByRole('button', { name: 'Explain' });
    await waitFor(() => expect(explain).toHaveAccessibleDescription('Part of Burrow Pro'));
    expect(explain).not.toBeDisabled();
  });

  it('keeps the Pro description for a user who has Pro, since a build without the Pro UI shows Free UI to everyone', async () => {
    licenseService.get.mockResolvedValue(LICENSED);
    mount(<CrossInsightsCard />);
    const explain = await screen.findByRole('button', { name: 'Explain' });
    await waitFor(() => expect(licenseService.get).toHaveBeenCalled());
    await waitFor(() => expect(explain).toHaveAccessibleDescription('Part of Burrow Pro'));
  });

  it('the pill is decorative and the description is screen reader only', () => {
    render(
      <>
        <ProPill />
        <ProPillDescription id="d" />
      </>,
    );
    expect(screen.getByText('Pro')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByText('Part of Burrow Pro')).toHaveClass('sr-only');
  });
});

describe('ProGateNotice', () => {
  it('sends an unlicensed user with an ended trial to the trial prompt', async () => {
    licenseService.get.mockResolvedValue(FREE);
    mount(<ProGateNotice capability="x" />);
    expect(await screen.findByText('Your Pro trial ended. Your data is all here.')).toBeInTheDocument();
  });

  it('shows one plain sentence and the Settings link (no trial text) when the clock is off', async () => {
    licenseService.get.mockResolvedValue(CLOCK);
    mount(<ProGateNotice capability="x" />);
    await screen.findByText(/Pro is off on this computer/);
    expect(screen.getByRole('link', { name: /Settings > License/ })).toHaveAttribute('href', '/settings#license');
    expect(screen.queryByText(/trial ended/)).not.toBeInTheDocument();
  });

  it('never says the trial ended to a licensed user whose Pro lapsed, and offers no Buy link', async () => {
    licenseService.get.mockResolvedValue(LAPSED);
    mount(<ProGateNotice capability="x" />);
    await screen.findByText(/Pro is off on this computer/);
    expect(screen.getByRole('link', { name: /Settings > License/ })).toHaveAttribute('href', '/settings#license');
    expect(screen.queryByText(/trial ended/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Activate it in Settings/)).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Buy Burrow Pro/ })).not.toBeInTheDocument();
  });
});
