import { useEffect, useId, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getDirectImportStatus, importFromDirect } from '../../services/backupService';
import { formatBackupDate } from '../../utils/backupFormat';
import { BTN } from './pillStyles';

const STATUS_KEY = ['backups', 'direct-import'];
const INTRO =
  'You have used Burrow from the website before. Import copies your data from that Burrow into this one: your entries, backups and settings. It only copies. Your other Burrow is not changed, moved or deleted. The copy is a snapshot from the moment you click: data you add to your other Burrow later is not included.';
const CLOSE_FIRST = 'Close your other Burrow first (File, then Quit), then choose Import.';
const QUESTION =
  'Copy your data from your other Burrow into this Burrow? Anything you added here since installing is kept in a safety folder, not deleted.';
const PENDING =
  'Your data is copied and checked. Close Burrow completely (File, then Quit) and open it again to finish. Do not add anything before then.';
const HAS_DATA =
  'Burrow found data from your other Burrow, but this Burrow already has data of its own, so it cannot import. Your data was not changed.';
const CANCELLED = {
  target_has_data:
    'Your last import was cancelled: you added data to this Burrow after preparing it, so nothing was replaced and your data here was kept.',
  unverified: 'Your last import was cancelled because the copied data did not pass its final check. Nothing was replaced. You can try again.',
};
const FAILED = 'The import did not work. Nothing was imported, and your other Burrow was not touched.';

/**
 * Settings > Data & storage, Microsoft Store build with its data in the user folder only: a user-clicked, one-way copy of the
 * data of the Burrow installed from the website. Never automatic. Renders nothing in any other build, and nothing when there
 * is no other Burrow data to offer.
 */
export default function ImportFromDirectControl() {
  const headingId = useId();
  const queryClient = useQueryClient();
  const triggerRef = useRef(null);
  const wasConfirming = useRef(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');
  const { data } = useQuery({
    queryKey: STATUS_KEY,
    queryFn: () => getDirectImportStatus(),
    retry: false,
    refetchOnWindowFocus: false,
    gcTime: 0,
  });

  // Return focus to the trigger once the confirmation closes (not on first mount).
  useEffect(() => {
    if (wasConfirming.current && !confirming) triggerRef.current?.focus();
    wasConfirming.current = confirming;
  }, [confirming]);

  if (!data || data.available !== true) return null;
  const pending = done || data.pending;
  if (!pending && (!data.found || data.reason === 'imported')) return null;

  const run = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await importFromDirect();
      setDone(true);
      setConfirming(false);
      queryClient.invalidateQueries({ queryKey: STATUS_KEY });
    } catch (e) {
      setError(e?.message || FAILED);
    } finally {
      setBusy(false);
    }
  };

  const changed = formatBackupDate(data.lastChangedAt);
  let body;
  if (pending) {
    body = (
      <p role="status" className="mt-3 text-sm text-slate-slate200">
        {PENDING}
      </p>
    );
  } else if (!data.canOffer) {
    body = <p className="mt-3 text-xs text-slate-slate400">{data.reason === 'target_has_data' ? HAS_DATA : CLOSE_FIRST}</p>;
  } else {
    body = (
      <>
        <p className="mt-3 text-xs text-slate-slate300">
          Found in {data.sourceDir}.{changed ? ` Last changed ${changed}.` : ''} {CLOSE_FIRST}
        </p>
        <div className="mt-3">
          {confirming ? (
            <div role="group" aria-label="Confirm import" className="flex flex-wrap items-center gap-2">
              <span className="text-sm text-slate-slate100">{QUESTION}</span>
              <button type="button" onClick={run} aria-disabled={busy} className={BTN}>
                {busy ? 'Copying…' : 'Copy my data'}
              </button>
              <button type="button" onClick={() => !busy && setConfirming(false)} aria-disabled={busy} className={BTN}>
                Cancel
              </button>
            </div>
          ) : (
            <button ref={triggerRef} type="button" onClick={() => setConfirming(true)} className={BTN}>
              Import from your existing Burrow
            </button>
          )}
        </div>
        {error && (
          <p role="alert" className="mt-2 text-xs text-accent-amber">
            {error}
          </p>
        )}
      </>
    );
  }

  return (
    <section aria-labelledby={headingId}>
      <h4 id={headingId} className="text-sm font-semibold text-slate-slate100">
        Import from your existing Burrow
      </h4>
      <p className="mt-1 text-xs text-slate-slate400">{INTRO}</p>
      {data.cancelled && CANCELLED[data.cancelled.reason] && !pending && (
        <p role="status" className="mt-3 text-xs text-accent-amber">
          {CANCELLED[data.cancelled.reason]}
        </p>
      )}
      {body}
    </section>
  );
}
