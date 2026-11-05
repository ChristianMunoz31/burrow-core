import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '../../../contexts/ToastContext';
import { LIMITS, folderView } from './folderFixtures';

// The Folders page side of Javi's inbox: /folders?folder=<uuid> focuses that card, and a rendered summary
// marks the folders item read (javi:inbox-read), never on #add-folder or an empty list.
vi.mock('../../../services/foldersService', () => ({
  foldersService: {
    list: vi.fn(),
    add: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    scan: vi.fn(),
    cancel: vi.fn(),
    job: vi.fn(async () => ({ job: null })),
    files: vi.fn(async () => ({ files: [], total: 0, offset: 0, limit: 100 })),
    report: vi.fn(),
    ask: vi.fn(),
    exportFile: vi.fn(),
  },
}));
vi.mock('../../../services/aiSettingsService', () => ({ aiSettingsService: { pull: vi.fn(), setup: vi.fn(), get: vi.fn() } }));

import FoldersPage from '../FoldersPage';
import { foldersService } from '../../../services/foldersService';

const A = '11111111-2222-4333-8444-555555555555';
const B = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const folderA = folderView({ id: A, name: 'Alpha notes' });
const folderB = folderView({ id: B, name: 'Beta notes', summary: { status: 'ok', text: 'B summary', model: 'm', at: '2026-10-08T11:00:00Z' } });

let client;
function renderAt(entry) {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter initialEntries={[entry]}>
          <FoldersPage />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

let events;
const onRead = (e) => events.push(e.detail);
beforeEach(() => {
  events = [];
  window.addEventListener('javi:inbox-read', onRead);
  foldersService.list.mockResolvedValue({ folders: [folderA, folderB], limits: LIMITS });
});
afterEach(() => {
  window.removeEventListener('javi:inbox-read', onRead);
  cleanup();
});

describe('?folder=<uuid>', () => {
  it('focuses the heading of a listed folder', async () => {
    renderAt(`/folders?folder=${B}`);
    const heading = await screen.findByRole('heading', { name: 'Beta notes' });
    await waitFor(() => expect(heading).toHaveFocus());
  });

  it.each([['not-a-uuid'], ['x"],a['], ['99999999-9999-4999-8999-999999999999']])('ignores %s without an error', async (value) => {
    renderAt(`/folders?folder=${encodeURIComponent(value)}`);
    await screen.findByRole('heading', { name: 'Beta notes' });
    await new Promise((r) => setTimeout(r, 20));
    expect(document.activeElement).toBe(document.body);
  });
});

describe('javi:inbox-read', () => {
  it('fires once when the list renders a summary', async () => {
    renderAt('/folders');
    await screen.findByText('B summary');
    await waitFor(() => expect(events).toEqual([['folders']]));
  });

  it('fires again when a newer summary is rendered later', async () => {
    renderAt('/folders');
    await waitFor(() => expect(events).toHaveLength(1));
    foldersService.list.mockResolvedValue({
      folders: [folderA, { ...folderB, summary: { ...folderB.summary, text: 'B newer', at: '2026-10-09T09:00:00Z' } }],
      limits: LIMITS,
    });
    await client.invalidateQueries();
    await screen.findByText('B newer');
    await waitFor(() => expect(events).toHaveLength(2));
  });

  it('does not fire on #add-folder (while its add dialog is open) or for an empty list', async () => {
    renderAt('/folders#add-folder');
    await screen.findByText('B summary');
    await screen.findByRole('dialog');
    await new Promise((r) => setTimeout(r, 20));
    expect(events).toEqual([]);
    cleanup();
    foldersService.list.mockResolvedValue({ folders: [], limits: LIMITS });
    renderAt('/folders');
    await waitFor(() => expect(foldersService.list).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(events).toEqual([]);
  });
});
