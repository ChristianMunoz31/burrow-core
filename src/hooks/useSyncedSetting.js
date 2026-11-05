import { useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { stateService } from '../services/stateService';
import {
  clearDirty,
  isDirty,
  readLocal,
  readRaw,
  writeLocal,
} from '../utils/syncMode';

// localStorage acts as a synchronous cache so values paint instantly; the data file is
// the source of truth (see utils/syncMode.js for keys whose save is still pending).
// readLocal tolerates legacy raw (non-JSON) values.

/**
 * A single setting saved to the database with a localStorage cache.
 * Returns `[value, set, meta]`. `set(next, { onError })` accepts a value or an
 * updater function, applies it locally right away and returns the resolved
 * value. The server save is best-effort; `onError(err)` (optional) is called if
 * it fails so callers can tell the user the change is only on this device.
 */
export function useSyncedSetting(key, fallback) {
  if (import.meta.env.DEV && key.startsWith('storage:')) {
    console.error(`useSyncedSetting: "${key}" is device-local and must not be synced.`);
  }
  const queryClient = useQueryClient();
  const queryKey = ['state', key];

  const query = useQuery({
    queryKey,
    // Coalesce to null: stateService.get returns undefined for a never-stored key,
    // which React Query rejects as query data. null is treated as "use fallback"
    // below, identical to undefined, so this is safe for every consumer.
    queryFn: async ({ signal }) => {
      // A key with unsaved local changes: the local copy wins (no migration, no cache overwrite).
      if (isDirty(key)) return readLocal(key) ?? null;
      const remote = await stateService.get(key);
      // Dirtiness may have flipped while the GET was in flight.
      if (isDirty(key)) return readLocal(key) ?? null;
      // set() cancels in-flight fetches; the shared GET still resolves, so skip
      // the cache write/migration or the stale server value would overwrite it.
      if (signal?.aborted) return remote ?? null;
      if (remote === undefined || remote === null) {
        // Server has no row: keep a local-only/legacy value and migrate it up.
        const local = readLocal(key);
        if (local === undefined || local === null) return null;
        stateService.put(key, local).catch(() => {});
        return local;
      }
      // Refresh the cache so the next load paints the synced value, not a stale one.
      writeLocal(key, remote);
      return remote;
    },
    // Paint from the local cache immediately, but treat it as stale so the synced
    // value is fetched in the background (and reconciled across devices).
    initialData: () => readLocal(key),
    initialDataUpdatedAt: 0,
  });

  const value = query.data === undefined || query.data === null ? fallback : query.data;

  const set = useCallback(
    (next, options) => {
      const current = queryClient.getQueryData(queryKey);
      const base = current === undefined || current === null ? fallback : current;
      const resolved = typeof next === 'function' ? next(base) : next;
      const written = writeLocal(key, resolved);
      const raw = written ? readRaw(key) : null;
      // Drop any in-flight fetch so its stale server value cannot overwrite this.
      void queryClient.cancelQueries({ queryKey });
      queryClient.setQueryData(queryKey, resolved);
      const onError = typeof options?.onError === 'function' ? options.onError : null;
      stateService
        .put(key, resolved)
        .then(() => {
          // The data file now holds this exact value, so a stale dirty flag is obsolete.
          if (raw !== null && isDirty(key) && readRaw(key) === raw) clearDirty(key);
        })
        .catch((err) => onError?.(err));
      return resolved;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key, fallback, queryClient],
  );

  return [value, set, { isFetched: query.isFetched, isLoading: query.isPending }];
}
