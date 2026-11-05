import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import { useBackups } from '../../hooks/useBackups';
import { BACKUP_TOO_LARGE_MESSAGE, BACKUP_UPLOAD_MAX_BYTES, uploadBackupFile } from '../../services/backupService';
import { formatBackupDate, formatBytes, plural } from '../../utils/backupFormat';
import BackupAutoSwitch from './BackupAutoSwitch';
import BackupRestoreConfirm from './BackupRestoreConfirm';
import BackupRetentionForm from './BackupRetentionForm';
import BackupStatusLine from './BackupStatusLine';
import { BTN, PILL, TONE_CLASS } from './pillStyles';
import { ListSkeleton } from '../shared/Skeleton';

const FOCUS_RING =
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:[outline-color:var(--focus-ring)]';
const SUBHEADING = 'text-xs font-semibold text-slate-slate300';
const FILE_INPUT = `mt-1 block w-full max-w-sm rounded-md text-xs text-slate-slate300 file:mr-3 file:cursor-pointer file:rounded-md file:border-0 file:bg-white/10 file:px-3 file:py-1.5 file:text-sm file:font-semibold file:text-slate-slate200 disabled:cursor-not-allowed disabled:opacity-60 ${FOCUS_RING}`;
const RESTORE_QUESTION_TAIL = 'Burrow saves a safety copy of your current data first, then reloads.';
const EXPIRED_MESSAGE = 'That file check expired. Choose the file again.';
const KEYS_NOTE = 'Saved keys are not included in backups for your safety. Re-enter them after moving to a new computer.';
const MAX_TIMER_MS = 2 ** 31 - 1;

/** True when a failed restore means the checked upload is gone or unusable (not a passing "busy"). */
const uploadIsGone = (e) =>
  e?.status === 410 ||
  e?.code === 'upload_expired' ||
  e?.status === 404 ||
  e?.status === 422 ||
  (e?.status === 409 && e?.code !== 'backup_busy');

function CheckBadge({ status }) {
  const ok = status === 'verified';
  const Icon = ok ? CheckCircle2 : AlertTriangle;
  return (
    <span className={`${PILL} gap-1 ${ok ? TONE_CLASS.ok : TONE_CLASS.warn}`}>
      <Icon size={12} aria-hidden="true" />
      {ok ? 'Verified' : 'Failed'}
    </span>
  );
}

/** Server time minus this computer's time, from the server's `now`; 0 when it did not say. */
function clockOffsetFrom(serverNowIso) {
  const serverNow = Date.parse(serverNowIso ?? '');
  return Number.isFinite(serverNow) ? serverNow - Date.now() : 0;
}

// The switch shows the user's own choice (autoSwitch). autoEnabled also folds in the global BURROW_SCHEDULER
// kill switch, which the desktop app never sets: it never turns the switch off, it only adds "paused in
// this build" to an ON switch (dev and sandbox).
const switchIsOn = (status) => status?.autoSwitch !== false;

function introText(data) {
  if (!data) return 'Backups are saved as files on this computer. Nothing leaves your computer.';
  if (!switchIsOn(data.status)) {
    return 'Automatic backups are off. Use Back up now to save a backup file of your data on this computer. Nothing leaves your computer.';
  }
  return 'Burrow saves a backup file of your data on this computer about once a day and keeps recent ones. Nothing leaves your computer.';
}

export default function BackupsControl({ onRestored }) {
  const headingId = useId();
  const fileId = useId();
  const fileHintId = useId();
  const { data, isLoading, error, refetch, isRefetching, backUpNow, isBackingUp, saveSettings, isSaving, setAuto } =
    useBackups();

  const [confirming, setConfirming] = useState(null); // backup id | 'upload' | null
  const [backupMessage, setBackupMessage] = useState('');
  const [backupError, setBackupError] = useState(null);
  const [phase, setPhase] = useState('idle'); // idle | uploading | ready
  const [progress, setProgress] = useState(0);
  const [inspection, setInspection] = useState(null);
  const [uploadError, setUploadError] = useState(null);
  const [restoring, setRestoring] = useState(false);
  const inputRef = useRef(null);
  const controllerRef = useRef(null);
  const triggerRefs = useRef(new Map());
  const restoreFileRef = useRef(null);
  const returnFocusTo = useRef(null);
  const backingUp = useRef(false);
  const restoringRef = useRef(false);
  const focusTimers = useRef(new Set());

  // Leaving the page cancels a running upload and any pending timers.
  useEffect(() => {
    const timers = focusTimers.current;
    return () => {
      controllerRef.current?.abort();
      for (const id of timers) clearTimeout(id);
      timers.clear();
    };
  }, []);

  const backups = data?.backups ?? [];
  const now = new Date();

  // Wait for the next render (a disabled or hidden control may be coming back), then focus.
  const focusLater = (getNode) => {
    const id = setTimeout(() => {
      focusTimers.current.delete(id);
      getNode()?.focus();
    }, 0);
    focusTimers.current.add(id);
  };
  const focusInput = () => focusLater(() => inputRef.current);

  const setBusy = useCallback((busy) => {
    restoringRef.current = busy;
    setRestoring(busy);
  }, []);

  const dropUpload = useCallback((message) => {
    setPhase('idle');
    setInspection(null);
    setProgress(0);
    setConfirming((prev) => (prev === 'upload' ? null : prev));
    setUploadError(message);
    if (inputRef.current) inputRef.current.value = '';
  }, []);

  // A checked upload is only good for a short time; drop the stale summary when it runs out. The
  // deadline is the server's (expiresAt). clockOffsetMs is server time minus this computer's time,
  // measured once when the answer arrived, so a wrong clock here does not move the deadline.
  const expiresAt = inspection?.expiresAt;
  const clockOffsetMs = inspection?.clockOffsetMs ?? 0;
  useEffect(() => {
    if (!expiresAt) return undefined;
    const wait = new Date(expiresAt).getTime() - (Date.now() + clockOffsetMs);
    if (Number.isNaN(wait)) return undefined;
    const id = setTimeout(() => {
      if (restoringRef.current) return; // the restore already took the token
      dropUpload(EXPIRED_MESSAGE);
      const active = document.activeElement;
      if (!active || active === document.body || !document.body.contains(active)) inputRef.current?.focus();
    }, Math.min(Math.max(0, wait), MAX_TIMER_MS));
    return () => clearTimeout(id);
  }, [expiresAt, clockOffsetMs, dropUpload]);

  const runBackup = async () => {
    if (backingUp.current || restoringRef.current) return;
    backingUp.current = true;
    setBackupMessage('');
    setBackupError(null);
    try {
      await backUpNow();
      setBackupMessage('Backup saved.');
    } catch (e) {
      setBackupError(e?.message || 'The backup did not finish. Try again.');
    } finally {
      backingUp.current = false;
    }
  };

  const askRestore = (id, trigger) => {
    if (restoringRef.current) return;
    returnFocusTo.current = trigger;
    setConfirming(id);
  };

  const resetUpload = () => {
    if (restoringRef.current) return;
    controllerRef.current?.abort();
    setPhase('idle');
    setInspection(null);
    setProgress(0);
    setUploadError(null);
    setConfirming((prev) => (prev === 'upload' ? null : prev));
    if (inputRef.current) inputRef.current.value = '';
  };

  const cancelUpload = () => {
    resetUpload();
    focusInput();
  };

  const cancelRestore = () => {
    const wasUpload = confirming === 'upload';
    const trigger = triggerRefs.current.get(confirming);
    setConfirming(null);
    // Wait for the confirm group to unmount, then put focus back where the user was.
    focusLater(() => (wasUpload ? restoreFileRef.current : trigger) ?? returnFocusTo.current);
  };

  const onUploadRestoreFailed = (e) => {
    if (!uploadIsGone(e)) return;
    dropUpload(e?.message || EXPIRED_MESSAGE);
    focusInput();
  };

  const onPick = async (event) => {
    if (restoringRef.current) return;
    const picked = event.target.files?.[0] ?? null;
    setInspection(null);
    setUploadError(null);
    setConfirming((prev) => (prev === 'upload' ? null : prev));
    if (!picked) {
      setPhase('idle');
      return;
    }
    if (picked.size > BACKUP_UPLOAD_MAX_BYTES) {
      setPhase('idle');
      setUploadError(BACKUP_TOO_LARGE_MESSAGE);
      event.target.value = '';
      return;
    }
    const controller = new AbortController();
    controllerRef.current = controller;
    setProgress(0);
    setPhase('uploading');
    try {
      const result = await uploadBackupFile(picked, { signal: controller.signal, onProgress: setProgress });
      if (controller.signal.aborted) return;
      setInspection({ ...result, clockOffsetMs: clockOffsetFrom(result?.now) });
      setPhase('ready');
    } catch (e) {
      if (controller.signal.aborted || e?.name === 'AbortError') return;
      setUploadError(e?.message || 'Could not check that file. Try again.');
      setPhase('idle');
      if (inputRef.current) inputRef.current.value = '';
      focusInput();
    }
  };

  // "today 14:32" worked out against the server's clock, not this computer's.
  const expiryWhen = expiresAt ? formatBackupDate(expiresAt, new Date(now.getTime() + clockOffsetMs)) : '';
  const expiryText = expiryWhen ? `This check is good until ${expiryWhen}.` : '';
  const uploading = phase === 'uploading';
  const percent = Math.round(progress * 100);
  const backUpBusy = isBackingUp || restoring;

  return (
    <section aria-labelledby={headingId}>
      <h4 id={headingId} className="text-sm font-semibold text-slate-slate100">
        Backups
      </h4>
      <p className="mt-1 text-xs text-slate-slate400">{introText(data)}</p>
      <p className="mt-1 text-xs text-slate-slate400">{KEYS_NOTE}</p>
      {data && <BackupStatusLine status={data.status} now={now} />}
      {data && (
        <div className="mt-3">
          <BackupAutoSwitch
            enabled={switchIsOn(data.status)}
            paused={data.status?.autoSwitch === true && data.status?.autoEnabled === false}
            onChange={setAuto}
            locked={restoring}
          />
        </div>
      )}

      <div className="mt-3">
        <button type="button" onClick={runBackup} aria-disabled={backUpBusy} aria-busy={isBackingUp} className={BTN}>
          {isBackingUp ? 'Backing up…' : 'Back up now'}
        </button>
      </div>
      <p role="status" className="sr-only">
        {isBackingUp ? 'Backing up your data.' : backupMessage}
      </p>
      {backupMessage && !isBackingUp && (
        <p aria-hidden="true" className="mt-2 text-xs text-accent-green">
          {backupMessage}
        </p>
      )}
      {backupError && (
        <p role="alert" className="mt-2 text-xs text-accent-amber">
          {backupError}
        </p>
      )}

      {isLoading && (
        <div className="mt-3">
          <ListSkeleton rows={2} />
        </div>
      )}
      {error && !data && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <p role="alert" className="text-xs text-accent-amber">
            {error.message || 'Could not load your backups.'}
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
      )}

      {backups.length > 0 && (
        <table className="mt-3 w-full text-left text-xs text-slate-slate300">
          <caption className="sr-only">Your backups, newest first</caption>
          <thead>
            <tr className="text-slate-slate400">
              <th scope="col" className="py-1 pr-3 font-semibold">
                Date
              </th>
              <th scope="col" className="py-1 pr-3 font-semibold">
                Size
              </th>
              <th scope="col" className="py-1 pr-3 font-semibold">
                Status
              </th>
              <th scope="col" className="py-1 text-right font-semibold">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {backups.map((backup) => {
              const date = formatBackupDate(backup.createdAt, now) || 'Unknown date';
              const ok = backup.status === 'verified';
              return [
                <tr key={backup.id} className="border-t border-white/10">
                  <th scope="row" className="py-2 pr-3 font-normal">
                    {date}
                    {backup.pinned && <span className={`${PILL} ${TONE_CLASS.muted} ml-2`}>Safety copy</span>}
                  </th>
                  <td className="whitespace-nowrap py-2 pr-3 tabular-nums">{ok ? formatBytes(backup.sizeBytes) : ''}</td>
                  <td className="py-2 pr-3">
                    <CheckBadge status={backup.status} />
                  </td>
                  <td className="py-2 text-right">
                    {ok ? (
                      <button
                        type="button"
                        ref={(node) => {
                          if (node) triggerRefs.current.set(backup.id, node);
                          else triggerRefs.current.delete(backup.id);
                        }}
                        onClick={(event) => askRestore(backup.id, event.currentTarget)}
                        aria-disabled={restoring}
                        aria-label={`Restore backup from ${date}`}
                        className={BTN}
                      >
                        Restore
                      </button>
                    ) : (
                      <span className="text-slate-slate400">{"Can't be restored"}</span>
                    )}
                  </td>
                </tr>,
                confirming === backup.id && (
                  <tr key={`${backup.id}-confirm`}>
                    <td colSpan={4} className="pb-3">
                      <BackupRestoreConfirm
                        source={{ id: backup.id }}
                        question={`Restore the backup from ${date}? ${RESTORE_QUESTION_TAIL}`}
                        onCancel={cancelRestore}
                        onRestored={onRestored}
                        onBusyChange={setBusy}
                      />
                    </td>
                  </tr>
                ),
              ];
            })}
          </tbody>
        </table>
      )}

      {data && (
        <div className="mt-4">
          <BackupRetentionForm settings={data.settings} onSave={saveSettings} saving={isSaving} locked={restoring} />
        </div>
      )}

      <div className="mt-4">
        <label htmlFor={fileId} className={`block ${SUBHEADING}`}>
          Restore from a file
        </label>
        <p id={fileHintId} className="mt-1 text-xs text-slate-slate400">
          Choose a backup file (.db) you saved earlier. You&apos;ll see a summary before anything changes. For a .zip
          export, use Import data below.
        </p>
        <input
          ref={inputRef}
          id={fileId}
          type="file"
          accept=".db"
          onChange={onPick}
          disabled={uploading || restoring}
          aria-describedby={fileHintId}
          className={FILE_INPUT}
        />
        {uploading && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <progress value={percent} max={100} aria-label="Upload progress" className="h-2 w-40" />
            <span className="text-xs text-slate-slate300" aria-hidden="true">
              {percent}%
            </span>
            <button type="button" onClick={cancelUpload} className={BTN}>
              Cancel upload
            </button>
          </div>
        )}
        <p role="status" className="sr-only">
          {uploading ? 'Checking your backup file.' : ''}
        </p>
        {uploadError && (
          <p role="alert" className="mt-2 text-xs text-accent-amber">
            {uploadError}
          </p>
        )}
        {phase === 'ready' && inspection && (
          <div className="mt-3">
            <p className="text-xs text-slate-slate300">
              {`This backup file has ${plural(inspection.totalRows, 'item', 'items')} (${formatBytes(inspection.bytes)}). ${
                inspection.migrationNeeded
                  ? 'It was made by an older version of Burrow, so Burrow will update it as it restores.'
                  : 'It matches this version of Burrow.'
              }`}
            </p>
            {expiryText && <p className="mt-1 text-xs text-slate-slate400">{expiryText}</p>}
            {confirming === 'upload' ? (
              <div className="mt-3">
                <BackupRestoreConfirm
                  source={{ uploadToken: inspection.uploadToken }}
                  question={`Restore this backup file? ${RESTORE_QUESTION_TAIL}`}
                  onCancel={cancelRestore}
                  onRestored={onRestored}
                  onBusyChange={setBusy}
                  onFailed={onUploadRestoreFailed}
                />
              </div>
            ) : (
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  ref={restoreFileRef}
                  onClick={(event) => askRestore('upload', event.currentTarget)}
                  aria-disabled={restoring}
                  className={BTN}
                >
                  Restore this file
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {data?.location && (
        <div className="mt-4">
          <p className={SUBHEADING}>Where backups are kept</p>
          <code className="mt-1 inline-block max-w-full break-all rounded-md bg-white/5 px-2 py-1 text-xs text-slate-slate200 select-all">
            {data.location}
          </code>
          {data.desktop && (
            <p className="mt-1 text-xs text-slate-slate400">
              You can also open it from the Help menu: Open data folder.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
