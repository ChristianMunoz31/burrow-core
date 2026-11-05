import { useEffect, useRef, useState } from 'react';
import { BTN } from './pillStyles';
import { GENERIC_ERROR, HINT, PRIMARY_BTN } from './updateCopy';
import { userMessage } from '../../utils/apiError';
import { useUpdateInstall } from '../../hooks/useUpdateInstall';

const RECHECK_CODES = new Set(['update_not_available', 'update_check_unavailable']);
// How long the installing state may last before the user is offered a way back.
const STUCK_AFTER_MS = 5 * 60 * 1000;

/** The server's fixed message for a refusal (`userFacing`), else the generic line. Raw error text never renders. */
const errorText = (err) =>
  err?.code === 'recheck_failed' ? "Burrow still can't check. Try again later." : userMessage(err, GENERIC_ERROR);

/**
 * Download and install. The click is the consent: nothing is downloaded before it. The server saves a backup first and
 * hands the update to the Burrow app, which downloads it, checks its signature, restarts and installs. The parent
 * (UpdatesSection) shows the version, notes, and keys this panel by version. `onBusyChange(true)` is
 * called while a backup is saving or the update is handed off, so the parent can hold Check now.
 * @param {{ version: string, onRecheck?: () => Promise<void>, onBusyChange?: (busy: boolean) => void }} props
 */
export default function UpdateInstallPanel({ version, onRecheck, onBusyChange }) {
  const { install } = useUpdateInstall();
  const [phase, setPhase] = useState('idle'); // idle | saving | handed_off
  const [error, setError] = useState(null);
  const [rechecking, setRechecking] = useState(false);
  const [stuck, setStuck] = useState(false);
  const busy = useRef(false);
  const installingRef = useRef(null);
  const startRef = useRef(null);
  const refocusStart = useRef(false);
  const handedOff = phase === 'handed_off';
  const working = phase === 'saving' || handedOff;

  // Move focus to the installing heading once it exists (the clicked button is gone by then).
  useEffect(() => {
    if (handedOff) installingRef.current?.focus();
  }, [handedOff]);

  // After "Go back to the update" the clicked button is gone: put focus on the button that replaces it.
  useEffect(() => {
    if (phase === 'idle' && refocusStart.current) {
      refocusStart.current = false;
      startRef.current?.focus();
    }
  }, [phase]);

  useEffect(() => {
    onBusyChange?.(working);
    return () => onBusyChange?.(false);
  }, [working, onBusyChange]);

  useEffect(() => {
    if (!handedOff) return undefined;
    const timer = setTimeout(() => setStuck(true), STUCK_AFTER_MS);
    return () => clearTimeout(timer);
  }, [handedOff]);

  const start = async () => {
    if (busy.current) return;
    busy.current = true;
    setError(null);
    setPhase('saving');
    try {
      await install(version);
      setPhase('handed_off');
    } catch (err) {
      setError(err);
      setPhase('idle');
      busy.current = false;
    }
  };

  const backToIdle = () => {
    setStuck(false);
    refocusStart.current = true;
    setPhase('idle');
    busy.current = false;
  };

  const recheck = async () => {
    if (rechecking || !onRecheck) return;
    setRechecking(true);
    try {
      await onRecheck();
      setError(null);
    } catch {
      setError({ code: 'recheck_failed' });
    } finally {
      setRechecking(false);
    }
  };

  return (
    <div className="space-y-2">
      {/* The heading takes focus, so it sits outside the live region (focus announces it; the region adds the rest). */}
      {handedOff && (
        <h5 ref={installingRef} tabIndex={-1} className="text-sm font-semibold text-slate-slate100 outline-none">
          Installing, Burrow will restart
        </h5>
      )}
      {/* Always mounted, so screen readers announce the text when it changes. */}
      <div role="status" aria-live="polite">
        {phase === 'saving' && <p className={HINT}>Saving a backup of your data...</p>}
        {handedOff && (
          <div className="space-y-1">
            <p className={HINT}>
              Backup saved. Burrow is downloading version {version}. When it is ready, Burrow closes, installs the update and opens
              again. This can take a few minutes.
            </p>
            <p className={HINT}>If nothing happens after a few minutes, close and reopen Burrow.</p>
          </div>
        )}
      </div>

      {handedOff && stuck && (
        <button type="button" onClick={backToIdle} className={BTN}>
          Go back to the update
        </button>
      )}

      {!handedOff && (
        <>
          {error && (
            <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-accent-amber">
              <span>{errorText(error)}</span>
              {RECHECK_CODES.has(error.code) && onRecheck && (
                <button type="button" onClick={recheck} aria-disabled={rechecking} aria-busy={rechecking} className={BTN}>
                  {rechecking ? 'Checking...' : 'Check again'}
                </button>
              )}
            </div>
          )}
          <button ref={startRef} type="button" onClick={start} aria-disabled={phase === 'saving'} className={PRIMARY_BTN}>
            Download and install
          </button>
        </>
      )}
    </div>
  );
}
