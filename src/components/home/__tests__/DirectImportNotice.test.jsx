import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import DirectImportNotice from '../DirectImportNotice';
import { getDirectImportStatus } from '../../../services/backupService';

vi.mock('../../../services/backupService', () => ({ getDirectImportStatus: vi.fn() }));

const synced = vi.hoisted(() => ({ store: {} }));
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

const STORE_PROFILE = { distribution: 'store', dataLocation: 'userprofile' };
const OFFER = { available: true, canOffer: true, reason: null, found: true, sourceDir: 'C:\\Users\\example\\AppData\\Roaming\\Burrow', pending: false };

function renderNotice() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <DirectImportNotice />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  getDirectImportStatus.mockReset();
  synced.store = {};
});
afterEach(() => {
  cleanup();
  appInfo.info = null;
});

describe('DirectImportNotice (Home)', () => {
  it('points to the import in Settings when the other Burrow left data and this one is empty', async () => {
    appInfo.info = STORE_PROFILE;
    getDirectImportStatus.mockResolvedValue(OFFER);
    renderNotice();
    expect(await screen.findByText(/Burrow found data from the Burrow you installed from the website/)).toBeInTheDocument();
    expect(screen.getByText(/It only copies and leaves the original untouched/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open Data & storage' })).toHaveAttribute('href', '/settings#data-storage');
  });

  it('is remembered as dismissed', async () => {
    const user = userEvent.setup();
    appInfo.info = STORE_PROFILE;
    getDirectImportStatus.mockResolvedValue(OFFER);
    const first = renderNotice();
    await user.click(await screen.findByRole('button', { name: 'Dismiss' }));
    expect(first.container).toBeEmptyDOMElement();
    first.unmount();
    const second = renderNotice();
    await waitFor(() => expect(getDirectImportStatus).toHaveBeenCalledTimes(2));
    expect(second.container).toBeEmptyDOMElement();
  });

  it('explains a cancelled import once, then stays gone after Dismiss', async () => {
    const user = userEvent.setup();
    appInfo.info = STORE_PROFILE;
    const cancelled = { reason: 'target_has_data', at: '2026-10-08T10:00:00.000Z' };
    getDirectImportStatus.mockResolvedValue({ ...OFFER, canOffer: false, reason: 'target_has_data', cancelled });
    const first = renderNotice();
    expect(await screen.findByText(/Your import was cancelled. You added data to this Burrow after preparing it/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(first.container).toBeEmptyDOMElement();
    first.unmount();
    const second = renderNotice();
    await waitFor(() => expect(getDirectImportStatus).toHaveBeenCalledTimes(2));
    expect(second.container).toBeEmptyDOMElement();
    expect(synced.store['directImport:cancelledSeen']).toBe(cancelled.at);
  });

  it('a new cancelled import (another time stamp) is explained again, in its own words', async () => {
    appInfo.info = STORE_PROFILE;
    synced.store['directImport:cancelledSeen'] = '2026-10-01T10:00:00.000Z';
    getDirectImportStatus.mockResolvedValue({ ...OFFER, canOffer: false, reason: 'target_has_data', cancelled: { reason: 'unverified', at: '2026-10-08T10:00:00.000Z' } });
    renderNotice();
    expect(await screen.findByText(/did not pass its final check/)).toBeInTheDocument();
  });

  it.each([
    ['a direct build', { distribution: 'direct', dataLocation: 'appdata' }],
    ['the Store build with the appdata location', { distribution: 'store', dataLocation: 'appdata' }],
    ['no app info yet', null],
  ])('%s: renders nothing and asks the server nothing', async (_name, info) => {
    appInfo.info = info;
    const { container } = renderNotice();
    expect(container).toBeEmptyDOMElement();
    expect(getDirectImportStatus).not.toHaveBeenCalled();
  });

  it.each([
    ['this Burrow already has data', { ...OFFER, canOffer: false, reason: 'target_has_data' }],
    ['an import already happened', { ...OFFER, canOffer: false, reason: 'imported' }],
    ['an import is waiting for a restart', { ...OFFER, canOffer: false, reason: 'pending', pending: true }],
    ['there is no other Burrow data', { ...OFFER, found: false, canOffer: false, reason: 'source_missing' }],
  ])('renders nothing when %s', async (_name, status) => {
    appInfo.info = STORE_PROFILE;
    getDirectImportStatus.mockResolvedValue(status);
    const { container } = renderNotice();
    await waitFor(() => expect(getDirectImportStatus).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
});
