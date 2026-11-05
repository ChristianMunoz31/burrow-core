import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, screen } from '@testing-library/react';
import { ToastProvider, useToast } from '../ToastContext';

const wrapper = ({ children }) => <ToastProvider>{children}</ToastProvider>;

let hook;
const toast = (opts) => hook.result.current(opts);

beforeEach(() => {
  vi.useFakeTimers();
  hook = renderHook(() => useToast(), { wrapper });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('ToastContext', () => {
  it('error toasts are alerts, others are status messages', () => {
    act(() => {
      toast({ message: 'Broke', type: 'error' });
      toast({ message: 'Saved', type: 'success' });
      toast({ message: 'FYI' });
    });
    expect(screen.getByRole('alert')).toHaveTextContent('Broke');
    expect(screen.getAllByRole('status').map((n) => n.textContent)).toEqual(['Saved', 'FYI']);
  });

  it('uses tokens, not raw red, green or slate-700 fills', () => {
    act(() => {
      toast({ message: 'Broke', type: 'error' });
      toast({ message: 'Saved', type: 'success' });
    });
    for (const node of [screen.getByRole('alert'), screen.getByRole('status')]) {
      expect(node.className).not.toMatch(/bg-red-600|bg-green-600|bg-slate-700|text-white/);
      expect(node.className).toMatch(/glass-strong/);
    }
    expect(screen.getByRole('alert').className).toMatch(/text-accent-red/);
    expect(screen.getByRole('status').className).toMatch(/text-accent-green/);
  });

  it('keeps errors on screen for 6 seconds and other toasts for 3', () => {
    act(() => {
      toast({ message: 'Broke', type: 'error' });
      toast({ message: 'Saved', type: 'success' });
    });
    act(() => {
      vi.advanceTimersByTime(3100);
    });
    expect(screen.queryByText('Saved')).not.toBeInTheDocument();
    expect(screen.getByText('Broke')).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(screen.queryByText('Broke')).not.toBeInTheDocument();
  });

  it('an explicit duration still wins', () => {
    act(() => {
      toast({ message: 'Quick', type: 'error', duration: 500 });
    });
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(screen.queryByText('Quick')).not.toBeInTheDocument();
  });
});
