import { useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { foldersService } from '../services/foldersService';
import { JOB_POLL_MS, isJobActive } from '../constants/folders';
import { FOLDERS_KEY, folderFilesKey, folderJobKey, folderPreviewKey } from './folderKeys';

/**
 * Follows the job of one folder. It polls `GET /api/folders/:id/job` every 2000 ms while the job is queued or
 * running and stops once it ends. `active` is what the folder list says (the job to follow exists); the hook
 * does nothing while it is false. When the job ends, the list and the file list are refreshed once. If the
 * job read fails, polling stops and the list is refreshed once.
 * @param {string} folderId
 * @param {{ active: boolean }} options
 * @returns {{ job: object|null, polling: boolean }}
 */
export function useFolderJob(folderId, { active }) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: folderJobKey(folderId),
    queryFn: async () => (await foldersService.job(folderId)).job ?? null,
    enabled: Boolean(folderId) && active,
    retry: false,
    staleTime: 0,
    refetchOnWindowFocus: false,
    refetchInterval: (q) => {
      if (q.state.status === 'error') return false;
      return isJobActive(q.state.data) || q.state.data === undefined ? JOB_POLL_MS : false;
    },
  });

  const job = query.data ?? null;
  const handled = useRef('');
  useEffect(() => {
    if (!active || query.isFetching) return;
    if (query.isError) {
      const errorMark = `${folderId}:error:${query.errorUpdatedAt}`;
      if (handled.current === errorMark) return;
      handled.current = errorMark;
      queryClient.invalidateQueries({ queryKey: FOLDERS_KEY });
      return;
    }
    if (query.data === undefined) return;
    if (isJobActive(job)) return;
    // The list still shows a job in progress, but the server says it has ended (or has none).
    const mark = `${folderId}:${job?.id ?? 'none'}:${job?.status ?? ''}`;
    if (handled.current === mark) return;
    handled.current = mark;
    queryClient.invalidateQueries({ queryKey: FOLDERS_KEY });
    queryClient.invalidateQueries({ queryKey: folderFilesKey(folderId) });
    queryClient.invalidateQueries({ queryKey: folderPreviewKey(folderId) });
  }, [active, folderId, job, query.data, query.errorUpdatedAt, query.isError, query.isFetching, queryClient]);

  return { job, polling: active && !query.isError && (isJobActive(job) || query.data === undefined) };
}
