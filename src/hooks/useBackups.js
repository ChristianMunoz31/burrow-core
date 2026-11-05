import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createBackup,
  dismissAutoReminder,
  getBackupStatus,
  listBackups,
  setAutoBackup,
  updateBackupSettings,
} from '../services/backupService';

const BACKUPS_KEY = ['backups', 'list'];
export const BACKUP_STATUS_KEY = ['backups', 'status'];

/**
 * Status with the switch set to `enabled`. A scheduler that was paused on this computer stays paused;
 * the background refetch corrects anything this cannot know. The weekly reminder is the server's call.
 */
function withSwitch(status, enabled) {
  const paused = status?.autoSwitch !== false && status?.autoEnabled === false;
  return {
    ...status,
    autoSwitch: enabled,
    autoEnabled: enabled && !paused,
    autoOffReminder: false,
  };
}

/** Backup list, status and settings, plus "back up now", "save settings" and the automatic backups switch. */
export function useBackups() {
  const queryClient = useQueryClient();
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: BACKUPS_KEY }),
      queryClient.invalidateQueries({ queryKey: BACKUP_STATUS_KEY }),
    ]);

  const query = useQuery({
    queryKey: BACKUPS_KEY,
    queryFn: ({ signal }) => listBackups({ signal }),
    retry: false,
    refetchOnWindowFocus: false,
  });
  const backUp = useMutation({
    mutationFn: () => createBackup(),
    onSettled: refresh,
  });
  const save = useMutation({
    mutationFn: (settings) => updateBackupSettings(settings),
    onSettled: refresh,
  });
  // The switch answers with the new state: show it at once (so the control stops being busy as soon as
  // the PUT succeeds), then refetch in the background to pick up the server's own view.
  const auto = useMutation({
    mutationFn: (enabled) => setAutoBackup(enabled),
    onSuccess: (_saved, enabled) => {
      queryClient.setQueryData(BACKUPS_KEY, (old) => (old ? { ...old, status: withSwitch(old.status, enabled) } : old));
      queryClient.setQueryData(BACKUP_STATUS_KEY, (old) => (old ? withSwitch(old, enabled) : old));
    },
    onSettled: () => {
      void refresh();
    },
  });

  return {
    data: query.data ?? null,
    isLoading: query.isPending,
    error: query.error ?? null,
    refetch: query.refetch,
    isRefetching: query.isFetching,
    backUpNow: backUp.mutateAsync,
    isBackingUp: backUp.isPending,
    saveSettings: save.mutateAsync,
    isSaving: save.isPending,
    setAuto: auto.mutateAsync,
    isSettingAuto: auto.isPending,
  };
}

/** Light status poll for the Home notice. */
export function useBackupStatus() {
  const query = useQuery({
    queryKey: BACKUP_STATUS_KEY,
    queryFn: ({ signal }) => getBackupStatus({ signal }),
    staleTime: 60 * 1000,
    refetchInterval: 5 * 60 * 1000,
    retry: false,
    refetchOnWindowFocus: false,
  });
  return { status: query.data ?? null, isLoading: query.isPending };
}

/** Remembers, on the server, that the "automatic backups are off" reminder was dismissed. */
export function useDismissAutoReminder() {
  const queryClient = useQueryClient();
  // Hide the reminder at once (the query data is the single source of truth); put it back if saving fails.
  const dismiss = useMutation({
    mutationFn: () => dismissAutoReminder(),
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: BACKUP_STATUS_KEY });
      const previous = queryClient.getQueryData(BACKUP_STATUS_KEY);
      queryClient.setQueryData(BACKUP_STATUS_KEY, (old) => (old ? { ...old, autoOffReminder: false } : old));
      return { previous };
    },
    onError: (_error, _vars, context) => {
      if (context?.previous !== undefined) queryClient.setQueryData(BACKUP_STATUS_KEY, context.previous);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: BACKUP_STATUS_KEY }),
  });
  return dismiss.mutate;
}
