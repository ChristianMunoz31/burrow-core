import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import DataStorageSection from '../DataStorageSection';
import ImportFromDirectControl from '../ImportFromDirectControl';
import { getDirectImportStatus, importFromDirect, listBackups } from '../../../services/backupService';

configure({ asyncUtilTimeout: 5000 });

vi.mock('../../../services/backupService', () => ({
  listBackups: vi.fn(),
  getBackupStatus: vi.fn(),
  createBackup: vi.fn(),
  updateBackupSettings: vi.fn(),
  uploadBackupFile: vi.fn(),
  restoreBackup: vi.fn(),
  getDirectImportStatus: vi.fn(),
  importFromDirect: vi.fn(),
}));

const synced = vi.hoisted(() => ({ store: {} }));
// The saved settings, in memory: the real hook talks to the server.
vi.mock('../../../hooks/useSyncedSetting', async () => {
  const React = await import('react');
  return {
    useSyncedSetting: (key, fallback) => {
      const [, bump] = React.useState(0);
      const value = synced.store[key] ?? fallback;
      const set = (next) => {
        synced.store[key] = next;
        bump((n) => n + 1);
      };
      return [value, set, { isFetched: true, isLoading: false }];
    },
  };
});

const appInfo = vi.hoisted(() => ({ info: null }));
vi.mock('../../../hooks/useAppInfo', () => ({ useAppInfo: () => ({ info: appInfo.info }) }));

const OFFER = {
  available: true,
  canOffer: true,
  reason: null,
  found: true,
  sourceDir: 'C:\\Users\\example\\AppData\\Roaming\\Burrow',
  lastChangedAt: null,
  pending: false,
};
const IMPORT_BUTTON = 'Import from your existing Burrow';

function renderUi(element) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>{element}</MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  getDirectImportStatus.mockReset();
  importFromDirect.mockReset();
  listBackups.mockReset();
  listBackups.mockResolvedValue({ backups: [], status: { health: 'none' }, settings: { keepDaily: 7, keepWeekly: 4, keepMonthly: 6 }, location: '/b', desktop: true });
  synced.store = {};
});
afterEach(() => {
  cleanup();
  appInfo.info = null;
});

describe('ImportFromDirectControl', () => {
  it('explains that it copies and leaves the original untouched, and offers a button that does nothing by itself', async () => {
    getDirectImportStatus.mockResolvedValue(OFFER);
    renderUi(<ImportFromDirectControl />);
    expect(await screen.findByRole('button', { name: IMPORT_BUTTON })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: IMPORT_BUTTON })).toBeInTheDocument();
    expect(screen.getByText(/It only copies. Your other Burrow is not changed, moved or deleted./)).toBeInTheDocument();
    expect(screen.getByText(/Found in C:\\Users\\example\\AppData\\Roaming\\Burrow\./)).toBeInTheDocument();
    expect(screen.getByText(/Close your other Burrow first/)).toBeInTheDocument();
    expect(importFromDirect).not.toHaveBeenCalled();
  });

  it('asks for a confirmation, can be cancelled, and then copies and tells the user to restart', async () => {
    const user = userEvent.setup();
    getDirectImportStatus.mockResolvedValue(OFFER);
    importFromDirect.mockResolvedValue({ status: 'staged', needsRestart: true });
    renderUi(<ImportFromDirectControl />);
    await user.click(await screen.findByRole('button', { name: IMPORT_BUTTON }));
    expect(screen.getByRole('group', { name: 'Confirm import' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(importFromDirect).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: IMPORT_BUTTON })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: IMPORT_BUTTON }));
    await user.click(screen.getByRole('button', { name: 'Copy my data' }));
    expect(await screen.findByRole('status')).toHaveTextContent(/Close Burrow completely \(File, then Quit\) and open it again to finish/);
    expect(importFromDirect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: IMPORT_BUTTON })).not.toBeInTheDocument();
  });

  it('shows the server message when the import is refused, and offers it again', async () => {
    const user = userEvent.setup();
    getDirectImportStatus.mockResolvedValue(OFFER);
    importFromDirect.mockRejectedValue(Object.assign(new Error('Your other Burrow is open. Close it (File, Quit), then try again. Nothing was changed.'), { status: 409 }));
    renderUi(<ImportFromDirectControl />);
    await user.click(await screen.findByRole('button', { name: IMPORT_BUTTON }));
    await user.click(screen.getByRole('button', { name: 'Copy my data' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Your other Burrow is open.');
    expect(screen.getByRole('button', { name: 'Copy my data' })).toBeInTheDocument();
  });

  it('shows the restart note when an import is already waiting', async () => {
    getDirectImportStatus.mockResolvedValue({ ...OFFER, canOffer: false, reason: 'pending', pending: true });
    renderUi(<ImportFromDirectControl />);
    expect(await screen.findByRole('status')).toHaveTextContent(/open it again to finish/);
    expect(screen.queryByRole('button', { name: IMPORT_BUTTON })).not.toBeInTheDocument();
  });

  it('says why when this Burrow already has data, with no button', async () => {
    getDirectImportStatus.mockResolvedValue({ ...OFFER, canOffer: false, reason: 'target_has_data' });
    renderUi(<ImportFromDirectControl />);
    expect(await screen.findByText(/already has data of its own, so it cannot import/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: IMPORT_BUTTON })).not.toBeInTheDocument();
  });

  it('says why the last import was cancelled, next to the offer', async () => {
    getDirectImportStatus.mockResolvedValue({ ...OFFER, cancelled: { reason: 'target_has_data', at: '2026-10-08T10:00:00.000Z' } });
    renderUi(<ImportFromDirectControl />);
    expect(await screen.findByText(/Your last import was cancelled: you added data to this Burrow after preparing it/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: IMPORT_BUTTON })).toBeInTheDocument();
  });

  it('renders nothing when the build does not offer it, or there is no other Burrow data', async () => {
    getDirectImportStatus.mockResolvedValue({ available: false, canOffer: false, reason: null, found: false, sourceDir: null, lastChangedAt: null, pending: false });
    const first = renderUi(<ImportFromDirectControl />);
    await waitFor(() => expect(getDirectImportStatus).toHaveBeenCalled());
    expect(first.container).toBeEmptyDOMElement();
    first.unmount();
    getDirectImportStatus.mockResolvedValue({ ...OFFER, found: false, canOffer: false, reason: 'source_missing' });
    const second = renderUi(<ImportFromDirectControl />);
    await waitFor(() => expect(getDirectImportStatus).toHaveBeenCalledTimes(2));
    expect(second.container).toBeEmptyDOMElement();
  });

  it('uses no em or en dashes', async () => {
    getDirectImportStatus.mockResolvedValue(OFFER);
    const { container } = renderUi(<ImportFromDirectControl />);
    await screen.findByRole('button', { name: IMPORT_BUTTON });
    expect(container.textContent).not.toMatch(/[\u2013\u2014]/);
  });
});

describe('Data & storage shows the import only in the Store build with the userprofile data location', () => {
  const STORE_PROFILE = { version: '1.0.0', channel: 'stable', distribution: 'store', dataLocation: 'userprofile', dataDir: 'C:\\Users\\example\\Burrow Data' };

  it('Store + userprofile: the offer is there', async () => {
    appInfo.info = STORE_PROFILE;
    getDirectImportStatus.mockResolvedValue(OFFER);
    renderUi(<DataStorageSection />);
    expect(await screen.findByRole('button', { name: IMPORT_BUTTON })).toBeInTheDocument();
  });

  it.each([
    ['direct edition', { version: '1.0.0', channel: 'stable', distribution: 'direct', dataLocation: 'appdata' }],
    ['Store + appdata', { version: '1.0.0', channel: 'stable', distribution: 'store', dataLocation: 'appdata' }],
    ['no app info', null],
  ])('%s: never shown, and the status is never even asked for', async (_name, info) => {
    appInfo.info = info;
    getDirectImportStatus.mockResolvedValue(OFFER);
    renderUi(<DataStorageSection />);
    await screen.findByRole('heading', { name: 'Backups' }).catch(() => {});
    expect(screen.queryByRole('button', { name: IMPORT_BUTTON })).not.toBeInTheDocument();
    expect(getDirectImportStatus).not.toHaveBeenCalled();
  });
});
