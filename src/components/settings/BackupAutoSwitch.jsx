import { useEffect, useId, useRef, useState } from 'react';
import SwitchToggle from './SwitchToggle';
import { BTN } from './pillStyles';

const AUTO_OFF_WARNING =
  'Turning off automatic backups means a problem with your computer could lose your data.';
const AUTO_ON_ANNOUNCEMENT = 'Automatic backups are on.';
const AUTO_OFF_ANNOUNCEMENT = 'Automatic backups are off.';
const SAVE_ERROR = "Couldn't save that change. Try again.";

/**
 * The automatic backups switch. Turning it on happens at once; turning it off asks first (inline,
 * no window.confirm): focus lands on Cancel, Escape cancels and focus returns to the switch.
 *
 * Props: enabled (bool, the user's choice), onChange(bool) (async, rejects when saving failed),
 * locked (bool, true while a restore runs), paused (bool, the switch is on but this build's scheduler is
 * switched off, which only happens in dev and sandbox). "Off" is only ever the user's own choice.
 */
export default function BackupAutoSwitch({ enabled, onChange, locked = false, paused = false }) {
  const labelId = useId();
  const descId = useId();
  const warningId = useId();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [announcement, setAnnouncement] = useState('');
  const switchRef = useRef(null);
  const cancelRef = useRef(null);
  const busyRef = useRef(false);
  const mounted = useRef(true);
  const focusTimer = useRef(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearTimeout(focusTimer.current);
    };
  }, []);

  useEffect(() => {
    if (asking) cancelRef.current?.focus();
  }, [asking]);

  // Wait for the confirm group to unmount, then put focus back on the switch.
  const focusSwitchLater = () => {
    clearTimeout(focusTimer.current);
    focusTimer.current = setTimeout(() => switchRef.current?.focus(), 0);
  };

  const save = async (next) => {
    if (busyRef.current || locked) return false;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setAnnouncement('');
    try {
      await onChange(next);
      // Said only after the user changed it, never worked out from the state on first show.
      if (mounted.current) setAnnouncement(next ? AUTO_ON_ANNOUNCEMENT : AUTO_OFF_ANNOUNCEMENT);
      return true;
    } catch {
      if (mounted.current) setError(SAVE_ERROR);
      return false;
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  const toggle = async () => {
    if (enabled) {
      if (busyRef.current || locked) return;
      setError(null);
      setAsking(true);
      return;
    }
    await save(true);
  };

  const cancel = () => {
    if (busyRef.current) return;
    setAsking(false);
    focusSwitchLater();
  };

  const confirmOff = async () => {
    if (await save(false)) {
      if (!mounted.current) return;
      setAsking(false);
      focusSwitchLater();
    }
  };

  // On the wrapper, so Escape also works once focus is back on the switch while the group is open.
  const onKeyDown = (event) => {
    if (event.key === 'Escape' && asking) {
      event.stopPropagation();
      cancel();
    }
  };

  let description = 'Off. Burrow only backs up when you use Back up now.';
  if (enabled) description = paused ? 'On (paused in this build).' : 'On. Burrow makes a backup about once a day.';

  return (
    <div onKeyDown={onKeyDown}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p id={labelId} className="text-xs font-semibold text-slate-slate300">
            Automatic backups
          </p>
          <p id={descId} className="mt-1 text-xs text-slate-slate400">
            {description}
          </p>
        </div>
        <SwitchToggle
          buttonRef={switchRef}
          checked={enabled}
          disabled={busy || locked}
          labelledBy={labelId}
          describedBy={descId}
          onChange={toggle}
        />
      </div>
      {asking && (
        <div
          role="group"
          aria-label="Confirm turning off automatic backups"
          aria-describedby={warningId}
          className="mt-3 flex flex-wrap items-center gap-2"
        >
          <span id={warningId} className="text-sm text-slate-slate100">
            {AUTO_OFF_WARNING}
          </span>
          <button
            type="button"
            onClick={confirmOff}
            aria-disabled={busy}
            aria-busy={busy}
            className={`${BTN} bg-red-700 text-white hover:bg-red-600`}
          >
            {busy ? 'Turning off…' : 'Turn off'}
          </button>
          <button ref={cancelRef} type="button" onClick={cancel} aria-disabled={busy} className={BTN}>
            Cancel
          </button>
        </div>
      )}
      {/* Always mounted so a screen reader announces the warning when the confirmation opens. */}
      <p aria-live="polite" className="sr-only" data-testid="auto-off-warning-live">
        {asking ? AUTO_OFF_WARNING : ''}
      </p>
      <p role="status" className="sr-only">
        {announcement}
      </p>
      {error && (
        <p role="alert" className="mt-2 text-xs text-accent-amber">
          {error}
        </p>
      )}
    </div>
  );
}
