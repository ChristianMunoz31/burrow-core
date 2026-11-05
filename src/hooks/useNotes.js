import { useCallback } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { notesService } from '../services/notesService';
import { newId } from '../utils/ids';

const QUERY_KEY = ['notes'];
const EMPTY = [];

export function useNotes() {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: QUERY_KEY,
    queryFn: async () => {
      const result = await notesService.list();
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
    mutationFn: (note) => notesService.create(note),
    onMutate: (note) =>
      optimistic((prev) => [{ id: `temp-${newId()}`, pinned: false, ...note }, ...prev]),
    onError: rollback,
    onSettled: invalidate,
  });
  const updateMutation = useMutation({
    mutationFn: ({ id, patch }) => notesService.update(id, patch),
    onMutate: ({ id, patch }) =>
      optimistic((prev) => prev.map((n) => (n.id === id ? { ...n, ...patch } : n))),
    onError: rollback,
    onSettled: invalidate,
  });
  const removeMutation = useMutation({
    mutationFn: (id) => notesService.remove(id),
    onMutate: (id) => optimistic((prev) => prev.filter((n) => n.id !== id)),
    onError: rollback,
    onSettled: invalidate,
  });

  const add = useCallback((note) => addMutation.mutateAsync(note), [addMutation]);
  const update = useCallback(
    (id, patch) => updateMutation.mutateAsync({ id, patch }),
    [updateMutation],
  );
  const remove = useCallback((id) => removeMutation.mutateAsync(id), [removeMutation]);

  return {
    notes: query.data ?? EMPTY,
    loading: query.isPending,
    error: query.error ?? null,
    refresh,
    add,
    update,
    remove,
  };
}
