import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { foldersService } from '../services/foldersService';
import { FILES_PAGE_SIZE, JOB_POLL_MS } from '../constants/folders';
import { folderFilesPageKey } from './folderKeys';

/**
 * One page of a folder's file list. Keeps the previous page on screen while the next one loads. With `polling`
 * (a scan job is active) the page is read again every 2000 ms so summaries appear as they are written.
 * @param {string} folderId
 * @param {{ offset?: number, sort?: 'path'|'size'|'modified'|'status', dir?: 'asc'|'desc', enabled?: boolean, polling?: boolean }} [options]
 */
export function useFolderFiles(folderId, { offset = 0, sort = 'path', dir = 'asc', enabled = true, polling = false } = {}) {
  const query = useQuery({
    queryKey: folderFilesPageKey(folderId, { offset, sort, dir }),
    queryFn: () => foldersService.files(folderId, { offset, limit: FILES_PAGE_SIZE, sort, dir }),
    enabled: Boolean(folderId) && enabled,
    placeholderData: keepPreviousData,
    retry: false,
    refetchInterval: polling ? JOB_POLL_MS : false,
  });
  return {
    files: query.data?.files ?? [],
    total: query.data?.total ?? 0,
    loading: query.isPending && enabled,
    error: query.error ?? null,
    refetch: query.refetch,
  };
}
