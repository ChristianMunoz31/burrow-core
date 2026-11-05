import { useQuery } from '@tanstack/react-query';

/** React Query key of the cached daily briefing; the refresh mutation of the private module writes the new briefing under it. */
export const BRIEFING_QUERY_KEY = ['jarvis-briefing'];

/** True when the briefing was written today (local date). Home and Javi use it. */
export const isBriefingToday = (b) =>
  Boolean(b?.generatedAt) && new Date(b.generatedAt).toDateString() === new Date().toDateString();

// Reads the cached daily briefing (GET /api/jarvis/briefing). Shared by the Javi card on Home, Home and the TopBar
// notification bell. Writing a new briefing comes from the private module (the UI hook useBriefingRefresh).
export function useBriefing() {
  const query = useQuery({
    queryKey: BRIEFING_QUERY_KEY,
    queryFn: async () => {
      const res = await fetch('/api/jarvis/briefing');
      if (!res.ok) return null;
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
  });

  const data = query.data;
  const briefing = data && !data.empty ? data : null;

  return {
    briefing,
    alerts: briefing?.alerts ?? [],
    loading: query.isPending,
    error: query.error ?? null,
    refetch: query.refetch,
  };
}
