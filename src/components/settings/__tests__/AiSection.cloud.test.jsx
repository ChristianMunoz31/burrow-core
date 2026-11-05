import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import AiSection from '../AiSection';
import { renderWithProviders } from '../../../test-utils/renderWithProviders';
import { aiSettingsService } from '../../../services/aiSettingsService';
import { CLOUD_CATEGORY_DEFAULTS } from '../../../constants/cloudAi';
import { allowSlowSuite } from '../../../test-utils/slowSuite';

vi.mock('../../../services/aiSettingsService', () => ({
  aiSettingsService: {
    get: vi.fn(),
    models: vi.fn(),
    setModels: vi.fn(),
    setHost: vi.fn(),
    setProvider: vi.fn(),
    setCloud: vi.fn(),
    enableCloud: vi.fn(),
    disableCloud: vi.fn(),
    setCloudCategories: vi.fn(),
    cloudHint: vi.fn(),
    setup: vi.fn(),
    pull: vi.fn(),
  },
}));
vi.mock('../../../services/secretsService', () => ({
  secretsService: {
    list: vi.fn(async () => ({
      encryption: { enabled: true },
      storage: { available: true },
      writable: true,
      secrets: [
        {
          name: 'AI_CLOUD_API_KEY',
          label: 'Cloud AI API key',
          description: 'Key for the cloud provider.',
          configured: true,
          source: 'settings',
          last4: 'wxyz',
          updatedAt: null,
          envFallback: false,
          stale: false,
          testable: false,
        },
      ],
    })),
    save: vi.fn(),
    remove: vi.fn(),
    test: vi.fn(),
  },
}));

const HOST = 'api.example.com';

const cloud = (over = {}) => ({
  optIn: false,
  keySaved: true,
  baseUrl: `https://${HOST}/v1`,
  host: HOST,
  model: 'some-model',
  tokenParam: 'max_tokens',
  ready: true,
  consent: { current: false, acceptedAt: null, host: null, version: null },
  consentVersion: 1,
  categories: { ...CLOUD_CATEGORY_DEFAULTS },
  active: false,
  ...over,
});

const settings = (over = {}, cloudOver = {}) => ({
  enabled: true,
  provider: 'ollama',
  effectiveProvider: 'ollama',
  ollama: {
    host: 'http://127.0.0.1:11434',
    hostSource: 'default',
    loopback: true,
    running: true,
    version: '0.32.14',
    numCtx: 8192,
    error: null,
  },
  models: {
    chat: { selected: null, effective: 'qwen2.5:3b', source: 'auto' },
    tools: { selected: null, effective: 'qwen2.5:7b', source: 'auto' },
  },
  cloud: cloud(cloudOver),
  ...over,
});

const MODELS = [
  { name: 'qwen2.5:7b', capabilities: ['completion', 'tools'], contextLength: 32768, parameterSize: '7.6B' },
];

const activeCloud = { optIn: true, consent: { current: true, acceptedAt: '2026-10-01T10:00:00.000Z', host: HOST, version: 1 }, active: true };

const renderSection = () =>
  renderWithProviders(
    <MemoryRouter>
      <AiSection />
    </MemoryRouter>,
  );

const radio = (name) => screen.findByRole('radio', { name });
const CLOUD_RADIO = 'Your own cloud AI (optional)';
const LOCAL_RADIO = 'On this computer (recommended)';

beforeEach(() => {
  vi.clearAllMocks();
  aiSettingsService.models.mockResolvedValue({ models: MODELS });
});
afterEach(cleanup);

// Heavy render-and-wait suite: raise the time limits so a busy machine does not trip them.
allowSlowSuite();

describe('Settings > AI source choice', () => {
  it('offers the two options in a group, local first and selected by default', async () => {
    aiSettingsService.get.mockResolvedValue(settings());
    renderSection();
    const group = await screen.findByRole('group', { name: 'Where Javi runs' });
    const radios = within(group).getAllByRole('radio');
    expect(radios.map((r) => r.closest('label').textContent)).toEqual([LOCAL_RADIO, CLOUD_RADIO]);
    expect(await radio(LOCAL_RADIO)).toBeChecked();
    expect(await screen.findByLabelText('Model for answers')).toBeInTheDocument();
    expect(screen.queryByLabelText('Provider address')).not.toBeInTheDocument();
  });

  it('choosing cloud only reveals the panel and sends nothing', async () => {
    aiSettingsService.get.mockResolvedValue(settings());
    const user = userEvent.setup();
    renderSection();
    await user.click(await radio(CLOUD_RADIO));
    expect(await screen.findByLabelText('Provider address')).toHaveValue(`https://${HOST}/v1`);
    expect(screen.getByLabelText('Cloud model')).toHaveValue('some-model');
    expect(screen.getByRole('group', { name: 'What cloud AI can see' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Model for answers')).not.toBeInTheDocument();
    for (const fn of [
      aiSettingsService.enableCloud,
      aiSettingsService.disableCloud,
      aiSettingsService.setProvider,
      aiSettingsService.setCloud,
      aiSettingsService.setCloudCategories,
    ]) {
      expect(fn).not.toHaveBeenCalled();
    }
  });

  it('choosing local while cloud is off does not call disableCloud', async () => {
    aiSettingsService.get.mockResolvedValue(settings());
    const user = userEvent.setup();
    renderSection();
    await user.click(await radio(CLOUD_RADIO));
    await user.click(await radio(LOCAL_RADIO));
    expect(await screen.findByLabelText('Model for answers')).toBeInTheDocument();
    expect(aiSettingsService.disableCloud).not.toHaveBeenCalled();
  });

  it('starts on cloud when cloud is active, and choosing local turns it off', async () => {
    aiSettingsService.get.mockResolvedValue(settings({ provider: 'openai_compat', effectiveProvider: 'openai_compat' }, activeCloud));
    aiSettingsService.disableCloud.mockResolvedValue(settings());
    const user = userEvent.setup();
    renderSection();
    expect(await radio(CLOUD_RADIO)).toBeChecked();
    await user.click(await radio(LOCAL_RADIO));
    await waitFor(() => expect(aiSettingsService.disableCloud).toHaveBeenCalledTimes(1));
    expect(await screen.findByLabelText('Model for answers')).toBeInTheDocument();
    expect(aiSettingsService.enableCloud).not.toHaveBeenCalled();
  });

  it('shows fixed copy when switching back to local fails', async () => {
    aiSettingsService.get.mockResolvedValue(settings({ provider: 'openai_compat', effectiveProvider: 'openai_compat' }, activeCloud));
    aiSettingsService.disableCloud.mockRejectedValue(Object.assign(new Error('boom'), { status: 500 }));
    const user = userEvent.setup();
    renderSection();
    await user.click(await radio(LOCAL_RADIO));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("Couldn't save that change. Try again.");
    expect(alert).not.toHaveTextContent('boom');
    expect(await radio(CLOUD_RADIO)).toBeChecked();
    expect(await radio(LOCAL_RADIO)).not.toBeChecked();
    expect(screen.getByRole('radio', { name: LOCAL_RADIO }).closest('fieldset')).not.toBeDisabled();
  });
});

describe('Settings > AI cloud panel', () => {
  it('shows the provider hostname and keeps the key masked', async () => {
    aiSettingsService.get.mockResolvedValue(settings());
    const user = userEvent.setup();
    renderSection();
    await user.click(await radio(CLOUD_RADIO));
    expect(await screen.findByText(HOST, { selector: 'span' })).toBeInTheDocument();
    expect(await screen.findByText('••••wxyz')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('sk-test-abcdefwxyz');
  });

  it('shows Saved. after a kind is saved', async () => {
    aiSettingsService.get.mockResolvedValue(settings());
    aiSettingsService.setCloudCategories.mockResolvedValue(
      settings({}, { categories: { ...CLOUD_CATEGORY_DEFAULTS, journal: true } }),
    );
    const user = userEvent.setup();
    renderSection();
    await user.click(await radio(CLOUD_RADIO));
    await user.click(await screen.findByRole('checkbox', { name: 'Journal' }));
    const group = screen.getByRole('group', { name: 'What cloud AI can see' });
    await waitFor(() => expect(within(group).getByRole('status')).toHaveTextContent('Saved.'));
  });

  it('shows the missing-setup hint on the paused banner button too', async () => {
    aiSettingsService.get.mockResolvedValue(
      settings({ provider: 'openai_compat', effectiveProvider: 'ollama' }, { ready: false, keySaved: false }),
    );
    const user = userEvent.setup();
    renderSection();
    const review = await screen.findByRole('button', { name: 'Review and turn on' });
    expect(review).toHaveAccessibleDescription('Add the provider address, model and API key first.');
    await user.click(review);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('does not open the dialog when there is no provider host', async () => {
    aiSettingsService.get.mockResolvedValue(settings({}, { host: null, baseUrl: null, ready: true }));
    const user = userEvent.setup();
    renderSection();
    await user.click(await radio(CLOUD_RADIO));
    await user.click(await screen.findByRole('button', { name: 'Turn on cloud AI' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('says the provider changed when saving drops current consent', async () => {
    const consented = { consent: { current: true, acceptedAt: '2026-10-01T10:00:00.000Z', host: HOST, version: 1 }, optIn: true };
    aiSettingsService.get.mockResolvedValue(settings({ provider: 'openai_compat', effectiveProvider: 'openai_compat' }, consented));
    aiSettingsService.setCloud.mockResolvedValue(
      settings({ provider: 'openai_compat', effectiveProvider: 'ollama' }, { host: 'other.example.com', baseUrl: 'https://other.example.com/v1' }),
    );
    const user = userEvent.setup();
    renderSection();
    await screen.findByLabelText('Provider address');
    await user.click(screen.getByRole('button', { name: 'Save provider' }));
    expect(await screen.findByText('Provider changed. Confirm cloud AI again.')).toBeInTheDocument();
  });

  it('keeps Ollama address under Advanced', async () => {
    aiSettingsService.get.mockResolvedValue(settings());
    const user = userEvent.setup();
    renderSection();
    await user.click(await radio(CLOUD_RADIO));
    expect(screen.getByLabelText('Ollama address')).not.toBeVisible();
    await user.click(screen.getByText('Advanced'));
    expect(screen.getByLabelText('Ollama address')).toBeVisible();
  });

  it('lists the kinds with their hints and defaults', async () => {
    aiSettingsService.get.mockResolvedValue(settings());
    const user = userEvent.setup();
    renderSection();
    await user.click(await radio(CLOUD_RADIO));
    const group = await screen.findByRole('group', { name: 'What cloud AI can see' });
    expect(
      within(group).getByText(`Only the kinds you tick are ever sent to ${HOST}. Javi tells you when it can't see something.`),
    ).toBeInTheDocument();
    const boxes = within(group).getAllByRole('checkbox');
    expect(boxes.map((b) => b.closest('label').textContent)).toEqual([
      'Budget',
      'Todos',
      'Calendar',
      'Habits',
      'Health',
      'Notes',
      'Journal',
      'Bookmarks',
      'Countdowns',
      'Focus sessions',
      'Folders',
    ]);
    expect(within(group).getByRole('checkbox', { name: 'Budget' })).toBeChecked();
    expect(within(group).getByRole('checkbox', { name: 'Folders' })).not.toBeChecked();
    expect(within(group).getByRole('checkbox', { name: 'Health' })).not.toBeChecked();
    expect(within(group).getByRole('checkbox', { name: 'Journal' })).not.toBeChecked();
    expect(within(group).getByRole('checkbox', { name: 'Health' })).toHaveAccessibleDescription(
      "Sleep, readiness and activity. Off by default because it's very personal.",
    );
    expect(within(group).getByText('Transactions, budget plan and subscriptions')).toBeInTheDocument();
  });

  it('saves a kind as soon as it is ticked, as a partial patch', async () => {
    aiSettingsService.get.mockResolvedValue(settings());
    aiSettingsService.setCloudCategories.mockResolvedValue(
      settings({}, { categories: { ...CLOUD_CATEGORY_DEFAULTS, journal: true } }),
    );
    const user = userEvent.setup();
    renderSection();
    await user.click(await radio(CLOUD_RADIO));
    await user.click(await screen.findByRole('checkbox', { name: 'Journal' }));
    await waitFor(() => expect(aiSettingsService.setCloudCategories).toHaveBeenCalledWith({ journal: true }));
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Journal' })).toBeChecked());
    expect(aiSettingsService.enableCloud).not.toHaveBeenCalled();
  });

  it('leaves the box as the server has it when a save fails', async () => {
    aiSettingsService.get.mockResolvedValue(settings());
    aiSettingsService.setCloudCategories.mockRejectedValue(Object.assign(new Error('raw'), { status: 400, code: 'invalid_body' }));
    const user = userEvent.setup();
    renderSection();
    await user.click(await radio(CLOUD_RADIO));
    await user.click(await screen.findByRole('checkbox', { name: 'Budget' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("Couldn't save that change. Try again.");
    expect(screen.getByRole('checkbox', { name: 'Budget' })).toBeChecked();
  });

  it('disables Turn on cloud AI with a reason until the setup is complete', async () => {
    aiSettingsService.get.mockResolvedValue(settings({}, { ready: false, keySaved: false, model: null }));
    const user = userEvent.setup();
    renderSection();
    await user.click(await radio(CLOUD_RADIO));
    const turnOn = await screen.findByRole('button', { name: 'Turn on cloud AI' });
    expect(turnOn).toHaveAttribute('aria-disabled', 'true');
    expect(turnOn).toHaveAccessibleDescription('Add the provider address, model and API key first.');
    await user.click(turnOn);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(aiSettingsService.enableCloud).not.toHaveBeenCalled();
  });

  it('refreshes the status after the key changes so Turn on becomes available', async () => {
    aiSettingsService.get.mockResolvedValue(settings({}, { ready: false, keySaved: false }));
    const { secretsService } = await import('../../../services/secretsService');
    secretsService.save.mockResolvedValue({ configured: true });
    const user = userEvent.setup();
    renderSection();
    await user.click(await radio(CLOUD_RADIO));
    await screen.findByText('••••wxyz');
    aiSettingsService.get.mockResolvedValue(settings());
    const before = aiSettingsService.get.mock.calls.length;
    await user.click(screen.getByRole('button', { name: 'Replace Cloud AI API key key' }));
    await user.type(screen.getByLabelText('Cloud AI API key API key'), 'sk-test-0000');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(aiSettingsService.get.mock.calls.length).toBeGreaterThan(before));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Turn on cloud AI' })).not.toHaveAttribute('aria-disabled'));
  });
});

describe('Settings > AI cloud opt-in', () => {
  it('opens the consent dialog, and cancel sends nothing', async () => {
    aiSettingsService.get.mockResolvedValue(settings());
    const user = userEvent.setup();
    renderSection();
    await user.click(await radio(CLOUD_RADIO));
    await user.click(await screen.findByRole('button', { name: 'Turn on cloud AI' }));
    const dialog = await screen.findByRole('dialog', { name: 'Turn on your own cloud AI' });
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(aiSettingsService.enableCloud).not.toHaveBeenCalled();
    expect(aiSettingsService.setProvider).not.toHaveBeenCalled();
  });

  it('enables cloud only after both boxes are ticked, with the exact body', async () => {
    aiSettingsService.get.mockResolvedValue(settings());
    aiSettingsService.enableCloud.mockResolvedValue(settings({ provider: 'openai_compat', effectiveProvider: 'openai_compat' }, activeCloud));
    const user = userEvent.setup();
    renderSection();
    await user.click(await radio(CLOUD_RADIO));
    await user.click(await screen.findByRole('button', { name: 'Turn on cloud AI' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Turn on cloud AI' }));
    expect(aiSettingsService.enableCloud).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('checkbox', { name: /my data goes to api\.example\.com/ }));
    await user.click(within(dialog).getByRole('checkbox', { name: /I pay api\.example\.com directly/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Turn on cloud AI' }));
    await waitFor(() =>
      expect(aiSettingsService.enableCloud).toHaveBeenCalledWith({
        version: 1,
        host: HOST,
        baseUrl: `https://${HOST}/v1`,
        acknowledgements: ['sends_data', 'pay_provider'],
      }),
    );
    expect(aiSettingsService.enableCloud).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(await screen.findByText(`Javi is using your cloud AI at ${HOST}.`)).toBeInTheDocument();
    const turnOff = screen.getByRole('button', { name: 'Turn off cloud AI' });
    expect(turnOff).toBeInTheDocument();
    await waitFor(() => expect(turnOff).toHaveFocus());
    expect(aiSettingsService.setProvider).not.toHaveBeenCalled();
  });

  it('turns cloud off with disableCloud only', async () => {
    aiSettingsService.get.mockResolvedValue(settings({ provider: 'openai_compat', effectiveProvider: 'openai_compat' }, activeCloud));
    aiSettingsService.disableCloud.mockResolvedValue(settings({}, { consent: { current: false, acceptedAt: null, host: null, version: null } }));
    const user = userEvent.setup();
    renderSection();
    await user.click(await screen.findByRole('button', { name: 'Turn off cloud AI' }));
    await waitFor(() => expect(aiSettingsService.disableCloud).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole('button', { name: 'Turn on cloud AI' })).toBeInTheDocument();
    expect(screen.queryByText(/Javi is using your cloud AI/)).not.toBeInTheDocument();
  });

  it('never enables or switches provider by itself, even with consent and the network option on', async () => {
    aiSettingsService.get.mockResolvedValue(settings({}, { consent: { current: true, acceptedAt: '2026-10-01T10:00:00.000Z', host: HOST, version: 1 }, optIn: true }));
    const user = userEvent.setup();
    renderSection();
    await user.click(await radio(CLOUD_RADIO));
    await screen.findByLabelText('Provider address');
    expect(await screen.findByRole('button', { name: 'Turn on cloud AI' })).toBeInTheDocument();
    expect(aiSettingsService.enableCloud).not.toHaveBeenCalled();
    expect(aiSettingsService.setProvider).not.toHaveBeenCalled();
  });
});

describe('Settings > AI cloud banners', () => {
  it('shows the paused banner when cloud was selected without current consent, and reviews on click', async () => {
    aiSettingsService.get.mockResolvedValue(settings({ provider: 'openai_compat', effectiveProvider: 'ollama' }));
    const user = userEvent.setup();
    renderSection();
    expect(await radio(CLOUD_RADIO)).toBeChecked();
    expect(
      await screen.findByText('Cloud AI is paused until you confirm it again. Javi is running on this computer for now.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Javi is using your cloud AI/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Review and turn on' }));
    expect(await screen.findByRole('dialog', { name: 'Turn on your own cloud AI' })).toBeInTheDocument();
    expect(aiSettingsService.enableCloud).not.toHaveBeenCalled();
  });

  it('choosing local on a paused setup clears the selected provider', async () => {
    aiSettingsService.get.mockResolvedValue(settings({ provider: 'openai_compat', effectiveProvider: 'ollama' }));
    aiSettingsService.disableCloud.mockResolvedValue(settings());
    const user = userEvent.setup();
    renderSection();
    await user.click(await radio(LOCAL_RADIO));
    await waitFor(() => expect(aiSettingsService.disableCloud).toHaveBeenCalledTimes(1));
  });

  it('says cloud is off when the network option is off but consent is current', async () => {
    aiSettingsService.get.mockResolvedValue(
      settings(
        { provider: 'openai_compat', effectiveProvider: 'ollama' },
        { optIn: false, consent: { current: true, acceptedAt: '2026-10-01T10:00:00.000Z', host: HOST, version: 1 } },
      ),
    );
    renderSection();
    const banner = await screen.findByText(/Cloud AI is off because/);
    expect(banner).toHaveTextContent(
      'Cloud AI is off because "Cloud AI provider" is off in Settings > Network.',
    );
    expect(within(banner).getByRole('link', { name: 'Settings > Network' })).toHaveAttribute('href', '/settings#network');
  });
});

describe('Settings > AI cloud address errors', () => {
  const submitWith = async (reason) => {
    aiSettingsService.get.mockResolvedValue(settings({}, { baseUrl: null, host: null, ready: false }));
    aiSettingsService.setCloud.mockRejectedValue(
      Object.assign(new Error('raw'), { status: 400, code: 'invalid_host', reason }),
    );
    const user = userEvent.setup();
    renderSection();
    await user.click(await radio(CLOUD_RADIO));
    await user.type(await screen.findByLabelText('Provider address'), 'http://nope');
    await user.click(screen.getByRole('button', { name: 'Save provider' }));
    return screen.findByRole('alert');
  };

  it('asks for https', async () => {
    expect(await submitWith('https_required')).toHaveTextContent('Use an https:// address.');
  });

  it.each(['private_address', 'local_name'])('explains a private address (%s)', async (reason) => {
    const alert = await submitWith(reason);
    expect(alert).toHaveTextContent(
      "That address points to this computer or a private network. Use your provider's public address. For Ollama on another computer, use Ollama address under Advanced.",
    );
    expect(alert).not.toHaveTextContent('raw');
  });

  it('falls back to generic copy for other reasons', async () => {
    expect(await submitWith('unparseable')).toHaveTextContent('That address is not valid. Use an https:// address');
  });
});
