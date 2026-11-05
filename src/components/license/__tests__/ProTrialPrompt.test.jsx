import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ProTrialPrompt from '../ProTrialPrompt';
import { ToastProvider } from '../../../contexts/ToastContext';

vi.mock('../../../services/licenseService', () => ({
  licenseService: { get: vi.fn() },
}));
import { licenseService } from '../../../services/licenseService';

const trial = (state, over = {}) => ({
  state,
  startedAt: null,
  endsAt: null,
  daysLeft: null,
  remindToday: false,
  notice: null,
  ...over,
});
const status = (over = {}) => ({
  state: 'free',
  pro: false,
  proSource: null,
  trial: trial('ended', { daysLeft: 0 }),
  perks: { founderBackground: false },
  ...over,
});
const activeStatus = () =>
  status({ pro: true, state: 'trial', proSource: 'local_trial', trial: trial('active', { daysLeft: 3 }) });

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter>
          <ProTrialPrompt capability="ask-archive" className="extra" />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const settle = () => new Promise((r) => setTimeout(r, 0));
const LICENSE_LINK = 'Activate it in Settings > License';

beforeEach(() => {
  licenseService.get.mockResolvedValue(status());
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ProTrialPrompt', () => {
  it('renders nothing while the status is loading', () => {
    licenseService.get.mockReturnValue(new Promise(() => {}));
    const { container } = mount();
    expect(container.querySelector('[data-capability]')).toBeNull();
  });

  it('renders nothing when Pro is on', async () => {
    licenseService.get.mockResolvedValue(status({ pro: true, state: 'pro', proSource: 'license' }));
    const { container } = mount();
    await waitFor(() => expect(licenseService.get).toHaveBeenCalled());
    await settle();
    expect(container.querySelector('[data-capability]')).toBeNull();
  });

  it('renders nothing during an active trial', async () => {
    licenseService.get.mockResolvedValue(activeStatus());
    const { container } = mount();
    await waitFor(() => expect(licenseService.get).toHaveBeenCalled());
    await settle();
    expect(container.querySelector('[data-capability]')).toBeNull();
  });

  it('renders nothing for an ended trial during a clock issue', async () => {
    licenseService.get.mockResolvedValue(status({ state: 'clock_issue' }));
    const { container } = mount();
    await waitFor(() => expect(licenseService.get).toHaveBeenCalled());
    await settle();
    expect(container.querySelector('[data-capability]')).toBeNull();
  });

  it('after the trial: plain upsell, ended line and a link to the license settings, no button', async () => {
    const { container } = mount();
    expect(await screen.findByText('This is a Burrow Pro feature.')).toBeInTheDocument();
    expect(screen.getByText('Your Pro trial ended. Your data is all here.')).toBeInTheDocument();
    expect(container.querySelector('[data-capability="ask-archive"]')).toHaveClass('extra');
    expect(screen.getByRole('link', { name: LICENSE_LINK })).toHaveAttribute('href', '/settings#license');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('with no trial record yet: the upsell without the ended line and no start button', async () => {
    licenseService.get.mockResolvedValue(status({ trial: trial('available') }));
    mount();
    expect(await screen.findByText('This is a Burrow Pro feature.')).toBeInTheDocument();
    expect(screen.queryByText(/trial ended/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Try Pro/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: LICENSE_LINK })).toBeInTheDocument();
  });
});
