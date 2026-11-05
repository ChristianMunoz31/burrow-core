import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import ImportControl from '../ImportControl';

const importExportZip = vi.hoisted(() => vi.fn());
vi.mock('../../../services/importService', () => ({ importExportZip }));

afterEach(() => {
  cleanup();
  importExportZip.mockReset();
});

const PREVIEW = {
  dryRun: true,
  tables: [
    { id: 'notes', received: 3, inserted: 2, updated: 1, skipped: 0 },
    { id: 'todos', received: 2, inserted: 1, updated: 0, skipped: 1 },
  ],
  totals: { received: 5, inserted: 3, updated: 1, skipped: 1 },
};
const APPLIED = { ...PREVIEW, dryRun: false };

const file = () => new File(['zip'], 'export.zip', { type: 'application/zip' });
const input = () => screen.getByLabelText('Export file (.zip)');

async function pick() {
  await userEvent.upload(input(), file());
}

describe('ImportControl', () => {
  it('names the folder tables in the preview', async () => {
    importExportZip.mockResolvedValue({
      ...PREVIEW,
      tables: [
        { id: 'folders', received: 1, inserted: 1, updated: 0, skipped: 0 },
        { id: 'folder_files', received: 2, inserted: 2, updated: 0, skipped: 0 },
      ],
    });
    render(<ImportControl />);
    await pick();
    expect(await screen.findByRole('row', { name: /^Folders/ })).toBeInTheDocument();
    expect(screen.getByRole('row', { name: /^Folder files/ })).toBeInTheDocument();
  });

  it('labels the file input and describes it with the hint', () => {
    render(<ImportControl />);
    expect(input()).toHaveAttribute('type', 'file');
    expect(input()).toHaveAttribute('accept', '.zip,application/zip');
    expect(input()).toHaveAccessibleDescription(
      'Bring in data from a Burrow export (.zip). Matching items are updated; nothing is deleted.',
    );
    expect(screen.queryByText(/Restore from a Burrow export/)).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('');
  });

  it('runs a dry run on pick and shows per-table counts without importing yet', async () => {
    importExportZip.mockResolvedValue(PREVIEW);
    render(<ImportControl />);
    await pick();
    expect(await screen.findByRole('table')).toBeInTheDocument();
    expect(importExportZip).toHaveBeenCalledTimes(1);
    expect(importExportZip.mock.calls[0][1]).toMatchObject({ dryRun: true });
    const notes = screen.getByRole('row', { name: /Notes/ });
    expect(within(notes).getAllByRole('cell').map((c) => c.textContent)).toEqual(['2', '1', '0']);
    const todos = screen.getByRole('row', { name: /Todos/ });
    expect(within(todos).getAllByRole('cell').map((c) => c.textContent)).toEqual(['1', '0', '1']);
    expect(screen.getByText(/Ready to import 5 items: 3 new, 1 will update existing items, 1 skipped\./)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Import 4 items' })).toBeInTheDocument();
  });

  it('announces the checking state while the preview runs', async () => {
    let finish;
    importExportZip.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    render(<ImportControl />);
    await pick();
    expect(screen.getByRole('status')).toHaveTextContent('Checking file…');
    expect(input()).toBeDisabled();
    finish(PREVIEW);
    await screen.findByRole('table');
    expect(input()).not.toBeDisabled();
  });

  it('imports on confirm with dryRun off, announces the result and clears the preview', async () => {
    importExportZip.mockResolvedValueOnce(PREVIEW).mockResolvedValueOnce(APPLIED);
    render(<ImportControl />);
    await pick();
    await userEvent.click(await screen.findByRole('button', { name: 'Import 4 items' }));
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('Import complete: 3 items added, 1 updated, 1 item skipped.'),
    );
    expect(importExportZip).toHaveBeenCalledTimes(2);
    expect(importExportZip.mock.calls[1][1]).toMatchObject({ dryRun: false });
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Import \d/ })).not.toBeInTheDocument();
  });

  it.each([
    [1, '1 imported folder needs confirming on the Folders page before Burrow reads it.'],
    [3, '3 imported folders need confirming on the Folders page before Burrow reads them.'],
  ])('tells the user %i imported folder(s) wait for confirmation', async (n, text) => {
    importExportZip.mockResolvedValueOnce(PREVIEW).mockResolvedValueOnce({ ...APPLIED, foldersToConfirm: n });
    render(<ImportControl />);
    await pick();
    expect(screen.queryByText(/imported folder/)).not.toBeInTheDocument();
    await userEvent.click(await screen.findByRole('button', { name: 'Import 4 items' }));
    expect(await screen.findByText(text)).toBeInTheDocument();
  });

  it('shows no folder line when nothing needs confirming', async () => {
    importExportZip.mockResolvedValueOnce(PREVIEW).mockResolvedValueOnce({ ...APPLIED, foldersToConfirm: 0 });
    render(<ImportControl />);
    await pick();
    await userEvent.click(await screen.findByRole('button', { name: 'Import 4 items' }));
    await screen.findAllByText(/Import complete/);
    expect(screen.queryByText(/imported folder/)).not.toBeInTheDocument();
  });

  it('cancel discards the preview without importing', async () => {
    importExportZip.mockResolvedValue(PREVIEW);
    render(<ImportControl />);
    await pick();
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(importExportZip).toHaveBeenCalledTimes(1);
  });

  it('shows an alert and no confirm button when the preview fails', async () => {
    importExportZip.mockRejectedValue(new Error('The file is not a valid export archive.'));
    render(<ImportControl />);
    await pick();
    expect(await screen.findByRole('alert')).toHaveTextContent('The file is not a valid export archive.');
    expect(screen.queryByRole('button', { name: /^Import \d/ })).not.toBeInTheDocument();
  });

  it('keeps the preview and shows an alert when the confirmed import fails', async () => {
    importExportZip.mockResolvedValueOnce(PREVIEW).mockRejectedValueOnce(new Error('Import failed. Try again.'));
    render(<ImportControl />);
    await pick();
    await userEvent.click(await screen.findByRole('button', { name: 'Import 4 items' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Import failed. Try again.');
    expect(screen.getByRole('button', { name: 'Import 4 items' })).toBeInTheDocument();
  });

  it('offers no confirm button for an empty file', async () => {
    importExportZip.mockResolvedValue({
      dryRun: true,
      tables: [],
      totals: { received: 0, inserted: 0, updated: 0, skipped: 0 },
    });
    render(<ImportControl />);
    await pick();
    expect(await screen.findByText('This file has nothing to import.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Import \d/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });

  it('offers no confirm button when every row would be skipped', async () => {
    importExportZip.mockResolvedValue({
      dryRun: true,
      tables: [{ id: 'notes', received: 2, inserted: 0, updated: 0, skipped: 2 }],
      totals: { received: 2, inserted: 0, updated: 0, skipped: 2 },
    });
    render(<ImportControl />);
    await pick();
    await screen.findByRole('table');
    expect(screen.queryByRole('button', { name: /^Import \d/ })).not.toBeInTheDocument();
  });
});
