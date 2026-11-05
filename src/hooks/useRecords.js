import { useCallback } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { transactionsService } from '../services/transactionsService';

const QUERY_KEY = ['transactions'];
const EMPTY = [];

function normalizeRecord(record) {
  const rawAmount = record.amount ?? record.Amount ?? 0;
  const rawType = (record.type || record.Type || '').toLowerCase();
  const type = rawType || (rawAmount >= 0 ? 'credit' : 'debit');
  return {
    id: record.id,
    date: record.date || record.Date || '',
    merchant: record.merchant || record.Merchant || 'Unknown',
    amount: Math.abs(rawAmount),
    category: record.category || record.Category || 'Other',
    type,
    createdTime: record.createdTime,
  };
}

export function useRecords() {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: QUERY_KEY,
    queryFn: async () => {
      // A failed fetch is still swallowed (consumers get an empty `records`
      // array rather than a thrown error), but it is flagged so callers that
      // care (useBudgetData) can tell "fetch failed" apart from "no data yet".
      try {
        const data = await transactionsService.fetchTransactions();
        return { records: data.length > 0 ? data.map(normalizeRecord) : [], failed: false };
      } catch {
        return { records: [], failed: true };
      }
    },
  });

  // fetchRecords keeps its imperative "refetch from source" contract.
  const fetchRecords = useCallback(
    () => queryClient.invalidateQueries({ queryKey: QUERY_KEY }),
    [queryClient],
  );

  const addMutation = useMutation({
    mutationFn: async (newRecords) => {
      const normalized = newRecords.map((r) => ({
        date: r.date,
        merchant: r.merchant,
        amount: Math.abs(Number(r.amount) || 0),
        category: r.category,
        type: (r.type || 'debit').toLowerCase(),
      }));
      await transactionsService.addTransactions(normalized);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: QUERY_KEY }),
  });

  const clearMutation = useMutation({
    mutationFn: () => transactionsService.clearTransactions(),
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: QUERY_KEY });
      const previous = queryClient.getQueryData(QUERY_KEY);
      queryClient.setQueryData(QUERY_KEY, { records: [], failed: false });
      return { previous };
    },
    onError: (_err, _vars, context) => {
      if (context?.previous !== undefined) {
        queryClient.setQueryData(QUERY_KEY, context.previous);
      }
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: QUERY_KEY }),
  });

  // The original hook reported add/clear failures as a plain string message
  // (rendered directly in the Dashboard). Fetch failures were swallowed, so we
  // only expose mutation errors here to keep that public shape intact.
  const error =
    addMutation.error?.message ?? clearMutation.error?.message ?? null;

  const addRecords = useCallback(
    (newRecords) => addMutation.mutateAsync(newRecords),
    [addMutation],
  );

  const clearRecords = useCallback(
    () => clearMutation.mutateAsync(),
    [clearMutation],
  );

  return {
    records: query.data?.records ?? EMPTY,
    fetchFailed: query.data?.failed ?? false,
    loading: query.isPending,
    error,
    fetchRecords,
    addRecords,
    clearRecords,
  };
}
