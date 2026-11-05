import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import TrialBadge from '../TrialBadge';

const profile = vi.hoisted(() => ({ value: { onboarded: true, isLoading: false, unresolved: false } }));
vi.mock('../../../hooks/useProfile', () => ({ useProfile: () => profile.value }));

vi.mock('../../../services/licenseService', () => ({
  licenseService: { get: vi.fn() },
}));
import { licenseService } from '../../../services/licenseService';

const trialStatus = (daysLeft) => ({
  state: 'trial',
  pro: true,
  proSource: 'local_trial',
  trial: { state: 'active', daysLeft, notice: null },
});

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <TrialBadge />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  profile.value = { onboarded: true, isLoading: false, unresolved: false };
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('TrialBadge', () => {
  it.each([
    [5, 'Pro trial: 5 days left'],
    [1, 'Pro trial: 1 day left'],
    [0, 'Pro trial: 0 days left'],
    [4.2, 'Pro trial: 5 days left'],
    [0.4, 'Pro trial: 1 day left'],
    [-1, 'Pro trial: 0 days left'],
  ])('shows %s days as a link to the license settings', async (days, text) => {
    licenseService.get.mockResolvedValue(trialStatus(days));
    mount();
    const link = await screen.findByRole('link', { name: text });
    expect(link).toHaveAttribute('href', '/settings#license');
  });

  it.each([
    ['a licensed user', { state: 'pro', pro: true, proSource: 'license', trial: { state: 'active', daysLeft: 3 } }],
    ['a free user', { state: 'free', pro: false, proSource: null, trial: { state: 'ended', daysLeft: 0 } }],
  ])('renders nothing for %s', async (_label, status) => {
    licenseService.get.mockResolvedValue(status);
    const { container } = mount();
    await waitFor(() => expect(licenseService.get).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(container).toBeEmptyDOMElement();
  });

  it.each([
    ['before onboarding is done', { onboarded: false, isLoading: false, unresolved: false }],
    ['while the profile is loading', { onboarded: true, isLoading: true, unresolved: false }],
    ['when the profile is unresolved', { onboarded: true, isLoading: false, unresolved: true }],
  ])('renders nothing %s', async (_label, value) => {
    profile.value = value;
    licenseService.get.mockResolvedValue(trialStatus(5));
    const { container } = mount();
    await waitFor(() => expect(licenseService.get).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(container).toBeEmptyDOMElement();
  });

  it('is hidden below sm and keeps a 24px tap target', async () => {
    licenseService.get.mockResolvedValue(trialStatus(5));
    mount();
    const link = await screen.findByRole('link', { name: 'Pro trial: 5 days left' });
    expect(link).toHaveClass('max-sm:hidden', 'min-h-6', 'self-center');
  });

  it('renders nothing while loading', () => {
    licenseService.get.mockReturnValue(new Promise(() => {}));
    const { container } = mount();
    expect(container).toBeEmptyDOMElement();
  });
});
