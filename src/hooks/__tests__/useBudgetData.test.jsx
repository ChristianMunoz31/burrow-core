import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useBudgetData } from '../useBudgetData';
import { transactionsService } from '../../services/transactionsService';

vi.mock('../../services/transactionsService', () => ({
  transactionsService: {
    fetchTransactions: vi.fn(),
    addTransactions: vi.fn(),
    clearTransactions: vi.fn(),
  },
}));

const fetchTransactions = transactionsService.fetchTransactions;

function render() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return renderHook(() => useBudgetData(), { wrapper });
}

beforeEach(() => {
  fetchTransactions.mockReset();
});

describe('useBudgetData', () => {
  it('reports loading while the fetch is pending', () => {
    fetchTransactions.mockReturnValue(new Promise(() => {}));
    const { result } = render();
    expect(result.current.loading).toBe(true);
  });

  it("falls back to 'sample' when there are no transactions", async () => {
    fetchTransactions.mockResolvedValue([]);
    const { result } = render();
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.source).toBe('sample');
    expect(result.current.summary.length).toBeGreaterThan(0);
  });

  it("derives 'transactions' data from fetched records", async () => {
    fetchTransactions.mockResolvedValue([
      { id: '1', date: '2026-03-01', merchant: 'Employer', amount: 1000, type: 'credit', category: 'Income' },
      { id: '2', date: '2026-03-02', merchant: 'Trader Joes', amount: 40, type: 'debit', category: 'Groceries' },
    ]);
    const { result } = render();
    await waitFor(() => expect(result.current.source).toBe('transactions'));
    expect(result.current.summary).toHaveLength(1);
    expect(result.current.summary[0]).toMatchObject({ month: '2026-03', income: 1000, expenses: 40 });
  });

  it("falls back to 'sample' when every record has a bad date", async () => {
    fetchTransactions.mockResolvedValue([
      { id: '1', date: 'nope', merchant: 'X', amount: 5, type: 'debit', category: 'Other' },
    ]);
    const { result } = render();
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.source).toBe('sample');
  });

  it("returns source 'error' with empty aggregates when the fetch throws", async () => {
    fetchTransactions.mockRejectedValue(new Error('boom'));
    const { result } = render();
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.source).toBe('error');
    expect(result.current.summary).toEqual([]);
    expect(result.current.categories).toEqual([]);
    expect(result.current.trend).toEqual([]);
  });
});
