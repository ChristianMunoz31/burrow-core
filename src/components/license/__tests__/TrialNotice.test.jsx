import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import TrialNotice from '../TrialNotice';
import serverConstants from '../../../../server/license/constants.js?raw';
import { TRIAL_DAYS } from '../../../constants/trial';

// The banner and notices below are what a build WITH the Pro UI shows (core components, so the test stays core); the
// build without it is covered in ProNotIncluded.test.jsx. Only PRO_UI_INCLUDED differs from the core module.
vi.mock('../../../extensions/proExtensions', async (importOriginal) => ({
  ...(await importOriginal()),
  PRO_UI_INCLUDED: true,
}));

vi.mock('../../../services/licenseService', () => ({
  licenseService: { get: vi.fn(), dismissTrialNotice: vi.fn() },
}));
import { licenseService } from '../../../services/licenseService';

const profile = vi.hoisted(() => ({ value: { onboarded: true, isLoading: false, unresolved: false } }));
vi.mock('../../../hooks/useProfile', () => ({ useProfile: () => profile.value }));

const status = (notice, over = {}) => ({
  state: 'trial',
  pro: true,
  proSource: 'local_trial',
  trial: {
    state: 'active',
    startedAt: '2026-10-05T00:00:00Z',
    endsAt: '2026-10-12T00:00:00Z',
    daysLeft: 5,
    remindToday: false,
    notice,
    ...over,
  },
});
const cleared = status(null);
const endedStatus = () => ({ ...status('ended', { state: 'ended', daysLeft: 0 }), state: 'free', pro: false });

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <main tabIndex={-1} data-testid="shell-main">
          <TrialNotice />
        </main>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  profile.value = { onboarded: true, isLoading: false, unresolved: false };
  licenseService.dismissTrialNotice.mockResolvedValue(cleared);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('TrialNotice', () => {
  it('welcome: status banner with the copy and one Got it button, no link', async () => {
    licenseService.get.mockResolvedValue(status('welcome', { daysLeft: 14 }));
    mount();
    const banner = await screen.findByRole('status');
    expect(banner).toHaveTextContent('Burrow Pro is on for 14 days.');
    expect(banner).toHaveTextContent(
      "Javi's follow-up questions, actions, briefings and Explain are unlocked. No card, no account, nothing leaves this computer. After that you move to Burrow Free and keep all your data.",
    );
    expect(screen.getByRole('button', { name: 'Got it' })).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it.each([
    [10, 'Burrow Pro is on for 10 days.'],
    [1, 'Burrow Pro is on for 1 day.'],
    [9.2, 'Burrow Pro is on for 10 days.'],
  ])('welcome title follows the days left (%s)', async (daysLeft, title) => {
    licenseService.get.mockResolvedValue(status('welcome', { daysLeft }));
    mount();
    expect(await screen.findByRole('status')).toHaveTextContent(title);
  });

  it('welcome title falls back to the trial length when daysLeft is missing', async () => {
    licenseService.get.mockResolvedValue(status('welcome', { daysLeft: undefined }));
    mount();
    expect(await screen.findByRole('status')).toHaveTextContent(`Burrow Pro is on for ${TRIAL_DAYS} days.`);
  });

  it("the client TRIAL_DAYS equals the server's", () => {
    const match = /export const TRIAL_DAYS\s*=\s*(\d+)/.exec(serverConstants);
    expect(match).not.toBeNull();
    expect(TRIAL_DAYS).toBe(Number(match[1]));
  });

  it('ending_soon: date, license link and Dismiss', async () => {
    licenseService.get.mockResolvedValue(status('ending_soon', { daysLeft: 1 }));
    mount();
    const banner = await screen.findByRole('status');
    expect(banner).toHaveTextContent('Your Pro trial ends on Oct 12, 2026.');
    expect(banner).toHaveTextContent(
      'Your data stays right here either way. Keep Pro any time with a Burrow Pro license.',
    );
    expect(screen.getByRole('link', { name: 'Activate a license' })).toHaveAttribute('href', '/settings#license');
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeInTheDocument();
  });

  it('ended: title, body, link and OK', async () => {
    licenseService.get.mockResolvedValue(endedStatus());
    mount();
    const banner = await screen.findByRole('status');
    expect(banner).toHaveTextContent("Your Pro trial ended. You're on Burrow Free.");
    expect(banner).toHaveTextContent(
      "All your data, export, import, backups and one Javi insight per page stay free. Pro features like Javi's follow-up questions, actions, briefings and Explain are off until you activate a license.",
    );
    expect(screen.getByRole('link', { name: 'Activate a license' })).toHaveAttribute('href', '/settings#license');
    expect(screen.getByRole('button', { name: 'OK' })).toBeInTheDocument();
  });

  it('ended with a license on this computer renders nothing', async () => {
    licenseService.get.mockResolvedValue({ ...endedStatus(), license: { keyLast4: '1234' } });
    mount();
    const container = screen.getByTestId('shell-main');
    await waitFor(() => expect(licenseService.get).toHaveBeenCalled());
    await settle();
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when the notice is null', async () => {
    licenseService.get.mockResolvedValue(cleared);
    mount();
    const container = screen.getByTestId('shell-main');
    await waitFor(() => expect(licenseService.get).toHaveBeenCalled());
    await settle();
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when the status has no trial block', async () => {
    licenseService.get.mockResolvedValue({ state: 'free', pro: false });
    mount();
    const container = screen.getByTestId('shell-main');
    await waitFor(() => expect(licenseService.get).toHaveBeenCalled());
    await settle();
    expect(container).toBeEmptyDOMElement();
  });

  it.each([
    ['before onboarding is done', { onboarded: false, isLoading: false, unresolved: false }],
    ['while the profile is loading', { onboarded: true, isLoading: true, unresolved: false }],
    ['when the profile is unresolved', { onboarded: true, isLoading: false, unresolved: true }],
  ])('renders nothing %s', async (_label, value) => {
    profile.value = value;
    licenseService.get.mockResolvedValue(status('welcome'));
    mount();
    const container = screen.getByTestId('shell-main');
    await waitFor(() => expect(licenseService.get).toHaveBeenCalled());
    await settle();
    expect(container).toBeEmptyDOMElement();
  });

  it('a click posts the notice once and hides the banner', async () => {
    const user = userEvent.setup();
    licenseService.get.mockResolvedValue(status('welcome'));
    mount();
    await user.click(await screen.findByRole('button', { name: 'Got it' }));
    expect(licenseService.dismissTrialNotice).toHaveBeenCalledTimes(1);
    expect(licenseService.dismissTrialNotice).toHaveBeenCalledWith('welcome');
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
  });

  it('moves focus to <main> when the focused button unmounts', async () => {
    const user = userEvent.setup();
    licenseService.get.mockResolvedValue(status('welcome'));
    mount();
    await user.click(await screen.findByRole('button', { name: 'Got it' }));
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
    expect(screen.getByTestId('shell-main')).toHaveFocus();
  });

  it('the license link dismisses too, once', async () => {
    const user = userEvent.setup();
    licenseService.get.mockResolvedValue(endedStatus());
    mount();
    await user.click(await screen.findByRole('link', { name: 'Activate a license' }));
    expect(licenseService.dismissTrialNotice).toHaveBeenCalledTimes(1);
    expect(licenseService.dismissTrialNotice).toHaveBeenCalledWith('ended');
  });

  it('a failed dismiss does not throw or loop: one post, banner hidden, status refetched', async () => {
    const user = userEvent.setup();
    licenseService.get.mockResolvedValue(status('ending_soon'));
    licenseService.dismissTrialNotice.mockRejectedValue(new Error('fetch failed'));
    mount();
    await user.click(await screen.findByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(licenseService.get).toHaveBeenCalledTimes(2));
    await settle();
    expect(licenseService.dismissTrialNotice).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
