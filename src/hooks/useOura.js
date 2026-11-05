import { useCallback, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ouraService } from '../services/ouraService';
import { isNetworkOptInError } from '../utils/apiError';
import { useNetworkFeature } from './useNetworkFeature';

const EMPTY_DAYS = [];

export function useOura() {
  const queryClient = useQueryClient();
  const { enabled, settingsLoading, offError } = useNetworkFeature('oura');

  const query = useQuery({
    queryKey: ['oura'],
    enabled,
    queryFn: async () => {
      const data = await ouraService.summary();
      return Array.isArray(data?.days) ? data.days : [];
    },
    // An off opt-in feature answers 403 until the user turns it on: never retry it.
    retry: (failureCount, err) => !isNetworkOptInError(err) && failureCount < 1,
  });

  const days = query.data ?? EMPTY_DAYS;

  // Most recent day that actually has at least one metric.
  const latest = useMemo(() => {
    for (let i = days.length - 1; i >= 0; i--) {
      const d = days[i];
      if (
        d.readiness != null ||
        d.sleep != null ||
        d.activity != null ||
        d.restingHr != null
      ) {
        return d;
      }
    }
    return null;
  }, [days]);

  const refresh = useCallback(
    () => queryClient.invalidateQueries({ queryKey: ['oura'] }),
    [queryClient],
  );

  return {
    days,
    latest,
    loading: settingsLoading || (enabled && query.isPending),
    error: offError ?? query.error ?? null,
    updatedAt: query.dataUpdatedAt,
    refresh,
  };
}
