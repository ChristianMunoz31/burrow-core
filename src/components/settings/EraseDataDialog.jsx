import { useId, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../auth/useAuth';
import Modal from '../shared/Modal';
import { useBackups } from '../../hooks/useBackups';
import { downloadExport } from '../../services/exportService';
import {
  ERASE_EXPORT_FAILED_MESSAGE,
  ERASE_FAILED_MESSAGE,
  ERASE_INCOMPLETE_CODE,
  ERASE_UNSURE_MESSAGE,
  eraseAllData,
  requestEraseToken,
} from '../../services/eraseService';
import { STORAGE_PREFIX, lsKey } from '../../utils/storageKeys';
import { INPUT_CLASS, LABEL_CLASS, PRIMARY_BTN } from './aiFormStyles';
import { BTN } from './pillStyles';

const ERASE_PHRASE = 'ERASE';
const DANGER_BTN = `${PRIMARY_BTN} !bg-red-700 disabled:cursor-not-allowed disabled:opacity-50`;

const DELETED = [
  'Your transactions, to-dos, calendar, habits, journal, notes, bookmarks, countdowns and focus sessions',
  'Javi conversations and memory',
  'Your activity log, settings, name and cloud AI choices',
  'Saved API keys',
];

function Check({ checked, onChange, children, hint }) {
  return (
    <label className="flex items-start gap-2 text-sm text-slate-slate200">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 shrink-0" />
      <span>
        {children}
        {hint && <span className="mt-0.5 block text-xs text-slate-slate400">{hint}</span>}
      </span>
    </label>
  );
}

function clearBrowserData() {
  try {
    for (const key of Object.keys(localStorage)) if (key.startsWith(STORAGE_PREFIX)) localStorage.removeItem(key);
  } catch {
    // storage unavailable: the reload still shows the server's empty state
  }
}

/**
 * The Danger zone dialog: choices and typed confirmation, then a final confirm that lists what goes and what stays.
 * @param {{ onClose: () => void, finalFocusRef?: import('react').RefObject<HTMLElement | null> }} props
 */
export default function EraseDataDialog({ onClose, finalFocusRef }) {
  const queryClient = useQueryClient();
  const { data: backups } = useBackups();
  // Sign-in is on only for a web install with a password; the desktop app never has one.
  const { enabled: needsPassword } = useAuth();
  const ids = useId();
  const [exportFirst, setExportFirst] = useState(true);
  const [understand, setUnderstand] = useState(false);
  const [deleteBackups, setDeleteBackups] = useState(false);
  const [removeLicense, setRemoveLicense] = useState(false);
  const [password, setPassword] = useState('');
  const [phrase, setPhrase] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [unsure, setUnsure] = useState(false);

  const ready = phrase === ERASE_PHRASE && (exportFirst || understand) && (!needsPassword || password !== '');
  const where = backups?.location ? backups.location : 'the backups folder inside your data folder';

  const run = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (exportFirst) {
        try {
          await downloadExport();
        } catch {
          setError(ERASE_EXPORT_FAILED_MESSAGE);
          setBusy(false);
          return;
        }
      }
      const { token } = await requestEraseToken();
      await eraseAllData({ token, phrase, removeLicense, deleteBackups, ...(needsPassword ? { password } : {}) });
    } catch (e) {
      if (e?.code === ERASE_INCOMPLETE_CODE) {
        // The data is already gone, so there is nothing to retry (a retry would export an empty app again).
        // Leave through the same path as a finished erase; the server's fixed message says what is left and
        // what to do, and the empty start screen shows it once.
        try {
          // Read once by PendingSyncFlush on the next load.
          window.sessionStorage.setItem(lsKey('erase:note'), e.message);
        } catch {
          // storage unavailable: the empty start screen shows without the note
        }
        onClose();
      } else {
        if (e?.unsure) setUnsure(true);
        else setError(e?.message || ERASE_FAILED_MESSAGE);
        setBusy(false);
        return;
      }
    }
    clearBrowserData();
    queryClient.clear();
    window.location.replace('/');
  };

  const kept = [
    removeLicense
      ? 'Your license will be removed from this computer.'
      : 'Your license activation (it includes your purchase email), unless you remove it.',
    'Your Pro trial status is kept.',
    deleteBackups
      ? 'All backups will be deleted too, so nothing can restore your data.'
      : `Your finished backups stay in ${where} and can restore everything.`,
  ];

  return (
    <>
      <Modal title="Erase all my data" onClose={onClose} dismissible={!busy} finalFocusRef={finalFocusRef} describedBy={`${ids}-intro`}>
        <div className="space-y-4 text-sm text-slate-slate200">
          <p id={`${ids}-intro`}>
            This permanently deletes your data on this computer. It cannot be undone. Burrow then starts over like a new
            install.
          </p>
          <div className="space-y-2">
            <Check checked={exportFirst} onChange={setExportFirst}>
              Download a final export first (recommended)
            </Check>
            {!exportFirst && (
              <Check checked={understand} onChange={setUnderstand}>
                I understand I can&apos;t undo this
              </Check>
            )}
            <Check
              checked={deleteBackups}
              onChange={setDeleteBackups}
              hint="Backups are the only way to get your data back after erasing."
            >
              Also delete all backups on this computer
            </Check>
            <Check checked={removeLicense} onChange={setRemoveLicense}>
              Also remove my license from this computer
            </Check>
          </div>
          {needsPassword && (
            <label className={LABEL_CLASS}>
              Your Burrow password
              <input
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className={`${INPUT_CLASS} mt-1 font-normal`}
              />
            </label>
          )}
          <label className={LABEL_CLASS}>
            Type {ERASE_PHRASE} to confirm
            <input
              value={phrase}
              onChange={(e) => setPhrase(e.target.value)}
              autoComplete="off"
              className={`${INPUT_CLASS} mt-1 font-normal`}
            />
          </label>
          <div className="flex flex-wrap justify-end gap-2">
            <button type="button" onClick={onClose} className={BTN}>
              Cancel
            </button>
            <button type="button" disabled={!ready} onClick={() => setConfirming(true)} className={DANGER_BTN}>
              Review and erase
            </button>
          </div>
        </div>
      </Modal>
      {confirming && (
        <Modal
          title="Erase everything now?"
          role="alertdialog"
          onClose={() => setConfirming(false)}
          dismissible={!busy}
          describedBy={`${ids}-final`}
        >
          <div className="space-y-4 text-sm text-slate-slate200">
            <p id={`${ids}-final`} className="font-semibold text-slate-slate100">
              This cannot be undone.
            </p>
            <section>
              <h3 className="font-semibold text-slate-slate100">Deleted:</h3>
              <ul className="mt-1 list-disc space-y-1 pl-5">
                {DELETED.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </section>
            <section>
              <h3 className="font-semibold text-slate-slate100">Kept:</h3>
              <ul className="mt-1 list-disc space-y-1 pl-5">
                {kept.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </section>
            <p className="text-xs text-slate-slate400">
              {exportFirst ? 'A final export is saved first.' : 'No export will be saved.'}
            </p>
            {error && (
              <p role="alert" className="text-xs text-accent-amber">
                {error}
              </p>
            )}
            {unsure && (
              <div role="alert" className="flex flex-wrap items-center gap-2 text-xs text-accent-amber">
                {ERASE_UNSURE_MESSAGE}
                <button type="button" onClick={() => window.location.reload()} className={BTN}>
                  Reload
                </button>
              </div>
            )}
            <div className="flex flex-wrap justify-end gap-2">
              <button type="button" onClick={() => setConfirming(false)} disabled={busy} className={BTN}>
                Go back
              </button>
              <button type="button" onClick={run} disabled={busy || unsure} className={DANGER_BTN}>
                {busy ? 'Erasing…' : 'Erase my data'}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
