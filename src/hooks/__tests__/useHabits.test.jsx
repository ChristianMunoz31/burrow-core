import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useHabits } from '../useHabits';

vi.mock('../../services/habitsService', () => ({
  habitsService: { list: vi.fn(), markDone: vi.fn(), unmarkDone: vi.fn() },
}));
import { habitsService } from '../../services/habitsService';

function run() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return renderHook(() => useHabits(), { wrapper });
}

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe('useHabits toggle', () => {
  it('puts the habit back and rejects when marking done fails', async () => {
    habitsService.list.mockResolvedValue([{ id: 'h1', title: 'Run', completions: [] }]);
    habitsService.markDone.mockRejectedValue(new Error('down'));
    const { result } = run();
    await waitFor(() => expect(result.current.habits).toHaveLength(1));

    let failure;
    await act(async () => {
      failure = await result.current.toggle('h1', '2026-10-08', false).catch((e) => e);
    });

    expect(failure).toBeInstanceOf(Error);
    expect(result.current.habits[0].completions).toEqual([]);
  });
});
