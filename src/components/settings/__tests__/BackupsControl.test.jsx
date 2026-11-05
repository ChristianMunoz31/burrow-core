import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import BackupsControl from '../BackupsControl';
import * as service from '../../../services/backupService';
import { allowSlowSuite } from '../../../test-utils/slowSuite';

vi.mock('../../../services/backupService', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    BACKUP_UPLOAD_MAX_BYTES: actual.BACKUP_UPLOAD_MAX_BYTES,
    BACKUP_TOO_LARGE_MESSAGE: actual.BACKUP_TOO_LARGE_MESSAGE,
    listBackups: vi.fn(),
    getBackupStatus: vi.fn(),
    createBackup: vi.fn(),
    updateBackupSettings: vi.fn(),
    setAutoBackup: vi.fn(),
    uploadBackupFile: vi.fn(),
    restoreBackup: vi.fn(),
  };
});

// Full-suite runs share the CPU with the backend project; the 1 s default is too tight for userEvent flows.
configure({ asyncUtilTimeout: 5000 });

const iso = (daysBack, hour, minute = 0) => {
  const d = new Date();
  d.setDate(d.getDate() - daysBack);
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
};

const BACKUPS = [
  { id: 'b1', kind: 'auto', createdAt: iso(0, 9), status: 'verified', sizeBytes: 4_400_000, pinned: false },
  { id: 'b2', kind: 'safety', createdAt: iso(1, 21, 15), status: 'verified', sizeBytes: 2048, pinned: true },
  { id: 'b3', kind: 'auto', createdAt: iso(2, 8), status: 'failed', error: 'integrity_failed', sizeBytes: 0, pinned: false },
];
const LIST = (overrides = {}) => ({
  backups: BACKUPS,
  status: { health: 'ok', lastSuccessAt: BACKUPS[0].createdAt, diskWarning: false },
  settings: { keepDaily: 7, keepWeekly: 4, keepMonthly: 6 },
  location: 'C:\\Burrow\\backups',
  desktop: true,
  ...overrides,
});

function renderControl(props = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onRestored = vi.fn();
  const view = render(
    <QueryClientProvider client={client}>
      <BackupsControl onRestored={onRestored} {...props} />
    </QueryClientProvider>,
  );
  return { onRestored, client, ...view };
}

beforeEach(() => {
  for (const fn of Object.values(service)) if (vi.isMockFunction(fn)) fn.mockReset();
  service.listBackups.mockResolvedValue(LIST());
});
afterEach(cleanup);

// Heavy render-and-wait suite: raise the time limits so a busy machine does not trip them.
allowSlowSuite();

describe('BackupsControl', () => {
  it('shows the status line and a friendly list with checks and safety copy', async () => {
    renderControl();
    const table = await screen.findByRole('table', { name: 'Your backups, newest first' });
    expect(screen.getByText(/Last backup: today 9:00, verified\./)).toBeInTheDocument();
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(3);
    expect(within(rows[0]).getByText('today 9:00')).toBeInTheDocument();
    expect(within(rows[0]).getByText('4.2 MB')).toBeInTheDocument();
    expect(within(rows[0]).getByText('Verified')).toBeInTheDocument();
    expect(within(rows[1]).getByText('yesterday 21:15')).toBeInTheDocument();
    expect(within(rows[1]).getByText('Safety copy')).toBeInTheDocument();
    expect(within(rows[2]).getByText('Failed')).toBeInTheDocument();
    expect(within(rows[2]).queryByRole('button')).not.toBeInTheDocument();
    expect(within(rows[2]).getByText("Can't be restored")).toBeInTheDocument();
    expect(within(table).getByRole('columnheader', { name: 'Status' })).toBeInTheDocument();
  });

  it('avoids technical words in visible text', async () => {
    renderControl();
    await screen.findByRole('table');
    expect(screen.queryByText(/database|sqlite/i)).not.toBeInTheDocument();
  });

  it('backs up now with a busy button, then confirms', async () => {
    const user = userEvent.setup();
    let finish;
    service.createBackup.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    renderControl();
    await screen.findByRole('table');
    await user.click(screen.getByRole('button', { name: 'Back up now' }));
    expect(screen.getByRole('button', { name: 'Backing up…' })).toHaveAttribute('aria-busy', 'true');
    await user.click(screen.getByRole('button', { name: 'Backing up…' }));
    expect(service.createBackup).toHaveBeenCalledTimes(1);
    finish({ id: 'new' });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Back up now' })).toHaveAttribute('aria-busy', 'false'));
    expect(screen.getAllByRole('status').some((el) => el.textContent === 'Backup saved.')).toBe(true);
    expect(service.listBackups.mock.calls.length).toBeGreaterThan(1);
  });

  it('shows the server message when a backup fails', async () => {
    const user = userEvent.setup();
    service.createBackup.mockRejectedValue(new Error('Not enough free disk space for a backup.'));
    renderControl();
    await screen.findByRole('table');
    await user.click(screen.getByRole('button', { name: 'Back up now' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Not enough free disk space for a backup.');
  });

  it('confirms before restoring a listed backup, cancels with Escape and returns focus', async () => {
    const user = userEvent.setup();
    renderControl();
    await screen.findByRole('table');
    const trigger = screen.getByRole('button', { name: 'Restore backup from today 9:00' });
    await user.click(trigger);
    const group = screen.getByRole('group', { name: 'Confirm restore' });
    expect(group).toHaveAccessibleDescription(
      'Restore the backup from today 9:00? Burrow saves a safety copy of your current data first, then reloads.',
    );
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('group', { name: 'Confirm restore' })).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(service.restoreBackup).not.toHaveBeenCalled();
  });

  it('restores a listed backup and calls onRestored', async () => {
    const user = userEvent.setup();
    service.restoreBackup.mockResolvedValue({ restoredFrom: 'b2' });
    const { onRestored } = renderControl();
    await screen.findByRole('table');
    await user.click(screen.getByRole('button', { name: 'Restore backup from yesterday 21:15' }));
    await user.click(screen.getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(onRestored).toHaveBeenCalledTimes(1));
    expect(service.restoreBackup).toHaveBeenCalledWith({ id: 'b2' });
  });

  it('saves retention settings after checking the bounds', async () => {
    const user = userEvent.setup();
    service.updateBackupSettings.mockResolvedValue({});
    renderControl();
    await screen.findByRole('table');
    const daily = screen.getByLabelText('Days to keep');
    await user.clear(daily);
    await user.type(daily, '0');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Days to keep must be a whole number from 1 to 60.');
    expect(daily).toHaveAttribute('aria-invalid', 'true');
    expect(daily).toHaveFocus();
    expect(screen.getByLabelText('Weeks to keep')).not.toHaveAttribute('aria-invalid');
    expect(service.updateBackupSettings).not.toHaveBeenCalled();
    await user.clear(daily);
    await user.type(daily, '10');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(service.updateBackupSettings).toHaveBeenCalledWith({ keepDaily: 10, keepWeekly: 4, keepMonthly: 6 }),
    );
    expect(await screen.findByText('Saved.')).toBeInTheDocument();
  });

  it('uploads a file, shows the summary, then asks for confirmation', async () => {
    const user = userEvent.setup();
    service.uploadBackupFile.mockImplementation(async (_file, { onProgress }) => {
      onProgress(0.5);
      return {
        uploadToken: 'tok',
        bytes: 3_000_000,
        totalRows: 120,
        migrationNeeded: true,
        schemaVersion: 2,
        appSchemaVersion: 3,
        rowCounts: {},
      };
    });
    service.restoreBackup.mockResolvedValue({});
    const { onRestored } = renderControl();
    await screen.findByRole('table');
    const input = screen.getByLabelText('Restore from a file');
    expect(input).toHaveAttribute('accept', '.db');
    await user.upload(input, new File([new Uint8Array(4)], 'burrow.db'));
    expect(await screen.findByText(/This backup file has 120 items \(2\.9 MB\)\. It was made by an older version/)).toBeInTheDocument();
    // No separate "Choose a different file": the file input stays enabled and picking again replaces the file.
    expect(screen.queryByRole('button', { name: 'Choose a different file' })).not.toBeInTheDocument();
    expect(input).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Restore this file' }));
    expect(screen.getByRole('group', { name: 'Confirm restore' })).toHaveAccessibleDescription(
      'Restore this backup file? Burrow saves a safety copy of your current data first, then reloads.',
    );
    await user.click(screen.getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(onRestored).toHaveBeenCalled());
    expect(service.restoreBackup).toHaveBeenCalledWith({ uploadToken: 'tok' });
  });

  it('says when the file already matches this version', async () => {
    const user = userEvent.setup();
    service.uploadBackupFile.mockResolvedValue({ uploadToken: 't', bytes: 10, totalRows: 1, migrationNeeded: false });
    renderControl();
    await screen.findByRole('table');
    await user.upload(screen.getByLabelText('Restore from a file'), new File([new Uint8Array(1)], 'a.db'));
    expect(await screen.findByText(/This backup file has 1 item .*It matches this version of Burrow\./)).toBeInTheDocument();
  });

  it('shows the server message for a backup that is too new', async () => {
    const user = userEvent.setup();
    const message = 'This backup was made by a newer version of Burrow. Update Burrow, then try again.';
    service.uploadBackupFile.mockRejectedValue(Object.assign(new Error(message), { code: 'backup_too_new' }));
    renderControl();
    await screen.findByRole('table');
    await user.upload(screen.getByLabelText('Restore from a file'), new File([new Uint8Array(1)], 'a.db'));
    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    expect(screen.queryByRole('button', { name: 'Restore this file' })).not.toBeInTheDocument();
  });

  it('shows where backups are kept as selectable text and mentions the Help menu on desktop', async () => {
    renderControl();
    await screen.findByRole('table');
    const path = screen.getByText(String.raw`C:\Burrow\backups`);
    expect(path.tagName).toBe('CODE');
    expect(path).toHaveClass('select-all');
    expect(screen.getByText('You can also open it from the Help menu: Open data folder.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy path' })).not.toBeInTheDocument();
  });

  it('hides the Help menu hint outside the desktop app', async () => {
    service.listBackups.mockResolvedValue(LIST({ desktop: false }));
    renderControl();
    await screen.findByRole('table');
    expect(screen.queryByText(/Help menu/)).not.toBeInTheDocument();
  });

  it('shows a plain message when the list cannot load', async () => {
    service.listBackups.mockRejectedValue(new Error("Couldn't reach the server. Check your connection and try again."));
    renderControl();
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't reach the server");
  });

  it('shows the empty and failing status lines', async () => {
    service.listBackups.mockResolvedValue(
      LIST({ backups: [], status: { health: 'failing', lastError: 'disk_low', diskWarning: true } }),
    );
    renderControl();
    expect(
      await screen.findByText(
        'The last backup did not finish. Burrow will try again. Disk space is low. Free up some disk space.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('shows a Try again button when the list cannot load and reloads on click', async () => {
    const user = userEvent.setup();
    service.listBackups.mockRejectedValueOnce(new Error("Couldn't reach the server. Check your connection and try again."));
    renderControl();
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't reach the server");
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('table')).toBeInTheDocument();
    expect(service.listBackups).toHaveBeenCalledTimes(2);
  });

  it('does not claim automatic backups when they are off', async () => {
    service.listBackups.mockResolvedValue(
      LIST({
        status: { health: 'failing', lastError: 'backup_failed', diskWarning: false, autoSwitch: false, autoEnabled: false },
      }),
    );
    renderControl();
    expect(await screen.findByText(/Automatic backups are off\. Use Back up now/)).toBeInTheDocument();
    expect(screen.getByText('The last backup did not finish. Try backing up again.')).toBeInTheDocument();
    expect(screen.queryByText(/about once a day|will try again|paused/)).not.toBeInTheDocument();
  });

  it('says the switch is on but paused in this build when the scheduler is globally off (dev and sandbox only)', async () => {
    service.listBackups.mockResolvedValue(
      LIST({
        status: { health: 'stale', lastSuccessAt: iso(5, 9), diskWarning: false, autoSwitch: true, autoEnabled: false },
      }),
    );
    renderControl();
    const toggle = await screen.findByRole('switch', { name: 'Automatic backups' });
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    expect(toggle).toHaveAccessibleDescription('On (paused in this build).');
    expect(screen.queryByText(/Automatic backups are off/)).not.toBeInTheDocument();
    expect(screen.queryByText(/BURROW_SCHEDULER/)).not.toBeInTheDocument();
  });

  it('keeps the plain on description when the switch is on and the scheduler runs', async () => {
    service.listBackups.mockResolvedValue(
      LIST({
        status: { health: 'ok', lastSuccessAt: iso(1, 9), diskWarning: false, autoSwitch: true, autoEnabled: true },
      }),
    );
    renderControl();
    const toggle = await screen.findByRole('switch', { name: 'Automatic backups' });
    expect(toggle).toHaveAccessibleDescription('On. Burrow makes a backup about once a day.');
    expect(screen.queryByText(/paused in this build/)).not.toBeInTheDocument();
  });

  it('says saved keys are not part of backups', async () => {
    renderControl();
    await screen.findByRole('table');
    expect(
      screen.getByText('Saved keys are not included in backups for your safety. Re-enter them after moving to a new computer.'),
    ).toBeInTheDocument();
  });

  it('shows the low disk sentence in the warning tone', async () => {
    service.listBackups.mockResolvedValue(
      LIST({ status: { health: 'ok', lastSuccessAt: BACKUPS[0].createdAt, diskWarning: true } }),
    );
    renderControl();
    const line = await screen.findByText(/Disk space is low\. Free up some disk space\./);
    expect(line).toHaveClass('text-accent-amber');
  });

  describe('uploads', () => {
    const pickFile = async (user, name = 'burrow.db') =>
      user.upload(screen.getByLabelText('Restore from a file'), new File([new Uint8Array(4)], name));
    const CHECKED = { uploadToken: 'tok', bytes: 1000, totalRows: 3, migrationNeeded: false };

    it('resets, keeps the message and focuses the file input when the upload expired (410)', async () => {
      const user = userEvent.setup();
      service.uploadBackupFile.mockResolvedValue(CHECKED);
      service.restoreBackup.mockRejectedValue(
        Object.assign(new Error('That file check expired. Choose the file again.'), {
          status: 410,
          code: 'upload_expired',
        }),
      );
      renderControl();
      await screen.findByRole('table');
      await pickFile(user);
      await user.click(await screen.findByRole('button', { name: 'Restore this file' }));
      await user.click(screen.getByRole('button', { name: 'Restore' }));
      expect(await screen.findByRole('alert')).toHaveTextContent('That file check expired. Choose the file again.');
      expect(screen.queryByRole('button', { name: 'Restore this file' })).not.toBeInTheDocument();
      expect(screen.queryByRole('group', { name: 'Confirm restore' })).not.toBeInTheDocument();
      await waitFor(() => expect(screen.getByLabelText('Restore from a file')).toHaveFocus());
      expect(screen.getByLabelText('Restore from a file')).not.toBeDisabled();
    });

    it('drops the summary when the checked upload runs out of time', async () => {
      vi.useFakeTimers();
      try {
        service.uploadBackupFile.mockResolvedValue({
          ...CHECKED,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        });
        renderControl();
        await act(async () => {
          await vi.advanceTimersByTimeAsync(0);
        });
        fireEvent.change(screen.getByLabelText('Restore from a file'), {
          target: { files: [new File([new Uint8Array(4)], 'burrow.db')] },
        });
        await act(async () => {
          await vi.advanceTimersByTimeAsync(0);
        });
        expect(screen.getByRole('button', { name: 'Restore this file' })).toBeInTheDocument();
        await act(async () => {
          await vi.advanceTimersByTimeAsync(59_000);
        });
        expect(screen.getByRole('button', { name: 'Restore this file' })).toBeInTheDocument();
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1_000);
        });
        expect(screen.queryByRole('button', { name: 'Restore this file' })).not.toBeInTheDocument();
        expect(screen.getByRole('alert')).toHaveTextContent('That file check expired. Choose the file again.');
      } finally {
        vi.useRealTimers();
      }
    });

    it('cancels an upload in progress and focuses the file input', async () => {
      const user = userEvent.setup();
      let signal;
      service.uploadBackupFile.mockImplementation(
        (_file, opts) =>
          new Promise((_resolve, reject) => {
            signal = opts.signal;
            opts.signal.addEventListener('abort', () =>
              reject(Object.assign(new Error('Cancelled'), { name: 'AbortError' })),
            );
          }),
      );
      renderControl();
      await screen.findByRole('table');
      await pickFile(user);
      await user.click(await screen.findByRole('button', { name: 'Cancel upload' }));
      expect(signal.aborted).toBe(true);
      expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      await waitFor(() => expect(screen.getByLabelText('Restore from a file')).toHaveFocus());
    });

    it('aborts a running upload when the component unmounts', async () => {
      const user = userEvent.setup();
      let signal;
      service.uploadBackupFile.mockImplementation((_file, opts) => {
        signal = opts.signal;
        return new Promise(() => {});
      });
      const { unmount } = renderControl();
      await screen.findByRole('table');
      await pickFile(user);
      await screen.findByRole('button', { name: 'Cancel upload' });
      expect(signal.aborted).toBe(false);
      unmount();
      expect(signal.aborted).toBe(true);
    });

    it('refuses a file over the size limit without uploading it', async () => {
      const user = userEvent.setup();
      renderControl();
      await screen.findByRole('table');
      const big = new File([new Uint8Array(1)], 'huge.db');
      Object.defineProperty(big, 'size', { value: 1024 * 1024 * 1024 + 1 });
      await user.upload(screen.getByLabelText('Restore from a file'), big);
      expect(await screen.findByRole('alert')).toHaveTextContent('This backup file is too large to restore here.');
      expect(service.uploadBackupFile).not.toHaveBeenCalled();
    });

    it('returns focus to "Restore this file" after cancelling the upload confirm', async () => {
      const user = userEvent.setup();
      service.uploadBackupFile.mockResolvedValue(CHECKED);
      renderControl();
      await screen.findByRole('table');
      await pickFile(user);
      await user.click(await screen.findByRole('button', { name: 'Restore this file' }));
      await user.click(screen.getByRole('button', { name: 'Cancel' }));
      await waitFor(() => expect(screen.getByRole('button', { name: 'Restore this file' })).toHaveFocus());
    });
  });

  it('blocks other actions while a restore is running and keeps its confirm mounted', async () => {
    const user = userEvent.setup();
    service.restoreBackup.mockReturnValue(new Promise(() => {}));
    renderControl();
    await screen.findByRole('table');
    await user.click(screen.getByRole('button', { name: 'Restore backup from yesterday 21:15' }));
    await user.click(screen.getByRole('button', { name: 'Restore' }));
    expect(service.restoreBackup).toHaveBeenCalledTimes(1);

    const otherRow = screen.getByRole('button', { name: 'Restore backup from today 9:00' });
    const backUp = screen.getByRole('button', { name: 'Back up now' });
    const save = screen.getByRole('button', { name: 'Save' });
    for (const control of [otherRow, backUp, save]) expect(control).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByLabelText('Restore from a file')).toBeDisabled();

    await user.click(otherRow);
    await user.click(backUp);
    await user.click(save);
    expect(service.createBackup).not.toHaveBeenCalled();
    expect(service.updateBackupSettings).not.toHaveBeenCalled();
    const groups = screen.getAllByRole('group', { name: 'Confirm restore' });
    expect(groups).toHaveLength(1);
    expect(within(groups[0]).getByRole('button', { name: 'Restoring…' })).toBeInTheDocument();
    expect(service.restoreBackup).toHaveBeenCalledWith({ id: 'b2' });
  });

  describe('automatic backups switch', () => {
    const WARNING = 'Turning off automatic backups means a problem with your computer could lose your data';
    const statusWith = (autoSwitch) => ({
      health: 'ok',
      lastSuccessAt: BACKUPS[0].createdAt,
      diskWarning: false,
      autoSwitch,
      autoEnabled: autoSwitch,
    });
    const onList = () => LIST({ status: statusWith(true) });
    const offList = () => LIST({ status: statusWith(false) });
    const CONFIRM = 'Confirm turning off automatic backups';

    const WARN_LIVE = 'auto-off-warning-live';

    it('is a labelled switch that is on by default (also when the server does not say)', async () => {
      renderControl();
      const toggle = await screen.findByRole('switch', { name: 'Automatic backups' });
      expect(toggle).toHaveAttribute('aria-checked', 'true');
      expect(toggle.tagName).toBe('BUTTON');
    });

    it('asks first when turning off: warning shown, Cancel keeps it on and returns focus', async () => {
      const user = userEvent.setup();
      service.listBackups.mockResolvedValue(onList());
      renderControl();
      const toggle = await screen.findByRole('switch', { name: 'Automatic backups' });
      await user.click(toggle);
      const group = screen.getByRole('group', { name: CONFIRM });
      expect(group).toHaveTextContent(WARNING);
      expect(group).toHaveAccessibleDescription(`${WARNING}.`);
      expect(within(group).getByRole('button', { name: 'Cancel' })).toHaveFocus();
      expect(service.setAutoBackup).not.toHaveBeenCalled();
      await user.click(within(group).getByRole('button', { name: 'Cancel' }));
      expect(screen.queryByRole('group', { name: CONFIRM })).not.toBeInTheDocument();
      expect(toggle).toHaveAttribute('aria-checked', 'true');
      await waitFor(() => expect(toggle).toHaveFocus());
      expect(service.setAutoBackup).not.toHaveBeenCalled();
    });

    it('Escape cancels the confirmation and returns focus to the switch', async () => {
      const user = userEvent.setup();
      renderControl();
      const toggle = await screen.findByRole('switch', { name: 'Automatic backups' });
      await user.click(toggle);
      await user.keyboard('{Escape}');
      expect(screen.queryByRole('group', { name: CONFIRM })).not.toBeInTheDocument();
      expect(service.setAutoBackup).not.toHaveBeenCalled();
      await waitFor(() => expect(toggle).toHaveFocus());
    });

    it('Escape also works when focus is back on the switch while the confirmation is open', async () => {
      const user = userEvent.setup();
      renderControl();
      const toggle = await screen.findByRole('switch', { name: 'Automatic backups' });
      await user.click(toggle);
      toggle.focus();
      await user.keyboard('{Escape}');
      expect(screen.queryByRole('group', { name: CONFIRM })).not.toBeInTheDocument();
    });

    it('announces the warning in a polite live region when the confirmation opens', async () => {
      const user = userEvent.setup();
      renderControl();
      const toggle = await screen.findByRole('switch', { name: 'Automatic backups' });
      const live = screen.getByTestId(WARN_LIVE);
      expect(live).toHaveAttribute('aria-live', 'polite');
      expect(live).toHaveTextContent('');
      await user.click(toggle);
      expect(live).toHaveTextContent(WARNING);
    });

    it('says nothing about the switch until the user changes it, then announces each change', async () => {
      const user = userEvent.setup();
      service.listBackups.mockResolvedValueOnce(offList()).mockResolvedValue(onList());
      service.setAutoBackup.mockResolvedValue({});
      renderControl();
      const toggle = await screen.findByRole('switch', { name: 'Automatic backups' });
      const spoken = () => screen.getAllByRole('status').map((el) => el.textContent);
      expect(spoken().some((t) => /Automatic backups are (on|off)\./.test(t))).toBe(false);
      await user.click(toggle);
      await waitFor(() => expect(spoken()).toContain('Automatic backups are on.'));
      await user.click(toggle);
      await user.click(screen.getByRole('button', { name: 'Turn off' }));
      await waitFor(() => expect(spoken()).toContain('Automatic backups are off.'));
    });

    it('a second click on Turn off while saving makes one API call', async () => {
      const user = userEvent.setup();
      let finish;
      service.setAutoBackup.mockReturnValue(new Promise((resolve) => (finish = resolve)));
      renderControl();
      await user.click(await screen.findByRole('switch', { name: 'Automatic backups' }));
      const turnOff = screen.getByRole('button', { name: 'Turn off' });
      await user.dblClick(turnOff);
      expect(service.setAutoBackup).toHaveBeenCalledTimes(1);
      finish({});
      await waitFor(() => expect(screen.queryByRole('group', { name: CONFIRM })).not.toBeInTheDocument());
      expect(service.setAutoBackup).toHaveBeenCalledTimes(1);
    });

    it('returns focus to the switch after a confirmed turn off', async () => {
      const user = userEvent.setup();
      service.listBackups.mockResolvedValueOnce(onList()).mockResolvedValue(offList());
      service.setAutoBackup.mockResolvedValue({});
      renderControl();
      const toggle = await screen.findByRole('switch', { name: 'Automatic backups' });
      await user.click(toggle);
      await user.click(screen.getByRole('button', { name: 'Turn off' }));
      await waitFor(() => expect(screen.queryByRole('group', { name: CONFIRM })).not.toBeInTheDocument());
      await waitFor(() => expect(screen.getByRole('switch', { name: 'Automatic backups' })).toHaveFocus());
    });

    it('stops being busy as soon as the save succeeds, even if the background refresh is slow', async () => {
      const user = userEvent.setup();
      service.listBackups.mockResolvedValueOnce(offList()).mockReturnValue(new Promise(() => {}));
      service.setAutoBackup.mockResolvedValue({});
      renderControl();
      const toggle = await screen.findByRole('switch', { name: 'Automatic backups' });
      await user.click(toggle);
      await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'));
      expect(toggle).not.toHaveAttribute('aria-disabled');
    });

    it('is locked while a restore runs: aria-disabled and no confirmation', async () => {
      const user = userEvent.setup();
      service.listBackups.mockResolvedValue(onList());
      service.restoreBackup.mockReturnValue(new Promise(() => {}));
      renderControl();
      await screen.findByRole('table');
      await user.click(screen.getByRole('button', { name: 'Restore backup from yesterday 21:15' }));
      await user.click(screen.getByRole('button', { name: 'Restore' }));
      const toggle = screen.getByRole('switch', { name: 'Automatic backups' });
      expect(toggle).toHaveAttribute('aria-disabled', 'true');
      await user.click(toggle);
      expect(screen.queryByRole('group', { name: CONFIRM })).not.toBeInTheDocument();
      expect(service.setAutoBackup).not.toHaveBeenCalled();
    });

    it('turns off only after confirming, calls the API and shows the new state', async () => {
      const user = userEvent.setup();
      service.listBackups.mockResolvedValueOnce(onList()).mockResolvedValue(offList());
      service.setAutoBackup.mockResolvedValue({ enabled: false });
      renderControl();
      await user.click(await screen.findByRole('switch', { name: 'Automatic backups' }));
      await user.click(screen.getByRole('button', { name: 'Turn off' }));
      await waitFor(() => expect(service.setAutoBackup).toHaveBeenCalledWith(false));
      await waitFor(() =>
        expect(screen.getByRole('switch', { name: 'Automatic backups' })).toHaveAttribute('aria-checked', 'false'),
      );
      expect(screen.queryByRole('group', { name: CONFIRM })).not.toBeInTheDocument();
      expect(screen.getByText(/Off\. Burrow only backs up when you use Back up now\./)).toBeInTheDocument();
    });

    it('keeps the confirmation open and shows a message when saving fails', async () => {
      const user = userEvent.setup();
      service.setAutoBackup.mockRejectedValue(new Error('nope'));
      renderControl();
      await user.click(await screen.findByRole('switch', { name: 'Automatic backups' }));
      await user.click(screen.getByRole('button', { name: 'Turn off' }));
      expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't save that change. Try again.");
      expect(screen.getByRole('group', { name: CONFIRM })).toBeInTheDocument();
      expect(screen.getByRole('switch', { name: 'Automatic backups' })).toHaveAttribute('aria-checked', 'true');
    });

    it('turning on needs no confirmation', async () => {
      const user = userEvent.setup();
      service.listBackups.mockResolvedValueOnce(offList()).mockResolvedValue(onList());
      service.setAutoBackup.mockResolvedValue({ enabled: true });
      renderControl();
      const toggle = await screen.findByRole('switch', { name: 'Automatic backups' });
      expect(toggle).toHaveAttribute('aria-checked', 'false');
      await user.click(toggle);
      expect(screen.queryByRole('group', { name: CONFIRM })).not.toBeInTheDocument();
      await waitFor(() => expect(service.setAutoBackup).toHaveBeenCalledWith(true));
    });

    it('Back up now stays available while the switch is off', async () => {
      const user = userEvent.setup();
      service.listBackups.mockResolvedValue(offList());
      service.createBackup.mockResolvedValue({ id: 'new' });
      renderControl();
      await screen.findByRole('table');
      await user.click(screen.getByRole('button', { name: 'Back up now' }));
      expect(service.createBackup).toHaveBeenCalledTimes(1);
    });

    it('never suggests the backup folder can be moved', async () => {
      renderControl();
      await screen.findByRole('table');
      expect(screen.queryByText(/(change|move|choose|pick) (the |your |a )?(backup )?(folder|location)/i)).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /change|move|choose (a )?(folder|location)/i })).not.toBeInTheDocument();
    });
  });

  describe('upload expiry follows the server clock', () => {
    const pick = async () => {
      fireEvent.change(screen.getByLabelText('Restore from a file'), {
        target: { files: [new File([new Uint8Array(4)], 'burrow.db')] },
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
    };
    const checked = (serverNow, ttlMs) => ({
      uploadToken: 'tok',
      bytes: 1000,
      totalRows: 3,
      migrationNeeded: false,
      now: new Date(serverNow).toISOString(),
      expiresAt: new Date(serverNow + ttlMs).toISOString(),
    });

    it('keeps the summary until the server deadline even when this computer clock is an hour ahead', async () => {
      vi.useFakeTimers();
      try {
        service.uploadBackupFile.mockResolvedValue(checked(Date.now() - 60 * 60 * 1000, 60_000));
        renderControl();
        await act(async () => {
          await vi.advanceTimersByTimeAsync(0);
        });
        await pick();
        expect(screen.getByRole('button', { name: 'Restore this file' })).toBeInTheDocument();
        expect(screen.getByText(/^This check is good until /)).toBeInTheDocument();
        await act(async () => {
          await vi.advanceTimersByTimeAsync(59_000);
        });
        expect(screen.getByRole('button', { name: 'Restore this file' })).toBeInTheDocument();
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1_000);
        });
        expect(screen.queryByRole('button', { name: 'Restore this file' })).not.toBeInTheDocument();
        expect(screen.getByRole('alert')).toHaveTextContent('That file check expired. Choose the file again.');
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not drop the summary early when this computer clock is behind the server', async () => {
      vi.useFakeTimers();
      try {
        service.uploadBackupFile.mockResolvedValue(checked(Date.now() + 60 * 60 * 1000, 15 * 60_000));
        renderControl();
        await act(async () => {
          await vi.advanceTimersByTimeAsync(0);
        });
        await pick();
        await act(async () => {
          await vi.advanceTimersByTimeAsync(14 * 60_000);
        });
        expect(screen.getByRole('button', { name: 'Restore this file' })).toBeInTheDocument();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
