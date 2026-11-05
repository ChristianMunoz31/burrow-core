import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../../../test-utils/renderWithProviders';
import FocusPage from '../FocusPage';

const h = vi.hoisted(() => ({ state: {}, log: vi.fn(), refresh: vi.fn() }));

vi.mock('../../../hooks/useFocus', () => ({
  useFocus: () => ({
    sessions: [],
    today: { count: 0, minutes: 0 },
    loading: false,
    error: null,
    log: h.log,
    refresh: h.refresh,
    ...h.state,
  }),
}));

vi.mock('../../../hooks/useSyncedSetting', async () => {
  const React = await import('react');
  return {
    useSyncedSetting: (_key, initial) => React.useState(initial),
  };
});

beforeEach(() => {
  h.state = {};
  h.log.mockReset().mockResolvedValue(undefined);
  h.refresh.mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

const setMinutes = (label, value) => {
  const input = screen.getByLabelText(label);
  fireEvent.change(input, { target: { value } });
  fireEvent.blur(input);
};

describe('FocusPage load errors', () => {
  it('shows a retry for a non-503 load error instead of a zero count', async () => {
    h.state = { error: { status: 500 } };
    renderWithProviders(<FocusPage />);
    expect(screen.getByRole('alert')).toHaveTextContent("couldn't load your focus sessions");
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });
});

describe('FocusPage block length', () => {
  it('applies a new length at once while the block has not started', () => {
    renderWithProviders(<FocusPage />);
    setMinutes('Focus minutes', '10');
    expect(screen.getByText('10:00')).toBeInTheDocument();
  });

  it('keeps the countdown when the length changes while paused', () => {
    vi.useFakeTimers();
    renderWithProviders(<FocusPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    expect(screen.getByText('24:55')).toBeInTheDocument();
    setMinutes('Focus minutes', '10');
    expect(screen.getByText('24:55')).toBeInTheDocument();
    expect(screen.getByText('25-min focus block')).toBeInTheDocument();
  });

  it('logs the planned length of the block that ran, not the edited setting', () => {
    vi.useFakeTimers();
    renderWithProviders(<FocusPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    setMinutes('Focus minutes', '10');
    act(() => {
      vi.advanceTimersByTime(25 * 60 * 1000);
    });
    expect(h.log).toHaveBeenCalledWith(expect.objectContaining({ kind: 'focus', durationMin: 25 }));
    expect(h.log.mock.calls[0][0]).not.toHaveProperty('context');
    expect(screen.getByText('05:00')).toBeInTheDocument();
  });

  it('has no Tag sessions as control', () => {
    renderWithProviders(<FocusPage />);
    expect(screen.queryByText('Tag sessions as')).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });
});
