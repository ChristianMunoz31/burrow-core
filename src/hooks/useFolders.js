import { useCallback } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { foldersService } from '../services/foldersService';
import { FOLDERS_KEY, folderFilesKey, folderJobKey, folderPreviewKey } from './folderKeys';
import { useShellDialog } from './useShellDialog';

/**
 * The folder list with its limits, plus the write calls. A write refreshes the list before it resolves,
 * so the card already shows the queued job. `exportFolder` changes nothing on the page. `pick` and
 * `exportToChosen` open a window in the Burrow app (only when `canPickFolder` / `canSaveFile`) and resolve to
 * its final view; one window is open at a time, and `dialogActive` is true meanwhile.
 */
export function useFolders() {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: FOLDERS_KEY,
    queryFn: foldersService.list,
    retry: false,
  });

  const refresh = useCallback(
    () => queryClient.invalidateQueries({ queryKey: FOLDERS_KEY }),
    [queryClient],
  );

  // A job the server just returned goes straight into the job cache, so the poller starts from it.
  const rememberJob = useCallback(
    (job) => {
      if (job?.folderId) queryClient.setQueryData(folderJobKey(job.folderId), job);
    },
    [queryClient],
  );

  const addMutation = useMutation({
    mutationFn: (input) => foldersService.add(input),
    onSuccess: async (result) => {
      rememberJob(result?.job);
      await refresh();
    },
  });
  const updateMutation = useMutation({
    mutationFn: ({ id, patch }) => foldersService.update(id, patch),
    onSuccess: refresh,
  });
  const removeMutation = useMutation({
    mutationFn: (id) => foldersService.remove(id),
    onSuccess: async (_data, id) => {
      queryClient.removeQueries({ queryKey: folderJobKey(id) });
      queryClient.removeQueries({ queryKey: folderFilesKey(id) });
      queryClient.removeQueries({ queryKey: folderPreviewKey(id) });
      await refresh();
    },
  });
  const scanMutation = useMutation({
    mutationFn: (id) => foldersService.scan(id),
    onSuccess: async (result) => {
      rememberJob(result?.job);
      await refresh();
    },
  });
  const cancelMutation = useMutation({
    mutationFn: (id) => foldersService.cancel(id),
    onSuccess: async (result) => {
      rememberJob(result?.job);
      await refresh();
    },
  });

  const confirmMutation = useMutation({
    mutationFn: ({ id, path }) => foldersService.confirm(id, path),
    onSuccess: async (result) => {
      rememberJob(result?.job);
      await refresh();
    },
  });

  const shell = useShellDialog();
  const { start: startDialog } = shell;
  const pick = useCallback(
    async (folderId) => {
      const result = await startDialog(foldersService.pick(folderId));
      if (result?.status === 'added') {
        rememberJob(result.job);
        await refresh();
      }
      return result;
    },
    [startDialog, rememberJob, refresh],
  );
  const exportToChosen = useCallback((id, format) => startDialog(foldersService.exportToChosen(id, format)), [startDialog]);

  const { mutateAsync: confirmAsync } = confirmMutation;
  const confirm = useCallback((id, path) => confirmAsync({ id, path }), [confirmAsync]);
  const { mutateAsync: updateAsync } = updateMutation;
  const update = useCallback((id, patch) => updateAsync({ id, patch }), [updateAsync]);

  return {
    folders: query.data?.folders ?? [],
    limits: query.data?.limits ?? null,
    canPickFolder: query.data?.canPickFolder === true,
    canSaveFile: query.data?.canSaveFile === true,
    loading: query.isPending,
    // A failed refresh keeps the list on screen; the error only matters when there is nothing to show.
    error: query.data ? null : (query.error ?? null),
    refresh,
    add: addMutation.mutateAsync,
    update,
    remove: removeMutation.mutateAsync,
    scan: scanMutation.mutateAsync,
    cancel: cancelMutation.mutateAsync,
    confirm,
    pick,
    exportToChosen,
    cancelDialog: shell.cancel,
    dialogActive: shell.active,
    exportFolder: foldersService.exportFile,
  };
}
