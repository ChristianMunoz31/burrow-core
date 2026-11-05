import { useCallback, useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { focusService } from '../services/focusService';

const QUERY_KEY = ['focus'];
const EMPTY = [];

function isToday(iso) {
  if (!iso) return false;
  const d = new Date(iso);
  const now = new Date();
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
}

export function useFocus() {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: QUERY_KEY,
    queryFn: async () => {
      const result = await focusService.list();
      return Array.isArray(result) ? result : [];
    },
  });

  const addMutation = useMutation({
    mutationFn: (session) => focusService.create(session),
    onSettled: () => queryClient.invalidateQueries({ queryKey: QUERY_KEY }),
  });

  const refresh = useCallback(
    () => queryClient.invalidateQueries({ queryKey: QUERY_KEY }),
    [queryClient],
  );

  const log = useCallback((session) => addMutation.mutateAsync(session), [addMutation]);

  const sessions = query.data ?? EMPTY;

  // Today's completed focus sessions → count + total minutes for the stat line.
  const today = useMemo(() => {
    const todays = sessions.filter((s) => s.kind === 'focus' && isToday(s.startedAt));
    return {
      count: todays.length,
      minutes: todays.reduce((sum, s) => sum + (s.durationMin || 0), 0),
    };
  }, [sessions]);

  return {
    sessions,
    today,
    loading: query.isPending,
    error: query.error ?? null,
    refresh,
    log,
  };
}
