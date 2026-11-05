import { useCallback } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { bookmarksService } from '../services/bookmarksService';
import { newId } from '../utils/ids';

const QUERY_KEY = ['bookmarks'];
const EMPTY = [];

export function useBookmarks() {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: QUERY_KEY,
    queryFn: async () => {
      const result = await bookmarksService.list();
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
    mutationFn: (bookmark) => bookmarksService.create(bookmark),
    onMutate: (bookmark) =>
      optimistic((prev) => [...prev, { id: `temp-${newId()}`, ...bookmark }]),
    onError: rollback,
    onSettled: invalidate,
  });
  const updateMutation = useMutation({
    mutationFn: ({ id, patch }) => bookmarksService.update(id, patch),
    onMutate: ({ id, patch }) =>
      optimistic((prev) => prev.map((b) => (b.id === id ? { ...b, ...patch } : b))),
    onError: rollback,
    onSettled: invalidate,
  });
  const removeMutation = useMutation({
    mutationFn: (id) => bookmarksService.remove(id),
    onMutate: (id) => optimistic((prev) => prev.filter((b) => b.id !== id)),
    onError: rollback,
    onSettled: invalidate,
  });

  const add = useCallback((bookmark) => addMutation.mutateAsync(bookmark), [addMutation]);
  const update = useCallback(
    (id, patch) => updateMutation.mutateAsync({ id, patch }),
    [updateMutation],
  );
  const remove = useCallback((id) => removeMutation.mutateAsync(id), [removeMutation]);

  return {
    bookmarks: query.data ?? EMPTY,
    loading: query.isPending,
    error: query.error ?? null,
    refresh,
    add,
    update,
    remove,
  };
}
