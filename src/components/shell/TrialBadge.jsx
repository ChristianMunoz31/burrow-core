import { Link } from 'react-router-dom';
import { useLicense } from '../../hooks/useLicense';
import { useProfile } from '../../hooks/useProfile';
import { PILL_CENTER, TONE_CLASS } from '../settings/pillStyles';

/**
 * "Pro trial: N days left" pill, only while Pro comes from the local trial and first-run onboarding
 * is done. Links to Settings > License. Hidden below `sm` so it never crushes the greeting; the
 * banner and Settings > License carry the same facts on a phone. min-h-6 keeps a 24px tap target.
 */
export default function TrialBadge() {
  const { status } = useLicense();
  const { onboarded, isLoading, unresolved } = useProfile();
  if (status?.proSource !== 'local_trial' || isLoading || unresolved || !onboarded) return null;
  const days = status.trial?.daysLeft;
  if (!Number.isFinite(days)) return null;
  const left = Math.ceil(Math.max(0, days));
  return (
    <Link
      to="/settings#license"
      className={`${PILL_CENTER} ${TONE_CLASS.ok} min-h-6 shrink-0 whitespace-nowrap max-sm:hidden focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:[outline-color:var(--focus-ring)]`}
    >
      Pro trial: {left} {left === 1 ? 'day' : 'days'} left
    </Link>
  );
}
