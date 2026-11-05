import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import OllamaSetup from '../OllamaSetup';
import { aiSettingsService } from '../../../services/aiSettingsService';
import { __resetPullStoreForTests } from '../../../hooks/ollamaPullStore';

vi.mock('../../../services/aiSettingsService', () => ({
  aiSettingsService: { setup: vi.fn(), pull: vi.fn() },
}));

const REC = {
  name: 'qwen2.5:3b',
  downloadGb: 1.9,
  purpose: 'both',
  reason: 'Small and quick on a computer with this much memory.',
};
const DOWNLOAD = { name: 'Download model qwen2.5:3b' };

const state = (over = {}) => ({
  ollama: 'running',
  host: 'http://127.0.0.1:11434',
  version: '0.32.14',
  models: [],
  ready: false,
  ramGb: 16,
  recommended: { tier: 'mid', ramGb: 16, primary: [REC], optional: [] },
  canPull: true,
  provider: 'ollama',
  ...over,
});

function renderSetup(props) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  const utils = render(
    <QueryClientProvider client={client}>
      <OllamaSetup {...props} />
    </QueryClientProvider>,
  );
  return { ...utils, invalidate };
}

const queryKeys = (spy) => spy.mock.calls.map((c) => JSON.stringify(c[0].queryKey));
const liveRegion = () => document.querySelector('[aria-live="polite"]');

/** A pull that stays pending until the test settles it; rejects with AbortError on abort. */
function controllablePull() {
  const ctl = {};
  aiSettingsService.pull.mockImplementation(
    (model, { signal, onProgress }) =>
      new Promise((resolve, reject) => {
        ctl.onProgress = onProgress;
        ctl.resolve = resolve;
        ctl.reject = reject;
        ctl.signal = signal;
        signal.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        );
      }),
  );
  return ctl;
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetPullStoreForTests();
});
afterEach(() => {
  cleanup();
  __resetPullStoreForTests();
});

describe('OllamaSetup states', () => {
  it('shows a checking state first', () => {
    aiSettingsService.setup.mockReturnValue(new Promise(() => {}));
    renderSetup();
    expect(liveRegion()).toHaveTextContent('Checking for Ollama');
  });

  it('explains Ollama and links to the download when it is missing', async () => {
    aiSettingsService.setup.mockResolvedValue(state({ ollama: 'missing', recommended: undefined }));
    renderSetup();
    expect(await screen.findByText(/free app called Ollama/)).toHaveTextContent(
      'nothing leaves the computer',
    );
    const link = screen.getByRole('link', { name: /Get Ollama/ });
    expect(link).toHaveAttribute('href', 'https://ollama.com/download');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('tells the user to open the app when Ollama is stopped', async () => {
    aiSettingsService.setup.mockResolvedValue(state({ ollama: 'stopped' }));
    renderSetup();
    expect(await screen.findByText(/installed but not running/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check again' })).toBeInTheDocument();
  });

  it.each([
    ['unreachable', /can't reach Ollama/],
    ['remote', /another computer/],
    ['disabled', /turned off on this computer/],
  ])('shows a short message for %s', async (ollama, text) => {
    aiSettingsService.setup.mockResolvedValue(state({ ollama }));
    renderSetup();
    expect(await screen.findByText(text)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check again' })).toBeInTheDocument();
  });

  it('Check again refetches the setup state', async () => {
    aiSettingsService.setup.mockResolvedValueOnce(state({ ollama: 'stopped' }));
    aiSettingsService.setup.mockResolvedValueOnce(state());
    const user = userEvent.setup();
    renderSetup();
    await user.click(await screen.findByRole('button', { name: 'Check again' }));
    expect(await screen.findByRole('list', { name: 'Recommended model' })).toBeInTheDocument();
    expect(aiSettingsService.setup).toHaveBeenCalledTimes(2);
  });

  it('offers a retry when the setup check itself fails', async () => {
    aiSettingsService.setup.mockRejectedValue(new Error('x'));
    renderSetup();
    expect(await screen.findByText(/Couldn't check for Ollama/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check again' })).toBeInTheDocument();
  });

  it('recommends a model with size, reason, memory and the privacy note', async () => {
    aiSettingsService.setup.mockResolvedValue(
      state({
        recommended: {
          tier: 'mid',
          ramGb: 16,
          primary: [REC],
          optional: [
            { name: 'llama3.2:1b', downloadGb: 1.3, purpose: 'chat', reason: 'Faster, less capable.' },
          ],
        },
      }),
    );
    renderSetup();
    expect(await screen.findByText('Recommended for your computer')).toBeInTheDocument();
    expect(screen.getByText('qwen2.5:3b')).toBeInTheDocument();
    expect(screen.getByText(/about 1\.9 GB/)).toBeInTheDocument();
    expect(screen.getByText(REC.reason)).toBeInTheDocument();
    expect(screen.getByText(/Your computer has 16 GB of memory/)).toBeInTheDocument();
    expect(screen.getByText('llama3.2:1b')).toBeInTheDocument();
    expect(
      screen.getByText(
        /Ollama downloads the model from the Ollama library\. Burrow does not use the internet for this\./,
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', DOWNLOAD)).toBeEnabled();
  });

  it('shows success and calls onReady when ready', async () => {
    aiSettingsService.setup.mockResolvedValue(
      state({ ready: true, models: [{ name: 'qwen2.5:3b' }] }),
    );
    const onReady = vi.fn();
    renderSetup({ onReady });
    expect(await screen.findByText(/Javi is ready/)).toBeInTheDocument();
    await waitFor(() => expect(onReady).toHaveBeenCalled());
  });

  it('says everything runs on this computer only for the local provider', async () => {
    aiSettingsService.setup.mockResolvedValue(state({ ready: true, provider: 'ollama' }));
    renderSetup();
    expect(await screen.findByText(/Everything runs on this computer/)).toBeInTheDocument();
  });

  it('does not claim local-only when a cloud provider is in use', async () => {
    aiSettingsService.setup.mockResolvedValue(
      state({ ready: true, ollama: 'missing', provider: 'openai_compat', recommended: undefined }),
    );
    renderSetup();
    expect(
      await screen.findByText(/using the cloud provider you set up in Settings/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Everything runs on this computer/)).toBeNull();
  });

  it('keeps one live region mounted while its text changes', async () => {
    aiSettingsService.setup.mockResolvedValueOnce(state());
    aiSettingsService.setup.mockResolvedValue(state({ ready: true }));
    const user = userEvent.setup();
    renderSetup();
    const region = liveRegion();
    expect(region).toHaveTextContent('Checking for Ollama');
    await screen.findByRole('list', { name: 'Recommended model' });
    expect(liveRegion()).toBe(region);
    expect(region).toBeEmptyDOMElement();
    await user.click(screen.getByRole('button', { name: 'Check again' }));
    await waitFor(() => expect(region).toHaveTextContent(/Javi is ready/));
    expect(liveRegion()).toBe(region);
    expect(document.querySelectorAll('[role="status"]')).toHaveLength(0);
  });

  it('Check again refreshes the whole AI settings prefix and the Javi status', async () => {
    aiSettingsService.setup.mockResolvedValue(state({ ollama: 'stopped' }));
    const user = userEvent.setup();
    const { invalidate } = renderSetup();
    await user.click(await screen.findByRole('button', { name: 'Check again' }));
    expect(queryKeys(invalidate)).toContain(JSON.stringify(['ai-settings']));
    expect(queryKeys(invalidate)).toContain(JSON.stringify(['jarvis-status']));
  });

  it('refreshes Javi status when a recheck finds a model installed outside Burrow', async () => {
    aiSettingsService.setup.mockResolvedValueOnce(state());
    aiSettingsService.setup.mockResolvedValue(state({ ready: true }));
    const user = userEvent.setup();
    const { invalidate } = renderSetup();
    await user.click(await screen.findByRole('button', { name: 'Check again' }));
    await screen.findByText(/Javi is ready/);
    // One from Check again itself, one from the false -> true transition.
    await waitFor(() =>
      expect(
        queryKeys(invalidate).filter((k) => k === JSON.stringify(['jarvis-status'])),
      ).toHaveLength(2),
    );
  });
});

describe('OllamaSetup download', () => {
  it('shows progress, then ready after a finished download, and refreshes AI status', async () => {
    const ctl = controllablePull();
    aiSettingsService.setup.mockResolvedValueOnce(state());
    aiSettingsService.setup.mockResolvedValue(
      state({ ready: true, models: [{ name: 'qwen2.5:3b' }] }),
    );
    const onReady = vi.fn();
    const onBusyChange = vi.fn();
    const user = userEvent.setup();
    const { invalidate } = renderSetup({ onReady, onBusyChange });
    await user.click(await screen.findByRole('button', DOWNLOAD));
    expect(aiSettingsService.pull).toHaveBeenCalledWith(
      'qwen2.5:3b',
      expect.objectContaining({ signal: expect.any(AbortSignal), onProgress: expect.any(Function) }),
    );
    expect(await screen.findByText('Preparing…')).toBeInTheDocument();
    expect(
      screen.getAllByText(/Ollama downloads the model from the Ollama library/),
    ).toHaveLength(1);
    act(() => ctl.onProgress({ phase: 'downloading', completed: 1.2e9, total: 2.0e9 }));
    const bar = await screen.findByRole('progressbar');
    await waitFor(() => expect(bar).toHaveAttribute('aria-valuenow', '60'));
    expect(screen.getByText(/60% · 1\.2 of 2\.0 GB/)).toBeInTheDocument();
    expect(screen.getByText('Downloading…')).toBeInTheDocument();
    expect(onBusyChange).toHaveBeenCalledWith(true);
    act(() => ctl.onProgress({ phase: 'verifying', completed: 2e9, total: 2e9 }));
    expect(await screen.findByText('Verifying…')).toBeInTheDocument();
    ctl.resolve();
    expect(await screen.findByText(/Javi is ready/)).toBeInTheDocument();
    await waitFor(() => expect(onReady).toHaveBeenCalled());
    expect(queryKeys(invalidate)).toContain(JSON.stringify(['ai-settings']));
    expect(queryKeys(invalidate)).toContain(JSON.stringify(['jarvis-status']));
    await waitFor(() => expect(onBusyChange).toHaveBeenLastCalledWith(false));
  });

  it('Cancel aborts the request and allows starting again', async () => {
    const ctl = controllablePull();
    aiSettingsService.setup.mockResolvedValue(state());
    const user = userEvent.setup();
    renderSetup();
    await user.click(await screen.findByRole('button', DOWNLOAD));
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(ctl.signal.aborted).toBe(true);
    expect(await screen.findByText(/Download cancelled/)).toBeInTheDocument();
    expect(screen.getByRole('button', DOWNLOAD)).toBeEnabled();
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('a double click starts one download', async () => {
    controllablePull();
    aiSettingsService.setup.mockResolvedValue(state());
    const user = userEvent.setup();
    renderSetup();
    await user.dblClick(await screen.findByRole('button', DOWNLOAD));
    await screen.findByRole('progressbar');
    expect(aiSettingsService.pull).toHaveBeenCalledTimes(1);
  });

  it('keeps downloading when the card unmounts, shows it again on remount, and Cancel still aborts', async () => {
    const ctl = controllablePull();
    aiSettingsService.setup.mockResolvedValue(state());
    const user = userEvent.setup();
    const first = renderSetup();
    await user.click(await screen.findByRole('button', DOWNLOAD));
    await screen.findByRole('progressbar');
    first.unmount();
    expect(ctl.signal.aborted).toBe(false);
    renderSetup();
    act(() => ctl.onProgress({ phase: 'downloading', completed: 1e9, total: 2e9 }));
    const bar = await screen.findByRole('progressbar');
    await waitFor(() => expect(bar).toHaveAttribute('aria-valuenow', '50'));
    expect(aiSettingsService.pull).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(ctl.signal.aborted).toBe(true);
  });

  it('never moves the percent backwards while downloading', async () => {
    const ctl = controllablePull();
    aiSettingsService.setup.mockResolvedValue(state());
    const user = userEvent.setup();
    renderSetup();
    await user.click(await screen.findByRole('button', DOWNLOAD));
    await screen.findByRole('progressbar');
    act(() => ctl.onProgress({ phase: 'downloading', completed: 6e8, total: 1e9 }));
    await waitFor(() =>
      expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '60'),
    );
    act(() => ctl.onProgress({ phase: 'downloading', completed: 6e8, total: 2e9 }));
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '60');
  });

  it('shows fixed error copy with a single retry action', async () => {
    const ctl = controllablePull();
    aiSettingsService.setup.mockResolvedValue(state());
    const user = userEvent.setup();
    renderSetup();
    await user.click(await screen.findByRole('button', DOWNLOAD));
    ctl.reject(Object.assign(new Error('raw provider text'), { code: 'ollama_unavailable' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("Burrow can't reach Ollama right now");
    expect(alert).not.toHaveTextContent('raw provider text');
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    await user.click(screen.getByRole('button', DOWNLOAD));
    expect(aiSettingsService.pull).toHaveBeenCalledTimes(2);
    expect(await screen.findByRole('progressbar')).toBeInTheDocument();
  });

  it.each([
    ['pull_failed', 'The download stopped. Check your internet connection, then try again.'],
    ['timeout', 'The download stopped. Check your internet connection, then try again.'],
    ['rate_limited', 'Too many download attempts. Try again in a few minutes.'],
  ])('has fixed copy for %s', async (code, copy) => {
    const ctl = controllablePull();
    aiSettingsService.setup.mockResolvedValue(state());
    const user = userEvent.setup();
    renderSetup();
    await user.click(await screen.findByRole('button', DOWNLOAD));
    ctl.reject(Object.assign(new Error('boom'), { code }));
    expect(await screen.findByRole('alert')).toHaveTextContent(copy);
  });

  it('falls back to generic copy for an unknown error code', async () => {
    const ctl = controllablePull();
    aiSettingsService.setup.mockResolvedValue(state());
    const user = userEvent.setup();
    renderSetup();
    await user.click(await screen.findByRole('button', DOWNLOAD));
    ctl.reject(Object.assign(new Error('boom'), { code: 'something_new' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The download did not finish');
  });

  it('holds Download until the setup refetch settles, then explains a not-ready result', async () => {
    const ctl = controllablePull();
    let release;
    aiSettingsService.setup.mockResolvedValueOnce(state());
    aiSettingsService.setup.mockImplementationOnce(
      () => new Promise((resolve) => (release = () => resolve(state()))),
    );
    const onBusyChange = vi.fn();
    const user = userEvent.setup();
    renderSetup({ onBusyChange });
    await user.click(await screen.findByRole('button', DOWNLOAD));
    ctl.resolve();
    expect(await screen.findByText('Download finished. Checking…')).toBeInTheDocument();
    expect(screen.getByRole('button', DOWNLOAD)).toBeDisabled();
    expect(onBusyChange).toHaveBeenLastCalledWith(true);
    act(() => release());
    expect(
      await screen.findByText("The download finished, but Javi can't use it yet. Check again."),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', DOWNLOAD)).toBeEnabled();
    expect(onBusyChange).toHaveBeenLastCalledWith(false);
  });

  it('says so when the setup refetch after a download fails', async () => {
    const ctl = controllablePull();
    aiSettingsService.setup.mockResolvedValueOnce(state());
    aiSettingsService.setup.mockRejectedValue(new Error('down'));
    const user = userEvent.setup();
    renderSetup();
    await user.click(await screen.findByRole('button', DOWNLOAD));
    ctl.resolve();
    expect(
      await screen.findByText("The download finished, but Burrow couldn't confirm it. Check again."),
    ).toBeInTheDocument();
  });
});
