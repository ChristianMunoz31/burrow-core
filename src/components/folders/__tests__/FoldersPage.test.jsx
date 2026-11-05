import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '../../../contexts/ToastContext';
import { __resetPullStoreForTests } from '../../../hooks/ollamaPullStore';
import { LIMITS, STATS, apiError, folderView, jobView } from './folderFixtures';

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
  },
}));
vi.mock('../../../services/aiSettingsService', () => ({
  aiSettingsService: { pull: vi.fn(), setup: vi.fn(), get: vi.fn() },
}));

import FoldersPage from '../FoldersPage';
import { foldersService } from '../../../services/foldersService';

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter>
          <FoldersPage />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const listing = (folders) => ({ folders, limits: LIMITS });
const MORE_BUTTON = 'More actions for Project notes';
const openMore = async (user) => {
  const trigger = await screen.findByRole('button', { name: MORE_BUTTON });
  await user.click(trigger);
  return trigger;
};
const openPanel = async (user, name) => user.click(await screen.findByRole('button', { name }));
const capability = (name) => document.querySelector(`[data-capability="${name}"]`);

beforeEach(() => {
  vi.clearAllMocks();
  foldersService.files.mockResolvedValue({ files: [], total: 0, offset: 0, limit: 100 });
  foldersService.job.mockResolvedValue({ job: null });
});

afterEach(() => {
  cleanup();
  __resetPullStoreForTests();
});

describe('FoldersPage empty state and add flow', () => {
  it('explains itself and offers the first step', async () => {
    foldersService.list.mockResolvedValue(listing([]));
    renderPage();
    expect(await screen.findByText("No folders yet. Add one to see what's inside and get a summary.")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add your first folder' })).toBeInTheDocument();
  });

  it('adds a folder by path and shows its card', async () => {
    const user = userEvent.setup();
    const folder = folderView({ lastScanAt: null, stats: null, summary: { status: 'none', text: null, model: null, at: null } });
    foldersService.list.mockResolvedValueOnce(listing([])).mockResolvedValue(listing([folder]));
    foldersService.add.mockResolvedValue({ folder, job: jobView() });
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Add your first folder' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add a folder' });
    expect(within(dialog).getByText(/Copy as path/)).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText('Folder path'), '"C:\\Users\\tester\\Documents\\Notes"');
    await user.click(within(dialog).getByRole('button', { name: 'Add folder' }));

    expect(foldersService.add).toHaveBeenCalledWith({ path: 'C:\\Users\\tester\\Documents\\Notes', name: undefined });
    expect(await screen.findByRole('heading', { name: 'Project notes' })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // The empty-state button is gone; focus lands on the new Add button.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add folder' })).toHaveFocus());
  });

  it('has no Cancel in the Add dialog; the Close button and Escape dismiss it', async () => {
    const user = userEvent.setup();
    foldersService.list.mockResolvedValue(listing([]));
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Add your first folder' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add a folder' });
    expect(within(dialog).queryByRole('button', { name: 'Cancel' })).toBeNull();
    await user.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await user.click(screen.getByRole('button', { name: 'Add your first folder' }));
    await screen.findByRole('dialog', { name: 'Add a folder' });
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('sends the optional name', async () => {
    const user = userEvent.setup();
    foldersService.list.mockResolvedValue(listing([]));
    foldersService.add.mockResolvedValue({ folder: folderView(), job: jobView() });
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Add your first folder' }));
    await user.type(screen.getByLabelText('Folder path'), 'C:\\Data');
    await user.type(screen.getByLabelText('Name (optional)'), 'Mine');
    await user.click(screen.getByRole('button', { name: 'Add folder' }));
    expect(foldersService.add).toHaveBeenCalledWith({ path: 'C:\\Data', name: 'Mine' });
  });

  it.each([
    ['folder_missing', "Burrow can't find that folder. Check the path and try again."],
    ['folder_protected', "Burrow doesn't read system or app folders. Pick a folder with your own files."],
    ['folder_exists', 'That folder is already in Burrow.'],
  ])('shows %s next to the path field', async (code, message) => {
    const user = userEvent.setup();
    foldersService.list.mockResolvedValue(listing([]));
    foldersService.add.mockRejectedValue(apiError(code, message));
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Add your first folder' }));
    const field = screen.getByLabelText('Folder path');
    await user.type(field, 'C:\\Nope');
    await user.click(screen.getByRole('button', { name: 'Add folder' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(message);
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(field).toHaveFocus();
    expect(field.getAttribute('aria-describedby')).toContain(alert.id);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('shows folder_limit as a form message, not on the field', async () => {
    const user = userEvent.setup();
    foldersService.list.mockResolvedValue(listing([]));
    foldersService.add.mockRejectedValue(
      apiError('folder_limit', 'You can add up to 20 folders. Remove one to add another.', { status: 409 }),
    );
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Add your first folder' }));
    const field = screen.getByLabelText('Folder path');
    await user.type(field, 'C:\\Data');
    await user.click(screen.getByRole('button', { name: 'Add folder' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('You can add up to 20 folders');
    expect(field).not.toHaveAttribute('aria-invalid');
  });

  it('falls back to fixed copy when an error has no message of its own', async () => {
    const user = userEvent.setup();
    foldersService.list.mockResolvedValue(listing([]));
    foldersService.add.mockRejectedValue(Object.assign(new Error('boom'), { code: 'folder_is_link', status: 422 }));
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Add your first folder' }));
    await user.type(screen.getByLabelText('Folder path'), 'C:\\Link');
    await user.click(screen.getByRole('button', { name: 'Add folder' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('That folder is a shortcut to another place. Enter the real folder instead.');
    expect(alert).not.toHaveTextContent('boom');
  });

  it('warns about OneDrive when the added folder is in OneDrive', async () => {
    const user = userEvent.setup();
    const folder = folderView({ warnings: ['onedrive'] });
    foldersService.list.mockResolvedValueOnce(listing([])).mockResolvedValue(listing([folder]));
    foldersService.add.mockResolvedValue({ folder, job: jobView() });
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Add your first folder' }));
    await user.type(screen.getByLabelText('Folder path'), 'C:\\Users\\tester\\OneDrive\\Docs');
    await user.click(screen.getByRole('button', { name: 'Add folder' }));
    const warnings = await screen.findAllByText(/This folder is in OneDrive/);
    expect(warnings.length).toBeGreaterThanOrEqual(1);
  });
});

describe('FoldersPage folder card', () => {
  it('shows the numbers the server sent and the plain-text summary', async () => {
    foldersService.list.mockResolvedValue(listing([folderView()]));
    renderPage();
    expect(await screen.findByText('Meeting notes and plans for a small project.')).toBeInTheDocument();
    expect(screen.getByText(/^124 files, 118 read, 12\.4 MB, 30,500 words\. Last read /)).toBeInTheDocument();
    expect(screen.getByText('Meeting notes and plans for a small project.').className).toContain('whitespace-pre-wrap');
  });

  it('renders summary markup as text', async () => {
    const summary = { status: 'ok', text: '**bold** [link](https://example.com)', model: null, at: null };
    foldersService.list.mockResolvedValue(listing([folderView({ summary })]));
    renderPage();
    expect(await screen.findByText('**bold** [link](https://example.com)')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'link' })).toBeNull();
  });

  it('says a stale summary is out of date', async () => {
    const summary = { status: 'stale', text: 'Old words.', model: null, at: '2026-09-01T12:00:00Z' };
    foldersService.list.mockResolvedValue(listing([folderView({ summary })]));
    renderPage();
    expect(await screen.findByText(/This summary is from .+\. Re-scan to update it\./)).toBeInTheDocument();
  });

  it('shows the withheld notice when the cloud category is off', async () => {
    const summary = { status: 'withheld', text: null, model: null, at: null };
    foldersService.list.mockResolvedValue(listing([folderView({ summary })]));
    renderPage();
    const message = "Your folder files aren't shared with cloud AI. You can change that in Settings > AI.";
    expect(await screen.findByText((_, el) => el?.tagName === 'P' && el.textContent === message)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Change what cloud AI can see' })).toBeInTheDocument();
  });

  it('shows the AI notice from a finished job through the shared Javi needs Ollama card', async () => {
    const job = jobView({
      status: 'done',
      phase: 'done',
      notices: [{ code: 'ai_unavailable', message: 'Start Ollama to get summaries.' }],
    });
    const summary = { status: 'ai_unavailable', text: null, model: null, at: null };
    foldersService.list.mockResolvedValue(listing([folderView({ summary, job })]));
    renderPage();
    expect(await screen.findByText('Javi needs Ollama')).toBeInTheDocument();
    expect(screen.getByText('Start Ollama to get summaries.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Set it up in Settings > AI' })).toHaveAttribute('href', '/settings#ai');
  });

  it('moves the Ollama address in a job notice behind Details', async () => {
    const job = jobView({
      status: 'done',
      phase: 'done',
      notices: [{ code: 'ai_unavailable', message: "Javi can't reach Ollama at http://127.0.0.1:11434. Start it, then Re-scan." }],
    });
    const summary = { status: 'ai_unavailable', text: null, model: null, at: null };
    foldersService.list.mockResolvedValue(listing([folderView({ summary, job })]));
    renderPage();
    await screen.findByText('Javi needs Ollama');
    expect(screen.queryByText(/Ollama at http/)).toBeNull();
    const details = screen.getByText('Details', { selector: 'summary' }).closest('details');
    expect(details).toHaveTextContent('http://127.0.0.1:11434');
    expect(details).not.toHaveAttribute('open');
  });

  it('says to open Files when there is no summary because Javi was unavailable', async () => {
    const summary = { status: 'ai_unavailable', text: null, model: null, at: null };
    foldersService.list.mockResolvedValue(listing([folderView({ summary })]));
    renderPage();
    expect(await screen.findByText('No summary yet. Open Files to see what is inside.')).toBeInTheDocument();
    expect(screen.queryByText(/file list below/)).toBeNull();
  });

  it('writes "on <date>" when every file changed on one day, a range otherwise', async () => {
    const user = userEvent.setup();
    const oneDay = { ...STATS, oldestModifiedAt: '2026-09-30T10:00:00Z', newestModifiedAt: '2026-09-30T12:00:00Z' };
    foldersService.list.mockResolvedValue(listing([folderView({ stats: oneDay })]));
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Details of Project notes' }));
    expect(screen.getByText(/^Files changed on .+\.$/)).toBeInTheDocument();
    expect(screen.queryByText(/ to /)).toBeNull();
    cleanup();
    foldersService.list.mockResolvedValue(listing([folderView()]));
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Details of Project notes' }));
    expect(screen.getByText(/^Files changed .+ to .+\.$/)).toBeInTheDocument();
  });

  it('follows a new active job from the list while the cached job is an older finished one', async () => {
    const running = jobView({ id: 'job-2', status: 'running', phase: 'summarizing_files' });
    foldersService.list.mockResolvedValue(listing([folderView({ job: running })]));
    foldersService.job.mockResolvedValue({ job: jobView({ id: 'job-1', status: 'done', phase: 'done' }) });
    renderPage();
    expect(await screen.findByText('Summarizing files')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Re-scan Project notes' })).toHaveAttribute('aria-disabled', 'true');
  });

  it('lists the limits the scan hit', async () => {
    const stats = { ...STATS, limitsHit: ['max_files', 'summary_limit'] };
    foldersService.list.mockResolvedValue(listing([folderView({ stats })]));
    renderPage();
    expect(
      await screen.findByText('Burrow listed the first 5,000 files. Pick a smaller folder to include everything.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Summaries cover the 300 most recently changed files.')).toBeInTheDocument();
  });

  it('shows a failed last scan in plain words', async () => {
    const lastJob = { status: 'failed', errorCode: 'folder_moved', message: 'This folder was moved, renamed or replaced. Remove it from Burrow and add it again.', at: null };
    foldersService.list.mockResolvedValue(listing([folderView({ lastJob })]));
    renderPage();
    expect(await screen.findByText(/This folder was moved, renamed or replaced/)).toBeInTheDocument();
  });

  it('shows the file list with status labels', async () => {
    const user = userEvent.setup();
    foldersService.list.mockResolvedValue(listing([folderView()]));
    foldersService.files.mockResolvedValue({
      files: [
        { id: 'a', path: 'a.md', ext: '.md', kind: 'text', status: 'ok', sizeBytes: 100, modifiedAt: '2026-10-01T00:00:00Z', lines: 3, words: 9, chars: 40, summary: 'About A.', summaryStatus: 'ok', indexed: true },
        { id: 'b', path: 'b.pdf', ext: '.pdf', kind: 'other', status: 'unsupported', sizeBytes: 2048, modifiedAt: null, lines: null, words: null, chars: null, summary: null, summaryStatus: 'not_text', indexed: false },
        { id: 'c', path: 'c.bin', ext: '.bin', kind: 'other', status: 'binary', sizeBytes: 5, modifiedAt: null, lines: null, words: null, chars: null, summary: null, summaryStatus: 'not_text', indexed: false },
      ],
      total: 3,
      offset: 0,
      limit: 100,
    });
    renderPage();
    const toggle = await screen.findByRole('button', { name: 'Files in Project notes' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(toggle).toHaveAccessibleName('Files in Project notes');
    expect(await screen.findByText('Not supported yet')).toBeInTheDocument();
    expect(screen.getByText('Not a text file')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Summary of a\.md/ }));
    expect(screen.getByText('About A.')).toBeInTheDocument();
    expect(screen.getByText('Showing 1 to 3 of 3')).toBeInTheDocument();
  });
});

describe('FoldersPage actions', () => {
  it('re-scans', async () => {
    const user = userEvent.setup();
    foldersService.list.mockResolvedValue(listing([folderView()]));
    foldersService.scan.mockResolvedValue({ job: jobView() });
    renderPage();
    await user.click(await screen.findByRole('button', { name: /Re-scan/ }));
    expect(foldersService.scan).toHaveBeenCalledWith('f1');
  });

  it('a fast scan that is already done in the list does not leave the card stuck on the queued job', async () => {
    const user = userEvent.setup();
    const queued = jobView({ id: 'job-fast', status: 'queued', phase: 'inventory' });
    const finished = jobView({ id: 'job-fast', status: 'done', phase: 'done', finishedAt: '2026-10-09T10:00:05Z' });
    foldersService.list
      .mockResolvedValueOnce(listing([folderView()]))
      .mockResolvedValue(listing([folderView({ job: finished })]));
    foldersService.scan.mockResolvedValue({ job: queued });
    renderPage();
    const button = await screen.findByRole('button', { name: /Re-scan/ });
    await user.click(button);
    expect(foldersService.scan).toHaveBeenCalledWith('f1');
    await waitFor(() => expect(foldersService.list).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole('button', { name: /Re-scan/ })).not.toHaveAttribute('aria-disabled', 'true'));
    expect(screen.getByRole('button', { name: /Re-scan/ })).not.toBeDisabled();
    expect(screen.queryByText('Listing files')).toBeNull();
  });

  it('a long scan keeps showing the running phase that is polled', async () => {
    const running = jobView({ id: 'job-long', status: 'running', phase: 'inventory' });
    const later = jobView({
      id: 'job-long',
      status: 'running',
      phase: 'summarizing_files',
      progress: { filesSeen: 10, filesRead: 10, bytesRead: 1, summariesTotal: 20, summariesDone: 5, chunksTotal: 0, chunksDone: 0 },
    });
    foldersService.list.mockResolvedValue(listing([folderView({ job: running })]));
    foldersService.job.mockResolvedValue({ job: later });
    renderPage();
    expect(await screen.findByText('Summarizing files')).toHaveAttribute('role', 'status');
    expect(screen.queryByText('Listing files')).toBeNull();
    expect(screen.getByRole('button', { name: /Re-scan/ })).toHaveAttribute('aria-disabled', 'true');
  });

  it('shows progress with the phase text and cancels', async () => {
    const user = userEvent.setup();
    const job = jobView({
      phase: 'summarizing_files',
      progress: { filesSeen: 10, filesRead: 10, bytesRead: 1, summariesTotal: 20, summariesDone: 5, chunksTotal: 0, chunksDone: 0 },
    });
    foldersService.list.mockResolvedValue(listing([folderView({ job })]));
    foldersService.job.mockResolvedValue({ job });
    foldersService.cancel.mockResolvedValue({ job: { ...job, status: 'cancelled' } });
    renderPage();
    // The live region names the phase only; the numbers belong to the progress bar.
    expect(await screen.findByText('Summarizing files')).toHaveAttribute('role', 'status');
    expect(screen.queryByText(/5 of 20/)).toBeNull();
    const bar = screen.getByRole('progressbar', { name: 'Summarizing files (5 of 20)' });
    expect(bar).toHaveAttribute('aria-valuenow', '5');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(foldersService.cancel).toHaveBeenCalledWith('f1');
  });

  it('keeps focus on Re-scan while it works and ignores a second press', async () => {
    const user = userEvent.setup();
    foldersService.list.mockResolvedValue(listing([folderView()]));
    foldersService.scan.mockReturnValue(new Promise(() => {}));
    renderPage();
    const button = await screen.findByRole('button', { name: /Re-scan/ });
    await user.click(button);
    expect(button).toHaveFocus();
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).not.toBeDisabled();
    await user.click(button);
    expect(foldersService.scan).toHaveBeenCalledTimes(1);
  });

  it('shows an export failure in the page flow and clears it on the next attempt', async () => {
    const user = userEvent.setup();
    foldersService.list.mockResolvedValue(listing([folderView()]));
    foldersService.exportFile
      .mockRejectedValueOnce(apiError('folder_failed', 'Export did not finish.'))
      .mockResolvedValue({ filename: 'x.md' });
    renderPage();
    const trigger = await openMore(user);
    await user.click(screen.getByRole('menuitem', { name: 'Report (Markdown)' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Export did not finish.');
    expect(alert.className).not.toContain('absolute');
    await user.click(trigger);
    await user.click(screen.getByRole('menuitem', { name: 'Report (JSON)' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });

  it('keeps the list on screen when a refresh fails', async () => {
    const user = userEvent.setup();
    foldersService.list.mockResolvedValueOnce(listing([folderView()])).mockRejectedValue(new Error('offline'));
    foldersService.scan.mockResolvedValue({ job: jobView() });
    renderPage();
    await user.click(await screen.findByRole('button', { name: /Re-scan/ }));
    await waitFor(() => expect(foldersService.list).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('heading', { name: 'Project notes' })).toBeInTheDocument();
  });

  it('steps back to the last page when the file list shrinks below the current page', async () => {
    const user = userEvent.setup();
    foldersService.list.mockResolvedValue(listing([folderView()]));
    const row = (id) => ({ id, path: `${id}.md`, ext: '.md', kind: 'text', status: 'ok', sizeBytes: 1, modifiedAt: null, summary: null, summaryStatus: 'ok', indexed: true });
    let shrunk = false;
    foldersService.files.mockImplementation(async (_id, { offset }) => {
      if (offset > 0) shrunk = true;
      return shrunk
        ? { files: offset === 0 ? [row('a')] : [], total: 50, offset, limit: 100 }
        : { files: [row('a')], total: 150, offset, limit: 100 };
    });
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Files in Project notes' }));
    await user.click(await screen.findByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Showing 1 to 50 of 50')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
  });

  it('labels a fully read file as Read', async () => {
    const user = userEvent.setup();
    foldersService.list.mockResolvedValue(listing([folderView()]));
    foldersService.files.mockResolvedValue({
      files: [{ id: 'a', path: 'a.md', ext: '.md', kind: 'text', status: 'ok', sizeBytes: 1, modifiedAt: null, summary: null, summaryStatus: 'ok', indexed: true }],
      total: 1,
      offset: 0,
      limit: 100,
    });
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Files in Project notes' }));
    expect(within(await screen.findByRole('table')).getByText('Read')).toBeInTheDocument();
  });

  it('asks before removing, and removes only after the confirmation', async () => {
    const user = userEvent.setup();
    foldersService.list.mockResolvedValue(listing([folderView()]));
    foldersService.remove.mockResolvedValue({ removed: true });
    renderPage();
    await openMore(user);
    await user.click(screen.getByRole('menuitem', { name: 'Remove' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Remove this folder from Burrow?' });
    expect(
      within(dialog).getByText('Burrow forgets its summaries and file list. The folder and your files stay exactly where they are.'),
    ).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(foldersService.remove).not.toHaveBeenCalled();

    await openMore(user);
    await user.click(screen.getByRole('menuitem', { name: 'Remove' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(foldersService.remove).toHaveBeenCalledWith('f1'));
  });

  it('exports each format through the service', async () => {
    const user = userEvent.setup();
    foldersService.list.mockResolvedValue(listing([folderView()]));
    foldersService.exportFile.mockResolvedValue({ filename: 'x.md' });
    renderPage();
    const trigger = await openMore(user);
    const items = screen.getAllByRole('menuitem').map((i) => i.textContent);
    expect(items).toEqual(['Report (Markdown)', 'Report (JSON)', 'File list (CSV)', 'Remove']);
    await user.click(screen.getByRole('menuitem', { name: 'File list (CSV)' }));
    expect(foldersService.exportFile).toHaveBeenCalledWith('f1', 'csv');
    await user.click(trigger);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('does not turn on the daily re-scan in a build without the private module and says so', async () => {
    const user = userEvent.setup();
    foldersService.list.mockResolvedValue(listing([folderView()]));
    renderPage();
    await openMore(user);
    await user.click(screen.getByRole('menuitemcheckbox', { name: 'Re-scan once a day' }));
    expect(foldersService.update).not.toHaveBeenCalled();
    await waitFor(() => expect(capability('folder_auto_rescan')).not.toBeNull());
  });
});

describe('FoldersPage Report notice (needs Javi)', () => {
  const unavailable = { status: 'ai_unavailable', text: null, model: null, at: null };

  it('shows the not-included notice, not the Javi notice, without the module', async () => {
    const user = userEvent.setup();
    foldersService.list.mockResolvedValue(listing([folderView({ summary: unavailable })]));
    renderPage();
    await openPanel(user, 'Report for Project notes');
    await waitFor(() => expect(capability('folder_report')).not.toBeNull());
    expect(screen.queryByText(/Reports need Javi/)).toBeNull();
  });
});

describe('FoldersPage module panels', () => {
  it('shows the not-included notice instead of the module panels in a core-only build', async () => {
    const user = userEvent.setup();
    foldersService.list.mockResolvedValue(listing([folderView()]));
    renderPage();
    await screen.findByRole('heading', { name: 'Project notes' });
    expect(capability('folder_qa')).toBeNull();
    await openPanel(user, 'Ask about Project notes');
    await openPanel(user, 'Report for Project notes');
    await waitFor(() => expect(capability('folder_qa')).not.toBeNull());
    expect(capability('folder_report')).not.toBeNull();
    expect(screen.queryByPlaceholderText('Ask about the files in this folder')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Write report' })).toBeNull();

    await openMore(user);
    await user.click(screen.getByRole('menuitemcheckbox', { name: 'Re-scan once a day' }));
    expect(foldersService.update).not.toHaveBeenCalled();
    await waitFor(() => expect(capability('folder_auto_rescan')).not.toBeNull());
  });

  it('keeps turning the daily re-scan off', async () => {
    const user = userEvent.setup();
    foldersService.list.mockResolvedValue(listing([folderView({ autoRescan: true })]));
    foldersService.update.mockResolvedValue({ folder: folderView({ autoRescan: false }) });
    renderPage();
    await openMore(user);
    await user.click(screen.getByRole('menuitemcheckbox', { name: 'Re-scan once a day' }));
    expect(foldersService.update).toHaveBeenCalledWith('f1', { autoRescan: false });
  });

  it('lets anyone read an existing report, while writing a new one needs the module', async () => {
    const user = userEvent.setup();
    const report = { text: 'Themes\nPlans and notes.', model: 'm', at: '2026-10-08T12:00:00Z' };
    foldersService.list.mockResolvedValue(listing([folderView({ report })]));
    renderPage();
    await openPanel(user, 'Report for Project notes');
    expect(await screen.findByText(/Plans and notes\./)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Write report' })).toBeNull();
    await waitFor(() => expect(capability('folder_report')).not.toBeNull());
  });

});

describe('FoldersPage More menu', () => {
  it('has no separate Export or Remove button on the card', async () => {
    foldersService.list.mockResolvedValue(listing([folderView()]));
    renderPage();
    await screen.findByRole('heading', { name: 'Project notes' });
    expect(screen.queryByRole('button', { name: /^Export/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Remove/ })).toBeNull();
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.getByRole('button', { name: MORE_BUTTON })).toHaveAttribute('aria-haspopup', 'menu');
  });

  it('opens on the first item and moves with the arrow keys, Home and End', async () => {
    const user = userEvent.setup();
    foldersService.list.mockResolvedValue(listing([folderView()]));
    renderPage();
    const trigger = await openMore(user);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const markdown = screen.getByRole('menuitem', { name: 'Report (Markdown)' });
    const remove = screen.getByRole('menuitem', { name: 'Remove' });
    const auto = screen.getByRole('menuitemcheckbox', { name: 'Re-scan once a day' });
    await waitFor(() => expect(markdown).toHaveFocus());
    await user.keyboard('{ArrowUp}');
    expect(remove).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(markdown).toHaveFocus();
    await user.keyboard('{End}');
    expect(remove).toHaveFocus();
    await user.keyboard('{ArrowUp}');
    expect(auto).toHaveFocus();
    await user.keyboard('{Home}');
    expect(markdown).toHaveFocus();
  });

  it('closes on Escape and on Tab, and Escape puts focus back on the trigger', async () => {
    const user = userEvent.setup();
    foldersService.list.mockResolvedValue(listing([folderView()]));
    renderPage();
    const trigger = await openMore(user);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(trigger).toHaveFocus();
    await user.click(trigger);
    await user.keyboard('{Tab}');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('hands Tab to the page: focus goes to the trigger first and the key is not prevented', async () => {
    const user = userEvent.setup();
    foldersService.list.mockResolvedValue(listing([folderView()]));
    renderPage();
    const trigger = await openMore(user);
    const first = screen.getByRole('menuitem', { name: 'Report (Markdown)' });
    await waitFor(() => expect(first).toHaveFocus());
    const notPrevented = fireEvent.keyDown(first, { key: 'Tab' });
    expect(notPrevented).toBe(true);
    expect(trigger).toHaveFocus();
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('closes on a pointer press outside the menu', async () => {
    const user = userEvent.setup();
    foldersService.list.mockResolvedValue(listing([folderView()]));
    renderPage();
    await openMore(user);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('opens from the trigger with ArrowDown on the first item and ArrowUp on the last', async () => {
    const user = userEvent.setup();
    foldersService.list.mockResolvedValue(listing([folderView()]));
    renderPage();
    const trigger = await screen.findByRole('button', { name: MORE_BUTTON });
    trigger.focus();
    await user.keyboard('{ArrowDown}');
    await waitFor(() => expect(screen.getByRole('menuitem', { name: 'Report (Markdown)' })).toHaveFocus());
    await user.keyboard('{Escape}');
    expect(trigger).toHaveFocus();
    await user.keyboard('{ArrowUp}');
    await waitFor(() => expect(screen.getByRole('menuitem', { name: 'Remove' })).toHaveFocus());
  });

  it('keeps the trigger, the switch and Remove working while an export is busy', async () => {
    const user = userEvent.setup();
    foldersService.list.mockResolvedValue(listing([folderView()]));
    let finish;
    foldersService.exportFile.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    foldersService.update.mockResolvedValue({ folder: folderView({ autoRescan: true }) });
    renderPage();
    const trigger = await openMore(user);
    await user.click(screen.getByRole('menuitem', { name: 'Report (JSON)' }));
    await waitFor(() => expect(foldersService.exportFile).toHaveBeenCalledTimes(1));

    expect(trigger).not.toHaveAttribute('aria-disabled');
    await user.click(trigger);
    expect(screen.getByRole('menu')).toBeInTheDocument();
    const csv = screen.getByRole('menuitem', { name: 'File list (CSV)' });
    expect(csv).toHaveAttribute('aria-disabled', 'true');
    await user.click(csv);
    expect(foldersService.exportFile).toHaveBeenCalledTimes(1);

    const auto = screen.getByRole('menuitemcheckbox', { name: 'Re-scan once a day' });
    expect(auto).not.toHaveAttribute('aria-disabled');
    await user.click(auto);
    await waitFor(() => expect(capability('folder_auto_rescan')).not.toBeNull());
    expect(foldersService.update).not.toHaveBeenCalled();

    await user.click(trigger);
    const remove = screen.getByRole('menuitem', { name: 'Remove' });
    expect(remove).not.toHaveAttribute('aria-disabled');
    await user.click(remove);
    expect(await screen.findByRole('alertdialog')).toBeInTheDocument();
    finish({ filename: 'x.json' });
  });

  it('says when the daily re-scan is turned off', async () => {
    const user = userEvent.setup();
    foldersService.list.mockResolvedValue(listing([folderView({ autoRescan: true })]));
    foldersService.update.mockResolvedValue({ folder: folderView({ autoRescan: false }) });
    renderPage();
    await openMore(user);
    await user.click(screen.getByRole('menuitemcheckbox', { name: 'Re-scan once a day' }));
    expect(await screen.findByText('Daily re-scan off')).toBeInTheDocument();
  });

  it('keeps the three exports in one Export group and returns focus to the trigger after a choice', async () => {
    const user = userEvent.setup();
    foldersService.list.mockResolvedValue(listing([folderView()]));
    foldersService.exportFile.mockResolvedValue({ filename: 'x.json' });
    renderPage();
    const trigger = await openMore(user);
    const group = screen.getByRole('group', { name: 'Export' });
    expect(within(group).getAllByRole('menuitem').map((i) => i.textContent)).toEqual([
      'Report (Markdown)',
      'Report (JSON)',
      'File list (CSV)',
    ]);
    await waitFor(() => expect(within(group).getByRole('menuitem', { name: 'Report (Markdown)' })).toHaveFocus());
    await user.keyboard('{ArrowDown}{Enter}');
    await waitFor(() => expect(foldersService.exportFile).toHaveBeenCalledWith('f1', 'json'));
    expect(screen.queryByRole('menu')).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it('shows the daily re-scan as a checked menu item and in the quiet line', async () => {
    const user = userEvent.setup();
    foldersService.list.mockResolvedValue(listing([folderView({ autoRescan: true })]));
    renderPage();
    expect(await screen.findByText(/Re-scans daily\./)).toBeInTheDocument();
    await openMore(user);
    const item = screen.getByRole('menuitemcheckbox', { name: 'Re-scan once a day' });
    expect(item).toHaveAttribute('aria-checked', 'true');
    expect(item).toHaveAccessibleDescription('While Burrow is open. Only changed files are read again.');
  });

  it('shows the folder summary once while Files is open with nothing selected', async () => {
    const user = userEvent.setup();
    foldersService.list.mockResolvedValue(listing([folderView()]));
    foldersService.files.mockResolvedValue({
      files: [{ id: 'a', path: 'a.md', ext: '.md', kind: 'text', status: 'ok', sizeBytes: 1, modifiedAt: null, summary: null, summaryStatus: 'ok', indexed: true }],
      total: 1,
      offset: 0,
      limit: 100,
    });
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Files in Project notes' }));
    await screen.findByRole('table');
    expect(screen.getAllByText('Meeting notes and plans for a small project.')).toHaveLength(1);
    expect(screen.getByText('Choose a file in the list to see what is inside it.')).toBeInTheDocument();
  });
});
