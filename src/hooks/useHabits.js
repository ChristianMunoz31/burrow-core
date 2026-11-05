import { useCallback } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { habitsService } from '../services/habitsService';
import { newId } from '../utils/ids';

const QUERY_KEY = ['habits'];
const EMPTY = [];

export function useHabits() {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: QUERY_KEY,
    queryFn: async () => {
      const result = await habitsService.list();
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
    mutationFn: (habit) => habitsService.create(habit),
    onMutate: (habit) =>
      optimistic((prev) => [
        ...prev,
        { id: `temp-${newId()}`, completions: [], ...habit },
      ]),
    onError: rollback,
    onSettled: invalidate,
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, patch }) => habitsService.update(id, patch),
    onMutate: ({ id, patch }) =>
      optimistic((prev) => prev.map((h) => (h.id === id ? { ...h, ...patch } : h))),
    onError: rollback,
    onSettled: invalidate,
  });

  const removeMutation = useMutation({
    mutationFn: (id) => habitsService.remove(id),
    onMutate: (id) => optimistic((prev) => prev.filter((h) => h.id !== id)),
    onError: rollback,
    onSettled: invalidate,
  });

  const toggleMutation = useMutation({
    mutationFn: ({ habitId, date, currentlyDone }) =>
      currentlyDone
        ? habitsService.unmarkDone(habitId, date)
        : habitsService.markDone(habitId, date),
    onMutate: ({ habitId, date, currentlyDone }) =>
      optimistic((prev) =>
        prev.map((h) => {
          if (h.id !== habitId) return h;
          const completions = Array.isArray(h.completions) ? h.completions : [];
          return {
            ...h,
            completions: currentlyDone
              ? completions.filter((d) => d !== date)
              : [...completions, date],
          };
        }),
      ),
    onError: rollback,
    onSettled: invalidate,
  });

  const add = useCallback((habit) => addMutation.mutateAsync(habit), [addMutation]);

  const update = useCallback(
    (id, patch) => updateMutation.mutateAsync({ id, patch }),
    [updateMutation],
  );

  const remove = useCallback((id) => removeMutation.mutateAsync(id), [removeMutation]);

  const toggle = useCallback(
    (habitId, date, currentlyDone) =>
      toggleMutation.mutateAsync({ habitId, date, currentlyDone }),
    [toggleMutation],
  );

  return {
    habits: query.data ?? EMPTY,
    loading: query.isPending,
    error: query.error ?? null,
    refresh,
    add,
    update,
    remove,
    toggle,
  };
}
