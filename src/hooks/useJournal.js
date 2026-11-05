import { useCallback } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { journalService } from '../services/journalService';
import { newId } from '../utils/ids';

const QUERY_KEY = ['journal'];
const EMPTY = [];

export function useJournal() {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: QUERY_KEY,
    queryFn: async () => {
      const result = await journalService.list();
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
    if (context?.previous !== undefined) {
      queryClient.setQueryData(QUERY_KEY, context.previous);
    }
  };

  const addMutation = useMutation({
    mutationFn: (entry) => journalService.create(entry),
    onMutate: (entry) =>
      optimistic((prev) => [
        // New entries sort to the top; the server-assigned date replaces this
        // on refetch. Default date keeps EntryList/stats rendering valid.
        { id: `temp-${newId()}`, date: new Date().toISOString(), tags: [], ...entry },
        ...prev,
      ]),
    onError: rollback,
    onSettled: invalidate,
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, patch }) => journalService.update(id, patch),
    onMutate: ({ id, patch }) =>
      optimistic((prev) => prev.map((e) => (e.id === id ? { ...e, ...patch } : e))),
    onError: rollback,
    onSettled: invalidate,
  });

  const removeMutation = useMutation({
    mutationFn: (id) => journalService.remove(id),
    onMutate: (id) => optimistic((prev) => prev.filter((e) => e.id !== id)),
    onError: rollback,
    onSettled: invalidate,
  });

  const add = useCallback((entry) => addMutation.mutateAsync(entry), [addMutation]);

  const update = useCallback(
    (id, patch) => updateMutation.mutateAsync({ id, patch }),
    [updateMutation],
  );

  const remove = useCallback((id) => removeMutation.mutateAsync(id), [removeMutation]);

  return {
    entries: query.data ?? EMPTY,
    loading: query.isPending,
    error: query.error ?? null,
    refresh,
    add,
    update,
    remove,
  };
}
