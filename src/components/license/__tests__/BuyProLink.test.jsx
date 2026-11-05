import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import TrialNotice from '../TrialNotice';
import ProTrialPrompt from '../ProTrialPrompt';
import ProGateNotice from '../ProGateNotice';
import BuyProLink from '../BuyProLink';
import { ToastProvider } from '../../../contexts/ToastContext';
import {
  FREE,
  GUM_LICENSE,
  PURCHASE_URL,
  TRIAL_ACTIVE,
  TRIAL_AVAILABLE,
  TRIAL_ENDED,
  renderSection,
  status,
} from '../../settings/__tests__/licenseFixtures';

// The banner and notices below are what a build WITH the Pro UI shows (core components, so the test stays core); the
// build without it is covered in ProNotIncluded.test.jsx. Only PRO_UI_INCLUDED differs from the core module.
vi.mock('../../../extensions/proExtensions', async (importOriginal) => ({
  ...(await importOriginal()),
  PRO_UI_INCLUDED: true,
}));

vi.mock('../../../services/licenseService', () => ({
  licenseService: {
    get: vi.fn(),
    activate: vi.fn(),
    deactivate: vi.fn(),
    remove: vi.fn(),
    dismissTrialNotice: vi.fn(),
  },
}));
import { licenseService } from '../../../services/licenseService';

vi.mock('../../../hooks/useProfile', () => ({
  useProfile: () => ({ onboarded: true, isLoading: false, unresolved: false }),
}));

const LABEL = /^Buy Burrow Pro/;
const settle = () => new Promise((r) => setTimeout(r, 0));

const freeWith = (trial, over = {}) => ({ ...FREE, trial, ...over });
const endedFree = (notice = null) => freeWith({ ...TRIAL_ENDED, notice });
const trialStatus = (notice = null, over = {}) =>
  status({
    state: 'trial',
    pro: true,
    license: null,
    licenseState: 'free',
    proSource: 'local_trial',
    trial: { ...TRIAL_ACTIVE, notice },
    ...over,
  });

function mountWith(node) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter>
          <main tabIndex={-1}>{node}</main>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

async function expectLink() {
  const link = await screen.findByRole('link', { name: LABEL });
  expect(link).toHaveAttribute('href', PURCHASE_URL);
  expect(link).toHaveAttribute('target', '_blank');
  expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  return link;
}
async function expectNoLink() {
  await waitFor(() => expect(licenseService.get).toHaveBeenCalled());
  await settle();
  expect(screen.queryByRole('link', { name: LABEL })).not.toBeInTheDocument();
}

beforeEach(() => {
  licenseService.get.mockResolvedValue(FREE);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('BuyProLink', () => {
  it('renders the plain external link for a free user, with no dash in the copy', async () => {
    mountWith(<BuyProLink />);
    const link = await expectLink();
    expect(link.textContent).not.toMatch(/[–—]/);
    expect(link.getAttribute('href')).toBe('https://cdmunoz98.gumroad.com/l/burrow');
  });

  it('renders nothing while the status is loading', () => {
    licenseService.get.mockReturnValue(new Promise(() => {}));
    mountWith(<BuyProLink />);
    expect(screen.queryByRole('link', { name: LABEL })).not.toBeInTheDocument();
  });

  it.each([
    ['null', null],
    ['missing', undefined],
    ['empty', ''],
  ])('renders nothing when purchaseUrl is %s', async (_n, purchaseUrl) => {
    licenseService.get.mockResolvedValue({ ...FREE, purchaseUrl });
    mountWith(<BuyProLink />);
    await expectNoLink();
  });

  it('renders nothing when purchaseUrl is not https', async () => {
    licenseService.get.mockResolvedValue({ ...FREE, purchaseUrl: 'http://example.com/l/burrow' });
    mountWith(<BuyProLink />);
    await expectNoLink();
  });

  it('renders nothing when a license is active', async () => {
    licenseService.get.mockResolvedValue(status());
    mountWith(<BuyProLink />);
    await expectNoLink();
  });

  it.each([
    ['update_window_passed', { state: 'update_window_passed', pro: false, licenseState: 'update_window_passed' }],
    ['expired', { state: 'expired', pro: false, licenseState: 'expired' }],
  ])('renders nothing for a %s license (renew or new key, not a new purchase)', async (_n, over) => {
    licenseService.get.mockResolvedValue(status({ ...over, proSource: null, license: GUM_LICENSE }));
    mountWith(<BuyProLink />);
    await expectNoLink();
  });

  it('shows during an active trial', async () => {
    licenseService.get.mockResolvedValue(trialStatus());
    mountWith(<BuyProLink />);
    await expectLink();
  });

  it('shows after the trial ended', async () => {
    licenseService.get.mockResolvedValue(endedFree());
    mountWith(<BuyProLink />);
    await expectLink();
  });
});

describe('BuyProLink placements', () => {
  it('TrialNotice ended: next to Activate a license', async () => {
    licenseService.get.mockResolvedValue(endedFree('ended'));
    mountWith(<TrialNotice />);
    await expectLink();
    expect(screen.getByRole('link', { name: 'Activate a license' })).toHaveAttribute('href', '/settings#license');
  });

  it('TrialNotice ending_soon: next to Activate a license', async () => {
    licenseService.get.mockResolvedValue(trialStatus('ending_soon'));
    mountWith(<TrialNotice />);
    await expectLink();
    expect(screen.getByRole('link', { name: 'Activate a license' })).toBeInTheDocument();
  });

  it('TrialNotice welcome: no buy link', async () => {
    licenseService.get.mockResolvedValue(trialStatus('welcome'));
    mountWith(<TrialNotice />);
    await screen.findByRole('status');
    expect(screen.queryByRole('link', { name: LABEL })).not.toBeInTheDocument();
  });

  it('TrialNotice ended: hidden without a purchase url', async () => {
    licenseService.get.mockResolvedValue({ ...endedFree('ended'), purchaseUrl: null });
    mountWith(<TrialNotice />);
    await screen.findByRole('status');
    expect(screen.queryByRole('link', { name: LABEL })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Activate a license' })).toBeInTheDocument();
  });

  it('LicenseSection free: shown with the activation form', async () => {
    renderSection();
    await expectLink();
  });

  it('LicenseSection trial: shown', async () => {
    licenseService.get.mockResolvedValue(trialStatus());
    renderSection();
    await expectLink();
  });

  it('LicenseSection licensed: hidden', async () => {
    licenseService.get.mockResolvedValue(status());
    renderSection();
    await screen.findByTestId('license-state');
    expect(screen.queryByRole('link', { name: LABEL })).not.toBeInTheDocument();
  });

  it('LicenseSection free without a purchase url: hidden', async () => {
    licenseService.get.mockResolvedValue({ ...FREE, purchaseUrl: null });
    renderSection();
    await screen.findByTestId('license-state');
    expect(screen.queryByRole('link', { name: LABEL })).not.toBeInTheDocument();
  });

  it('ProTrialPrompt after the trial: shown with the activate link', async () => {
    licenseService.get.mockResolvedValue(endedFree());
    mountWith(<ProTrialPrompt capability="ask-archive" />);
    await expectLink();
    expect(screen.getByRole('link', { name: 'Activate it in Settings > License' })).toBeInTheDocument();
  });

  it('ProTrialPrompt hidden without a purchase url', async () => {
    licenseService.get.mockResolvedValue({ ...endedFree(), purchaseUrl: null });
    mountWith(<ProTrialPrompt capability="ask-archive" />);
    await screen.findByText('This is a Burrow Pro feature.');
    expect(screen.queryByRole('link', { name: LABEL })).not.toBeInTheDocument();
  });

  it('ProGateNotice fallback (no trial prompt to show): shown', async () => {
    licenseService.get.mockResolvedValue(freeWith({ ...TRIAL_AVAILABLE, state: 'active' }, { state: 'clock_issue' }));
    mountWith(<ProGateNotice capability="x" />);
    await screen.findByText(/This is a Burrow Pro feature\./);
    await expectLink();
  });
});
