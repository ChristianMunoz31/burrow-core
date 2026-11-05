import { useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { updateService } from '../services/updateService';

const KEY = ['updates', 'check'];

/** Opt-in update status. Only calls out while `enabled`; `recheck` bypasses the server cache. */
export function useUpdateCheck({ enabled }) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: KEY,
    queryFn: () => updateService.check(),
    enabled: enabled === true,
    staleTime: 6 * 60 * 60 * 1000,
    retry: false,
    refetchOnWindowFocus: false,
  });

  const recheck = useCallback(async () => {
    await queryClient.fetchQuery({
      queryKey: KEY,
      queryFn: () => updateService.check({ refresh: true }),
      staleTime: 0,
    });
  }, [queryClient]);

  return {
    status: query.data ?? null,
    isLoading: enabled === true && query.isPending,
    recheck,
  };
}
