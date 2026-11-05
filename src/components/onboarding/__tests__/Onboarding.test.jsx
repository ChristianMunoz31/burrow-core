import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import Onboarding from '../Onboarding';
import { lsKey } from '../../../utils/storageKeys';

vi.mock('../../../services/profileService', () => ({
  profileService: { get: vi.fn(), update: vi.fn() },
}));
vi.mock('../../../services/stateService', () => ({
  stateService: {
    get: vi.fn(async () => undefined),
    getAll: vi.fn(async () => ({})),
    put: vi.fn(async () => undefined),
  },
}));
vi.mock('../../../services/aiSettingsService', () => ({
  aiSettingsService: { setup: vi.fn(), pull: vi.fn() },
}));
import { profileService } from '../../../services/profileService';
import { aiSettingsService } from '../../../services/aiSettingsService';
import { stateService } from '../../../services/stateService';
import { __resetPullStoreForTests } from '../../../hooks/ollamaPullStore';
import { allowSlowSuite } from '../../../test-utils/slowSuite';

// The first test opens a cold lazy chunk; React holds its reveal at least 300 ms after the fallback,
// which leaves too little of the 1 s findBy default on a busy full run.
allowSlowSuite();

const NOT_ONBOARDED = { displayName: null, onboardedAt: null };

function renderOnboarding() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <Onboarding />
    </QueryClientProvider>,
  );
}

const dialog = () => screen.findByRole('dialog', { name: 'Welcome to Burrow' });

const setupState = (over = {}) => ({
  ollama: 'missing',
  host: 'http://127.0.0.1:11434',
  version: null,
  models: [],
  ready: false,
  ramGb: 16,
  recommended: {
    tier: 'mid',
    ramGb: 16,
    primary: [{ name: 'qwen2.5:3b', downloadGb: 1.9, purpose: 'both', reason: 'Fits this computer.' }],
    optional: [],
  },
  canPull: true,
  ...over,
});

/** Welcome Continue, then skip the Javi step, landing on the starter budget step. */
async function toBudgetStep(user) {
  await user.click(screen.getByRole('button', { name: 'Continue' }));
  await screen.findByRole('dialog', { name: 'Set up Javi' });
  await user.click(screen.getByRole('button', { name: 'Skip for now' }));
  await screen.findByRole('dialog', { name: 'Starter budget' });
}

beforeEach(() => {
  localStorage.clear();
  aiSettingsService.setup.mockResolvedValue(setupState());
  profileService.get.mockResolvedValue(NOT_ONBOARDED);
  profileService.update.mockImplementation(async (patch) => ({
    displayName: patch.displayName ?? null,
    onboardedAt: patch.onboarded ? '2026-10-04T00:00:00.000Z' : null,
  }));
});
afterEach(() => {
  cleanup();
  __resetPullStoreForTests();
  vi.clearAllMocks();
});

describe('Onboarding', () => {
  it('shows the welcome dialog with the privacy promise when not onboarded', async () => {
    renderOnboarding();
    const el = await dialog();
    expect(el).toHaveTextContent('Your data stays on this device');
    expect(el).toHaveTextContent('Nothing calls the internet unless you turn it on');
  });

  it('moves focus to the optional name field', async () => {
    renderOnboarding();
    await dialog();
    await waitFor(() => expect(screen.getByLabelText(/What should Burrow call you/)).toHaveFocus());
  });

  it('does not show when the server says onboarded', async () => {
    profileService.get.mockResolvedValue({ displayName: 'Sam', onboardedAt: '2026-01-01T00:00:00.000Z' });
    renderOnboarding();
    await waitFor(() => expect(profileService.get).toHaveBeenCalled());
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('does not flash when only the local cache says onboarded', async () => {
    localStorage.setItem(
      lsKey('profile'),
      JSON.stringify({ displayName: null, onboardedAt: '2026-01-01T00:00:00.000Z' }),
    );
    renderOnboarding();
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(profileService.get).toHaveBeenCalled());
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('saves the display name and marks onboarded', async () => {
    const user = userEvent.setup();
    renderOnboarding();
    await dialog();
    await user.type(screen.getByLabelText(/What should Burrow call you/), '  Sam  ');
    await toBudgetStep(user);
    await user.click(screen.getByRole('button', { name: 'Skip' }));
    await waitFor(() =>
      expect(profileService.update).toHaveBeenCalledWith({ displayName: 'Sam', onboarded: true }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(JSON.parse(localStorage.getItem(lsKey('profile')))).toMatchObject({ displayName: 'Sam' });
    expect(stateService.put).not.toHaveBeenCalled();
  });

  it('skip marks onboarded without a name', async () => {
    const user = userEvent.setup();
    renderOnboarding();
    await dialog();
    await user.type(screen.getByLabelText(/What should Burrow call you/), 'Ignored');
    await user.click(screen.getByRole('button', { name: 'Skip for now' }));
    await waitFor(() => expect(profileService.update).toHaveBeenCalledWith({ onboarded: true }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('Escape hides the dialog without marking onboarded', async () => {
    const user = userEvent.setup();
    renderOnboarding();
    await dialog();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(profileService.update).not.toHaveBeenCalled();
  });

  it('Escape does nothing once a name is typed, so input is not lost', async () => {
    const user = userEvent.setup();
    renderOnboarding();
    await dialog();
    await user.type(screen.getByLabelText(/What should Burrow call you/), 'Sam');
    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByLabelText(/What should Burrow call you/)).toHaveValue('Sam');
    expect(profileService.update).not.toHaveBeenCalled();
  });

  it('never sends an empty displayName', async () => {
    const user = userEvent.setup();
    renderOnboarding();
    await dialog();
    await user.type(screen.getByLabelText(/What should Burrow call you/), '   ');
    await toBudgetStep(user);
    await user.click(screen.getByRole('button', { name: 'Skip' }));
    await waitFor(() => expect(profileService.update).toHaveBeenCalledWith({ onboarded: true }));
  });

  it('does not show onboarding when the first load fails with no cache', async () => {
    profileService.get.mockRejectedValue(Object.assign(new Error('boom'), { status: 500 }));
    renderOnboarding();
    await waitFor(() => expect(profileService.get).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('syncs a locally saved profile to the server on the next load, local winning', async () => {
    localStorage.setItem(
      lsKey('profile'),
      JSON.stringify({ displayName: 'Local', onboardedAt: '2026-02-01T00:00:00.000Z', pendingSync: true }),
    );
    profileService.get.mockResolvedValue({ displayName: 'Stale', onboardedAt: null });
    renderOnboarding();
    await waitFor(() =>
      expect(profileService.update).toHaveBeenCalledWith({ displayName: 'Local', onboarded: true }),
    );
    await waitFor(() =>
      expect(JSON.parse(localStorage.getItem(lsKey('profile'))).pendingSync).toBeUndefined(),
    );
  });

  it('flags a failed save as pending sync', async () => {
    profileService.update.mockRejectedValue(Object.assign(new Error('unavailable'), { status: 503 }));
    const user = userEvent.setup();
    renderOnboarding();
    await dialog();
    await user.click(screen.getByRole('button', { name: 'Skip for now' }));
    await waitFor(() =>
      expect(JSON.parse(localStorage.getItem(lsKey('profile'))).pendingSync).toBe(true),
    );
  });

  it('keeps working when profile storage is unavailable (503)', async () => {
    profileService.get.mockRejectedValue(Object.assign(new Error('unavailable'), { status: 503 }));
    profileService.update.mockRejectedValue(Object.assign(new Error('unavailable'), { status: 503 }));
    const user = userEvent.setup();
    renderOnboarding();
    await dialog();
    await user.click(screen.getByRole('button', { name: 'Skip for now' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(JSON.parse(localStorage.getItem(lsKey('profile'))).onboardedAt).toEqual(expect.any(String));
  });

  it('writes entered budget amounts to the planner defaults', async () => {
    const user = userEvent.setup();
    renderOnboarding();
    await dialog();
    await toBudgetStep(user);
    const housing = await screen.findByLabelText('Housing');
    await waitFor(() => expect(housing).toHaveFocus());
    await user.type(housing, '1,200');
    await user.type(screen.getByLabelText('Income (monthly)'), '3000');
    await user.click(screen.getByRole('button', { name: 'Finish' }));
    await waitFor(() =>
      expect(stateService.put).toHaveBeenCalledWith('budget:defaults', {
        'cat-housing': 1200,
        'cat-income': 3000,
      }),
    );
    await waitFor(() => expect(profileService.update).toHaveBeenCalled());
  });

  it('rejects a non-numeric amount without finishing', async () => {
    const user = userEvent.setup();
    renderOnboarding();
    await dialog();
    await toBudgetStep(user);
    await user.type(await screen.findByLabelText('Groceries'), 'lots');
    await user.click(screen.getByRole('button', { name: 'Finish' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Enter Groceries as a number');
    expect(profileService.update).not.toHaveBeenCalled();
    expect(stateService.put).not.toHaveBeenCalled();
  });
});

describe('Onboarding without a start choice', () => {
  it('asks no start question: no radio, no workspace copy', async () => {
    renderOnboarding();
    const el = await dialog();
    expect(screen.queryByRole('radio')).toBeNull();
    expect(screen.queryByRole('group', { name: 'Where do you want to start?' })).toBeNull();
    expect(el).not.toHaveTextContent(/workspace|switch any time/i);
  });

  it('writes only the profile and the optional budget defaults, never a workspace', async () => {
    const user = userEvent.setup();
    renderOnboarding();
    await dialog();
    await toBudgetStep(user);
    await user.type(screen.getByLabelText(/^Groceries/), '450');
    await user.click(screen.getByRole('button', { name: 'Finish' }));
    await waitFor(() => expect(profileService.update).toHaveBeenCalledWith({ onboarded: true }));
    const keys = stateService.put.mock.calls.map(([key]) => key);
    expect(keys.every((key) => key === 'budget:defaults')).toBe(true);
    expect(keys).not.toContain('workspace');
  });

  it('the Javi step always continues to the starter budget step', async () => {
    const user = userEvent.setup();
    renderOnboarding();
    await dialog();
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByRole('dialog', { name: 'Set up Javi' });
    expect(screen.queryByRole('button', { name: 'Finish' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Skip for now' }));
    expect(await screen.findByRole('dialog', { name: 'Starter budget' })).toBeInTheDocument();
    expect(profileService.update).not.toHaveBeenCalled();
  });
});

describe('Onboarding Javi step', () => {
  it('comes after the name step and before the starter budget', async () => {
    const user = userEvent.setup();
    renderOnboarding();
    await dialog();
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    const step = await screen.findByRole('dialog', { name: 'Set up Javi' });
    expect(step).toHaveTextContent('free app called Ollama');
    expect(screen.getByRole('link', { name: /Get Ollama/ })).toHaveAttribute(
      'href',
      'https://ollama.com/download',
    );
    expect(screen.getByRole('button', { name: 'Back' })).toBeEnabled();
    // One forward button: Skip while Javi is not ready, never a disabled Continue beside it.
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Skip for now' }));
    expect(await screen.findByRole('dialog', { name: 'Starter budget' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(await screen.findByRole('dialog', { name: 'Set up Javi' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(await screen.findByRole('dialog', { name: 'Welcome to Burrow' })).toBeInTheDocument();
    expect(profileService.update).not.toHaveBeenCalled();
  });

  it('moves focus to the step intro and describes the dialog with it', async () => {
    const user = userEvent.setup();
    renderOnboarding();
    await dialog();
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    const step = await screen.findByRole('dialog', { name: 'Set up Javi' });
    const intro = screen.getByText(/Javi is Burrow's built-in AI helper/);
    await waitFor(() => expect(intro).toHaveFocus());
    expect(intro).toHaveAttribute('tabindex', '-1');
    expect(step).toHaveAttribute('aria-describedby', intro.id);
    expect(step.getAttribute('aria-describedby')).toBeTruthy();
    // The description is the intro only, not the whole setup card.
    expect(document.getElementById(intro.id)).not.toContainElement(
      screen.getByRole('link', { name: /Get Ollama/ }),
    );
  });

  it('shows Continue as the single primary forward button once Javi is ready', async () => {
    aiSettingsService.setup.mockResolvedValue(
      setupState({ ollama: 'running', ready: true, models: [{ name: 'qwen2.5:3b' }] }),
    );
    const user = userEvent.setup();
    renderOnboarding();
    await dialog();
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByText(/Javi is ready/);
    expect(screen.queryByRole('button', { name: 'Skip for now' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('dialog', { name: 'Starter budget' })).toBeInTheDocument();
  });

  it('holds Back and the forward button, with a linked hint, while a download runs', async () => {
    aiSettingsService.setup.mockResolvedValue(setupState({ ollama: 'running' }));
    aiSettingsService.pull.mockImplementation(() => new Promise(() => {}));
    const user = userEvent.setup();
    renderOnboarding();
    await dialog();
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(await screen.findByRole('button', { name: 'Download model qwen2.5:3b' }));
    await screen.findByRole('progressbar');
    const hint = screen.getByText('Finish or cancel the download to continue');
    expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled();
    const forward = screen.getByRole('button', { name: 'Skip for now' });
    expect(forward).toBeDisabled();
    expect(forward).toHaveAttribute('aria-describedby', hint.id);
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Skip for now' })).toBeEnabled());
    expect(screen.queryByText('Finish or cancel the download to continue')).toBeNull();
  });
});
