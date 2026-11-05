import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import DataExportControl from '../DataExportControl';

const downloadExport = vi.hoisted(() => vi.fn());
vi.mock('../../../services/exportService', () => ({ downloadExport }));

afterEach(() => {
  cleanup();
  downloadExport.mockReset();
});

const BUTTON = 'Export all data (.zip)';
const done = (over = {}) => ({ filename: 'a.zip', bytes: 1, complete: true, tooLarge: [], parts: 1, ...over });

describe('DataExportControl', () => {
  it('shows a busy state while exporting, announces it, then announces success', async () => {
    let finish;
    downloadExport.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    render(<DataExportControl />);
    const live = screen.getByRole('status');
    expect(live).toHaveTextContent('');
    await userEvent.click(screen.getByRole('button', { name: BUTTON }));
    expect(screen.getByRole('button', { name: 'Preparing export…' })).toHaveAttribute('aria-busy', 'true');
    expect(live).toHaveTextContent('Preparing export…');
    finish(done());
    await waitFor(() => expect(live).toHaveTextContent('Export ready. Check your downloads.'));
    expect(screen.getByRole('button', { name: BUTTON })).toHaveAttribute('aria-busy', 'false');
    // The visible copy is hidden from assistive tech so it is not read twice.
    expect(screen.getByText('Export ready. Check your downloads.', { selector: 'p[aria-hidden="true"]' })).toBeVisible();
    expect(downloadExport).toHaveBeenCalledTimes(1);
  });

  it('keeps the live region mounted through the whole lifecycle', async () => {
    downloadExport.mockResolvedValue(done());
    render(<DataExportControl />);
    const live = screen.getByRole('status');
    await userEvent.click(screen.getByRole('button', { name: BUTTON }));
    await waitFor(() => expect(live).toHaveTextContent('Export ready'));
    expect(screen.getByRole('status')).toBe(live);
  });

  it('shows the hint without promising anything about notes', () => {
    render(<DataExportControl />);
    expect(screen.getByText(/Saved tokens are never included\./)).toBeInTheDocument();
  });

  it('shows a warning, not success, when the export was incomplete', async () => {
    downloadExport.mockResolvedValue(done({ complete: false, tooLarge: ['transactions'] }));
    render(<DataExportControl />);
    await userEvent.click(screen.getByRole('button', { name: BUTTON }));
    const live = screen.getByRole('status');
    await waitFor(() => expect(live).toHaveTextContent("Some items couldn't be exported. Try again."));
    expect(live).not.toHaveTextContent('Export ready');
  });

  it('tells the user about multiple downloads when the export was split', async () => {
    downloadExport.mockResolvedValue(done({ parts: 3 }));
    render(<DataExportControl />);
    await userEvent.click(screen.getByRole('button', { name: BUTTON }));
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(
        'Export ready: 3 files. Your browser may ask to allow multiple downloads.',
      ),
    );
  });

  it('reports files saved so far plus the reason when the fallback stops partway', async () => {
    downloadExport.mockRejectedValue(
      Object.assign(new Error('Too many exports. Try again in a few minutes.'), { savedParts: 2, totalParts: 5 }),
    );
    render(<DataExportControl />);
    await userEvent.click(screen.getByRole('button', { name: BUTTON }));
    await waitFor(() => {
      const alert = screen.getByRole('alert');
      expect(alert).toHaveTextContent('Saved 2 of 5 files before stopping.');
      expect(alert).toHaveTextContent('Too many exports. Try again in a few minutes.');
    });
  });

  it('shows the error message in an alert and leaves the live region empty', async () => {
    downloadExport.mockRejectedValue(new Error('Too many exports. Try again in a few minutes.'));
    render(<DataExportControl />);
    await userEvent.click(screen.getByRole('button', { name: BUTTON }));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('Too many exports. Try again in a few minutes.'),
    );
    expect(screen.getByRole('status')).toHaveTextContent('');
  });

  it('ignores a second click while an export is running', async () => {
    downloadExport.mockReturnValue(new Promise(() => {}));
    render(<DataExportControl />);
    const button = screen.getByRole('button', { name: BUTTON });
    await userEvent.click(button);
    await userEvent.click(screen.getByRole('button', { name: 'Preparing export…' }));
    expect(downloadExport).toHaveBeenCalledTimes(1);
  });

  it('aborts the export on unmount and does not update state afterwards', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let signal;
    let finish;
    downloadExport.mockImplementation((opts) => {
      signal = opts.signal;
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const { unmount } = render(<DataExportControl />);
    await userEvent.click(screen.getByRole('button', { name: BUTTON }));
    unmount();
    expect(signal.aborted).toBe(true);
    finish(done());
    await Promise.resolve();
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
