import { describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { isTempId, useCrudDialogs } from '../useCrudDialogs';

describe('useCrudDialogs', () => {
  it('starts closed', () => {
    const { result } = renderHook(() => useCrudDialogs());
    expect(result.current.dialog).toBeNull();
    expect(result.current.pendingRemove).toBeNull();
  });

  it('openAdd defaults to {} and carries provided defaults', () => {
    const { result } = renderHook(() => useCrudDialogs());
    act(() => result.current.openAdd());
    expect(result.current.dialog).toEqual({ mode: 'add', item: null, defaults: {} });
    act(() => result.current.openAdd({ date: '2026-01-01' }));
    expect(result.current.dialog.defaults).toEqual({ date: '2026-01-01' });
  });

  it('openEdit then close', () => {
    const { result } = renderHook(() => useCrudDialogs());
    const item = { id: 1 };
    act(() => result.current.openEdit(item));
    expect(result.current.dialog).toEqual({ mode: 'edit', item });
    act(() => result.current.close());
    expect(result.current.dialog).toBeNull();
  });

  it('askRemove / cancelRemove', () => {
    const { result } = renderHook(() => useCrudDialogs());
    const item = { id: 2 };
    act(() => result.current.askRemove(item));
    expect(result.current.pendingRemove).toBe(item);
    act(() => result.current.cancelRemove());
    expect(result.current.pendingRemove).toBeNull();
  });

  it('runSubmit tracks submitting, passes the dialog and closes on success', async () => {
    const { result } = renderHook(() => useCrudDialogs());
    act(() => result.current.openAdd());
    let resolve;
    const fn = vi.fn(() => new Promise((r) => (resolve = r)));
    let promise;
    act(() => {
      promise = result.current.runSubmit(fn)({ a: 1 });
    });
    expect(result.current.submitting).toBe(true);
    expect(fn).toHaveBeenCalledWith({ a: 1 }, result.current.dialog);
    await act(async () => {
      resolve();
      await promise;
    });
    expect(result.current.submitting).toBe(false);
    expect(result.current.dialog).toBeNull();
  });

  it('runSubmit rethrows, resets submitting and keeps the dialog open', async () => {
    const { result } = renderHook(() => useCrudDialogs());
    act(() => result.current.openAdd());
    await act(async () => {
      await expect(
        result.current.runSubmit(() => Promise.reject(new Error('boom')))({}),
      ).rejects.toThrow('boom');
    });
    expect(result.current.submitting).toBe(false);
    expect(result.current.dialog).not.toBeNull();
  });

  it('runSubmit does not close a different dialog opened meanwhile', async () => {
    const { result } = renderHook(() => useCrudDialogs());
    act(() => result.current.openAdd());
    let resolve;
    let promise;
    act(() => {
      promise = result.current.runSubmit(() => new Promise((r) => (resolve = r)))({});
    });
    act(() => result.current.openEdit({ id: 9 }));
    await act(async () => {
      resolve();
      await promise;
    });
    expect(result.current.dialog).toEqual({ mode: 'edit', item: { id: 9 } });
  });

  it('isTempId detects optimistic ids', () => {
    expect(isTempId('temp-123')).toBe(true);
    expect(isTempId(42)).toBe(false);
    expect(isTempId('abc')).toBe(false);
  });
});
