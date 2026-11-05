import { Link } from 'react-router-dom';
import { useLicense } from '../../hooks/useLicense';
import BuyProLink from './BuyProLink';

/**
 * Shown in place of a Pro-only action while Pro is off (docs/LICENSING.md section 12). The 14-day
 * trial starts by itself, so this is a plain upsell with no start button.
 * `capability` names the gated feature and lands in `data-capability` for future gating.
 * Renders nothing while the status is unknown, while Pro is on, or during an active trial.
 */
export default function ProTrialPrompt({ capability, className = '' }) {
  const { status } = useLicense();

  const trialState = status?.trial?.state;
  if (!status || status.pro || trialState === 'active') return null;
  if (trialState !== 'available' && trialState !== 'ended') return null;
  // The clock message elsewhere already explains why Pro is off.
  if (trialState === 'ended' && status.state === 'clock_issue') return null;

  return (
    <div
      data-capability={capability}
      className={`glass-subtle rounded-lg p-3 text-sm text-slate-slate300 ${className}`.trim()}
    >
      <p>This is a Burrow Pro feature.</p>
      {trialState === 'ended' && <p className="mt-1">Your Pro trial ended. Your data is all here.</p>}
      <p className="mt-2 text-xs">
        Have a license?{' '}
        <Link
          to="/settings#license"
          className="font-semibold text-slate-slate100 underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:[outline-color:var(--focus-ring)]"
        >
          Activate it in Settings &gt; License
        </Link>
      </p>
      <div className="mt-2 flex">
        <BuyProLink />
      </div>
    </div>
  );
}
