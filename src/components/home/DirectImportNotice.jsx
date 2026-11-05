import { Link } from 'react-router-dom';
import { Info } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useAppInfo } from '../../hooks/useAppInfo';
import { useSyncedSetting } from '../../hooks/useSyncedSetting';
import { getDirectImportStatus } from '../../services/backupService';

const LINK =
  'font-semibold underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:[outline-color:var(--focus-ring)]';
const DISMISS =
  'ml-auto shrink-0 rounded-md px-2 py-1 text-xs font-semibold text-slate-slate300 hover:text-slate-slate100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:[outline-color:var(--focus-ring)]';
const SEEN_KEY = 'directImport:notice';
// The `at` of the cancelled-import note the user already dismissed (the server writes the note, see directImport.js).
const CANCELLED_SEEN_KEY = 'directImport:cancelledSeen';
const CANCELLED_COPY = {
  target_has_data:
    'Your import was cancelled. You added data to this Burrow after preparing it, so nothing was replaced. Your data here was kept, and your other Burrow was not touched.',
  unverified:
    'Your import was cancelled because the copied data did not pass its final check. Nothing was replaced, and your other Burrow was not touched. You can try the import again in Settings.',
};

/**
 * First-run pointer on Home, Microsoft Store build with its data in the user folder only: when the Burrow installed from the
 * website left data on this computer and this Burrow is still empty, say so and link to the import in Settings > Data &
 * storage. It never imports anything itself. Gone as soon as this Burrow has data, after Dismiss, and in every other build.
 */
export default function DirectImportNotice() {
  const { info } = useAppInfo();
  const offered = info?.distribution === 'store' && info?.dataLocation === 'userprofile';
  const [dismissed, setDismissed, { isFetched }] = useSyncedSetting(SEEN_KEY, false);
  const [seenCancelled, setSeenCancelled, { isFetched: cancelledFetched }] = useSyncedSetting(CANCELLED_SEEN_KEY, '');
  const { data } = useQuery({
    queryKey: ['backups', 'direct-import', 'notice'],
    queryFn: () => getDirectImportStatus(),
    enabled: offered,
    retry: false,
    refetchOnWindowFocus: false,
    gcTime: 0,
  });
  // A prepared import that was cancelled at the last start: say why nothing came in, once.
  const cancelled = data?.cancelled;
  if (offered && cancelledFetched && cancelled && CANCELLED_COPY[cancelled.reason] && seenCancelled !== cancelled.at) {
    return (
      <aside aria-label="Import cancelled" className="glass-subtle mb-4 flex items-start gap-2 rounded-lg p-3 text-sm text-slate-slate200">
        <Info size={16} className="mt-0.5 shrink-0 text-slate-slate300" aria-hidden="true" />
        <p className="min-w-0">{CANCELLED_COPY[cancelled.reason]}</p>
        <button type="button" onClick={() => setSeenCancelled(cancelled.at)} className={DISMISS}>
          Dismiss
        </button>
      </aside>
    );
  }
  if (!offered || !isFetched || dismissed === true || !data || data.canOffer !== true) return null;
  return (
    <aside aria-label="Import from your existing Burrow" className="glass-subtle mb-4 flex items-start gap-2 rounded-lg p-3 text-sm text-slate-slate200">
      <Info size={16} className="mt-0.5 shrink-0 text-slate-slate300" aria-hidden="true" />
      <p className="min-w-0">
        Burrow found data from the Burrow you installed from the website. You can copy it into this Burrow. It only copies and
        leaves the original untouched.{' '}
        <Link to={{ pathname: '/settings', hash: '#data-storage' }} className={LINK}>
          Open Data & storage
        </Link>
      </p>
      <button type="button" onClick={() => setDismissed(true)} className={DISMISS}>
        Dismiss
      </button>
    </aside>
  );
}
