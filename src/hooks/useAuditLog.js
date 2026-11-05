import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { auditService } from '../services/auditService';

const AUDIT_KEY = ['audit'];

/** Paged audit entries (newest first), cursor = the previous page's `nextBefore`. */
export function useAuditLog() {
  const queryClient = useQueryClient();
  const query = useInfiniteQuery({
    queryKey: AUDIT_KEY,
    queryFn: ({ pageParam, signal }) => auditService.list({ before: pageParam, signal }),
    initialPageParam: null,
    getNextPageParam: (page) => page.nextBefore ?? undefined,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    retry: false,
  });
  const pages = query.data?.pages ?? [];
  return {
    entries: pages.flatMap((p) => p.entries),
    available: pages.length === 0 ? null : pages[0].available,
    reason: pages[0]?.reason ?? null,
    isLoading: query.isPending,
    isFetching: query.isFetching,
    isFetchingNextPage: query.isFetchingNextPage,
    isFetchNextPageError: query.isFetchNextPageError,
    dataUpdatedAt: query.dataUpdatedAt,
    hasNextPage: !!query.hasNextPage,
    error: query.error,
    fetchNextPage: query.fetchNextPage,
    // Reset (not refetch) so a refresh always lands on page 1 instead of replaying every loaded page.
    refresh: () => queryClient.resetQueries({ queryKey: AUDIT_KEY }),
  };
}
