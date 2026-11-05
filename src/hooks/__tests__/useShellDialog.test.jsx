import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

vi.mock('../../constants/folders', async (importOriginal) => ({ ...(await importOriginal()), DIALOG_POLL_MS: 5 }));
vi.mock('../../services/foldersService', () => ({
  foldersService: { dialog: vi.fn(), cancelDialog: vi.fn() },
}));

import { foldersService } from '../../services/foldersService';
import { useShellDialog } from '../useShellDialog';

const view = (over = {}) => ({ id: 'd1', kind: 'pick_folder', status: 'waiting', error: null, ...over });

beforeEach(() => {
  foldersService.dialog.mockReset();
  foldersService.cancelDialog.mockReset();
  foldersService.cancelDialog.mockResolvedValue({ dialog: view({ status: 'cancelled' }) });
});
afterEach(() => vi.restoreAllMocks());

describe('useShellDialog', () => {
  it('polls until the request ends and resolves to the final view', async () => {
    foldersService.dialog
      .mockResolvedValueOnce({ dialog: view({ status: 'checking' }) })
      .mockResolvedValueOnce({ dialog: view({ status: 'added' }) });
    const { result } = renderHook(() => useShellDialog());
    let final;
    await act(async () => {
      final = await result.current.start(Promise.resolve({ dialog: view() }));
    });
    expect(final.status).toBe('added');
    expect(foldersService.dialog).toHaveBeenCalledTimes(2);
    expect(result.current.active).toBe(false);
  });

  it('does not poll a request that already ended', async () => {
    const { result } = renderHook(() => useShellDialog());
    let final;
    await act(async () => {
      final = await result.current.start(Promise.resolve({ dialog: view({ status: 'cancelled' }) }));
    });
    expect(final.status).toBe('cancelled');
    expect(foldersService.dialog).not.toHaveBeenCalled();
  });

  it('rejects when the request cannot be created', async () => {
    const { result } = renderHook(() => useShellDialog());
    await act(async () => {
      await expect(result.current.start(Promise.reject(new Error('no')))).rejects.toThrow('no');
    });
    expect(result.current.active).toBe(false);
  });

  it('turns a vanished request into a failed view with the server text', async () => {
    foldersService.dialog.mockRejectedValue(Object.assign(new Error('That request has ended. Try again.'), { code: 'dialog_not_found' }));
    const { result } = renderHook(() => useShellDialog());
    let final;
    await act(async () => {
      final = await result.current.start(Promise.resolve({ dialog: view() }));
    });
    expect(final).toMatchObject({ status: 'failed', error: { code: 'dialog_not_found', message: 'That request has ended. Try again.' } });
  });

  it('gives up after repeated poll failures', async () => {
    foldersService.dialog.mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() => useShellDialog());
    await act(async () => {
      await expect(result.current.start(Promise.resolve({ dialog: view() }))).rejects.toThrow('offline');
    });
    expect(foldersService.dialog).toHaveBeenCalledTimes(5);
  });

  it('stops polling on unmount and resolves to null', async () => {
    foldersService.dialog.mockResolvedValue({ dialog: view() });
    const { result, unmount } = renderHook(() => useShellDialog());
    let pending;
    act(() => {
      pending = result.current.start(Promise.resolve({ dialog: view() }));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    unmount();
    await expect(pending).resolves.toBeNull();
    const calls = foldersService.dialog.mock.calls.length;
    await new Promise((r) => setTimeout(r, 30));
    expect(foldersService.dialog.mock.calls.length).toBe(calls);
  });

  it('cancel asks the server to close the request that is open', async () => {
    let release;
    foldersService.dialog.mockImplementation(
      () => new Promise((resolve) => { release = () => resolve({ dialog: view({ status: 'cancelled' }) }); }),
    );
    const { result } = renderHook(() => useShellDialog());
    let pending;
    act(() => {
      pending = result.current.start(Promise.resolve({ dialog: view() }));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    await act(async () => {
      await result.current.cancel();
    });
    expect(foldersService.cancelDialog).toHaveBeenCalledWith('d1');
    await act(async () => {
      release();
      await pending;
    });
  });
});
