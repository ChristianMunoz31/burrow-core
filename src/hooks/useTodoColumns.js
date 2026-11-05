import { useCallback, useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { todoColumnsService } from '../services/todoColumnsService';

const QUERY_KEY = ['todoColumns'];
const TODOS_KEY = ['todos'];

export function useTodoColumns() {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => todoColumnsService.list(),
  });

  const refresh = useCallback(
    () => queryClient.invalidateQueries({ queryKey: QUERY_KEY }),
    [queryClient],
  );

  const addMutation = useMutation({
    mutationFn: (col) => todoColumnsService.create(col),
    onSettled: refresh,
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, patch }) => todoColumnsService.update(id, patch),
    // A rename moves the column's todos on the server, so the todo list is stale too.
    onSuccess: (_data, { patch }) => {
      if (patch && 'name' in patch) return queryClient.invalidateQueries({ queryKey: TODOS_KEY });
      return undefined;
    },
    onSettled: refresh,
  });

  const removeMutation = useMutation({
    mutationFn: (id) => todoColumnsService.remove(id),
    onSettled: refresh,
  });

  const add = useCallback((col) => addMutation.mutateAsync(col), [addMutation]);
  const update = useCallback(
    (id, patch) => updateMutation.mutateAsync({ id, patch }),
    [updateMutation],
  );
  const remove = useCallback((id) => removeMutation.mutateAsync(id), [removeMutation]);

  const result = query.data;
  const columns = useMemo(() => {
    const cols = Array.isArray(result?.columns) ? result.columns : [];
    return cols.slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  }, [result]);

  return {
    columns,
    source: result?.source || 'default',
    writable: result?.writable ?? (result?.source !== 'default'),
    loading: query.isPending,
    error: query.data ? null : (query.error ?? null),
    refresh,
    add,
    update,
    remove,
  };
}
