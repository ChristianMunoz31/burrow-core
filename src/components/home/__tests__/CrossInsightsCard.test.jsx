import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import CrossInsightsCard from '../CrossInsightsCard';
import { renderWithProviders } from '../../../test-utils/renderWithProviders';
import { expectCardAbsent } from '../../../test-utils/crossInsightsFixtures';

const h = vi.hoisted(() => ({ state: {}, args: null }));

vi.mock('../../../hooks/useCrossInsights', () => ({
  useCrossInsights: (...args) => {
    h.args = args;
    return h.state;
  },
}));

const INSIGHT = {
  id: 'sleep_dining',
  n: 24,
  rho: -0.42,
  r: -0.4,
  groupA: { label: 'under 7h', days: 9, mean: 18.5 },
  groupB: { label: '7h or more', days: 15, mean: 13.4 },
  effectPct: 38,
  effectAbs: 5.1,
  unit: 'usd',
  text: 'On days you slept under 7h you spent 38% more on dining (n=24).',
};
const OK = { loading: false, result: { status: 'ok', insights: [INSIGHT], windowDays: 60, coverage: {}, missing: [] } };

beforeEach(() => {
  h.state = OK;
  h.args = null;
});
afterEach(cleanup);

describe('CrossInsightsCard sources', () => {
  it('asks for every pair, with no workspace argument', () => {
    renderWithProviders(<CrossInsightsCard />);
    expect(h.args).toEqual([]);
  });

  it('renders nothing while the data loads', () => {
    h.state = { ...OK, loading: true };
    const { container } = renderWithProviders(<CrossInsightsCard />);
    expectCardAbsent(container);
    expect(screen.queryByText('Patterns across your data')).not.toBeInTheDocument();
  });

  it('renders the finding once loaded', () => {
    renderWithProviders(<CrossInsightsCard />);
    expect(screen.getByText('Patterns across your data')).toBeInTheDocument();
  });
});

describe('CrossInsightsCard', () => {
  const EMPTY_RESULT = { status: 'insufficient', insights: [], windowDays: 60, coverage: {}, missing: ['health_not_connected', 'no_transactions', 'no_calendar'] };
  const OLD_COPY = /Not enough overlapping|isn't connected|imported yet|so spending is skipped|couldn't load|Couldn't load|Loading patterns|Loading health|No timed calendar|No daily habits|No journal entries/;

  it('renders nothing when there are no findings, whatever is missing', () => {
    h.state = { loading: false, result: EMPTY_RESULT };
    const { container } = renderWithProviders(<CrossInsightsCard />);
    expectCardAbsent(container);
    expect(screen.queryByText('Patterns across your data')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(OLD_COPY);
  });

  it('renders nothing while loading, even if findings exist, and shows no skeleton', () => {
    h.state = { loading: true, result: OK.result };
    const { container } = renderWithProviders(<CrossInsightsCard />);
    expectCardAbsent(container);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('renders nothing while loading with no findings', () => {
    h.state = { loading: true, result: EMPTY_RESULT };
    const { container } = renderWithProviders(<CrossInsightsCard />);
    expectCardAbsent(container);
  });

  it('appears once loading finishes with findings and shows no diagnostic text', () => {
    h.state = { loading: true, result: { ...OK.result, insights: [] } };
    const view = renderWithProviders(<CrossInsightsCard />);
    expectCardAbsent(view.container);
    cleanup();
    h.state = OK;
    renderWithProviders(<CrossInsightsCard />);
    expect(screen.getByRole('heading', { name: 'Patterns across your data' })).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(OLD_COPY);
  });

  it('keeps the Explain button at its intrinsic width on mobile', () => {
    renderWithProviders(<CrossInsightsCard />);
    const button = screen.getByRole('button', { name: /Explain/ });
    expect(button).toHaveClass('self-start');
    expect(button).toHaveClass('sm:self-auto');
  });

  it('lists insights with stats and the correlation footnote', () => {
    renderWithProviders(<CrossInsightsCard />);
    expect(screen.getByText(INSIGHT.text)).toBeInTheDocument();
    expect(screen.getByText('Based on 9 and 15 days')).toBeInTheDocument();
    expect(screen.getByText('Correlation, not causation. Tested across 6 pairs.')).toBeInTheDocument();
  });
});
