import { useMemo } from 'react';
import { useRecords } from './useRecords';
import { buildBudgetDashboard } from '../utils/budgetFromTransactions';
import {
  SAMPLE_CATEGORIES,
  SAMPLE_SUMMARY,
  SAMPLE_TREND,
} from '../data/budgetSample';

const SAMPLE = {
  summary: SAMPLE_SUMMARY,
  categories: SAMPLE_CATEGORIES,
  trend: SAMPLE_TREND,
  source: 'sample',
};

const ERROR = { summary: [], categories: [], trend: [], source: 'error' };

/**
 * Budget aggregates for the Budget module, derived from Burrow transactions
 * (shares the ['transactions'] react-query cache via useRecords). Falls back to
 * bundled sample data when there are no transactions yet, so the dashboard
 * always renders. When the transactions fetch failed, returns source 'error'
 * with empty aggregates instead (never sample data masquerading as real).
 */
export function useBudgetData() {
  const { records, loading, fetchFailed, fetchRecords } = useRecords();

  const data = useMemo(() => {
    if (fetchFailed) return ERROR;
    if (records.length === 0) return SAMPLE;
    const dashboard = buildBudgetDashboard(records);
    if (dashboard.summary.length === 0) return SAMPLE;
    return { ...dashboard, source: 'transactions' };
  }, [records, fetchFailed]);

  return {
    summary: data.summary,
    categories: data.categories,
    trend: data.trend,
    source: data.source,
    loading,
    refresh: fetchRecords,
  };
}
