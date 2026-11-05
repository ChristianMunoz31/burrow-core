import { PRO_NOT_INCLUDED_COPY } from '../../constants/proFeatures';

/**
 * Fixed notice for a feature that lives in the private module when this build does not include it
 * (`PRO_UI_INCLUDED` false). There is nothing to buy or start: it only says the feature is absent here.
 * `capability` lands in `data-capability` so tests and hosts can tell which feature asked.
 */
export default function NotIncludedNotice({ capability, className = '' }) {
  return (
    <div
      data-capability={capability}
      data-reason="pro_not_included"
      className={`glass-subtle rounded-lg p-3 text-sm text-slate-slate300 ${className}`.trim()}
    >
      <p>{PRO_NOT_INCLUDED_COPY}</p>
    </div>
  );
}
