import { useCallback, useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { countdownsService } from '../services/countdownsService';
import { newId } from '../utils/ids';

const QUERY_KEY = ['countdowns'];

export function useCountdowns() {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: QUERY_KEY,
    queryFn: async () => {
      const result = await countdownsService.list();
      return Array.isArray(result) ? result : [];
    },
  });

  const refresh = useCallback(
    () => queryClient.invalidateQueries({ queryKey: QUERY_KEY }),
    [queryClient],
  );
  const invalidate = () => queryClient.invalidateQueries({ queryKey: QUERY_KEY });

  const optimistic = async (updater) => {
    await queryClient.cancelQueries({ queryKey: QUERY_KEY });
    const previous = queryClient.getQueryData(QUERY_KEY) ?? [];
    queryClient.setQueryData(QUERY_KEY, updater(previous));
    return { previous };
  };
  const rollback = (_err, _vars, context) => {
    if (context?.previous !== undefined) queryClient.setQueryData(QUERY_KEY, context.previous);
  };

  const addMutation = useMutation({
    mutationFn: (countdown) => countdownsService.create(countdown),
    onMutate: (countdown) =>
      optimistic((prev) => [...prev, { id: `temp-${newId()}`, ...countdown }]),
    onError: rollback,
    onSettled: invalidate,
  });
  const updateMutation = useMutation({
    mutationFn: ({ id, patch }) => countdownsService.update(id, patch),
    onMutate: ({ id, patch }) =>
      optimistic((prev) => prev.map((c) => (c.id === id ? { ...c, ...patch } : c))),
    onError: rollback,
    onSettled: invalidate,
  });
  const removeMutation = useMutation({
    mutationFn: (id) => countdownsService.remove(id),
    onMutate: (id) => optimistic((prev) => prev.filter((c) => c.id !== id)),
    onError: rollback,
    onSettled: invalidate,
  });

  const add = useCallback((countdown) => addMutation.mutateAsync(countdown), [addMutation]);
  const update = useCallback(
    (id, patch) => updateMutation.mutateAsync({ id, patch }),
    [updateMutation],
  );
  const remove = useCallback((id) => removeMutation.mutateAsync(id), [removeMutation]);

  // Events arrive pre-sorted by target_date ascending from the server; re-sort
  // client-side too so optimistic inserts land in the right place.
  const countdowns = useMemo(
    () =>
      (query.data ?? [])
        .slice()
        .sort((a, b) => String(a.targetDate).localeCompare(String(b.targetDate))),
    [query.data],
  );

  return {
    countdowns,
    loading: query.isPending,
    error: query.error ?? null,
    refresh,
    add,
    update,
    remove,
  };
}
