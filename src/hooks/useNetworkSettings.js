import { useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { networkService } from '../services/networkService';

const KEY = ['network-settings'];
// Queries that were answering 403 while their feature was off (or should stop calling
// out once it is turned off), so they refetch when a toggle changes.
const FEATURE_QUERIES = [['weather'], ['oura']];

/** Network opt-in features (all off by default) and a toggle that returns the saved list. */
export function useNetworkSettings() {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: KEY,
    queryFn: networkService.get,
    staleTime: 30_000,
    retry: false,
  });

  const setEnabled = useCallback(
    async (id, enabled) => {
      const saved = await networkService.set(id, enabled);
      queryClient.setQueryData(KEY, saved);
      await Promise.all(
        FEATURE_QUERIES.map((queryKey) => queryClient.invalidateQueries({ queryKey })),
      );
      return saved;
    },
    [queryClient],
  );

  return {
    features: Array.isArray(query.data?.features) ? query.data.features : null,
    isLoading: query.isPending,
    error: query.error,
    refetch: query.refetch,
    setEnabled,
  };
}
