import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import UpdateInstallPanel from '../UpdateInstallPanel';

vi.mock('../../../services/updateService', () => ({ updateService: { check: vi.fn(), install: vi.fn(), manual: vi.fn() } }));
import { updateService } from '../../../services/updateService';

const wrap = (ui) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
};

const GENERIC = "Burrow couldn't start the update. Close and reopen Burrow, then try again.";
const apiError = (code, message = 'Fixed server message.') =>
  Object.assign(new Error(message), { code, status: 409, userFacing: true });
const noEmDash = (el) => expect(el.textContent).not.toMatch(/[—–]/);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('UpdateInstallPanel: idle', () => {
  it('shows only Download and install, with an empty live region, and calls nothing yet', () => {
    wrap(<UpdateInstallPanel version="1.1.0" />);
    expect(screen.getByRole('button', { name: 'Download and install' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Later' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Burrow 1.1.0 is available' })).toBeNull();
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
    expect(updateService.install).not.toHaveBeenCalled();
    expect(updateService.check).not.toHaveBeenCalled();
  });
});

describe('UpdateInstallPanel: install', () => {
  it('shows the saving state while the server works, then the installing state with the final copy', async () => {
    let finish;
    updateService.install.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const user = userEvent.setup();
    const { container } = wrap(<UpdateInstallPanel version="1.1.0" />);
    await user.click(screen.getByRole('button', { name: 'Download and install' }));
    expect(await screen.findByText('Saving a backup of your data...')).toBeInTheDocument();
    expect(updateService.install).toHaveBeenCalledWith('1.1.0');
    finish({ status: 'handed_off', version: '1.1.0', backupId: 'b1' });
    expect(await screen.findByText('Installing, Burrow will restart')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Backup saved. Burrow is downloading version 1.1.0. When it is ready, Burrow closes, installs the update and opens again. This can take a few minutes.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('If nothing happens after a few minutes, close and reopen Burrow.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Download and install' })).toBeNull();
    expect(screen.queryByText('Saving a backup of your data...')).toBeNull();
    noEmDash(container);
  });

  it('guards a double click: install is called once', async () => {
    updateService.install.mockReturnValue(new Promise(() => {}));
    const user = userEvent.setup();
    wrap(<UpdateInstallPanel version="1.1.0" />);
    const button = screen.getByRole('button', { name: 'Download and install' });
    await user.dblClick(button);
    await user.click(button);
    expect(updateService.install).toHaveBeenCalledTimes(1);
  });

  it('moves focus to the installing heading after the handoff', async () => {
    updateService.install.mockResolvedValue({ status: 'handed_off', version: '1.1.0', backupId: null });
    const user = userEvent.setup();
    wrap(<UpdateInstallPanel version="1.1.0" />);
    await user.click(screen.getByRole('button', { name: 'Download and install' }));
    expect(await screen.findByRole('heading', { name: 'Installing, Burrow will restart' })).toHaveFocus();
  });

  it('keeps one live region mounted across saving and installing', async () => {
    let finish;
    updateService.install.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const user = userEvent.setup();
    wrap(<UpdateInstallPanel version="1.1.0" />);
    const live = screen.getByRole('status');
    expect(live).toHaveAttribute('aria-live', 'polite');
    await user.click(screen.getByRole('button', { name: 'Download and install' }));
    expect(screen.getByRole('status')).toBe(live);
    expect(live).toHaveTextContent('Saving a backup of your data...');
    finish({ status: 'handed_off', version: '1.1.0', backupId: 'b1' });
    await waitFor(() => expect(live).toHaveTextContent('Backup saved. Burrow is downloading version 1.1.0.'));
    expect(screen.getByRole('status')).toBe(live);
    // The focused heading sits outside the live region.
    const heading = screen.getByRole('heading', { name: 'Installing, Burrow will restart' });
    expect(live).not.toContainElement(heading);
  });

  it('reports busy to the parent while saving and installing, and clears it on unmount', async () => {
    updateService.install.mockResolvedValue({ status: 'handed_off', version: '1.1.0', backupId: null });
    const onBusyChange = vi.fn();
    const user = userEvent.setup();
    const { unmount } = wrap(<UpdateInstallPanel version="1.1.0" onBusyChange={onBusyChange} />);
    expect(onBusyChange).toHaveBeenLastCalledWith(false);
    await user.click(screen.getByRole('button', { name: 'Download and install' }));
    await screen.findByRole('heading', { name: 'Installing, Burrow will restart' });
    expect(onBusyChange).toHaveBeenCalledWith(true);
    unmount();
    expect(onBusyChange).toHaveBeenLastCalledWith(false);
  });
});

describe('UpdateInstallPanel: errors', () => {
  it('shows the server message for a refusal and lets the user try again', async () => {
    updateService.install.mockRejectedValueOnce(apiError('backup_busy', 'Burrow is busy with a backup. Try again in a minute.'));
    const user = userEvent.setup();
    const { container } = wrap(<UpdateInstallPanel version="1.1.0" />);
    await user.click(screen.getByRole('button', { name: 'Download and install' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Burrow is busy with a backup. Try again in a minute.');
    expect(screen.queryByText('Saving a backup of your data...')).toBeNull();
    expect(screen.getByRole('button', { name: 'Download and install' })).toBeEnabled();
    noEmDash(container);

    updateService.install.mockResolvedValueOnce({ status: 'handed_off', version: '1.1.0', backupId: null });
    await user.click(screen.getByRole('button', { name: 'Download and install' }));
    expect(await screen.findByText('Installing, Burrow will restart')).toBeInTheDocument();
    expect(updateService.install).toHaveBeenCalledTimes(2);
  });

  it('shows the generic line, never raw error text, when the error is not the server\'s fixed copy', async () => {
    updateService.install.mockRejectedValueOnce(Object.assign(new Error('TypeError: failed to fetch'), { code: 'x' }));
    const user = userEvent.setup();
    const { container } = wrap(<UpdateInstallPanel version="1.1.0" />);
    await user.click(screen.getByRole('button', { name: 'Download and install' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(GENERIC);
    expect(container.textContent).not.toContain('failed to fetch');
  });

  it('offers Check again for a stale or unconfirmed update', async () => {
    updateService.install.mockRejectedValueOnce(apiError('update_not_available'));
    const onRecheck = vi.fn(async () => {});
    const user = userEvent.setup();
    wrap(<UpdateInstallPanel version="1.1.0" onRecheck={onRecheck} />);
    await user.click(screen.getByRole('button', { name: 'Download and install' }));
    await user.click(await screen.findByRole('button', { name: 'Check again' }));
    await waitFor(() => expect(onRecheck).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });

  it('offers no Check again for other errors', async () => {
    updateService.install.mockRejectedValueOnce(apiError('backup_busy'));
    const user = userEvent.setup();
    wrap(<UpdateInstallPanel version="1.1.0" onRecheck={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Download and install' }));
    await screen.findByRole('alert');
    expect(screen.queryByRole('button', { name: 'Check again' })).toBeNull();
  });

  it('shows a short fixed line when the recheck fails', async () => {
    updateService.install.mockRejectedValueOnce(apiError('update_check_unavailable'));
    const onRecheck = vi.fn(async () => {
      throw new Error('raw upstream text');
    });
    const user = userEvent.setup();
    wrap(<UpdateInstallPanel version="1.1.0" onRecheck={onRecheck} />);
    await user.click(screen.getByRole('button', { name: 'Download and install' }));
    await user.click(await screen.findByRole('button', { name: 'Check again' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("Burrow still can't check. Try again later.");
    expect(alert.textContent).not.toContain('raw upstream text');
  });
});

describe('UpdateInstallPanel: stuck installing', () => {
  it('offers a way back after about five minutes, which resets to idle and allows another try', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      updateService.install.mockResolvedValue({ status: 'handed_off', version: '1.1.0', backupId: null });
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      wrap(<UpdateInstallPanel version="1.1.0" />);
      await user.click(screen.getByRole('button', { name: 'Download and install' }));
      await screen.findByRole('heading', { name: 'Installing, Burrow will restart' });
      expect(screen.queryByRole('button', { name: 'Go back to the update' })).toBeNull();
      await act(async () => {
        vi.advanceTimersByTime(4 * 60 * 1000);
      });
      expect(screen.queryByRole('button', { name: 'Go back to the update' })).toBeNull();
      await act(async () => {
        vi.advanceTimersByTime(61 * 1000);
      });
      await user.click(screen.getByRole('button', { name: 'Go back to the update' }));
      expect(screen.getByRole('button', { name: 'Download and install' })).toBeEnabled();
      expect(screen.getByRole('button', { name: 'Download and install' })).toHaveFocus();
      await user.click(screen.getByRole('button', { name: 'Download and install' }));
      expect(updateService.install).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
