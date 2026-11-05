import { Link } from 'react-router-dom';
import { isProNotIncluded, useEntitlements } from '../../hooks/useEntitlements';
import { useLicense } from '../../hooks/useLicense';
import { NEWER_LICENSE_COPY, PRO_NOT_INCLUDED_COPY, labelsOf } from '../../constants/proFeatures';
import ProTrialPrompt from './ProTrialPrompt';
import BuyProLink from './BuyProLink';

const LINK_CLASS =
  'font-semibold text-slate-slate100 underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:[outline-color:var(--focus-ring)]';

/**
 * Store license past its update window, asked for a feature released after it (docs/LICENSING.md 6.1).
 * Not the "no Pro" upsell: the user has Pro, just not this newer part, and a newer license includes it.
 */
function NewerLicenseNotice({ capability, includedFeatures, className }) {
  const included = labelsOf(includedFeatures);
  return (
    <div
      data-capability={capability}
      data-reason="newer_license_required"
      className={`glass-subtle rounded-lg p-3 text-sm text-slate-slate300 ${className}`.trim()}
    >
      <p>{NEWER_LICENSE_COPY}</p>
      {included.length > 0 && (
        <p className="mt-1 text-xs">Your license still includes: {included.join(', ')}.</p>
      )}
      <p className="mt-1 text-xs">
        <Link
          to="/settings#license"
          className="font-semibold text-slate-slate100 underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:[outline-color:var(--focus-ring)]"
        >
          See your license in Settings &gt; License
        </Link>
      </p>
      <div className="mt-2 flex">
        <BuyProLink allowLicensed />
      </div>
    </div>
  );
}

/**
 * The prompt for a Pro action the user just tried without Pro. Renders nothing while the status
 * is unknown or Pro is on. The trial upsell is for people with no license and a usable clock; a
 * licensed user whose Pro lapsed, or a clock issue, gets one plain sentence instead, so the
 * attempt never fails silently and never tells a license holder their trial ended. A Store license
 * past its update window gets the distinct "newer license" notice for a feature it does not include,
 * and nothing for one it does. In a build without the Pro module (`isProNotIncluded`), a user who has Pro
 * gets the fixed "not included in this build" sentence instead.
 */
export default function ProGateNotice({ capability, className = '' }) {
  const entitlements = useEntitlements();
  const { known, pro, trial, proScope, includedFeatures } = entitlements;
  const { status } = useLicense();
  // Pro is on (trial or license) but this build has no Pro module: say so plainly, with no buy link.
  if (isProNotIncluded(entitlements)) {
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
  if (!known || pro) return null;
  if (proScope === 'features_until') {
    if (includedFeatures?.includes(capability)) return null;
    return <NewerLicenseNotice capability={capability} includedFeatures={includedFeatures} className={className} />;
  }
  const licensed = Boolean(status?.license);
  const clockIssue = status?.state === 'clock_issue';
  if (!licensed && !clockIssue && (trial?.state === 'available' || trial?.state === 'ended')) {
    return <ProTrialPrompt capability={capability} className={className} />;
  }
  return (
    <div data-capability={capability} className={`glass-subtle rounded-lg p-3 text-sm text-slate-slate300 ${className}`.trim()}>
      <p>
        This is a Burrow Pro feature. Pro is off on this computer.{' '}
        <Link to="/settings#license" className={LINK_CLASS}>
          See Settings &gt; License
        </Link>
      </p>
      {!licensed && (
        <div className="mt-2 flex">
          <BuyProLink />
        </div>
      )}
    </div>
  );
}
