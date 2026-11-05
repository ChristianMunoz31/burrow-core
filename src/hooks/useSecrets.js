import { useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { secretsService } from '../services/secretsService';

const KEY = ['secrets'];

/**
 * API-key status plus save/remove/test. The mutations are plain async functions on
 * purpose: useMutation would hold the submitted key in its variables.
 */
export function useSecrets() {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: KEY,
    queryFn: secretsService.list,
    staleTime: 0,
    retry: false,
  });

  const save = useCallback(
    async (name, value) => {
      const status = await secretsService.save(name, value);
      await queryClient.invalidateQueries({ queryKey: KEY });
      return status;
    },
    [queryClient],
  );

  const remove = useCallback(
    async (name) => {
      const status = await secretsService.remove(name);
      await queryClient.invalidateQueries({ queryKey: KEY });
      return status;
    },
    [queryClient],
  );

  const test = useCallback((name) => secretsService.test(name), []);

  return {
    data: query.data ?? null,
    isLoading: query.isPending,
    error: query.error,
    refetch: query.refetch,
    save,
    remove,
    test,
  };
}
