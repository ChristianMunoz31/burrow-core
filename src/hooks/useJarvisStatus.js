import { useQuery } from '@tanstack/react-query';
import { JARVIS_STATUS_KEY as KEY, fetchJarvisStatus } from './useCachedJarvisAi';

// Reads GET /api/jarvis/status: { available, provider, model, reason? }. The provider and
// model are changed in Settings > AI (see useAiSettings), which refreshes this query.
export function useJarvisStatus() {
  const query = useQuery({
    queryKey: KEY,
    queryFn: fetchJarvisStatus,
    staleTime: 60 * 1000,
  });

  return {
    status: query.data || null,
    loading: query.isPending,
    error: query.error ?? null,
  };
}
