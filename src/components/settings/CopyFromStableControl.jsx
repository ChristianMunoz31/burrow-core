import { useEffect, useId, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { copyFromStable, getStableCopyStatus } from '../../services/backupService';
import { formatBackupDate } from '../../utils/backupFormat';
import BackupRestoreConfirm from './BackupRestoreConfirm';
import { BTN } from './pillStyles';

const INTRO =
  'Burrow Dev keeps its own data, separate from Burrow. You can copy your Burrow data into Burrow Dev to test with it. This is one-way: Burrow Dev never changes your Burrow data, and changes you make here stay in Burrow Dev.';
const NOT_FOUND = 'No Burrow data was found on this computer, so there is nothing to copy.';
const BUSY = 'Burrow is restoring a backup right now. Try again when it finishes.';
const SAME_FOLDER = 'Burrow Dev is using the same data folder as Burrow, so there is nothing to copy.';
const QUESTION =
  'Replace the data in Burrow Dev with a copy of your Burrow data? Burrow Dev makes a safety backup of its current data first. Your Burrow data is not changed. Saved API keys are not copied, for your safety. Re-enter them in Burrow Dev if you need them.';
const UNSURE = 'Burrow Dev may have copied your data. Reload Burrow Dev to check.';
const FAILED = 'The copy did not work. Burrow Dev was not changed, and your Burrow data was not touched.';
const STATUS_KEY = ['backups', 'stable-copy'];

function foundText({ dataDir, lastChangedAt, overridden }) {
  const changed = formatBackupDate(lastChangedAt);
  return `Burrow data found in ${dataDir}.${changed ? ` Last changed ${changed}.` : ''}${overridden ? ' (custom test folder)' : ''}`;
}

/** Burrow Dev only: copy the Burrow data into this Dev app, after a confirmation. */
export default function CopyFromStableControl() {
  const headingId = useId();
  const [confirming, setConfirming] = useState(false);
  const triggerRef = useRef(null);
  const wasConfirming = useRef(false);
  const { data, isLoading, error, refetch, isRefetching } = useQuery({
    queryKey: STATUS_KEY,
    queryFn: () => getStableCopyStatus(),
    retry: false,
    refetchOnWindowFocus: false,
    gcTime: 0,
  });

  // Return focus to the trigger once the confirmation closes (not on first mount).
  useEffect(() => {
    if (wasConfirming.current && !confirming) triggerRef.current?.focus();
    wasConfirming.current = confirming;
  }, [confirming]);

  const open = () => {
    setConfirming(true);
    refetch();
  };
  const cancel = () => setConfirming(false);
  const onFailed = (e) => {
    if (e?.code === 'stable_busy') refetch();
  };

  let body = null;
  if (isLoading) {
    body = <p className="mt-3 text-xs text-slate-slate400">Looking for your Burrow data…</p>;
  } else if (error && !data) {
    body = (
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <p role="alert" className="text-xs text-accent-amber">
          {error.message || 'Could not check for your Burrow data.'}
        </p>
        <button
          type="button"
          onClick={() => {
            if (!isRefetching) refetch();
          }}
          aria-disabled={isRefetching}
          className={BTN}
        >
          Try again
        </button>
      </div>
    );
  } else if (data?.sameFolder) {
    body = <p className="mt-3 text-xs text-slate-slate400">{SAME_FOLDER}</p>;
  } else if (data?.busy) {
    body = <p className="mt-3 text-xs text-slate-slate400">{BUSY}</p>;
  } else if (data && !data.found) {
    body = <p className="mt-3 text-xs text-slate-slate400">{NOT_FOUND}</p>;
  } else if (data) {
    body = (
      <>
        <p className="mt-3 text-xs text-slate-slate300">{foundText(data)}</p>
        <div className="mt-3">
          {confirming ? (
            <BackupRestoreConfirm
              question={QUESTION}
              run={copyFromStable}
              confirmLabel="Copy and replace"
              busyLabel="Copying…"
              groupLabel="Confirm copy"
              busyStatus="Copying your Burrow data."
              doneStatus="Copied. Reloading Burrow Dev."
              onCancel={cancel}
              unsureMessage={UNSURE}
              failedMessage={FAILED}
              onFailed={onFailed}
            />
          ) : (
            <button
              ref={triggerRef}
              type="button"
              onClick={open}
              className={BTN}
            >
              Copy my data from Burrow
            </button>
          )}
        </div>
      </>
    );
  }

  return (
    <section aria-labelledby={headingId}>
      <h4 id={headingId} className="text-sm font-semibold text-slate-slate100">
        Copy my data from Burrow
      </h4>
      <p className="mt-1 text-xs text-slate-slate400">{INTRO}</p>
      {body}
    </section>
  );
}
