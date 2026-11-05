import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import CopyFromStableControl from '../CopyFromStableControl';
import DataStorageSection from '../DataStorageSection';
import { copyFromStable, getStableCopyStatus, listBackups } from '../../../services/backupService';
import { getPendingKeys, markDirty } from '../../../utils/syncMode';

configure({ asyncUtilTimeout: 5000 });

vi.mock('../../../services/backupService', () => ({
  listBackups: vi.fn(),
  getBackupStatus: vi.fn(),
  createBackup: vi.fn(),
  updateBackupSettings: vi.fn(),
  uploadBackupFile: vi.fn(),
  restoreBackup: vi.fn(),
  getStableCopyStatus: vi.fn(),
  copyFromStable: vi.fn(),
}));

const appInfo = vi.hoisted(() => ({ info: null }));
vi.mock('../../../hooks/useAppInfo', () => ({ useAppInfo: () => ({ info: appInfo.info }) }));

const FOUND = { found: true, dataDir: 'C:\\Burrow', overridden: false, lastChangedAt: null, busy: false, sameFolder: false };
const COPY_BUTTON = 'Copy my data from Burrow';
let client;

function renderUi(element = <CopyFromStableControl />) {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['todos'], [{ id: 1 }]);
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>{element}</MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  getStableCopyStatus.mockReset();
  copyFromStable.mockReset();
  listBackups.mockReset();
  listBackups.mockResolvedValue({
    backups: [],
    status: { health: 'none' },
    settings: { keepDaily: 7, keepWeekly: 4, keepMonthly: 6 },
    location: '/data/backups',
    desktop: false,
  });
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  appInfo.info = null;
});

describe('CopyFromStableControl', () => {
  it('explains the one-way rule', async () => {
    getStableCopyStatus.mockResolvedValue(FOUND);
    renderUi();
    expect(screen.getByRole('heading', { name: COPY_BUTTON })).toBeInTheDocument();
    expect(screen.getByText(/This is one-way: Burrow Dev never changes your Burrow data/)).toBeInTheDocument();
    await screen.findByText('Burrow data found in C:\\Burrow.');
  });

  it('shows the folder, last change and test folder marker', async () => {
    getStableCopyStatus.mockResolvedValue({ ...FOUND, lastChangedAt: '2020-01-02T03:04:00.000Z', overridden: true });
    renderUi();
    const text = await screen.findByText(/Burrow data found in C:\\Burrow\./);
    expect(text).toHaveTextContent(/Last changed .+\. \(custom test folder\)$/);
  });

  it('hides the button when no Burrow data was found', async () => {
    getStableCopyStatus.mockResolvedValue({ ...FOUND, found: false });
    renderUi();
    await screen.findByText('No Burrow data was found on this computer, so there is nothing to copy.');
    expect(screen.queryByRole('button', { name: COPY_BUTTON })).not.toBeInTheDocument();
  });

  it('hides the button while Burrow is restoring', async () => {
    getStableCopyStatus.mockResolvedValue({ ...FOUND, busy: true });
    renderUi();
    await screen.findByText('Burrow is restoring a backup right now. Try again when it finishes.');
    expect(screen.queryByRole('button', { name: COPY_BUTTON })).not.toBeInTheDocument();
  });

  it('hides the button when both apps share one folder', async () => {
    getStableCopyStatus.mockResolvedValue({ ...FOUND, sameFolder: true });
    renderUi();
    await screen.findByText('Burrow Dev is using the same data folder as Burrow, so there is nothing to copy.');
    expect(screen.queryByRole('button', { name: COPY_BUTTON })).not.toBeInTheDocument();
  });

  it('shows a load error with a retry', async () => {
    getStableCopyStatus.mockRejectedValueOnce(new Error('Server said no.')).mockResolvedValue(FOUND);
    const user = userEvent.setup();
    renderUi();
    expect(await screen.findByRole('alert')).toHaveTextContent('Server said no.');
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByRole('button', { name: COPY_BUTTON });
  });

  it('asks first, and Cancel copies nothing', async () => {
    getStableCopyStatus.mockResolvedValue(FOUND);
    const user = userEvent.setup();
    renderUi();
    await user.click(await screen.findByRole('button', { name: COPY_BUTTON }));
    expect(screen.getByText(/Replace the data in Burrow Dev with a copy of your Burrow data\?/)).toBeInTheDocument();
    expect(screen.getByText(/Saved API keys are not copied, for your safety/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(copyFromStable).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole('button', { name: COPY_BUTTON })).toHaveFocus());
  });

  it('shows the server message when the copy is refused', async () => {
    getStableCopyStatus.mockResolvedValue(FOUND);
    copyFromStable.mockRejectedValue(Object.assign(new Error('Burrow is busy with its data right now.'), { status: 409 }));
    const user = userEvent.setup();
    renderUi();
    await user.click(await screen.findByRole('button', { name: COPY_BUTTON }));
    await user.click(screen.getByRole('button', { name: 'Copy and replace' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Burrow is busy with its data right now.');
    expect(screen.getByRole('button', { name: 'Copy and replace' })).toBeInTheDocument();
  });

  it('on success clears pending keys and the query cache, then reloads', async () => {
    getStableCopyStatus.mockResolvedValue(FOUND);
    copyFromStable.mockResolvedValue({ copiedFrom: 'C:\\Burrow', safetyBackupId: 's', schemaFrom: 1, schemaTo: 1, totalRows: 3 });
    markDirty('burrow.test.pending');
    const reload = vi.fn();
    const original = window.location;
    Object.defineProperty(window, 'location', { configurable: true, value: { ...original, reload } });
    try {
      const user = userEvent.setup();
      renderUi();
      await user.click(await screen.findByRole('button', { name: COPY_BUTTON }));
      await user.click(screen.getByRole('button', { name: 'Copy and replace' }));
      await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
      expect(getPendingKeys()).toEqual([]);
      expect(client.getQueryData(['todos'])).toBeUndefined();
      expect(screen.getByRole('status')).toHaveTextContent('Copied. Reloading Burrow Dev.');
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: original });
    }
  });
});

describe('CopyFromStableControl states', () => {
  it('ignores a second click while the copy runs and shows the busy label and status', async () => {
    getStableCopyStatus.mockResolvedValue(FOUND);
    let resolveCopy;
    copyFromStable.mockReturnValue(
      new Promise((resolve) => {
        resolveCopy = resolve;
      }),
    );
    const reload = vi.fn();
    const original = window.location;
    Object.defineProperty(window, 'location', { configurable: true, value: { ...original, reload } });
    try {
      const user = userEvent.setup();
      renderUi();
      await user.click(await screen.findByRole('button', { name: COPY_BUTTON }));
      await user.click(screen.getByRole('button', { name: 'Copy and replace' }));
      await user.click(screen.getByRole('button', { name: 'Copying…' }));
      expect(copyFromStable).toHaveBeenCalledTimes(1);
      expect(screen.getByRole('button', { name: 'Copying…' })).toHaveAttribute('aria-busy', 'true');
      expect(screen.getByRole('status')).toHaveTextContent('Copying your Burrow data.');
      resolveCopy({});
      await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: original });
    }
  });

  it('shows copy wording when the answer is lost', async () => {
    getStableCopyStatus.mockResolvedValue(FOUND);
    copyFromStable.mockRejectedValue(new Error('Network down'));
    const user = userEvent.setup();
    renderUi();
    await user.click(await screen.findByRole('button', { name: COPY_BUTTON }));
    await user.click(screen.getByRole('button', { name: 'Copy and replace' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Burrow Dev may have copied your data. Reload Burrow Dev to check.',
    );
    expect(screen.getByRole('button', { name: 'Reload' })).toHaveFocus();
  });

  it('Escape cancels the confirmation and returns focus to the button', async () => {
    getStableCopyStatus.mockResolvedValue(FOUND);
    const user = userEvent.setup();
    renderUi();
    await user.click(await screen.findByRole('button', { name: COPY_BUTTON }));
    await user.keyboard('{Escape}');
    expect(copyFromStable).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole('button', { name: COPY_BUTTON })).toHaveFocus());
  });

  it('refetches the status when the confirmation opens and after stable_busy', async () => {
    getStableCopyStatus.mockResolvedValue(FOUND);
    copyFromStable.mockRejectedValue(Object.assign(new Error('Burrow is busy.'), { status: 409, code: 'stable_busy' }));
    const user = userEvent.setup();
    renderUi();
    await user.click(await screen.findByRole('button', { name: COPY_BUTTON }));
    await waitFor(() => expect(getStableCopyStatus).toHaveBeenCalledTimes(2));
    await user.click(screen.getByRole('button', { name: 'Copy and replace' }));
    await waitFor(() => expect(getStableCopyStatus).toHaveBeenCalledTimes(3));
  });
});

describe('DataStorageSection channel gating', () => {
  it('does not show the copy control in the stable channel', () => {
    appInfo.info = { version: '0.1.0', channel: 'stable', desktop: true };
    renderUi(<DataStorageSection />);
    expect(screen.queryByRole('heading', { name: COPY_BUTTON })).not.toBeInTheDocument();
    expect(getStableCopyStatus).not.toHaveBeenCalled();
  });

  it('shows the copy control in the dev channel', () => {
    getStableCopyStatus.mockResolvedValue(FOUND);
    appInfo.info = { version: '0.2.0-dev.20261005.abc1234', channel: 'dev', desktop: true };
    renderUi(<DataStorageSection />);
    expect(screen.getByRole('heading', { name: COPY_BUTTON })).toBeInTheDocument();
  });
});
