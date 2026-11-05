import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '../../../contexts/ToastContext';
import { resetEntitlementsState } from '../../../test-utils/entitlements';
import { __resetPullStoreForTests } from '../../../hooks/ollamaPullStore';
import { LIMITS, apiError, folderView, jobView } from './folderFixtures';

vi.mock('../../../hooks/useEntitlements', async () =>
  (await import('../../../test-utils/entitlements.js')).entitlementsModule(),
);
// Poll the app's window fast so the tests do not wait a second per step.
vi.mock('../../../constants/folders', async (importOriginal) => ({ ...(await importOriginal()), DIALOG_POLL_MS: 5 }));
vi.mock('../../../services/foldersService', () => ({
  foldersService: {
    list: vi.fn(),
    add: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    scan: vi.fn(),
    cancel: vi.fn(),
    job: vi.fn(),
    files: vi.fn(),
    report: vi.fn(),
    ask: vi.fn(),
    exportFile: vi.fn(),
    pick: vi.fn(),
    dialog: vi.fn(),
    cancelDialog: vi.fn(),
    confirm: vi.fn(),
    exportToChosen: vi.fn(),
  },
}));
vi.mock('../../../services/aiSettingsService', () => ({
  aiSettingsService: { pull: vi.fn(), setup: vi.fn(), get: vi.fn() },
}));
vi.mock('../../../services/licenseService', () => ({
  licenseService: {
    get: vi.fn(async () => ({ state: 'free', pro: false, trial: { state: 'ended' }, license: null, purchaseUrl: null })),
  },
}));

import FoldersPage from '../FoldersPage';
import { foldersService } from '../../../services/foldersService';

function Hash() {
  return <output data-testid="hash">{useLocation().hash}</output>;
}

function renderPage(entry = '/folders') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter initialEntries={[entry]}>
          <FoldersPage />
          <Hash />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const listing = (folders, over = {}) => ({ folders, limits: LIMITS, canPickFolder: false, canSaveFile: false, ...over });
const view = (over = {}) => ({
  id: 'd1',
  kind: 'pick_folder',
  status: 'waiting',
  folderId: null,
  error: null,
  folder: null,
  job: null,
  ...over,
});
const answers = (...views) => {
  views.forEach((v) => foldersService.dialog.mockResolvedValueOnce({ dialog: v }));
};

/** Holds the window open (status waiting) until `release()`, then answers with `final`. */
const holdOpen = (open, final) => {
  let released = false;
  foldersService.dialog.mockImplementation(async () => ({ dialog: released ? final : open }));
  return () => {
    released = true;
  };
};

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks keeps implementations and queued answers; start every test from nothing.
  Object.values(foldersService).forEach((fn) => fn.mockReset());
  foldersService.files.mockResolvedValue({ files: [], total: 0, offset: 0, limit: 100 });
  foldersService.job.mockResolvedValue({ job: null });
  foldersService.cancelDialog.mockResolvedValue({ dialog: view({ status: 'cancelled' }) });
});

afterEach(() => {
  cleanup();
  resetEntitlementsState();
  __resetPullStoreForTests();
});

describe('Add folder with the native window (canPickFolder)', () => {
  it('opens the window, waits, then shows the new folder and a toast', async () => {
    const user = userEvent.setup();
    const added = folderView({ id: 'f2', name: 'Receipts' });
    foldersService.list
      .mockResolvedValueOnce(listing([folderView()], { canPickFolder: true }))
      .mockResolvedValue(listing([folderView(), added], { canPickFolder: true }));
    foldersService.pick.mockResolvedValue({ dialog: view() });
    const release = holdOpen(view(), view({ status: 'added', folderId: 'f2', folder: added, job: jobView({ folderId: 'f2' }) }));
    renderPage();

    const button = await screen.findByRole('button', { name: 'Add folder' });
    expect(button).not.toHaveAttribute('aria-haspopup');
    await user.click(button);

    expect(foldersService.pick).toHaveBeenCalledWith(undefined);
    expect(await screen.findByText('Choose a folder in the window that opened.')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('button', { name: 'Add folder' })).toHaveAttribute('aria-disabled', 'true');
    release();
    expect(await screen.findByRole('heading', { name: 'Receipts' })).toBeInTheDocument();
    expect(await screen.findByText('Added Receipts. Burrow is reading it now.')).toBeInTheDocument();
    expect(screen.queryByText('Choose a folder in the window that opened.')).toBeNull();
    expect(foldersService.add).not.toHaveBeenCalled();
  });

  it('shows a refused folder with the server message and offers another pick', async () => {
    const user = userEvent.setup();
    foldersService.list.mockResolvedValue(listing([], { canPickFolder: true }));
    foldersService.pick.mockResolvedValue({ dialog: view() });
    answers(view({ status: 'refused', error: { code: 'folder_protected', message: 'That is a system folder.' } }));
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Add your first folder' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('That is a system folder.');

    answers(view({ status: 'cancelled' }));
    await user.click(screen.getByRole('button', { name: 'Choose another folder' }));
    await waitFor(() => expect(foldersService.pick).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });

  it.each([
    ['busy', 'dialog_busy'],
    ['expired', 'dialog_expired'],
    ['failed', 'pick_failed'],
  ])('shows an alert for a %s window and no second-pick button', async (status, code) => {
    const user = userEvent.setup();
    foldersService.list.mockResolvedValue(listing([], { canPickFolder: true }));
    foldersService.pick.mockResolvedValue({ dialog: view() });
    answers(view({ status, error: { code, message: `Message for ${code}.` } }));
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Add your first folder' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(`Message for ${code}.`);
    expect(screen.queryByRole('button', { name: 'Choose another folder' })).toBeNull();
  });

  it('stops waiting on request and stays silent about a cancelled window', async () => {
    const user = userEvent.setup();
    foldersService.list.mockResolvedValue(listing([], { canPickFolder: true }));
    foldersService.pick.mockResolvedValue({ dialog: view() });
    foldersService.dialog.mockImplementation(async () => ({
      dialog: foldersService.cancelDialog.mock.calls.length ? view({ status: 'cancelled' }) : view(),
    }));
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Add your first folder' }));
    expect(await screen.findByText('Choose a folder in the window that opened.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Stop waiting' }));
    expect(foldersService.cancelDialog).toHaveBeenCalledWith('d1');
    await waitFor(() => expect(screen.queryByText('Choose a folder in the window that opened.')).toBeNull());
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows the error text when the window cannot be requested', async () => {
    const user = userEvent.setup();
    foldersService.list.mockResolvedValue(listing([], { canPickFolder: true }));
    foldersService.pick.mockRejectedValue(apiError('dialog_busy', 'A Burrow window is already open.', { status: 409 }));
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Add your first folder' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('A Burrow window is already open.');
  });

  it('starts one pick for File > Add a folder (#add-folder) and clears the hash', async () => {
    foldersService.list.mockResolvedValue(listing([folderView()], { canPickFolder: true }));
    foldersService.pick.mockResolvedValue({ dialog: view() });
    answers(view({ status: 'cancelled' }));
    renderPage('/folders#add-folder');
    await waitFor(() => expect(foldersService.pick).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByTestId('hash')).toHaveTextContent(''));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(foldersService.pick).toHaveBeenCalledTimes(1);
  });

  it('opens the paste dialog for #add-folder when the window is not available', async () => {
    foldersService.list.mockResolvedValue(listing([folderView()]));
    renderPage('/folders#add-folder');
    expect(await screen.findByRole('dialog', { name: 'Add a folder' })).toBeInTheDocument();
    expect(foldersService.pick).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByTestId('hash')).toHaveTextContent(''));
  });

  it('keeps the paste dialog as the only way in without the capability', async () => {
    const user = userEvent.setup();
    foldersService.list.mockResolvedValue(listing([], { canPickFolder: false }));
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Add your first folder' }));
    expect(await screen.findByRole('dialog', { name: 'Add a folder' })).toBeInTheDocument();
    expect(foldersService.pick).not.toHaveBeenCalled();
  });
});

describe('an imported folder that needs confirming', () => {
  const imported = (over = {}) => folderView({ needsConfirm: true, lastScanAt: null, ...over });
  const NOTE =
    "Imported from a Burrow export. Burrow won't read this folder until you confirm where it is on this computer.";

  it('shows the note and hides re-scan, daily switch, ask and report', async () => {
    foldersService.list.mockResolvedValue(listing([imported()], { canPickFolder: true }));
    renderPage();
    expect(await screen.findByText(NOTE)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Re-scan/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Ask about/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Report for/ })).toBeNull();
    expect(screen.queryByPlaceholderText('Ask about the files in this folder')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Write report' })).toBeNull();
    await userEvent.setup().click(screen.getByRole('button', { name: 'More actions for Project notes' }));
    expect(screen.queryByRole('menuitemcheckbox')).toBeNull();
    expect(screen.getAllByRole('menuitem').map((i) => i.textContent)).toEqual([
      'Report (Markdown)',
      'Report (JSON)',
      'File list (CSV)',
      'Remove',
    ]);
  });

  it('re-picks the folder in the window with Choose folder', async () => {
    const user = userEvent.setup();
    foldersService.list.mockResolvedValue(listing([imported()], { canPickFolder: true }));
    foldersService.pick.mockResolvedValue({ dialog: view() });
    answers(view({ status: 'cancelled' }));
    renderPage();
    await user.click(await screen.findByRole('button', { name: /^Choose folder/ }));
    expect(foldersService.pick).toHaveBeenCalledWith('f1');
  });

  it('confirms by path in a prefilled dialog without the capability', async () => {
    const user = userEvent.setup();
    foldersService.list.mockResolvedValue(listing([imported()]));
    foldersService.confirm.mockResolvedValue({ folder: folderView(), job: jobView() });
    renderPage();
    await user.click(await screen.findByRole('button', { name: /^Confirm folder/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Confirm this folder' });
    expect(within(dialog).queryByLabelText('Name (optional)')).toBeNull();
    expect(within(dialog).getByText(/Burrow reads it only after you confirm\./)).toBeInTheDocument();
    const field = within(dialog).getByLabelText('Folder path');
    expect(field).toHaveValue('C:\\Users\\tester\\Documents\\Notes');
    await user.clear(field);
    await user.type(field, 'D:\\Moved');
    await user.click(within(dialog).getByRole('button', { name: 'Confirm folder' }));
    expect(foldersService.confirm).toHaveBeenCalledWith('f1', 'D:\\Moved');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('maps a refused path to the path field', async () => {
    const user = userEvent.setup();
    foldersService.list.mockResolvedValue(listing([imported()]));
    foldersService.confirm.mockRejectedValue(apiError('folder_missing', "Burrow can't find that folder."));
    renderPage();
    await user.click(await screen.findByRole('button', { name: /^Confirm folder/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Confirm this folder' });
    await user.click(within(dialog).getByRole('button', { name: 'Confirm folder' }));
    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent("Burrow can't find that folder.");
    expect(within(dialog).getByLabelText('Folder path')).toHaveAttribute('aria-invalid', 'true');
  });
});

describe('Export with the save window (canSaveFile)', () => {
  async function openExport(user, item = 'File list (CSV)') {
    await user.click(await screen.findByRole('button', { name: 'More actions for Project notes' }));
    await user.click(screen.getByRole('menuitem', { name: item }));
  }
  const saveView = (over = {}) => view({ id: 's1', kind: 'save_file', ...over });

  beforeEach(() => {
    foldersService.list.mockResolvedValue(listing([folderView()], { canSaveFile: true }));
    foldersService.exportToChosen.mockResolvedValue({ dialog: saveView() });
  });

  it('saves through the window and says so', async () => {
    const user = userEvent.setup();
    const release = holdOpen(saveView(), saveView({ status: 'saved' }));
    renderPage();
    await openExport(user);
    expect(foldersService.exportToChosen).toHaveBeenCalledWith('f1', 'csv');
    expect(foldersService.exportFile).not.toHaveBeenCalled();
    expect(await screen.findByText('Choose where to save in the window that opened.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'More actions for Project notes' })).not.toHaveAttribute('aria-disabled');
    release();
    expect(await screen.findByText('Saved File list (CSV).')).toBeInTheDocument();
    expect(screen.queryByText('Choose where to save in the window that opened.')).toBeNull();
  });

  it('keeps Remove and the daily switch usable while the save window waits, with the exports off', async () => {
    const user = userEvent.setup();
    foldersService.update.mockResolvedValue({ folder: folderView({ autoRescan: true }) });
    holdOpen(saveView(), saveView({ status: 'saved' }));
    renderPage();
    await openExport(user);
    expect(await screen.findByText('Choose where to save in the window that opened.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'More actions for Project notes' }));
    const csv = screen.getByRole('menuitem', { name: 'File list (CSV)' });
    expect(csv).toHaveAttribute('aria-disabled', 'true');
    await user.click(csv);
    expect(foldersService.exportToChosen).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('menuitemcheckbox', { name: 'Re-scan once a day' }));
    expect(document.querySelector('[data-capability="folder_auto_rescan"]')).not.toBeNull();
    expect(foldersService.update).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'More actions for Project notes' }));
    expect(screen.getByRole('menuitem', { name: 'Remove' })).not.toHaveAttribute('aria-disabled');
    await user.click(screen.getByRole('menuitem', { name: 'Remove' }));
    expect(await screen.findByRole('alertdialog')).toBeInTheDocument();
  });

  it('stays silent when the window is cancelled', async () => {
    const user = userEvent.setup();
    const release = holdOpen(saveView(), saveView({ status: 'cancelled' }));
    renderPage();
    await openExport(user);
    expect(await screen.findByText('Choose where to save in the window that opened.')).toBeInTheDocument();
    release();
    await waitFor(() => expect(screen.queryByText('Choose where to save in the window that opened.')).toBeNull());
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText(/^Saved/)).toBeNull();
  });

  it('stops waiting on request', async () => {
    const user = userEvent.setup();
    foldersService.dialog.mockImplementation(async () => ({
      dialog: foldersService.cancelDialog.mock.calls.length ? saveView({ status: 'cancelled' }) : saveView(),
    }));
    renderPage();
    await openExport(user);
    expect(await screen.findByText('Choose where to save in the window that opened.')).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'Stop waiting' }));
    expect(foldersService.cancelDialog).toHaveBeenCalledWith('s1');
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Stop waiting' })).toBeNull());
  });

  it.each([
    ['save_exists', 'A file with that name is already there, so nothing was saved.'],
    ['save_too_large', 'This export is too large to save this way. Use Download instead.'],
    ['save_failed', "Burrow couldn't save the file."],
  ])('shows %s and offers Download instead', async (code, message) => {
    const user = userEvent.setup();
    answers(saveView({ status: 'failed', error: { code, message } }));
    foldersService.exportFile.mockResolvedValue({ filename: 'x.csv' });
    renderPage();
    await openExport(user);
    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    await user.click(screen.getByRole('button', { name: 'Download instead' }));
    expect(foldersService.exportFile).toHaveBeenCalledWith('f1', 'csv');
    expect(await screen.findByText('Saved File list (CSV).')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Download instead' })).toBeNull();
  });

  it.each([
    ['busy', 'dialog_busy'],
    ['expired', 'dialog_expired'],
  ])('shows a %s window as a message only', async (status, code) => {
    const user = userEvent.setup();
    answers(saveView({ status, error: { code, message: `Message for ${code}.` } }));
    renderPage();
    await openExport(user);
    expect(await screen.findByRole('alert')).toHaveTextContent(`Message for ${code}.`);
    expect(screen.queryByRole('button', { name: 'Download instead' })).toBeNull();
  });

  it('offers Download instead when the request itself answers 413', async () => {
    const user = userEvent.setup();
    foldersService.exportToChosen.mockRejectedValue(
      apiError('save_too_large', 'This export is too large to save this way. Use Download instead.', { status: 413 }),
    );
    renderPage();
    await openExport(user);
    expect(await screen.findByRole('alert')).toHaveTextContent('too large to save this way');
    expect(screen.getByRole('button', { name: 'Download instead' })).toBeInTheDocument();
  });

  it('downloads to the Downloads folder when the window is not available', async () => {
    const user = userEvent.setup();
    foldersService.list.mockResolvedValue(listing([folderView()], { canSaveFile: false }));
    foldersService.exportFile.mockResolvedValue({ filename: 'x.md' });
    renderPage();
    await openExport(user, 'Report (Markdown)');
    expect(foldersService.exportFile).toHaveBeenCalledWith('f1', 'md');
    expect(foldersService.exportToChosen).not.toHaveBeenCalled();
  });
});

describe('file labels', () => {
  it('loads the file list only on demand and labels documents', async () => {
    const user = userEvent.setup();
    foldersService.list.mockResolvedValue(listing([folderView()]));
    const file = (over) => ({
      path: 'a.pdf',
      kind: 'document',
      status: 'ok',
      summaryStatus: 'none',
      summary: null,
      sizeBytes: 10,
      modifiedAt: '2026-10-01T10:00:00Z',
      ...over,
    });
    foldersService.files.mockResolvedValue({
      files: [file({}), file({ path: 'b.docx', status: 'unreadable' }), file({ path: 'c.pdf', status: 'brand_new_status' })],
      total: 3,
      offset: 0,
      limit: 100,
    });
    renderPage();
    const toggle = await screen.findByRole('button', { name: 'Files in Project notes' });
    expect(foldersService.files).not.toHaveBeenCalled();
    await user.click(toggle);
    expect(await screen.findByText('Could not read this file')).toBeInTheDocument();
    expect(screen.getAllByText('Document')).toHaveLength(3);
    expect(screen.getByText('Not read')).toBeInTheDocument();
    expect(screen.queryByText('brand_new_status')).toBeNull();
  });
});
