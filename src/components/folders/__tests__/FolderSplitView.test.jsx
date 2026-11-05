import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { apiError, jobView } from './folderFixtures';

vi.mock('../../../services/foldersService', () => ({
  foldersService: { files: vi.fn(), preview: vi.fn() },
}));

import FolderFilesTable from '../FolderFilesTable';
import { foldersService } from '../../../services/foldersService';

const fileView = (n, over = {}) => ({
  id: `id-${n}`,
  path: `notes/file-${n}.md`,
  kind: 'text',
  sizeBytes: 100,
  modifiedAt: '2026-10-01T10:00:00Z',
  status: 'ok',
  summaryStatus: 'ok',
  summary: `Summary ${n}`,
  ...over,
});

const previewOf = (text, over = {}) => ({
  file: {},
  preview: {
    kind: 'text',
    reason: null,
    text,
    truncated: false,
    shownChars: text?.length ?? 0,
    totalChars: text?.length ?? 0,
    pageBreaks: null,
    ...over,
  },
});

function renderTable(props = {}, files = [fileView(1), fileView(2), fileView(3)]) {
  foldersService.files.mockResolvedValue({ files, total: files.length, offset: 0, limit: 100 });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onRescan = vi.fn();
  const view = render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <FolderFilesTable
          folderId="f1"
          name="Notes"
          onRescan={onRescan}
          {...props}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...view, onRescan, client };
}

// The row button is named by its visible text: the path, then the kind.
const rowName = (path) => new RegExp(`^${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}, `);
const rowButton = (n) => screen.findByRole('button', { name: rowName(`notes/file-${n}.md`) });
const previewRegion = (n) => screen.getByRole('region', { name: `Preview of notes/file-${n}.md` });
const liveStatus = () => document.querySelector('p.sr-only[role="status"]');
const summaryRegion = (n) => screen.getByRole('region', { name: `Summary and status of notes/file-${n}.md` });

beforeEach(() => {
  vi.clearAllMocks();
  foldersService.preview.mockImplementation(async (_f, fileId) => previewOf(`Body of ${fileId}`));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('split view selection and pane sync', () => {
  it('shows one quiet line and no panes until a file is chosen', async () => {
    renderTable();
    await rowButton(1);
    expect(screen.getByText('Choose a file in the list to see what is inside it.')).toBeInTheDocument();
    expect(screen.queryByRole('region')).toBeNull();
    expect(screen.queryByText('Folder summary text')).toBeNull();
    expect(foldersService.preview).not.toHaveBeenCalled();
  });

  it('opens both panes on click and marks the row', async () => {
    const user = userEvent.setup();
    renderTable();
    const row = await rowButton(2);
    await user.click(row);
    expect(row).toHaveAttribute('aria-current', 'true');
    expect(await within(previewRegion(2)).findByText('Body of id-2')).toBeInTheDocument();
    expect(summaryRegion(2)).toHaveTextContent('Summary 2');
    expect(foldersService.preview).toHaveBeenCalledWith('f1', 'id-2', expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(screen.getByText('2 of 3 on this page')).toBeInTheDocument();
  });

  it('selects with Enter and Space on the focused row', async () => {
    const user = userEvent.setup();
    renderTable();
    (await rowButton(1)).focus();
    await user.keyboard('{Enter}');
    expect(await within(previewRegion(1)).findByText('Body of id-1')).toBeInTheDocument();
    (await rowButton(3)).focus();
    await user.keyboard(' ');
    expect(await within(previewRegion(3)).findByText('Body of id-3')).toBeInTheDocument();
    expect(await rowButton(1)).not.toHaveAttribute('aria-current');
  });

  it('moves both panes with the previous and next buttons and disables them at the ends', async () => {
    const user = userEvent.setup();
    renderTable();
    await user.click(await rowButton(1));
    const prev = screen.getByRole('button', { name: 'Previous file' });
    const next = screen.getByRole('button', { name: 'Next file' });
    expect(prev).toHaveAttribute('aria-disabled', 'true');
    await user.click(next);
    expect(await within(previewRegion(2)).findByText('Body of id-2')).toBeInTheDocument();
    expect(summaryRegion(2)).toHaveTextContent('Summary 2');
    expect(await rowButton(2)).toHaveAttribute('aria-current', 'true');
    await user.click(next);
    expect(await within(previewRegion(3)).findByText('Body of id-3')).toBeInTheDocument();
    expect(next).toHaveAttribute('aria-disabled', 'true');
    await user.click(next);
    expect(screen.getByText('3 of 3 on this page')).toBeInTheDocument();
    await user.click(prev);
    expect(await within(previewRegion(2)).findByText('Body of id-2')).toBeInTheDocument();
  });

  it('steps with ArrowDown and ArrowUp on a row and keeps focus on the row', async () => {
    const user = userEvent.setup();
    renderTable();
    const first = await rowButton(1);
    await user.click(first);
    first.focus();
    await user.keyboard('{ArrowDown}');
    expect(await within(previewRegion(2)).findByText('Body of id-2')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: rowName('notes/file-2.md') })).toHaveFocus());
    await user.keyboard('{ArrowUp}');
    expect(await within(previewRegion(1)).findByText('Body of id-1')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: rowName('notes/file-1.md') })).toHaveFocus());
  });

  it('steps with the bracket keys from inside a pane', async () => {
    const user = userEvent.setup();
    renderTable();
    await user.click(await rowButton(1));
    screen.getByRole('region', { name: 'Preview of notes/file-1.md' }).focus();
    await user.keyboard(']');
    expect(await within(previewRegion(2)).findByText('Body of id-2')).toBeInTheDocument();
    await user.keyboard('[[');
    expect(await within(previewRegion(1)).findByText('Body of id-1')).toBeInTheDocument();
  });

  it('closes on Escape and returns focus to the row', async () => {
    const user = userEvent.setup();
    renderTable();
    await user.click(await rowButton(2));
    await within(previewRegion(2)).findByText('Body of id-2');
    screen.getByRole('region', { name: 'Preview of notes/file-2.md' }).focus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('region')).toBeNull();
    await waitFor(() => expect(screen.getByRole('button', { name: rowName('notes/file-2.md') })).toHaveFocus());
    expect(screen.getByRole('button', { name: rowName('notes/file-2.md') })).not.toHaveAttribute('aria-current');
  });

  it('closes with the Close preview button', async () => {
    const user = userEvent.setup();
    renderTable();
    await user.click(await rowButton(1));
    await user.click(screen.getByRole('button', { name: 'Close preview' }));
    expect(screen.queryByRole('region')).toBeNull();
    await waitFor(() => expect(screen.getByRole('button', { name: rowName('notes/file-1.md') })).toHaveFocus());
  });

  it('aborts the request of the file that was left', async () => {
    const user = userEvent.setup();
    const signals = [];
    foldersService.preview.mockImplementation((_f, _id, { signal }) => {
      signals.push(signal);
      return new Promise(() => {});
    });
    renderTable();
    await user.click(await rowButton(1));
    await waitFor(() => expect(signals).toHaveLength(1));
    await user.click(screen.getByRole('button', { name: 'Next file' }));
    await waitFor(() => expect(signals).toHaveLength(2));
    expect(signals[0].aborted).toBe(true);
    expect(previewRegion(2)).toHaveAttribute('aria-busy', 'true');
  });
});

describe('narrow layout', () => {
  it('stacks the panes below md and scrolls each on its own', async () => {
    const user = userEvent.setup();
    renderTable();
    await user.click(await rowButton(1));
    const preview = previewRegion(1);
    const summary = summaryRegion(1);
    expect(preview.parentElement).toHaveClass('grid-cols-1', 'md:grid-cols-2');
    expect(preview.parentElement).toBe(summary.parentElement);
    for (const pane of [preview, summary]) {
      expect(pane).toHaveClass('overflow-auto', 'max-h-96');
      expect(pane).toHaveAttribute('tabindex', '0');
    }
    expect(screen.queryByRole('tab')).toBeNull();
  });
});

describe('preview kinds', () => {
  it('draws page dividers at the page breaks of a document', async () => {
    const user = userEvent.setup();
    foldersService.preview.mockResolvedValue(
      previewOf('Page one text.Page two text.Page three text.', { kind: 'document', pageBreaks: [14, 28] }),
    );
    renderTable();
    await user.click(await rowButton(1));
    const region = previewRegion(1);
    expect(await within(region).findByText('Page one text.')).toBeInTheDocument();
    expect(within(region).getByText('Page two text.')).toBeInTheDocument();
    expect(within(region).getAllByRole('separator').map((s) => s.getAttribute('aria-label'))).toEqual(['Page 2', 'Page 3']);
  });

  it('ignores page breaks that do not fit and shows a document with unknown pages as one block', async () => {
    const user = userEvent.setup();
    foldersService.preview.mockResolvedValue(previewOf('Just text', { kind: 'document', pageBreaks: [0, 999, 4.5] }));
    renderTable();
    await user.click(await rowButton(1));
    expect(await within(previewRegion(1)).findByText('Just text')).toBeInTheDocument();
    expect(within(previewRegion(1)).queryByRole('separator')).toBeNull();
  });

  it('renders a CSV as a table with a header row', async () => {
    const user = userEvent.setup();
    foldersService.preview.mockResolvedValue(previewOf('name,qty\napple,3\n"pear, ripe",4\n', { kind: 'csv' }));
    renderTable();
    await user.click(await rowButton(1));
    const region = previewRegion(1);
    const table = await within(region).findByRole('table');
    expect(within(table).getAllByRole('columnheader').map((c) => c.textContent)).toEqual(['name', 'qty']);
    expect(within(table).getAllByRole('row')).toHaveLength(3);
    expect(within(table).getByRole('cell', { name: 'pear, ripe' })).toBeInTheDocument();
    expect(within(region).queryByText(/Showing the first/)).toBeNull();
  });

  it('shows only the first 200 CSV rows and says so', async () => {
    const user = userEvent.setup();
    const rows = Array.from({ length: 250 }, (_, i) => `r${i},${i}`).join('\n');
    foldersService.preview.mockResolvedValue(previewOf(`a,b\n${rows}\n`, { kind: 'csv' }));
    renderTable();
    await user.click(await rowButton(1));
    const region = previewRegion(1);
    await within(region).findByRole('table');
    expect(within(region).getAllByRole('row')).toHaveLength(201);
    expect(within(region).getByText('Showing the first 200 rows.')).toBeInTheDocument();
    expect(within(region).queryByText('r200')).toBeNull();
  });

  it('computes the truncated note from the characters shown', async () => {
    const user = userEvent.setup();
    foldersService.preview.mockResolvedValue(previewOf('abc', { truncated: true, shownChars: 262144, totalChars: 900000 }));
    renderTable();
    await user.click(await rowButton(1));
    expect(await within(previewRegion(1)).findByText('Showing the first 256 KB of this file.')).toBeInTheDocument();
  });

  it.each([
    ['unsupported', "Burrow can't show this kind of file yet."],
    ['binary', "This isn't a text file, so there is nothing to show."],
    ['too_large', "This file is larger than 2 MB, so Burrow doesn't open it."],
    ['unreadable', "Burrow couldn't read this file. Check that you can open it, then click Re-scan."],
    ['empty', 'This file is empty.'],
    ['link', 'This is a shortcut, so Burrow skipped it.'],
    ['outside_root', 'This points outside the folder, so Burrow skipped it.'],
    ['skipped_limit', "Burrow reached this folder's file limit before it read this file."],
    ['something_new', "Burrow didn't read this file, so there is nothing to show."],
  ])('shows the empty state for reason %s', async (reason, copy) => {
    const user = userEvent.setup();
    foldersService.preview.mockResolvedValue(previewOf(null, { kind: 'none', reason }));
    renderTable();
    await user.click(await rowButton(1));
    expect(await within(previewRegion(1)).findByText(copy)).toBeInTheDocument();
  });
});

describe('escaping', () => {
  const HOSTILE = '<img src=x onerror=alert(1)>\n<script>alert(2)</script>\n[x](javascript:alert(3)) https://example.com **bold**';

  it('renders HTML in a text file as text and creates no element', async () => {
    const user = userEvent.setup();
    foldersService.preview.mockResolvedValue(previewOf(HOSTILE));
    renderTable();
    await user.click(await rowButton(1));
    const region = previewRegion(1);
    await waitFor(() => expect(region).toHaveTextContent('<img src=x onerror=alert(1)>'));
    expect(region).toHaveTextContent('<script>alert(2)</script>');
    expect(region.querySelector('img, script, a, strong')).toBeNull();
    expect(document.querySelector('img, script')).toBeNull();
  });

  it('renders HTML in CSV cells as text', async () => {
    const user = userEvent.setup();
    foldersService.preview.mockResolvedValue(
      previewOf('<img src=x onerror=alert(1)>,<script>x</script>\n<b>bold</b>,ok\n', { kind: 'csv' }),
    );
    renderTable();
    await user.click(await rowButton(1));
    const region = previewRegion(1);
    const table = await within(region).findByRole('table');
    expect(within(table).getByRole('columnheader', { name: '<img src=x onerror=alert(1)>' })).toBeInTheDocument();
    expect(within(table).getByRole('cell', { name: '<b>bold</b>' })).toBeInTheDocument();
    expect(region.querySelector('img, script, b')).toBeNull();
  });

  it('renders a hostile file name as text', async () => {
    const user = userEvent.setup();
    const path = '<img src=x onerror=alert(1)>.md';
    renderTable({}, [fileView(1, { path })]);
    await user.click(await screen.findByRole('button', { name: rowName(path) }));
    expect(document.querySelector('img')).toBeNull();
  });
});

describe('preview errors', () => {
  it('offers Re-scan when the file changed', async () => {
    const user = userEvent.setup();
    foldersService.preview.mockRejectedValue(
      apiError('folder_file_changed', 'This file changed since the last scan. Re-scan the folder to see it.', { status: 409 }),
    );
    const { onRescan } = renderTable();
    await user.click(await rowButton(1));
    const region = previewRegion(1);
    expect(await within(region).findByRole('alert')).toHaveTextContent(
      'This file changed since the last scan. Re-scan the folder to see it.',
    );
    await user.click(within(region).getByRole('button', { name: 'Re-scan' }));
    expect(onRescan).toHaveBeenCalledTimes(1);
  });

  it('does not start a Re-scan while a job is running', async () => {
    const user = userEvent.setup();
    foldersService.preview.mockRejectedValue(apiError('folder_file_changed', 'x', { status: 409 }));
    const { onRescan } = renderTable({ job: jobView() });
    await user.click(await rowButton(1));
    const button = await within(previewRegion(1)).findByRole('button', { name: 'Re-scan' });
    expect(button).toHaveAttribute('aria-disabled', 'true');
    await user.click(button);
    expect(onRescan).not.toHaveBeenCalled();
  });

  it('retries by hand when Burrow is busy and never on its own', async () => {
    const user = userEvent.setup();
    foldersService.preview
      .mockRejectedValueOnce(apiError('folder_preview_busy', 'Burrow is still opening another file. Try again in a moment.', { status: 429 }))
      .mockResolvedValue(previewOf('Second try'));
    renderTable();
    await user.click(await rowButton(1));
    const region = previewRegion(1);
    expect(await within(region).findByRole('alert')).toHaveTextContent(
      'Burrow is still opening another file. Try again in a moment.',
    );
    expect(foldersService.preview).toHaveBeenCalledTimes(1);
    await user.click(within(region).getByRole('button', { name: 'Try again' }));
    expect(await within(region).findByText('Second try')).toBeInTheDocument();
    expect(foldersService.preview).toHaveBeenCalledTimes(2);
  });

  it('shows the confirm copy and no retry for an imported folder', async () => {
    const user = userEvent.setup();
    foldersService.preview.mockRejectedValue(apiError('folder_needs_confirm', "Confirm where this folder is first. Burrow doesn't read a folder from an import until you choose it again.", { status: 409 }));
    renderTable();
    await user.click(await rowButton(1));
    const region = previewRegion(1);
    expect(await within(region).findByRole('alert')).toHaveTextContent(/Confirm where this folder is first/);
    expect(within(region).queryByRole('button')).toBeNull();
  });

  it('falls back to fixed copy for an unknown failure', async () => {
    const user = userEvent.setup();
    foldersService.preview.mockRejectedValue(new Error('boom'));
    renderTable();
    await user.click(await rowButton(1));
    expect(await within(previewRegion(1)).findByRole('alert')).toBeInTheDocument();
    expect(within(previewRegion(1)).getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});

describe('summary pane states', () => {
  const open = async (file, props = {}) => {
    const user = userEvent.setup();
    renderTable(props, [file]);
    await user.click(await screen.findByRole('button', { name: rowName(file.path) }));
    return screen.getByRole('region', { name: `Summary and status of ${file.path}` });
  };

  it('shows the summary as plain text', async () => {
    const pane = await open(fileView(1, { summary: '<b>hi</b>\nline two' }));
    expect(pane).toHaveTextContent('<b>hi</b>');
    expect(pane.querySelector('b')).toBeNull();
  });

  it('flags a stale summary', async () => {
    const pane = await open(fileView(1, { summaryStatus: 'stale' }));
    expect(pane).toHaveTextContent('Summary 1');
    expect(pane).toHaveTextContent('Summary is out of date');
  });

  it('says Summarizing for the file the job is on, with the progress bar', async () => {
    const job = jobView({
      phase: 'summarizing_files',
      progress: { ...jobView().progress, summariesTotal: 10, summariesDone: 4, currentFileId: 'id-1' },
    });
    const pane = await open(fileView(1, { summary: null, summaryStatus: 'none' }), { job });
    expect(pane).toHaveTextContent('Summarizing this file');
    expect(within(pane).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '4');
  });

  it('says Waiting for its turn when the job is on another file', async () => {
    const job = jobView({
      phase: 'summarizing_files',
      progress: { ...jobView().progress, summariesTotal: 10, summariesDone: 4, currentFileId: 'id-9' },
    });
    const pane = await open(fileView(1, { summary: null, summaryStatus: 'none' }), { job });
    expect(pane).toHaveTextContent('Waiting for its turn');
  });

  it('does not wait for a file that will not be summarized', async () => {
    const job = jobView({ phase: 'summarizing_files' });
    const pane = await open(fileView(1, { summary: null, summaryStatus: 'not_included' }), { job });
    expect(pane).toHaveTextContent('Not summarized, folder limit reached');
    expect(pane).not.toHaveTextContent('Waiting');
  });

  it.each([
    ['unreadable', 'Could not read this file'],
    ['unsupported', 'Not supported yet'],
    ['binary', 'Not a text file'],
    ['made_up', 'Not read'],
  ])('explains a %s file', async (status, copy) => {
    const pane = await open(fileView(1, { status, summary: null, summaryStatus: 'none' }));
    expect(pane).toHaveTextContent(copy);
  });

  it('shows the withheld notice', async () => {
    const pane = await open(fileView(1, { summary: null, summaryStatus: 'withheld' }));
    expect(pane).toHaveTextContent("Your folder files aren't shared with cloud AI.");
  });

  it('shows the Javi-unavailable and failed copy', async () => {
    cleanup();
    let pane = await open(fileView(1, { summary: null, summaryStatus: 'ai_unavailable' }));
    expect(pane).toHaveTextContent('No summary yet.');
    cleanup();
    pane = await open(fileView(1, { summary: null, summaryStatus: 'failed' }));
    expect(pane).toHaveTextContent("Summary couldn't be written");
  });

  it('says there is no summary yet when there is nothing else to say', async () => {
    const pane = await open(fileView(1, { summary: null, summaryStatus: 'none' }));
    expect(pane).toHaveTextContent('No summary yet.');
  });
});

describe('live summary, vanished selection and keyboard rules', () => {
  it('refreshes the selected file while a job runs so its new summary appears', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const waiting = fileView(1, { summary: null, summaryStatus: 'none' });
    const job = jobView({ phase: 'summarizing_files', progress: { ...jobView().progress, currentFileId: 'id-9' } });
    renderTable({ job }, [waiting]);
    await user.click(await rowButton(1));
    expect(summaryRegion(1)).toHaveTextContent('Waiting for its turn');
    foldersService.files.mockResolvedValue({ files: [fileView(1)], total: 1, offset: 0, limit: 100 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });
    await waitFor(() => expect(summaryRegion(1)).toHaveTextContent('Summary 1'));
  });

  it('does not poll the file list when no job is active', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderTable({}, [fileView(1)]);
    await rowButton(1);
    const calls = foldersService.files.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    expect(foldersService.files.mock.calls.length).toBe(calls);
  });

  it('clears the selection, announces it and moves focus to the list when the file disappears', async () => {
    const user = userEvent.setup();
    const { client } = renderTable();
    await user.click(await rowButton(2));
    await within(previewRegion(2)).findByText('Body of id-2');
    foldersService.files.mockResolvedValue({ files: [fileView(1), fileView(3)], total: 2, offset: 0, limit: 100 });
    await act(async () => {
      await client.invalidateQueries();
    });
    await waitFor(() => expect(screen.queryByRole('region')).toBeNull());
    expect(liveStatus()).toHaveTextContent('That file is no longer in the list.');
    await waitFor(() => expect(screen.getByRole('table', { name: /Files in/ })).toHaveFocus());
  });

  it('has one polite status region that announces only the selection', async () => {
    const user = userEvent.setup();
    const job = jobView({ phase: 'summarizing_files', progress: { ...jobView().progress, currentFileId: 'id-1' } });
    renderTable({ job }, [fileView(1, { summary: null, summaryStatus: 'none' }), fileView(2)]);
    const button = await rowButton(1);
    expect(liveStatus()).toBeEmptyDOMElement();
    await user.click(button);
    const pane = summaryRegion(1);
    expect(pane).toHaveTextContent('Summarizing this file');
    expect(pane.querySelector('[role="status"]')).toBeNull();
    expect(liveStatus()).toHaveTextContent('Showing notes/file-1.md, 1 of 2');
  });

  it('steps the arrow keys from the focused row, not the selected one', async () => {
    const user = userEvent.setup();
    renderTable();
    await user.click(await rowButton(1));
    (await rowButton(3)).focus();
    await user.keyboard('{ArrowUp}');
    expect(await within(previewRegion(2)).findByText('Body of id-2')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: rowName('notes/file-2.md') })).toHaveFocus());
  });

  it('ignores auto-repeat and fetches only the file the selection settled on', async () => {
    const user = userEvent.setup();
    renderTable();
    await user.click(await rowButton(1));
    const region = previewRegion(1);
    fireEvent.keyDown(region, { key: ']', repeat: true });
    expect(screen.getByText('1 of 3 on this page')).toBeInTheDocument();
    await user.keyboard(']]');
    expect(await within(previewRegion(3)).findByText('Body of id-3')).toBeInTheDocument();
    expect(foldersService.preview).toHaveBeenCalledTimes(1);
    expect(foldersService.preview).toHaveBeenCalledWith('f1', 'id-3', expect.anything());
  });

  it('sizes the icon buttons for touch', async () => {
    const user = userEvent.setup();
    renderTable();
    await user.click(await rowButton(1));
    for (const name of ['Previous file', 'Next file', 'Close preview']) {
      expect(screen.getByRole('button', { name })).toHaveClass('h-9', 'w-9', 'sm:h-7', 'sm:w-7');
    }
  });

  it('notes cut columns and drops the partial last CSV line of a truncated file', async () => {
    const user = userEvent.setup();
    const wide = Array.from({ length: 25 }, (_, i) => `c${i}`).join(',');
    foldersService.preview.mockResolvedValue(
      previewOf(`${wide}\n1,2\npartial,ro`, { kind: 'csv', truncated: true, shownChars: 40 }),
    );
    renderTable();
    await user.click(await rowButton(1));
    const region = previewRegion(1);
    const table = await within(region).findByRole('table');
    expect(within(table).getAllByRole('columnheader')).toHaveLength(20);
    expect(within(table).getAllByRole('row')).toHaveLength(2);
    expect(within(region).getByText('Showing the first 20 columns.')).toBeInTheDocument();
  });

  it('strips bidi controls from file names and CSV cells', async () => {
    const user = userEvent.setup();
    foldersService.preview.mockResolvedValue(previewOf('a\u202Eb,c\n1,2\n', { kind: 'csv' }));
    renderTable({}, [fileView(1, { path: 'x\u202Etxt.md' })]);
    await user.click(await screen.findByRole('button', { name: rowName('xtxt.md') }));
    const table = await within(screen.getByRole('region', { name: 'Preview of xtxt.md' })).findByRole('table');
    expect(within(table).getByRole('columnheader', { name: 'ab' })).toBeInTheDocument();
  });
});
