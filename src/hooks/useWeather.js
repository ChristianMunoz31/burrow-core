import { useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { weatherService } from '../services/weatherService';
import { isNetworkOptInError } from '../utils/apiError';
import { useNetworkFeature } from './useNetworkFeature';

// The forecast for the location saved in Settings > Network (the server falls back to its own default). This hook
// never asks the browser for the device location: that happens only on a click on Use my location in Settings
// (requestDeviceLocation in src/utils/weatherLocation.js). With Weather off it makes no request at all.
export function useWeather() {
  const queryClient = useQueryClient();
  const { settingsLoading, offError } = useNetworkFeature('weather');

  const query = useQuery({
    queryKey: ['weather'],
    queryFn: () => weatherService.fetch(),
    enabled: !settingsLoading && !offError,
    // The server answers no-store; React Query keeps the forecast for 30 minutes, so a remount within that time
    // reuses it. Settings resets this query when the location is saved or cleared.
    staleTime: 30 * 60_000,
    // An off opt-in feature answers 403 until the user turns it on, and a missing location until one is saved.
    retry: (failureCount, err) => !isNetworkOptInError(err) && !err?.locationMissing && failureCount < 1,
  });

  const refresh = useCallback(
    () => queryClient.invalidateQueries({ queryKey: ['weather'] }),
    [queryClient],
  );

  return {
    data: query.data ?? null,
    loading: settingsLoading || (!offError && query.isPending),
    error: offError ?? query.error ?? null,
    // 'saved' for the location typed in Settings, 'default' for the server's own default location.
    locationSource: locationSourceOf(query.data),
    updatedAt: query.dataUpdatedAt,
    refresh,
  };
}

const locationSourceOf = (data) => (data?.locationSource === 'saved' ? 'saved' : 'default');

/**
 * The newest forecast already in the query cache with where its location came from, or null. Never fetches.
 * @param {import('@tanstack/react-query').QueryClient} queryClient
 */
export function latestCachedWeather(queryClient) {
  let best = null;
  for (const q of queryClient.getQueryCache().findAll({ queryKey: ['weather'] })) {
    if (q.state.data && (!best || q.state.dataUpdatedAt > best.state.dataUpdatedAt)) best = q;
  }
  if (!best) return null;
  return { data: best.state.data, locationSource: locationSourceOf(best.state.data) };
}

/**
 * For a Javi page context (Home): a reader that returns the forecast the Javi card already loaded, or null while
 * Weather is off. It never fetches and never asks for the location.
 */
export function useCachedWeatherReader() {
  const queryClient = useQueryClient();
  const { enabled } = useNetworkFeature('weather');
  return useCallback(() => (enabled ? latestCachedWeather(queryClient) : null), [enabled, queryClient]);
}
