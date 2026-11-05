import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, configure, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import BackupHealthNotice from '../BackupHealthNotice';
import { BACKUP_STATUS_KEY } from '../../../hooks/useBackups';
import { dismissAutoReminder, getBackupStatus } from '../../../services/backupService';

// Full-suite runs share the CPU with the backend project; the 1 s default is too tight.
configure({ asyncUtilTimeout: 5000 });

vi.mock('../../../services/backupService', () => ({ getBackupStatus: vi.fn(), dismissAutoReminder: vi.fn() }));

function renderNotice() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <BackupHealthNotice />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { client, ...view };
}

const queryStatus = (client) => client.getQueryState(BACKUP_STATUS_KEY)?.status;
const flush = () => act(async () => {});

// Braces matter: Vitest runs a function returned from beforeEach as teardown, and mockReset() returns the
// mock itself, so an arrow without braces would call getBackupStatus() again after each test.
beforeEach(() => {
  getBackupStatus.mockReset();
  dismissAutoReminder.mockReset();
  dismissAutoReminder.mockResolvedValue({});
});
afterEach(cleanup);

describe('BackupHealthNotice', () => {
  it('renders nothing before the status loads and when backups are healthy', async () => {
    getBackupStatus.mockResolvedValue({ health: 'ok', lastSuccessAt: new Date().toISOString(), diskWarning: false });
    const { client, container } = renderNotice();
    expect(container).toBeEmptyDOMElement();
    await waitFor(() => expect(queryStatus(client)).toBe('success'));
    await flush();
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when the status request fails', async () => {
    getBackupStatus.mockRejectedValue(new Error('Server is down'));
    const { client, container } = renderNotice();
    await waitFor(() => expect(queryStatus(client)).toBe('error'));
    await flush();
    expect(container).toBeEmptyDOMElement();
  });

  it('warns when the last backup is old, with a link to the settings', async () => {
    const fourDaysAgo = new Date(Date.now() - 4.5 * 24 * 60 * 60 * 1000).toISOString();
    getBackupStatus.mockResolvedValue({ health: 'stale', lastSuccessAt: fourDaysAgo, autoEnabled: true });
    renderNotice();
    const notice = await screen.findByRole('complementary', { name: 'Backup reminder' });
    expect(notice).toHaveTextContent('Last backup was 4 days ago.');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open backup settings' })).toHaveAttribute('href', '/settings#data-storage');
  });

  it('warns when backups are failing and Burrow will retry', async () => {
    getBackupStatus.mockResolvedValue({ health: 'failing', lastError: 'disk_full', autoEnabled: true });
    renderNotice();
    expect(await screen.findByRole('complementary', { name: 'Backup reminder' })).toHaveTextContent(
      'The last backup did not finish. Burrow will try again. Free up some disk space.',
    );
  });

  it('does not promise a retry when automatic backups are off', async () => {
    getBackupStatus.mockResolvedValue({ health: 'failing', lastError: 'backup_failed', autoEnabled: false });
    renderNotice();
    const notice = await screen.findByRole('complementary', { name: 'Backup reminder' });
    expect(notice).toHaveTextContent('The last backup did not finish. Try backing up again.');
    expect(notice).not.toHaveTextContent(/will try again/);
  });

  it('uses gentle wording when there is no backup yet and automatic backups are on', async () => {
    getBackupStatus.mockResolvedValue({ health: 'none', autoEnabled: true });
    renderNotice();
    expect(await screen.findByRole('complementary', { name: 'Backup reminder' })).toHaveTextContent(
      "Burrow hasn't made a backup yet. It will make one soon.",
    );
  });

  it('points to Settings when there is no backup yet and automatic backups are off', async () => {
    getBackupStatus.mockResolvedValue({ health: 'none', autoEnabled: false });
    renderNotice();
    const notice = await screen.findByRole('complementary', { name: 'Backup reminder' });
    expect(notice).toHaveTextContent("Burrow hasn't made a backup yet. You can make one in Settings.");
    expect(notice).not.toHaveTextContent(/It will make one soon/);
  });

  it('tells the user to restart Burrow when a failed rollback still needs recovery', async () => {
    getBackupStatus.mockResolvedValue({ health: 'failing', recoveryRequired: true, autoEnabled: true });
    renderNotice();
    const notice = await screen.findByRole('complementary', { name: 'Backup reminder' });
    expect(notice).toHaveTextContent(
      'Burrow could not finish undoing the restore. Your data is safe. Restart Burrow to finish recovering it.',
    );
    expect(notice).not.toHaveTextContent(/will try again/);
  });

  it('shows a disk reminder even when the last backup is fine', async () => {
    getBackupStatus.mockResolvedValue({
      health: 'ok',
      lastSuccessAt: new Date().toISOString(),
      diskWarning: true,
      autoEnabled: true,
    });
    renderNotice();
    const notice = await screen.findByRole('complementary', { name: 'Backup reminder' });
    expect(notice).toHaveTextContent('Disk space is low. Free up some disk space.');
    expect(notice).not.toHaveTextContent(/Last backup/);
  });

  describe('automatic backups switched off', () => {
    const daysBack = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
    const off = (extra) => ({ autoSwitch: false, autoEnabled: false, ...extra });

    it('shows a gentle reminder with the age of the last backup when the server says it is due', async () => {
      getBackupStatus.mockResolvedValue(
        off({ health: 'stale', lastSuccessAt: daysBack(9.5), autoOffReminder: true }),
      );
      renderNotice();
      const notice = await screen.findByRole('complementary', { name: 'Backup reminder' });
      expect(notice).toHaveTextContent('Automatic backups are off. Last backup: 9 days ago.');
      expect(notice).not.toHaveTextContent(/did not finish|will try again/);
      expect(screen.getByRole('link', { name: 'Open backup settings' })).toHaveAttribute('href', '/settings#data-storage');
    });

    it('says there are no backups yet when there is none', async () => {
      getBackupStatus.mockResolvedValue(off({ health: 'none', autoOffReminder: true }));
      renderNotice();
      expect(await screen.findByRole('complementary', { name: 'Backup reminder' })).toHaveTextContent(
        'Automatic backups are off. No backups yet.',
      );
    });

    it('stays quiet when the server says it is not due (recent backup or dismissed this week)', async () => {
      getBackupStatus.mockResolvedValue(off({ health: 'stale', lastSuccessAt: daysBack(5), autoOffReminder: false }));
      const { client, container } = renderNotice();
      await waitFor(() => expect(queryStatus(client)).toBe('success'));
      await flush();
      expect(container).toBeEmptyDOMElement();
    });

    it('dismisses on the server and hides at once', async () => {
      const user = userEvent.setup();
      getBackupStatus
        .mockResolvedValueOnce(off({ health: 'none', autoOffReminder: true }))
        .mockResolvedValue(off({ health: 'none', autoOffReminder: false }));
      renderNotice();
      await screen.findByRole('complementary', { name: 'Backup reminder' });
      await user.click(screen.getByRole('button', { name: 'Dismiss backup reminder' }));
      expect(screen.queryByRole('complementary', { name: 'Backup reminder' })).not.toBeInTheDocument();
      expect(dismissAutoReminder).toHaveBeenCalledTimes(1);
    });

    it('moves focus to a stable target and says the reminder was dismissed', async () => {
      const user = userEvent.setup();
      getBackupStatus
        .mockResolvedValueOnce(off({ health: 'none', autoOffReminder: true }))
        .mockResolvedValue(off({ health: 'none', autoOffReminder: false }));
      renderNotice();
      await screen.findByRole('complementary', { name: 'Backup reminder' });
      await user.click(screen.getByRole('button', { name: 'Dismiss backup reminder' }));
      await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Reminder dismissed.'));
      expect(document.activeElement).not.toBe(document.body);
      expect(document.activeElement).toBe(screen.getByRole('status'));
    });

    it('brings the reminder back when saving the dismissal fails', async () => {
      const user = userEvent.setup();
      dismissAutoReminder.mockRejectedValue(new Error('nope'));
      getBackupStatus.mockResolvedValue(off({ health: 'none', autoOffReminder: true }));
      renderNotice();
      await screen.findByRole('complementary', { name: 'Backup reminder' });
      await user.click(screen.getByRole('button', { name: 'Dismiss backup reminder' }));
      expect(await screen.findByRole('complementary', { name: 'Backup reminder' })).toBeInTheDocument();
      expect(screen.getByRole('status')).toHaveTextContent('');
    });

    it('shows the reminder again when the server says so after a dismissal (off, dismissed, on, off again)', async () => {
      const user = userEvent.setup();
      getBackupStatus
        .mockResolvedValueOnce(off({ health: 'none', autoOffReminder: true }))
        .mockResolvedValueOnce(off({ health: 'none', autoOffReminder: false }))
        .mockResolvedValue(off({ health: 'none', autoOffReminder: true }));
      const { client } = renderNotice();
      await screen.findByRole('complementary', { name: 'Backup reminder' });
      await user.click(screen.getByRole('button', { name: 'Dismiss backup reminder' }));
      await waitFor(() => expect(screen.queryByRole('complementary', { name: 'Backup reminder' })).not.toBeInTheDocument());
      await act(() => client.invalidateQueries({ queryKey: BACKUP_STATUS_KEY }));
      expect(await screen.findByRole('complementary', { name: 'Backup reminder' })).toBeInTheDocument();
    });

    it('keeps failure reminders, which cannot be dismissed', async () => {
      getBackupStatus.mockResolvedValue(
        off({ health: 'failing', lastError: 'backup_failed', autoOffReminder: true }),
      );
      renderNotice();
      const notice = await screen.findByRole('complementary', { name: 'Backup reminder' });
      expect(notice).toHaveTextContent('The last backup did not finish. Try backing up again.');
      expect(screen.queryByRole('button', { name: /dismiss/i })).not.toBeInTheDocument();
    });

    it('still warns about low disk space', async () => {
      getBackupStatus.mockResolvedValue(
        off({ health: 'stale', lastSuccessAt: daysBack(9), diskWarning: true, autoOffReminder: true }),
      );
      renderNotice();
      const notice = await screen.findByRole('complementary', { name: 'Backup reminder' });
      expect(notice).toHaveTextContent('Disk space is low. Free up some disk space.');
      expect(screen.queryByRole('button', { name: /dismiss/i })).not.toBeInTheDocument();
    });

    it('does not remind while automatic backups are on', async () => {
      getBackupStatus.mockResolvedValue({ health: 'ok', lastSuccessAt: daysBack(1), autoSwitch: true, autoOffReminder: false });
      const { client, container } = renderNotice();
      await waitFor(() => expect(queryStatus(client)).toBe('success'));
      await flush();
      expect(container).toBeEmptyDOMElement();
    });
  });
});
