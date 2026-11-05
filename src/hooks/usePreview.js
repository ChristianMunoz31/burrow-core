import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { foldersService } from '../services/foldersService';
import { folderFilePreviewKey } from './folderKeys';

// Holding a step key moves the selection quickly; the request starts only once the file id has stayed put.
const PREVIEW_DEBOUNCE_MS = 120;

/**
 * The read-only preview of one file of a folder. The request starts once the file id has been stable for
 * 120 ms, and is aborted when the file changes or the view closes. Nothing retries on its own (a 409 or 429
 * will not fix itself); `refetch` is the manual retry.
 * @param {string} folderId
 * @param {string|null} fileId  null while nothing is selected (the hook does nothing)
 * @returns {{ preview: object|null, loading: boolean, error: (Error & { code?: string, status?: number })|null,
 *   refetch: () => Promise<unknown> }}
 */
export function usePreview(folderId, fileId) {
  const [stableId, setStableId] = useState(fileId);
  useEffect(() => {
    if (stableId === fileId) return undefined;
    const timer = setTimeout(() => setStableId(fileId), fileId ? PREVIEW_DEBOUNCE_MS : 0);
    return () => clearTimeout(timer);
  }, [fileId, stableId]);

  const wanted = Boolean(folderId && fileId);
  const enabled = wanted && stableId === fileId;
  const query = useQuery({
    queryKey: folderFilePreviewKey(folderId, fileId),
    queryFn: ({ signal }) => foldersService.preview(folderId, fileId, { signal }),
    enabled,
    retry: false,
    staleTime: 0,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });
  const loading = wanted && (!enabled || (query.isFetching && !query.data));
  return {
    preview: enabled ? (query.data?.preview ?? null) : null,
    loading,
    error: enabled && !loading ? (query.error ?? null) : null,
    refetch: query.refetch,
  };
}
