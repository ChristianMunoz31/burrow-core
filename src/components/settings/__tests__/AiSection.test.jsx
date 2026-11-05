import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import AiSection from '../AiSection';
import { renderWithProviders } from '../../../test-utils/renderWithProviders';
import { aiSettingsService } from '../../../services/aiSettingsService';
import { allowSlowSuite } from '../../../test-utils/slowSuite';

vi.mock('../../../services/aiSettingsService', () => ({
  aiSettingsService: {
    get: vi.fn(),
    models: vi.fn(),
    setModels: vi.fn(),
    setHost: vi.fn(),
    setProvider: vi.fn(),
    setCloud: vi.fn(),
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

const settings = (over = {}) => ({
  enabled: true,
  provider: 'ollama',
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
  cloud: {
    optIn: false,
    keySaved: false,
    baseUrl: null,
    host: null,
    model: null,
    tokenParam: 'max_tokens',
    ready: false,
    consent: { current: false, acceptedAt: null, host: null, version: null },
    consentVersion: 1,
    categories: { budget: true, todos: true, calendar: true, habits: true, health: false, notes: false, journal: false, bookmarks: true, countdowns: true, focus: true },
    active: false,
  },
  ...over,
});

const MODELS = [
  {
    name: 'qwen2.5:7b',
    sizeBytes: 4_700_000_000,
    parameterSize: '7.6B',
    quantization: 'Q4_K_M',
    capabilities: ['completion', 'tools'],
    contextLength: 32768,
  },
  {
    name: 'qwen2.5:3b',
    sizeBytes: 1_900_000_000,
    parameterSize: '3.1B',
    quantization: 'Q4_K_M',
    capabilities: ['completion', 'tools'],
    contextLength: 32768,
  },
  {
    name: 'llava:7b',
    sizeBytes: 4_700_000_000,
    parameterSize: '7B',
    quantization: 'Q4_0',
    capabilities: ['completion', 'vision'],
    contextLength: 4096,
  },
];

const SETUP = {
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
};

const renderSection = () =>
  renderWithProviders(
    <MemoryRouter>
      <AiSection />
    </MemoryRouter>,
  );

const pickCloud = async (user) =>
  user.click(await screen.findByRole('radio', { name: 'Your own cloud AI (optional)' }));

beforeEach(() => {
  vi.clearAllMocks();
  aiSettingsService.setup.mockResolvedValue(SETUP);
});
afterEach(cleanup);

// Heavy render-and-wait suite: raise the time limits so a busy machine does not trip them.
allowSlowSuite();

describe('AiSection with Ollama running', () => {
  beforeEach(() => {
    aiSettingsService.get.mockResolvedValue(settings());
    aiSettingsService.models.mockResolvedValue({ models: MODELS });
  });

  it('shows status and version without a redundant local badge, and lists installed models only in the selects', async () => {
    renderSection();
    expect(await screen.findByText('Ollama is running')).toBeInTheDocument();
    expect(screen.queryByText('local')).not.toBeInTheDocument();
    expect(screen.getByText(/version 0\.32\.14/)).toBeInTheDocument();
    expect(await screen.findByLabelText('Model for answers')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Installed models' })).not.toBeInTheDocument();
  });

  it('shows Automatic with the effective model for both selects', async () => {
    renderSection();
    const chat = await screen.findByLabelText('Model for answers');
    const tool = screen.getByLabelText('Model for your data');
    expect(within(chat).getByRole('option', { name: 'Automatic (qwen2.5:3b)' })).toBeInTheDocument();
    expect(within(tool).getByRole('option', { name: 'Automatic (qwen2.5:7b)' })).toBeInTheDocument();
  });

  it('only offers tools-capable models in the tool select', async () => {
    renderSection();
    const chat = await screen.findByLabelText('Model for answers');
    const tool = screen.getByLabelText('Model for your data');
    const names = (select) => within(select).getAllByRole('option').map((o) => o.textContent);
    expect(names(chat)).toContain('llava:7b (vision model)');
    expect(names(tool).some((n) => n.startsWith('llava:7b'))).toBe(false);
    expect(names(tool)).toEqual(
      expect.arrayContaining(['Automatic (qwen2.5:7b)', 'qwen2.5:7b', 'qwen2.5:3b']),
    );
  });

  it('saves a selection with PUT models and keeps the other slot', async () => {
    aiSettingsService.setModels.mockResolvedValue(
      settings({
        models: {
          chat: { selected: 'qwen2.5:7b', effective: 'qwen2.5:7b', source: 'settings' },
          tools: { selected: null, effective: 'qwen2.5:7b', source: 'auto' },
        },
      }),
    );
    const user = userEvent.setup();
    renderSection();
    await user.selectOptions(await screen.findByLabelText('Model for answers'), 'qwen2.5:7b');
    await waitFor(() =>
      expect(aiSettingsService.setModels).toHaveBeenCalledWith({
        chatModel: 'qwen2.5:7b',
        toolModel: null,
      }),
    );
    expect(await screen.findByText('Saved.')).toBeInTheDocument();
  });

  it('shows a 400 error inline without raw server text', async () => {
    aiSettingsService.setModels.mockRejectedValue(
      Object.assign(new Error('boom stack trace'), { status: 400, code: 'model_lacks_tools' }),
    );
    const user = userEvent.setup();
    renderSection();
    await user.selectOptions(await screen.findByLabelText('Model for your data'), 'qwen2.5:3b');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('That model cannot use tools');
    expect(alert).not.toHaveTextContent('boom');
  });

  it('includes the RAM guidance line', async () => {
    renderSection();
    expect(await screen.findByText(/7B models need about 8 GB of free RAM/)).toBeInTheDocument();
  });

  it('keeps Advanced collapsed until opened', async () => {
    const user = userEvent.setup();
    renderSection();
    await screen.findByText('Ollama is running');
    const summary = screen.getByText('Advanced');
    expect(summary.tagName).toBe('SUMMARY');
    expect(summary.closest('details')).not.toHaveAttribute('open');
    expect(screen.getByLabelText('Ollama address')).not.toBeVisible();
    await user.click(summary);
    expect(screen.getByLabelText('Ollama address')).toBeVisible();
    // Save with an empty field is the one way back to the default address.
    expect(screen.queryByRole('button', { name: 'Use default address' })).not.toBeInTheDocument();
    // The cloud provider moved out of Advanced into its own choice above.
    expect(screen.queryByLabelText('Provider address')).not.toBeInTheDocument();
    expect(screen.queryByText(/OpenAI/)).not.toBeInTheDocument();
  });

  it('saving an empty address resets to the default (there is no separate default button)', async () => {
    aiSettingsService.setHost.mockResolvedValue(settings());
    const user = userEvent.setup();
    renderSection();
    await user.click(await screen.findByText('Advanced'));
    await user.click(screen.getByRole('button', { name: 'Save address' }));
    await waitFor(() => expect(aiSettingsService.setHost).toHaveBeenCalledWith(null));
  });

  it('points a network_opt_in_required host error at Settings > Network', async () => {
    aiSettingsService.setHost.mockRejectedValue(
      Object.assign(new Error('x'), {
        status: 403,
        code: 'network_opt_in_required',
        feature: 'aiLan',
      }),
    );
    const user = userEvent.setup();
    renderSection();
    await user.click(await screen.findByText('Advanced'));
    await user.type(screen.getByLabelText('Ollama address'), 'http://192.168.1.5:11434');
    await user.click(screen.getByRole('button', { name: 'Save address' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Ollama on another computer');
    expect(within(alert).getByRole('link', { name: 'Settings > Network' })).toHaveAttribute(
      'href',
      '/settings#network',
    );
    expect(aiSettingsService.setHost).toHaveBeenCalledWith('http://192.168.1.5:11434');
  });

  it('shows invalid_host copy inline', async () => {
    aiSettingsService.setHost.mockRejectedValue(
      Object.assign(new Error('x'), { status: 400, code: 'invalid_host' }),
    );
    const user = userEvent.setup();
    renderSection();
    await user.click(await screen.findByText('Advanced'));
    await user.type(screen.getByLabelText('Ollama address'), 'nope');
    await user.click(screen.getByRole('button', { name: 'Save address' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('That address is not valid');
  });

  it('saves the cloud endpoint and never shows the key, only the last 4', async () => {
    aiSettingsService.setCloud.mockResolvedValue(settings());
    const user = userEvent.setup();
    renderSection();
    await pickCloud(user);
    await user.type(screen.getByLabelText('Provider address'), 'https://api.example.com/v1');
    await user.type(screen.getByLabelText('Cloud model'), 'some-model');
    await user.click(screen.getByText('Advanced options'));
    await user.selectOptions(screen.getByLabelText('Token limit parameter'), 'max_completion_tokens');
    await user.click(screen.getByRole('button', { name: 'Save provider' }));
    await waitFor(() =>
      expect(aiSettingsService.setCloud).toHaveBeenCalledWith({
        baseUrl: 'https://api.example.com/v1',
        model: 'some-model',
        tokenParam: 'max_completion_tokens',
      }),
    );
    expect(await screen.findByText('••••wxyz')).toBeInTheDocument();
  });
});

describe('AiSection model select rules', () => {
  it('excludes models without completion from the chat select but keeps ones with no capabilities', async () => {
    aiSettingsService.get.mockResolvedValue(settings());
    aiSettingsService.models.mockResolvedValue({
      models: [
        { name: 'embed:1b', capabilities: ['embedding'] },
        { name: 'legacy:1b' },
        MODELS[0],
      ],
    });
    renderSection();
    const chat = await screen.findByLabelText('Model for answers');
    const names = within(chat).getAllByRole('option').map((o) => o.textContent);
    expect(names).not.toContain('embed:1b');
    expect(names).toEqual(expect.arrayContaining(['legacy:1b', 'qwen2.5:7b']));
  });

  it('keeps a vision-only, small-context model selectable but labels it', async () => {
    aiSettingsService.get.mockResolvedValue(settings());
    aiSettingsService.models.mockResolvedValue({
      models: [
        MODELS[0],
        { name: 'moondream:latest', parameterSize: '1B', capabilities: ['completion', 'vision'], contextLength: 2048 },
        { name: 'tiny:1b', parameterSize: '1B', capabilities: ['completion', 'tools'], contextLength: 2048 },
      ],
    });
    renderSection();
    const chat = await screen.findByLabelText('Model for answers');
    const tool = screen.getByLabelText('Model for your data');
    const option = within(chat).getByRole('option', { name: 'moondream:latest (vision model, small context)' });
    expect(option).toHaveValue('moondream:latest');
    expect(within(chat).getByRole('option', { name: 'qwen2.5:7b' })).toBeInTheDocument();
    expect(within(tool).getByRole('option', { name: 'tiny:1b (small context)' })).toBeInTheDocument();
  });

  it('labels a saved data model that lacks tools as no tools support, not not installed', async () => {
    aiSettingsService.get.mockResolvedValue(
      settings({
        models: {
          chat: { selected: null, effective: 'qwen2.5:3b', source: 'auto' },
          tools: { selected: 'llava:7b', effective: 'qwen2.5:7b', source: 'settings' },
        },
      }),
    );
    aiSettingsService.models.mockResolvedValue({ models: MODELS });
    renderSection();
    const tool = await screen.findByLabelText('Model for your data');
    expect(within(tool).getByRole('option', { name: 'llava:7b (no tools support)' })).toBeInTheDocument();
    expect(within(tool).queryByRole('option', { name: /not installed/ })).not.toBeInTheDocument();
  });

  it('says so when no installed model supports tools', async () => {
    aiSettingsService.get.mockResolvedValue(settings());
    aiSettingsService.models.mockResolvedValue({ models: [MODELS[2]] });
    renderSection();
    await screen.findByLabelText('Model for your data');
    expect(
      screen.getByText('No installed model supports tools. Download one, for example qwen2.5:7b.'),
    ).toBeInTheDocument();
  });

  it.each([
    ['invalid_model', 'That model name is not valid'],
    ['invalid_token_param', "That setting isn't supported."],
  ])('shows friendly copy for %s on the cloud endpoint', async (code, copy) => {
    aiSettingsService.get.mockResolvedValue(settings());
    aiSettingsService.models.mockResolvedValue({ models: MODELS });
    aiSettingsService.setCloud.mockRejectedValue(
      Object.assign(new Error('raw server text'), { status: 400, code }),
    );
    const user = userEvent.setup();
    renderSection();
    await pickCloud(user);
    await user.type(screen.getByLabelText('Provider address'), 'https://api.example.com/v1');
    await user.click(screen.getByRole('button', { name: 'Save provider' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(copy);
    expect(alert).not.toHaveTextContent('raw server text');
    expect(alert.textContent).not.toMatch(/[–—]/);
  });

  it('shows friendly copy when saving a model answers 503 ollama_unavailable', async () => {
    aiSettingsService.get.mockResolvedValue(settings());
    aiSettingsService.models.mockResolvedValue({ models: MODELS });
    aiSettingsService.setModels.mockRejectedValue(
      Object.assign(new Error('x'), { status: 503, code: 'ollama_unavailable' }),
    );
    const user = userEvent.setup();
    renderSection();
    await user.selectOptions(await screen.findByLabelText('Model for answers'), 'qwen2.5:7b');
    expect(await screen.findByRole('alert')).toHaveTextContent("Burrow can't reach Ollama right now");
  });

  it('says AI is off and does not claim Ollama is down when the server has AI disabled', async () => {
    aiSettingsService.get.mockResolvedValue(
      settings({
        enabled: false,
        ollama: { host: 'http://127.0.0.1:11434', hostSource: 'default', loopback: true, running: false, version: null, numCtx: 8192, error: null },
      }),
    );
    renderSection();
    expect(await screen.findByText('AI is off')).toBeInTheDocument();
    expect(screen.queryByText('Ollama is not running')).not.toBeInTheDocument();
    expect(screen.queryByText('Javi needs Ollama')).not.toBeInTheDocument();
    expect(screen.getByText(/AI features are turned off on this computer/)).toBeInTheDocument();
  });

  it('shows cloud specific copy for invalid_host on the cloud endpoint', async () => {
    aiSettingsService.get.mockResolvedValue(settings());
    aiSettingsService.models.mockResolvedValue({ models: MODELS });
    aiSettingsService.setCloud.mockRejectedValue(
      Object.assign(new Error('x'), { status: 400, code: 'invalid_host' }),
    );
    const user = userEvent.setup();
    renderSection();
    await pickCloud(user);
    await user.type(screen.getByLabelText('Provider address'), 'ftp://nope');
    await user.click(screen.getByRole('button', { name: 'Save provider' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Use an https:// address');
  });
});

describe('AiSection with Ollama down', () => {
  it('shows the probe hint only when it adds something beyond the serve copy', async () => {
    aiSettingsService.get.mockResolvedValue(
      settings({
        ollama: {
          host: 'http://127.0.0.1:8080',
          hostSource: 'settings',
          loopback: true,
          running: false,
          version: null,
          numCtx: 8192,
          error: { code: 'not_ollama', hint: 'Something answered at this address, but it is not Ollama.' },
        },
      }),
    );
    aiSettingsService.models.mockRejectedValue(
      Object.assign(new Error('x'), { status: 503, code: 'ollama_unavailable' }),
    );
    renderSection();
    expect(await screen.findByText('Something answered at this address, but it is not Ollama.')).toBeInTheDocument();
  });

  it('renders the guided Ollama setup, with the install link and retry', async () => {
    aiSettingsService.get.mockResolvedValue(
      settings({
        ollama: {
          host: 'http://127.0.0.1:11434',
          hostSource: 'default',
          loopback: true,
          running: false,
          version: null,
          numCtx: 8192,
          error: { code: 'connection_refused', hint: 'Start Ollama and press Retry.' },
        },
      }),
    );
    aiSettingsService.models.mockRejectedValue(
      Object.assign(new Error('x'), { status: 503, code: 'ollama_unavailable' }),
    );
    const user = userEvent.setup();
    renderSection();
    expect(await screen.findByText('Ollama is not running')).toBeInTheDocument();
    expect(await screen.findByText(/free app called Ollama/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /^Get Ollama/ })).toHaveAttribute(
      'href',
      'https://ollama.com/download',
    );
    // connection_refused: the server hint repeats the setup copy, so it is not shown twice.
    expect(screen.queryByText('Start Ollama and press Retry.')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Model for answers')).not.toBeInTheDocument();
    // The setup card owns the recheck: no second Retry button beside Check again.
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    const callsBefore = aiSettingsService.get.mock.calls.length;
    await user.click(screen.getByRole('button', { name: 'Check again' }));
    await waitFor(() => expect(aiSettingsService.get.mock.calls.length).toBeGreaterThan(callsBefore));
  });

  it('Check again syncs the status pill with the new state', async () => {
    const down = settings({
      ollama: {
        host: 'http://127.0.0.1:11434',
        hostSource: 'default',
        loopback: true,
        running: false,
        version: null,
        numCtx: 8192,
        error: { code: 'connection_refused' },
      },
    });
    aiSettingsService.get.mockResolvedValueOnce(down);
    aiSettingsService.get.mockResolvedValue(settings());
    aiSettingsService.models.mockResolvedValue({ models: MODELS });
    const user = userEvent.setup();
    renderSection();
    expect(await screen.findByText('Ollama is not running')).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'Check again' }));
    expect(await screen.findByText('Ollama is running')).toBeInTheDocument();
    expect(screen.queryByText('Ollama is not running')).not.toBeInTheDocument();
    expect(await screen.findByLabelText('Model for answers')).toBeInTheDocument();
  });
});

describe('AiSection with no models', () => {
  it('renders the guided model download instead of a pull command', async () => {
    aiSettingsService.get.mockResolvedValue(settings());
    aiSettingsService.models.mockResolvedValue({ models: [] });
    aiSettingsService.setup.mockResolvedValue({ ...SETUP, ollama: 'running' });
    renderSection();
    expect(await screen.findByRole('button', { name: 'Download model qwen2.5:3b' })).toBeInTheDocument();
    expect(screen.getByText(/Your computer has 16 GB of memory/)).toBeInTheDocument();
    expect(screen.queryByText(/ollama pull/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Model for answers')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check again' })).toBeEnabled();
  });
});
