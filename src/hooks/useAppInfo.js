import { useQuery } from '@tanstack/react-query';
import { getAppInfo } from '../services/appInfoService';

const APP_INFO_QUERY_KEY = ['app', 'info'];

/** The running app's version, channel, commit and build date. `info` is null until it loads or when it cannot be read; `isLoading` is true only until the first answer; `refetch` retries a failed read. */
export function useAppInfo() {
  const query = useQuery({
    queryKey: APP_INFO_QUERY_KEY,
    queryFn: getAppInfo,
    staleTime: Infinity,
    retry: 1,
    refetchOnWindowFocus: false,
  });
  return { info: query.data ?? null, isLoading: query.isPending, refetch: query.refetch };
}
