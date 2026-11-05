import { useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { aiSettingsService } from '../services/aiSettingsService';

export const AI_SETTINGS_KEY = ['ai-settings'];
const AI_MODELS_KEY = ['ai-settings', 'models'];

// Everything that reads Javi availability refetches after a settings write.
export const AI_DEPENDENT_KEYS = [['jarvis-status']];

/**
 * Ollama status, installed models and the write calls for Settings > AI. The writes return
 * the saved settings payload, which replaces the cached status.
 */
export function useAiSettings() {
  const queryClient = useQueryClient();

  const settings = useQuery({
    queryKey: AI_SETTINGS_KEY,
    queryFn: aiSettingsService.get,
    staleTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
  });

  const ollamaRunning = settings.data?.ollama?.running === true;

  const models = useQuery({
    queryKey: AI_MODELS_KEY,
    queryFn: aiSettingsService.models,
    staleTime: 0,
    retry: false,
    enabled: ollamaRunning,
  });

  const afterWrite = useCallback(
    async (saved) => {
      queryClient.setQueryData(AI_SETTINGS_KEY, saved);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: AI_MODELS_KEY }),
        ...AI_DEPENDENT_KEYS.map((queryKey) => queryClient.invalidateQueries({ queryKey })),
      ]);
      return saved;
    },
    [queryClient],
  );

  const setModels = useCallback(
    async (input) => afterWrite(await aiSettingsService.setModels(input)),
    [afterWrite],
  );
  const setHost = useCallback(
    async (host) => afterWrite(await aiSettingsService.setHost(host)),
    [afterWrite],
  );
  const setProvider = useCallback(
    async (provider) => afterWrite(await aiSettingsService.setProvider(provider)),
    [afterWrite],
  );
  const setCloud = useCallback(
    async (input) => afterWrite(await aiSettingsService.setCloud(input)),
    [afterWrite],
  );

  const enableCloud = useCallback(
    async (input) => afterWrite(await aiSettingsService.enableCloud(input)),
    [afterWrite],
  );
  const disableCloud = useCallback(
    async () => afterWrite(await aiSettingsService.disableCloud()),
    [afterWrite],
  );
  const setCloudCategories = useCallback(
    async (categories) => afterWrite(await aiSettingsService.setCloudCategories(categories)),
    [afterWrite],
  );

  const refetchSettings = settings.refetch;
  const refetchModels = models.refetch;
  // The models query is disabled while Ollama is down; it starts by itself once the settings
  // refetch reports it running, so only refetch it here when it is already active.
  const refresh = useCallback(
    () => Promise.all([refetchSettings(), ollamaRunning ? refetchModels() : null]),
    [refetchSettings, refetchModels, ollamaRunning],
  );

  return {
    settings: settings.data ?? null,
    isLoading: settings.isPending,
    error: settings.error,
    installed: Array.isArray(models.data?.models) ? models.data.models : null,
    modelsLoading: models.isLoading,
    modelsError: models.error,
    isFetching: settings.isFetching || models.isFetching,
    refresh,
    setModels,
    setHost,
    setProvider,
    setCloud,
    enableCloud,
    disableCloud,
    setCloudCategories,
  };
}
