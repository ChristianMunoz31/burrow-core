import { useCallback, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { licenseService } from '../services/licenseService';

export const LICENSE_QUERY_KEY = ['license'];

// Query keys that depend on the real license state (a Settings extension reads them); a real license change
// invalidates this prefix. Nothing uses it in the core, so the invalidation is a no-op there.
export const LICENSE_DEPENDENT_QUERY_KEY = ['license-dependent'];

export const TRIAL_POLL_MIN_MS = 30_000;
export const TRIAL_POLL_MAX_MS = 60 * 60 * 1000;

/**
 * While the local trial runs, re-read the status on a timer aimed just past the trial end (never
 * faster than 30 s, never slower than 1 h), so the ended flip and the header pill update without a
 * window focus change. Any other state (licensed, Free, unknown) does not poll.
 */
export function trialRefetchInterval(query) {
  const data = query.state.data;
  if (data?.proSource !== 'local_trial') return false;
  const endsAt = Date.parse(data.trial?.endsAt ?? '');
  if (Number.isNaN(endsAt)) return TRIAL_POLL_MAX_MS;
  const untilEnd = endsAt - Date.now() + 1000;
  return Math.min(TRIAL_POLL_MAX_MS, Math.max(TRIAL_POLL_MIN_MS, untilEnd));
}

const LICENSE_QUERY_OPTIONS = {
  queryKey: LICENSE_QUERY_KEY,
  queryFn: licenseService.get,
  staleTime: 30_000,
  retry: false,
  refetchOnWindowFocus: true,
};

/**
 * Returns a function that marks the license status stale and re-reads it. Call it where a
 * 403 pro_required is caught: the cached status said Pro, the server says otherwise.
 */
export function useRefreshEntitlements() {
  const queryClient = useQueryClient();
  return useCallback(
    () => queryClient.invalidateQueries({ queryKey: LICENSE_QUERY_KEY }).catch(() => {}),
    [queryClient],
  );
}

/**
 * License status plus activate/deactivate/remove/dismissTrialNotice actions. Each returns the new status and updates the cache.
 * `pollTrial` makes this reader run the trial-end timer; exactly one always-mounted reader (TrialNotice
 * in the app shell) sets it, so N readers do not each poll.
 */
export function useLicense({ pollTrial = false } = {}) {
  const queryClient = useQueryClient();
  const query = useQuery(pollTrial ? { ...LICENSE_QUERY_OPTIONS, refetchInterval: trialRefetchInterval } : LICENSE_QUERY_OPTIONS);

  const actions = useMemo(
    () =>
      Object.fromEntries(
        ['activate', 'deactivate', 'remove', 'dismissTrialNotice'].map((name) => [
          name,
          async (input) => {
            const status = await licenseService[name](input);
            queryClient.setQueryData(LICENSE_QUERY_KEY, status);
            return status;
          },
        ]),
      ),
    [queryClient],
  );

  return {
    status: query.data ?? null,
    // A retry after a failed load keeps the error view (with a disabled Retry) instead of the skeleton.
    isLoading: query.isPending && query.errorUpdateCount === 0,
    isFetching: query.isFetching,
    refetch: query.refetch,
    ...actions,
  };
}

const UNKNOWN_FLAGS = Object.freeze({
  known: false,
  founderBackground: false,
  pro: false,
  trial: null,
  proScope: null,
  includedFeatures: [],
});

const NO_FEATURES = Object.freeze([]);

const selectFlags = (status) =>
  status
    ? {
        known: true,
        founderBackground: status.perks?.founderBackground === true,
        pro: status.pro === true,
        trial: status.trial ?? null,
        // 'features_until': a Store license past its update window that keeps the features listed in includedFeatures.
        proScope: status.proScope === 'features_until' ? 'features_until' : null,
        includedFeatures: Array.isArray(status.proFeatures?.included) ? status.proFeatures.included : NO_FEATURES,
      }
    : UNKNOWN_FLAGS;

/**
 * Small derived view of the license status for chrome that must not re-render with
 * every field (theme, gating). `known` is false while the status is loading or failed
 * to load (for example a 401 before login), so callers keep their saved preference.
 */
export function useLicenseFlags() {
  const { data } = useQuery({ ...LICENSE_QUERY_OPTIONS, select: selectFlags });
  return data ?? UNKNOWN_FLAGS;
}
