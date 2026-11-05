import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ProGateNotice from '../ProGateNotice';
import LicenseSection from '../../settings/LicenseSection';
import { ToastProvider } from '../../../contexts/ToastContext';
import { isKnownFree } from '../../../hooks/useEntitlements';
import { NEWER_LICENSE_COPY } from '../../../constants/proFeatures';
import { FREE, PURCHASE_URL, TRIAL_ENDED, status } from '../../settings/__tests__/licenseFixtures';

// The banner and notices below are what a build WITH the Pro UI shows (core components, so the test stays core); the
// build without it is covered in ProNotIncluded.test.jsx. Only PRO_UI_INCLUDED differs from the core module.
vi.mock('../../../extensions/proExtensions', async (importOriginal) => ({
  ...(await importOriginal()),
  PRO_UI_INCLUDED: true,
}));

vi.mock('../../../services/licenseService', () => ({
  licenseService: { get: vi.fn(), activate: vi.fn(), deactivate: vi.fn(), remove: vi.fn(), dismissTrialNotice: vi.fn() },
}));
import { licenseService } from '../../../services/licenseService';

const SERVER_COPY = "This feature came out after your license's updates ended. It is included in a newer Burrow Pro license.";
const ALL = ['javi_tools', 'briefings', 'explain', 'insights', 'semantic_search'];

/** A Store build's perpetual license past its update window. */
const lapsed = (included, over = {}) =>
  status({
    state: 'update_window_passed',
    pro: false,
    licenseState: 'update_window_passed',
    reasons: ['update_window_passed'],
    message: 'Your license\'s updates have ended. Every Pro feature released during your update period stays on for good. Pro features released later need a newer Burrow Pro license. Your data is untouched.',
    proScope: 'features_until',
    proFeatures: { included, locked: ALL.filter((id) => !included.includes(id)) },
    trial: { ...TRIAL_ENDED },
    ...over,
  });

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

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("isKnownFree", () => {
  const flags = (over) => ({ known: true, pro: false, proScope: null, includedFeatures: [], ...over });

  it('a plain free user is free for every feature, a Pro user for none', () => {
    expect(isKnownFree(flags({}))).toBe(true);
    expect(isKnownFree(flags({}), 'briefings')).toBe(true);
    expect(isKnownFree(flags({ pro: true }), 'briefings')).toBe(false);
    expect(isKnownFree(flags({ known: false }), 'briefings')).toBe(false);
  });

  it('a lapsed Store license is free only for the features it does not include', () => {
    const e = flags({ proScope: 'features_until', includedFeatures: ['briefings'] });
    expect(isKnownFree(e, 'briefings')).toBe(false);
    expect(isKnownFree(e, 'explain')).toBe(true);
    // without a feature id it is not counted as free (it has some Pro; the server decides per feature)
    expect(isKnownFree(e)).toBe(false);
  });
});

describe('ProGateNotice for a lapsed Store license', () => {
  it('shows the distinct newer-license notice with the included features and the Buy link for a locked feature', async () => {
    mount(<ProGateNotice capability="explain" />, lapsed(['javi_tools', 'briefings']));
    const notice = await screen.findByText(SERVER_COPY);
    expect(NEWER_LICENSE_COPY).toBe(SERVER_COPY);
    const box = notice.closest('[data-capability]');
    expect(box).toHaveAttribute('data-reason', 'newer_license_required');
    expect(within(box).getByText(/Your license still includes: Javi tools and actions, Daily briefings\./)).toBeInTheDocument();
    expect(within(box).getByRole('link', { name: /Buy Burrow Pro/ })).toHaveAttribute('href', PURCHASE_URL);
    expect(within(box).getByRole('link', { name: /Settings > License/ })).toHaveAttribute('href', '/settings#license');
    expect(screen.queryByText('This is a Burrow Pro feature.')).toBeNull();
    expect(box.textContent).not.toContain('—');
  });

  it('shows nothing for a feature the license includes', async () => {
    const { container } = mount(<ProGateNotice capability="briefings" />, lapsed(['briefings']));
    await vi.waitFor(() => expect(licenseService.get).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(container.querySelector('[data-capability]')).toBeNull();
  });

  it('a plain free user still gets the ordinary Pro upsell, not the newer-license notice', async () => {
    mount(<ProGateNotice capability="explain" />, { ...FREE, trial: { ...TRIAL_ENDED } });
    expect(await screen.findByText('This is a Burrow Pro feature.')).toBeInTheDocument();
    expect(screen.queryByText(SERVER_COPY)).toBeNull();
  });
});

describe('Settings > License for a lapsed Store license', () => {
  it('shows a state distinct from no Pro, the included and locked features and the Buy button', async () => {
    mount(<LicenseSection />, lapsed(['javi_tools', 'briefings']));
    expect(await screen.findByText('Updates ended: earlier Pro features kept')).toBeInTheDocument();
    expect(screen.getByText('Some Pro features on')).toBeInTheDocument();
    expect(screen.queryByText('Pro off')).toBeNull();
    const list = screen.getByTestId('license-included-features');
    expect(within(list).getByText('Javi tools and actions: included')).toBeInTheDocument();
    expect(within(list).getByText('Daily briefings: included')).toBeInTheDocument();
    expect(within(list).getByText('Explain patterns: needs a newer Burrow Pro license')).toBeInTheDocument();
    expect(screen.getByText(/Pro features released later need a newer Burrow Pro license/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Buy Burrow Pro/ })).toHaveAttribute('href', PURCHASE_URL);
  });

  it('a direct-build lapsed license keeps the old state, no feature list and no Buy button', async () => {
    mount(
      <LicenseSection />,
      status({ state: 'update_window_passed', pro: false, licenseState: 'update_window_passed', reasons: ['update_window_passed'], message: 'x' }),
    );
    expect(await screen.findByText('Update window passed')).toBeInTheDocument();
    expect(screen.getByText('Pro off')).toBeInTheDocument();
    expect(screen.queryByTestId('license-included-features')).toBeNull();
    expect(screen.queryByRole('link', { name: /Buy Burrow Pro/ })).toBeNull();
  });
});
