import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ProGateNotice from '../ProGateNotice';
import TrialNotice from '../TrialNotice';
import LicenseSection from '../../settings/LicenseSection';
import { ToastProvider } from '../../../contexts/ToastContext';
import { PRO_NOT_INCLUDED_COPY } from '../../../constants/proFeatures';
import { FREE, PURCHASE_URL, TRIAL_ACTIVE, TRIAL_ENDED, status } from '../../settings/__tests__/licenseFixtures';

// The core build: src/extensions/proExtensions.js has PRO_UI_INCLUDED false (docs/adr/0001-open-core-split.md 3.11).
vi.mock('../../../services/licenseService', () => ({
  licenseService: { get: vi.fn(), activate: vi.fn(), deactivate: vi.fn(), remove: vi.fn(), dismissTrialNotice: vi.fn() },
}));
vi.mock('../../../hooks/useProfile', () => ({ useProfile: () => ({ onboarded: true, isLoading: false, unresolved: false }) }));
vi.mock('../../../services/appInfoService', () => ({ getAppInfo: vi.fn() }));
import { licenseService } from '../../../services/licenseService';
import { getAppInfo } from '../../../services/appInfoService';

function mount(node, value) {
  licenseService.get.mockResolvedValue(value);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter>{node}</MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const TRIAL_PRO = status({ state: 'trial', proSource: 'local_trial', license: null, trial: { ...TRIAL_ACTIVE, notice: 'welcome' } });

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ProGateNotice in a build without the Pro module', () => {
  it('a trial user gets the fixed not-included copy and no buy link', async () => {
    mount(<ProGateNotice capability="explain" />, TRIAL_PRO);
    expect(await screen.findByText(PRO_NOT_INCLUDED_COPY)).toBeInTheDocument();
    expect(document.querySelector('[data-reason="pro_not_included"]')).toHaveAttribute('data-capability', 'explain');
    expect(screen.queryByRole('link', { name: /buy/i })).toBeNull();
  });

  it('a license holder gets the same copy', async () => {
    mount(<ProGateNotice capability="folder_qa" />, status({ purchaseUrl: PURCHASE_URL }));
    expect(await screen.findByText(PRO_NOT_INCLUDED_COPY)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /buy/i })).toBeNull();
  });

  it('a Store license with included features gets the same copy', async () => {
    mount(
      <ProGateNotice capability="explain" />,
      status({ state: 'update_window_passed', pro: false, proScope: 'features_until', proFeatures: { included: ['explain'], locked: [] }, trial: { ...TRIAL_ENDED } }),
    );
    expect(await screen.findByText(PRO_NOT_INCLUDED_COPY)).toBeInTheDocument();
  });

  it('a Free user still gets the usual Pro notice', async () => {
    mount(<ProGateNotice capability="explain" />, { ...FREE, purchaseUrl: PURCHASE_URL });
    await waitFor(() => expect(document.querySelector('[data-capability="explain"]')).not.toBeNull());
    expect(screen.queryByText(PRO_NOT_INCLUDED_COPY)).toBeNull();
  });
});

describe('TrialNotice in a build without the Pro module', () => {
  it('renders nothing, even for a welcome notice, and never reads the status', async () => {
    mount(<TrialNotice />, TRIAL_PRO);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId('trial-notice')).toBeNull();
    expect(licenseService.get).not.toHaveBeenCalled();
  });
});

describe('Settings > License and /api/app/info proModule', () => {
  it('says the Pro features are not included when proModule is false', async () => {
    getAppInfo.mockResolvedValue({ version: '1.4.0', channel: 'stable', desktop: false, proModule: false });
    mount(<LicenseSection />, TRIAL_PRO);
    expect(await screen.findByTestId('pro-module-missing')).toHaveTextContent('Burrow Pro features: not included in this build');
  });

  it('says nothing when proModule is true or missing', async () => {
    getAppInfo.mockResolvedValue({ version: '1.4.0', channel: 'stable', desktop: false, proModule: true });
    mount(<LicenseSection />, TRIAL_PRO);
    await screen.findByTestId('license-state');
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId('pro-module-missing')).toBeNull();
    cleanup();
    getAppInfo.mockResolvedValue({ version: '1.4.0', channel: 'stable', desktop: false });
    mount(<LicenseSection />, TRIAL_PRO);
    await screen.findByTestId('license-state');
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId('pro-module-missing')).toBeNull();
    expect(screen.queryByTestId('core-source-link')).toBeNull();
  });

  it('shows the core source link only when proModule is false', async () => {
    getAppInfo.mockResolvedValue({ version: '1.4.0', channel: 'stable', desktop: false, proModule: false });
    mount(<LicenseSection />, TRIAL_PRO);
    const para = await screen.findByTestId('core-source-link');
    const link = screen.getByRole('link', { name: 'github.com/ChristianMunoz31/burrow-core' });
    expect(link).toHaveAttribute('href', 'https://github.com/ChristianMunoz31/burrow-core');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
    expect(para.textContent).not.toMatch(/[—–]/);
    expect(para.textContent).not.toMatch(/self.?host/i);
  });

  it('hides the core source link when proModule is true or null', async () => {
    for (const info of [{ proModule: true }, { proModule: null }]) {
      getAppInfo.mockResolvedValue({ version: '1.4.0', channel: 'stable', desktop: false, ...info });
      mount(<LicenseSection />, TRIAL_PRO);
      await screen.findByTestId('license-state');
      await new Promise((r) => setTimeout(r, 20));
      expect(screen.queryByTestId('core-source-link')).toBeNull();
      expect(screen.queryByRole('link', { name: /burrow-core/ })).toBeNull();
      cleanup();
    }
  });
});
