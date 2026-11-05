import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, Info } from 'lucide-react';
import { useBackupStatus, useDismissAutoReminder } from '../../hooks/useBackups';
import { autoOffSentence, noticeSentence } from '../settings/backupStatusText';

const LINK =
  'font-semibold underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:[outline-color:var(--focus-ring)]';
const DISMISS =
  'ml-auto shrink-0 rounded-md px-2 py-1 text-xs font-semibold text-slate-slate300 hover:text-slate-slate100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:[outline-color:var(--focus-ring)]';

/**
 * Small reminder on Home when backups are late, failing, missing or disk space is low. When the user
 * turned automatic backups off, a gentle reminder at most once a week (the server decides and
 * remembers the dismissal). Renders nothing otherwise.
 */
export default function BackupHealthNotice() {
  const { status } = useBackupStatus();
  const dismissReminder = useDismissAutoReminder();
  const [announced, setAnnounced] = useState(false);
  const [dismissals, setDismissals] = useState(0);
  const doneRef = useRef(null);
  const warning = noticeSentence(status);
  const reminder = warning ? '' : autoOffSentence(status);
  const text = warning || reminder;

  // The Dismiss button disappears with the reminder, so focus moves to the "dismissed" note, which stays.
  useEffect(() => {
    if (dismissals > 0) doneRef.current?.focus();
  }, [dismissals]);

  // Mounted whenever a reminder is or was showing, so the change is read out and focus has somewhere to go.
  const note =
    reminder || announced ? (
      <p ref={doneRef} tabIndex={-1} role="status" className="sr-only">
        {announced && !reminder ? 'Reminder dismissed.' : ''}
      </p>
    ) : null;
  if (!text && !note) return null;
  const Icon =
    reminder || (status?.health === 'none' && !status?.diskWarning && status?.recoveryRequired !== true)
      ? Info
      : AlertTriangle;
  const tone = Icon === Info ? 'text-slate-slate300' : 'text-accent-amber';
  const dismiss = () => {
    setAnnounced(true);
    setDismissals((n) => n + 1);
    // If saving fails the reminder comes back (see useDismissAutoReminder): forget the "dismissed" note.
    dismissReminder(undefined, { onError: () => setAnnounced(false) });
  };
  // One stable tree (the note keeps its place when the aside goes), so focus on the note survives.
  return (
    <>
      {text && (
        <aside
          aria-label="Backup reminder"
          className="glass-subtle mb-4 flex items-start gap-2 rounded-lg p-3 text-sm text-slate-slate200"
        >
          <Icon size={16} className={`mt-0.5 shrink-0 ${tone}`} aria-hidden="true" />
          <p className="min-w-0">
            {text}{' '}
            <Link to={{ pathname: '/settings', hash: '#data-storage' }} className={LINK}>
              Open backup settings
            </Link>
          </p>
          {reminder && (
            <button type="button" onClick={dismiss} aria-label="Dismiss backup reminder" className={DISMISS}>
              Dismiss
            </button>
          )}
        </aside>
      )}
      {note}
    </>
  );
}
