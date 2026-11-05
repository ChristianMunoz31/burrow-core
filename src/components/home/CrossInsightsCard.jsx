import { memo, useId, useMemo } from "react";
import { Sparkles } from "lucide-react";
import { useCrossInsights } from "../../hooks/useCrossInsights";
import {
  toExplainSummary,
  CROSS_INSIGHT_PAIRS,
} from "../../utils/crossInsights";
import AiUnavailable from "../shared/AiUnavailable";
import Markdown from "../shared/Markdown";
import { useInsightsExplain } from "../../extensions/proExtensions";
import NotIncludedNotice from "../shared/NotIncludedNotice";
import { btnPrimary } from "../shared/formStyles";

const DISALLOWED_ELEMENTS = ["img"];

// Correlation card on Home. Everything is computed in the browser from cached data;
// "Explain" sends only the numeric summary stats to the local model (Ollama).
// Renders nothing (no empty state, skeleton or diagnostics) unless there is a real finding.
function CrossInsightsCard() {
  const { result, loading } = useCrossInsights();
  const headingId = useId();

  // Stable identity of what Explain would send; a change means any shown explanation is stale.
  const summaryKey = useMemo(
    () => JSON.stringify(toExplainSummary(result)),
    [result],
  );

  const {
    explaining,
    explanation,
    error,
    unavailable,
    unavailableReason,
    unavailableMessage,
    proAttempted,
    explain,
  } = useInsightsExplain({ result, summaryKey });

  if (loading || result.insights.length === 0) return null;

  return (
    <section className="mb-5 glass rounded-2xl p-5" aria-labelledby={headingId}>
      <div className="flex items-center gap-2">
        <Sparkles
          size={16}
          className="text-accent-purple shrink-0"
          aria-hidden="true"
        />
        <h3
          id={headingId}
          className="text-sm font-semibold text-slate-slate100"
        >
          Patterns across your data
        </h3>
      </div>

      <div className="mt-2">
        <ul className="space-y-2">
          {result.insights.map((insight) => (
            <li key={insight.id}>
              <p className="text-sm text-slate-slate200">{insight.text}</p>
              <p className="text-xs text-slate-slate400">
                Based on {insight.groupA.days} and {insight.groupB.days} days
              </p>
            </li>
          ))}
        </ul>
        <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
          <p className="text-[11px] text-slate-slate400">
            Correlation, not causation. Tested across{" "}
            {CROSS_INSIGHT_PAIRS.length} pairs.
          </p>
          <button
            type="button"
            onClick={explain}
            aria-disabled={explaining}
            aria-busy={explaining}
            className={`${btnPrimary} shrink-0 self-start sm:self-auto ${
              explaining ? "opacity-50 cursor-not-allowed" : ""
            }`}
          >
            <Sparkles size={14} aria-hidden="true" />{" "}
            {explaining ? "Explaining…" : "Explain"}
          </button>
        </div>
        {proAttempted && <NotIncludedNotice capability="explain" className="mt-2" />}
        {error &&
          (unavailable ? (
            <div className="mt-2">
              <AiUnavailable message={unavailableMessage} reason={unavailableReason} className="text-sm text-slate-slate300" />
            </div>
          ) : (
            <p role="alert" className="mt-2 text-sm text-accent-red">
              {error}
            </p>
          ))}
        <div aria-live="polite" className="mt-3 empty:mt-0">
          {explanation && (
            <div className="prose-jarvis text-sm text-slate-slate200 break-words">
              <Markdown disallowedElements={DISALLOWED_ELEMENTS} unwrapDisallowed>
                {explanation}
              </Markdown>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

export default memo(CrossInsightsCard);
