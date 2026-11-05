import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { ouraService } from "../services/ouraService";
import { useNetworkFeature } from "./useNetworkFeature";
import { useRecords } from "./useRecords";
import { useHabits } from "./useHabits";
import { useJournal } from "./useJournal";
import { useCalendar } from "./useCalendar";
import { computeCrossInsights, WINDOW_DAYS } from "../utils/crossInsights";

const EMPTY = [];

// The window ends yesterday (local) but Oura days are dated in UTC, so ask for two spare days.
const OURA_DAYS = WINDOW_DAYS + 2;
const OURA_STALE_MS = 30 * 60 * 1000;

export function useOuraHistory(days = OURA_DAYS) {
  const { enabled } = useNetworkFeature("oura");
  const query = useQuery({
    queryKey: ["oura", "history", days],
    enabled,
    queryFn: async () => {
      const data = await ouraService.history(days);
      return {
        days: Array.isArray(data?.days) ? data.days : EMPTY,
        source: typeof data?.source === "string" ? data.source : null,
      };
    },
    staleTime: OURA_STALE_MS,
    // Health is optional here: one failed attempt means "not connected", not a retry storm.
    retry: false,
  });
  return {
    days: query.data?.days ?? EMPTY,
    source: query.data?.source ?? null,
  };
}

export function useCrossInsights() {
  const { records, loading: txLoading } = useRecords();
  const { habits, loading: habitsLoading } = useHabits();
  const { entries, loading: journalLoading } = useJournal();
  const { events, loading: calendarLoading } = useCalendar();
  const oura = useOuraHistory(OURA_DAYS);

  // A failed source yields an empty list (transactions) or an undefined query result, so it
  // contributes no series and can never produce a finding. Oura with no data ever loaded has a null
  // source (health pairs skipped); cached data is kept if a background refetch fails.
  const result = useMemo(
    () =>
      computeCrossInsights({
        transactions: records,
        ouraDays: oura.days,
        ouraSource: oura.source,
        habits,
        journal: entries,
        events,
      }),
    [records, oura.days, oura.source, habits, entries, events],
  );

  // Oura is deliberately not part of the blocking flag: the non-health pairs render as soon as
  // the rest is ready and the health-dependent pairs appear when Oura arrives.
  const loading =
    txLoading || habitsLoading || journalLoading || calendarLoading;
  return { result, loading };
}
