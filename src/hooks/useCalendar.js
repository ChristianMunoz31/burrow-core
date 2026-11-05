import { useCallback, useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { calendarService } from '../services/calendarService';
import { newId } from '../utils/ids';

const QUERY_KEY = ['calendar'];

export function useCalendar() {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: QUERY_KEY,
    queryFn: async () => {
      const data = await calendarService.list();
      return Array.isArray(data?.events) ? data.events : [];
    },
    staleTime: 5 * 60 * 1000,
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
    mutationFn: (event) => calendarService.create(event),
    onMutate: (event) =>
      optimistic((prev) => [
        ...prev,
        { id: `temp-${newId()}`, source: 'manual', context: 'both', ...event },
      ]),
    onError: rollback,
    onSettled: invalidate,
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, patch }) => calendarService.update(id, patch),
    onMutate: ({ id, patch }) =>
      optimistic((prev) => prev.map((e) => (e.id === id ? { ...e, ...patch } : e))),
    onError: rollback,
    onSettled: invalidate,
  });

  const removeMutation = useMutation({
    mutationFn: (id) => calendarService.remove(id),
    onMutate: (id) => optimistic((prev) => prev.filter((e) => e.id !== id)),
    onError: rollback,
    onSettled: invalidate,
  });

  const importMutation = useMutation({
    mutationFn: ({ ics, context }) => calendarService.importIcs(ics, context),
    onSettled: invalidate,
  });

  const add = useCallback((event) => addMutation.mutateAsync(event), [addMutation]);
  const update = useCallback(
    (id, patch) => updateMutation.mutateAsync({ id, patch }),
    [updateMutation],
  );
  const remove = useCallback((id) => removeMutation.mutateAsync(id), [removeMutation]);
  const importIcs = useCallback(
    (ics, context) => importMutation.mutateAsync({ ics, context }),
    [importMutation],
  );

  // Events are sorted ascending by start so callers can rely on chronological
  // order. slice() first: sort works in place and must not reorder the cache.
  const events = useMemo(
    () => (query.data ?? []).slice().sort((a, b) => String(a.start).localeCompare(String(b.start))),
    [query.data],
  );

  return {
    events,
    loading: query.isPending,
    error: query.error ?? null,
    refresh,
    add,
    update,
    remove,
    importIcs,
  };
}
