import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../../hooks/useEntitlements', async () => (await import('../../../test-utils/entitlements.js')).entitlementsModule());
import { cleanup, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import CrossInsightsCard from '../CrossInsightsCard';
import { renderWithProviders } from '../../../test-utils/renderWithProviders';
import { expectCardAbsent } from '../../../test-utils/crossInsightsFixtures';

const h = vi.hoisted(() => ({ state: {} }));

vi.mock('../../../hooks/useCrossInsights', () => ({ useCrossInsights: () => h.state }));

const insight = (id, over = {}) => ({
  id,
  n: 24,
  rho: -0.42,
  r: -0.4,
  groupA: { label: 'under 7h', days: 9, mean: 18.5 },
  groupB: { label: '7h or more', days: 15, mean: 13.4 },
  effectPct: 38,
  effectAbs: 5.1,
  unit: 'usd',
  text: `Text for ${id}.`,
  ...over,
});
const ok = (insights) => ({ loading: false, result: { status: 'ok', insights, windowDays: 60, coverage: {}, missing: [] } });

beforeEach(() => {
  h.state = ok([insight('sleep_dining')]);
});
afterEach(cleanup);

describe('empty and list states', () => {
  it('renders nothing (no heading, list or button) when insufficient with no reasons', () => {
    h.state = { loading: false, result: { status: 'insufficient', insights: [], windowDays: 60, coverage: {}, missing: [] } };
    const { container } = renderWithProviders(<CrossInsightsCard />);
    expectCardAbsent(container);
  });

  it('does not render the list or empty copy while loading', () => {
    h.state = { loading: true, result: { status: 'ok', insights: [insight('sleep_dining')], missing: [] } };
    renderWithProviders(<CrossInsightsCard />);
    expect(screen.queryByText('Text for sleep_dining.')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/Not enough overlapping data/);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('lists several insights in order with their stats', () => {
    h.state = ok([
      insight('sleep_dining', { rho: -0.6 }),
      insight('busyness_spend', { rho: 0.5, groupA: { label: 'x', days: 7, mean: 1 }, groupB: { label: 'y', days: 17, mean: 2 } }),
    ]);
    renderWithProviders(<CrossInsightsCard />);
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('Text for sleep_dining.');
    expect(items[0]).toHaveTextContent('Based on 9 and 15 days');
    expect(items[1]).toHaveTextContent('Based on 7 and 17 days');
  });

  it('shows only correlation wording in its own copy', () => {
    renderWithProviders(<CrossInsightsCard />);
    const text = document.body.textContent;
    expect(text).toMatch(/Correlation, not causation\. Tested across 6 pairs\./);
    expect(text).not.toMatch(/[–—]/);
  });
});
