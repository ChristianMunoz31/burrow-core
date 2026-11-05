import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { aiSettingsService } from '../services/aiSettingsService';
import { AI_DEPENDENT_KEYS, AI_SETTINGS_KEY } from './useAiSettings';
import { cancelPull, getSnapshot, resetPull, startPull, subscribe } from './ollamaPullStore';

// Nested under ['ai-settings'] so invalidating the AI settings also refreshes the setup state.
export const OLLAMA_SETUP_KEY = ['ai-settings', 'setup'];

const isSetupQuery = (query) => query.queryKey[1] === 'setup';

/**
 * First-run Ollama setup: the setup state (fetched once, refetched on demand) and the model
 * download state. The download lives in a module-level store (`ollamaPullStore`), so it keeps
 * running when the component that shows it unmounts; only `cancel` aborts it. When a download
 * finishes, the AI settings and Javi status queries are refreshed so Javi becomes available
 * without a reload. `checkAgain` refreshes the whole `['ai-settings']` prefix plus the Javi
 * status, so every part of Settings > AI syncs with one click.
 */
export function useOllamaSetup() {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: OLLAMA_SETUP_KEY,
    queryFn: aiSettingsService.setup,
    staleTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const pull = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  // A finished, failed or cancelled download from an earlier visit is not news; a running one is kept.
  useEffect(() => {
    resetPull();
  }, []);

  const start = useCallback(
    (model) =>
      startPull(model, {
        // Rejects when the setup state cannot be refreshed, so the UI can say so.
        onFinished: () =>
          Promise.all([
            queryClient.invalidateQueries({ queryKey: AI_SETTINGS_KEY }, { throwOnError: true }),
            ...AI_DEPENDENT_KEYS.map((queryKey) => queryClient.invalidateQueries({ queryKey })),
          ]),
      }),
    [queryClient],
  );

  const checkAgain = useCallback(async () => {
    resetPull();
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: AI_SETTINGS_KEY }),
      ...AI_DEPENDENT_KEYS.map((queryKey) => queryClient.invalidateQueries({ queryKey })),
    ]);
  }, [queryClient]);

  // Ollama or a model installed outside Burrow: a recheck flips ready false -> true, so the
  // rest of the app (settings status, Javi) must learn about it too.
  const ready = query.data?.ready;
  const prevReady = useRef(undefined);
  useEffect(() => {
    if (typeof ready !== 'boolean') return;
    const becameReady = prevReady.current === false && ready;
    prevReady.current = ready;
    if (!becameReady || getSnapshot().status === 'done') return;
    queryClient.invalidateQueries({
      queryKey: AI_SETTINGS_KEY,
      predicate: (q) => !isSetupQuery(q),
    });
    AI_DEPENDENT_KEYS.forEach((queryKey) => queryClient.invalidateQueries({ queryKey }));
  }, [ready, queryClient]);

  return {
    setup: query.data ?? null,
    isLoading: query.isPending,
    isFetching: query.isFetching,
    error: query.error ?? null,
    checkAgain,
    pull,
    startPull: start,
    cancel: cancelPull,
  };
}
