import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useLicense } from '../../hooks/useLicense';
import { useProfile } from '../../hooks/useProfile';
import { TRIAL_DAYS } from '../../constants/trial';
import { BTN, LINK_BTN } from '../settings/pillStyles';
import BuyProLink from './BuyProLink';
import { PRO_UI_INCLUDED } from '../../extensions/proExtensions';

/** Date only, in the user's locale. UTC so it matches the date the server reports. */
function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeZone: 'UTC' }).format(date);
}

/** Title, body and the dismiss label for each notice the server can ask for. */
function copyFor(notice, endsAt, daysLeft) {
  switch (notice) {
    case 'welcome': {
      // Mid-trial welcomes (a licensed user removes the license on day 10) show what is really left.
      const days = Number.isFinite(daysLeft) ? Math.ceil(Math.max(0, daysLeft)) : TRIAL_DAYS;
      return {
        title: `Burrow Pro is on for ${days} ${days === 1 ? 'day' : 'days'}.`,
        body: "Javi's follow-up questions, actions, briefings and Explain are unlocked. No card, no account, nothing leaves this computer. After that you move to Burrow Free and keep all your data.",
        dismiss: 'Got it',
        showLink: false,
      };
    }
    case 'ending_soon': {
      const date = formatDate(endsAt);
      return {
        title: date ? `Your Pro trial ends on ${date}.` : 'Your Pro trial ends soon.',
        body: 'Your data stays right here either way. Keep Pro any time with a Burrow Pro license.',
        dismiss: 'Dismiss',
        showLink: true,
      };
    }
    case 'ended':
      return {
        title: "Your Pro trial ended. You're on Burrow Free.",
        body: "All your data, export, import, backups and one Javi insight per page stay free. Pro features like Javi's follow-up questions, actions, briefings and Explain are off until you activate a license.",
        dismiss: 'OK',
        showLink: true,
      };
    default:
      return null;
  }
}

/**
 * One light, non-modal banner for the reverse trial, driven by `status.trial.notice` (the server
 * remembers what was already shown). The dismiss button and the Activate link dismiss it (the Buy link does not),
 * posting at most once per click target; a failed post is silent and the banner stays hidden for this session while the
 * status refetches. Never shown until first-run onboarding is done. A build without the Pro UI
 * (`PRO_UI_INCLUDED` false) shows no trial banner: the trial would unlock nothing there.
 */
export default function TrialNotice() {
  return PRO_UI_INCLUDED ? <TrialNoticeBanner /> : null;
}

function TrialNoticeBanner() {
  const { status, dismissTrialNotice, refetch } = useLicense({ pollTrial: true });
  const { onboarded, isLoading, unresolved } = useProfile();
  const [hidden, setHidden] = useState(null);
  const sent = useRef(null);
  const bannerRef = useRef(null);

  // A license on this computer means the trial ending is not news: never tell a license holder they dropped to Free.
  const notice = status?.license && status?.trial?.notice === 'ended' ? null : (status?.trial?.notice ?? null);
  if (!notice || notice === hidden || isLoading || unresolved || !onboarded) return null;
  const copy = copyFor(notice, status.trial.endsAt, status.trial.daysLeft);
  if (!copy) return null;

  const dismiss = async () => {
    if (sent.current === notice) return;
    sent.current = notice;
    // The focused button is about to unmount; hand focus to the page's <main> so it does not fall to <body>.
    const banner = bannerRef.current;
    if (banner?.contains(document.activeElement)) banner.closest('main')?.focus();
    setHidden(notice);
    try {
      await dismissTrialNotice(notice);
    } catch {
      refetch().catch(() => {});
    }
  };

  return (
    <div
      ref={bannerRef}
      role="status"
      data-testid="trial-notice"
      className="glass mx-4 mt-3 flex flex-wrap items-start justify-between gap-3 rounded-2xl p-4 sm:mx-6"
    >
      <div className="min-w-0 flex-1 space-y-1 basis-64">
        <p className="text-sm font-bold tracking-tight text-slate-slate100">{copy.title}</p>
        <p className="text-sm text-slate-slate300">{copy.body}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {copy.showLink && <BuyProLink />}
        {copy.showLink && (
          <Link to="/settings#license" onClick={dismiss} className={LINK_BTN}>
            Activate a license
          </Link>
        )}
        <button type="button" onClick={dismiss} className={BTN}>
          {copy.dismiss}
        </button>
      </div>
    </div>
  );
}
