import { useCallback } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { todosService } from '../services/todosService';
import { newId } from '../utils/ids';

const QUERY_KEY = ['todos'];
const EMPTY = [];

export function useTodos() {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: QUERY_KEY,
    queryFn: async () => {
      const result = await todosService.list();
      return Array.isArray(result) ? result : [];
    },
  });

  const refresh = useCallback(
    () => queryClient.invalidateQueries({ queryKey: QUERY_KEY }),
    [queryClient],
  );

  // Shared optimistic-update plumbing: cancel in-flight refetches, snapshot the
  // current cache, apply `updater`, and hand back a rollback context.
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
    mutationFn: (todo) => todosService.create(todo),
    onMutate: (todo) =>
      optimistic((prev) => [
        ...prev,
        { id: `temp-${newId()}`, done: false, ...todo },
      ]),
    onError: rollback,
    onSettled: refresh,
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, patch }) => todosService.update(id, patch),
    onMutate: ({ id, patch }) =>
      optimistic((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t))),
    onError: rollback,
    onSettled: refresh,
  });

  const removeMutation = useMutation({
    mutationFn: (id) => todosService.remove(id),
    onMutate: (id) => optimistic((prev) => prev.filter((t) => t.id !== id)),
    onError: rollback,
    onSettled: refresh,
  });

  // Bulk reorder from a Kanban drag. `items` is [{ id, status, order }]; merge
  // each into the matching cached todo so the board settles instantly.
  const reorderMutation = useMutation({
    mutationFn: (items) => todosService.reorder(items),
    onMutate: (items) => {
      const byId = new Map((items || []).map((i) => [i.id, i]));
      return optimistic((prev) =>
        prev.map((t) => (byId.has(t.id) ? { ...t, ...byId.get(t.id) } : t)),
      );
    },
    onError: rollback,
    onSettled: refresh,
  });

  const add = useCallback((todo) => addMutation.mutateAsync(todo), [addMutation]);

  const update = useCallback(
    (id, patch) => updateMutation.mutateAsync({ id, patch }),
    [updateMutation],
  );

  const reorder = useCallback(
    (items) => reorderMutation.mutateAsync(items),
    [reorderMutation],
  );

  const remove = useCallback((id) => removeMutation.mutateAsync(id), [removeMutation]);

  return {
    todos: query.data ?? EMPTY,
    loading: query.isPending,
    error: query.data ? null : (query.error ?? null),
    refresh,
    add,
    update,
    reorder,
    remove,
  };
}
