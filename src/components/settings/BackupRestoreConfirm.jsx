import { useEffect, useId, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { restoreBackup } from '../../services/backupService';
import { clearDirty, getPendingKeys } from '../../utils/syncMode';

const BTN =
  'min-h-9 rounded-md px-3 py-1.5 text-sm font-semibold transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:[outline-color:var(--focus-ring)] aria-disabled:cursor-not-allowed aria-disabled:opacity-60 sm:min-h-0';
const UNSURE_MESSAGE = 'Burrow may have restored the backup. Reload Burrow to check.';
const FAILED_MESSAGE = 'The restore did not work. Your current data was not changed.';

const reloadPage = () => window.location.reload();

// Runs one cleanup step; a failure must never stop the reload that follows a restore.
function attempt(step) {
  try {
    step();
  } catch {
    // Ignored on purpose: the data is already restored, the reload shows it.
  }
}

/**
 * Inline restore confirmation (no window.confirm). Mount it when the user asks to restore;
 * focus lands on Cancel and Escape cancels. The parent returns focus to its trigger in onCancel.
 *
 * Props: source ({ id } or { uploadToken }), question (text), onCancel(), onRestored() (defaults
 * to a page reload so every screen shows the restored data), onBusyChange(bool) (true while a
 * restore is running or its outcome is unknown), onFailed(error) (the server refused the restore).
 * Optional wording and action, for other "replace my data" flows: run() (defaults to restoring `source`),
 * confirmLabel, busyLabel, groupLabel, busyStatus and doneStatus (screen reader texts), unsureMessage
 * (no answer from the server) and failedMessage (refusal without a message).
 */
export default function BackupRestoreConfirm({
  source,
  question,
  onCancel,
  onRestored = reloadPage,
  onBusyChange,
  onFailed,
  run,
  confirmLabel = 'Restore',
  busyLabel = 'Restoring…',
  groupLabel = 'Confirm restore',
  busyStatus = 'Restoring your backup.',
  doneStatus = 'Restored. Reloading Burrow.',
  unsureMessage = UNSURE_MESSAGE,
  failedMessage = FAILED_MESSAGE,
}) {
  const queryClient = useQueryClient();
  const questionId = useId();
  const cancelRef = useRef(null);
  const reloadRef = useRef(null);
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [unsure, setUnsure] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  useEffect(() => {
    if (unsure) reloadRef.current?.focus();
  }, [unsure]);

  const cancel = () => {
    if (!inFlight.current) onCancel();
  };

  const onKeyDown = (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      cancel();
    }
  };

  // aria-disabled (not disabled) keeps keyboard focus on the button while it runs.
  const confirm = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    onBusyChange?.(true);
    try {
      await (run ? run() : restoreBackup(source));
    } catch (e) {
      if (e?.status === undefined) {
        // No HTTP answer: the server may have finished the swap before the connection dropped.
        setBusy(false);
        setUnsure(true);
        return;
      }
      setError(e?.message || failedMessage);
      inFlight.current = false;
      setBusy(false);
      onBusyChange?.(false);
      onFailed?.(e);
      return;
    }
    attempt(() => getPendingKeys().forEach(clearDirty));
    attempt(() => queryClient.clear());
    setDone(true);
    onRestored();
  };

  if (unsure) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <p role="alert" className="text-sm text-accent-amber">
          {unsureMessage}
        </p>
        <button
          ref={reloadRef}
          type="button"
          onClick={onRestored}
          className={`${BTN} bg-red-700 text-white hover:bg-red-600`}
        >
          Reload
        </button>
      </div>
    );
  }

  return (
    <div>
      <div
        role="group"
        aria-label={groupLabel}
        aria-describedby={questionId}
        onKeyDown={onKeyDown}
        className="flex flex-wrap items-center gap-2"
      >
        <span id={questionId} className="text-sm text-slate-slate100">
          {question}
        </span>
        <button
          type="button"
          onClick={confirm}
          aria-disabled={busy || done}
          aria-busy={busy}
          className={`${BTN} bg-red-700 text-white hover:bg-red-600`}
        >
          {busy || done ? busyLabel : confirmLabel}
        </button>
        <button
          ref={cancelRef}
          type="button"
          onClick={cancel}
          aria-disabled={busy || done}
          className={`${BTN} glass-subtle text-slate-slate100`}
        >
          Cancel
        </button>
      </div>
      <p role="status" className="sr-only">
        {done ? doneStatus : busy ? busyStatus : ''}
      </p>
      {error && (
        <p role="alert" className="mt-2 text-xs text-accent-amber">
          {error}
        </p>
      )}
    </div>
  );
}
