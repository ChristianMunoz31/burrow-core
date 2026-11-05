import { useQuery } from '@tanstack/react-query';

export const JARVIS_STATUS_KEY = ['jarvis-status'];

export const fetchJarvisStatus = async () => {
  const res = await fetch('/api/jarvis/status');
  return res.ok ? res.json() : null;
};

/**
 * Where Javi runs ({ kind, host }) from the status already in the query cache, with no request
 * of its own: the panel's useJarvisStatus fetches it when Javi opens, and this follows the cache.
 * For code that must not call the server on mount.
 * @returns {{ ai: { kind: string, host: string | null } | null }}
 */
export function useCachedJarvisAi() {
  const query = useQuery({ queryKey: JARVIS_STATUS_KEY, queryFn: fetchJarvisStatus, enabled: false });
  return { ai: query.data?.ai ?? null };
}
