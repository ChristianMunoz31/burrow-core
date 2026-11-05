import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import BackupRestoreConfirm from '../BackupRestoreConfirm';
import { restoreBackup } from '../../../services/backupService';
import { getPendingKeys, markDirty } from '../../../utils/syncMode';

// Full-suite runs share the CPU with the backend project; the 1 s default is too tight.
configure({ asyncUtilTimeout: 5000 });

vi.mock('../../../services/backupService', () => ({ restoreBackup: vi.fn() }));

const QUESTION = 'Restore the backup from today 9:00? Burrow saves a safety copy of your current data first, then reloads.';

function setup(props = {}) {
  const client = new QueryClient();
  client.setQueryData(['todos'], [{ id: 1 }]);
  const onCancel = vi.fn();
  const onRestored = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <BackupRestoreConfirm
        source={{ id: 'a' }}
        question={QUESTION}
        onCancel={onCancel}
        onRestored={onRestored}
        {...props}
      />
    </QueryClientProvider>,
  );
  return { client, onCancel, onRestored };
}

beforeEach(() => {
  restoreBackup.mockReset();
  localStorage.clear();
});
afterEach(cleanup);

describe('BackupRestoreConfirm', () => {
  it('asks the question in a labelled group with focus on Cancel', () => {
    setup();
    const group = screen.getByRole('group', { name: 'Confirm restore' });
    expect(group).toHaveAccessibleDescription(QUESTION);
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
  });

  it('cancels with the button and with Escape', async () => {
    const user = userEvent.setup();
    const { onCancel } = setup();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalledTimes(2);
    expect(restoreBackup).not.toHaveBeenCalled();
  });

  it('restores, clears pending sync keys and the query cache, then calls onRestored', async () => {
    const user = userEvent.setup();
    markDirty('burrow.test.pending');
    expect(getPendingKeys()).toContain('burrow.test.pending');
    restoreBackup.mockResolvedValue({ restoredFrom: 'a' });
    const { client, onRestored } = setup();
    await user.click(screen.getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(onRestored).toHaveBeenCalledTimes(1));
    expect(restoreBackup).toHaveBeenCalledWith({ id: 'a' });
    expect(getPendingKeys()).toEqual([]);
    expect(client.getQueryData(['todos'])).toBeUndefined();
    expect(screen.getByRole('status')).toHaveTextContent('Restored. Reloading Burrow.');
  });

  it('marks the button busy while running and ignores a second click', async () => {
    const user = userEvent.setup();
    let finish;
    restoreBackup.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    setup();
    const button = screen.getByRole('button', { name: 'Restore' });
    await user.click(button);
    expect(screen.getByRole('button', { name: 'Restoring…' })).toHaveAttribute('aria-busy', 'true');
    await user.click(screen.getByRole('button', { name: 'Restoring…' }));
    expect(restoreBackup).toHaveBeenCalledTimes(1);
    finish({});
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Restored'));
  });

  it('does not cancel while a restore is running', async () => {
    const user = userEvent.setup();
    restoreBackup.mockReturnValue(new Promise(() => {}));
    const { onCancel } = setup();
    await user.click(screen.getByRole('button', { name: 'Restore' }));
    await user.keyboard('{Escape}');
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('shows the server message for a too-new backup and keeps data untouched', async () => {
    const user = userEvent.setup();
    const message = 'This backup was made by a newer version of Burrow. Update Burrow, then try again.';
    restoreBackup.mockRejectedValue(Object.assign(new Error(message), { code: 'backup_too_new', status: 409 }));
    markDirty('burrow.test.pending');
    const { client, onRestored } = setup();
    await user.click(screen.getByRole('button', { name: 'Restore' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    expect(onRestored).not.toHaveBeenCalled();
    expect(getPendingKeys()).toContain('burrow.test.pending');
    expect(client.getQueryData(['todos'])).toEqual([{ id: 1 }]);
    expect(screen.getByRole('button', { name: 'Restore' })).toBeInTheDocument();
  });

  it('restores from an upload token', async () => {
    const user = userEvent.setup();
    restoreBackup.mockResolvedValue({});
    const { onRestored } = setup({ source: { uploadToken: 'tok' } });
    await user.click(screen.getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(onRestored).toHaveBeenCalled());
    expect(restoreBackup).toHaveBeenCalledWith({ uploadToken: 'tok' });
  });

  it('reloads the page by default', async () => {
    const user = userEvent.setup();
    restoreBackup.mockResolvedValue({});
    const reload = vi.fn();
    const original = window.location;
    Object.defineProperty(window, 'location', { configurable: true, value: { ...original, reload } });
    try {
      const client = new QueryClient();
      render(
        <QueryClientProvider client={client}>
          <BackupRestoreConfirm source={{ id: 'a' }} question={QUESTION} onCancel={() => {}} />
        </QueryClientProvider>,
      );
      await user.click(screen.getByRole('button', { name: 'Restore' }));
      await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: original });
    }
  });

  it('keeps the dialog open on a 503 db_restoring and succeeds on retry', async () => {
    const user = userEvent.setup();
    const onBusyChange = vi.fn();
    restoreBackup
      .mockRejectedValueOnce(
        Object.assign(new Error('Burrow is restoring a backup. Try again in a few seconds.'), {
          status: 503,
          code: 'db_restoring',
        }),
      )
      .mockResolvedValueOnce({});
    const { onRestored } = setup({ onBusyChange });
    await user.click(screen.getByRole('button', { name: 'Restore' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Burrow is restoring a backup.');
    expect(screen.getByRole('group', { name: 'Confirm restore' })).toBeInTheDocument();
    expect(onRestored).not.toHaveBeenCalled();
    expect(onBusyChange).toHaveBeenLastCalledWith(false);
    await user.click(screen.getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(onRestored).toHaveBeenCalledTimes(1));
    expect(restoreBackup).toHaveBeenCalledTimes(2);
    expect(onBusyChange).toHaveBeenCalledWith(true);
  });

  it('tells the user to reload after a network error instead of offering Restore again', async () => {
    const user = userEvent.setup();
    const onBusyChange = vi.fn();
    markDirty('burrow.test.pending');
    restoreBackup.mockRejectedValue(new Error("Couldn't reach the server. Check your connection and try again."));
    const { client, onRestored } = setup({ onBusyChange });
    await user.click(screen.getByRole('button', { name: 'Restore' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Burrow may have restored the backup. Reload Burrow to check.',
    );
    expect(screen.queryByRole('button', { name: 'Restore' })).not.toBeInTheDocument();
    expect(onBusyChange).not.toHaveBeenCalledWith(false);
    expect(onRestored).not.toHaveBeenCalled();
    expect(client.getQueryData(['todos'])).toEqual([{ id: 1 }]);
    const reload = screen.getByRole('button', { name: 'Reload' });
    await waitFor(() => expect(reload).toHaveFocus());
    await user.click(reload);
    expect(onRestored).toHaveBeenCalledTimes(1);
  });

  it('still calls onRestored when a step after a successful restore throws', async () => {
    const user = userEvent.setup();
    restoreBackup.mockResolvedValue({});
    const { client, onRestored } = setup();
    vi.spyOn(client, 'clear').mockImplementation(() => {
      throw new Error('cache cleanup failed');
    });
    await user.click(screen.getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(onRestored).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Restored. Reloading Burrow.');
  });

  it('reports the refusal to the parent', async () => {
    const user = userEvent.setup();
    const onFailed = vi.fn();
    const error = Object.assign(new Error('That file check expired.'), { status: 410, code: 'upload_expired' });
    restoreBackup.mockRejectedValue(error);
    setup({ onFailed });
    await user.click(screen.getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(onFailed).toHaveBeenCalledWith(error));
  });

  it('uses the custom action, labels and status texts when given', async () => {
    const user = userEvent.setup();
    const run = vi.fn().mockResolvedValue({});
    const { onRestored } = setup({
      run,
      confirmLabel: 'Copy and replace',
      busyLabel: 'Copying…',
      groupLabel: 'Confirm copy',
      busyStatus: 'Copying your Burrow data.',
      doneStatus: 'Copied. Reloading Burrow Dev.',
    });
    expect(screen.getByRole('group', { name: 'Confirm copy' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Copy and replace' }));
    await waitFor(() => expect(onRestored).toHaveBeenCalledTimes(1));
    expect(run).toHaveBeenCalledTimes(1);
    expect(restoreBackup).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Copying…' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Copied. Reloading Burrow Dev.');
  });

  it('uses the custom failed message when the refusal has no message', async () => {
    const user = userEvent.setup();
    restoreBackup.mockRejectedValue(Object.assign(new Error(''), { status: 500 }));
    setup({ failedMessage: 'The copy did not work. Burrow Dev was not changed.' });
    await user.click(screen.getByRole('button', { name: 'Restore' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The copy did not work. Burrow Dev was not changed.');
  });

  it('uses the custom unsure message when no answer arrives', async () => {
    const user = userEvent.setup();
    restoreBackup.mockRejectedValue(new Error('offline'));
    setup({ unsureMessage: 'Burrow Dev may have copied your data. Reload Burrow Dev to check.' });
    await user.click(screen.getByRole('button', { name: 'Restore' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Burrow Dev may have copied your data.');
  });
});
