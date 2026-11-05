import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { dataBrowserService } from '../services/dataBrowserService';

export function useDataTables() {
  return useQuery({
    queryKey: ['data-tables'],
    queryFn: dataBrowserService.listTables,
    staleTime: 60_000,
    retry: false,
  });
}

export function useTableRows(table, params) {
  return useQuery({
    queryKey: ['data-rows', table, params],
    queryFn: () => dataBrowserService.getRows(table, params),
    enabled: !!table,
    placeholderData: keepPreviousData,
    retry: false,
  });
}

export function useTableOverview(table, enabled = true) {
  return useQuery({
    queryKey: ['data-overview', table],
    queryFn: () => dataBrowserService.getOverview(table),
    enabled: !!table && enabled,
    staleTime: 5 * 60_000,
    retry: false,
  });
}
