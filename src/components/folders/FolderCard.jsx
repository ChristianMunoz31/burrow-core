import { Suspense, useId, useState } from 'react';
import { ChevronDown, ChevronRight, RefreshCw } from 'lucide-react';
import { useFolderJob } from '../../hooks/useFolderJob';
import { FolderAskPanel, PRO_UI_INCLUDED } from '../../extensions/proExtensions';
import { userMessage } from '../../utils/apiError';
import AiUnavailable from '../shared/AiUnavailable';
import NotIncludedNotice from '../shared/NotIncludedNotice';
import WithheldNotice from '../javi/WithheldNotice';
import { BTN } from '../settings/pillStyles';
import { formErrorClass } from '../shared/formStyles';
import { usePickFlow } from '../../hooks/usePickFlow';
import { useToast } from '../../contexts/ToastContext';
import AddFolderDialog from './AddFolderDialog';
import FolderMoreMenu from './FolderMoreMenu';
import FolderFilesTable from './FolderFilesTable';
import FolderJobProgress from './FolderJobProgress';
import FolderDetails, { FolderLimits } from './FolderStats';
import { hasDetails, statsLine } from '../../utils/folderStats';
import FolderReportCard from './FolderReportCard';
import PickStatus from './PickStatus';
import { TOGGLE } from './folderStyles';
import {
  ASK_HEADING,
  CHOOSE_FOLDER_BUTTON,
  CONFIRM_FOLDER_BUTTON,
  NEEDS_CONFIRM_TEXT,
  SUMMARY_AI_UNAVAILABLE,
  ERROR_COPY,
  GENERIC_ERROR,
  LAST_JOB_FALLBACK,
  ONEDRIVE_WARNING,
  WITHHELD_MESSAGE,
  formatDate,
  isJobActive,
} from '../../constants/folders';

const SAVE_ERROR = "Couldn't save that change. Try again.";

function JobNotice({ notice }) {
  if (notice.code === 'withheld') {
    return <WithheldNotice message={notice.message || WITHHELD_MESSAGE} />;
  }
  if (notice.code === 'ai_unavailable') {
    return <AiUnavailable message={notice.message} className="text-sm text-slate-slate300" />;
  }
  return (
    <p role="status" className="text-sm text-slate-slate300">
      {notice.message}
    </p>
  );
}

function SummaryBlock({ folder, scanning, noticeShown }) {
  const { summary } = folder;
  if (summary.text && (summary.status === 'ok' || summary.status === 'stale')) {
    return (
      <div className="space-y-1">
        <p className="whitespace-pre-wrap text-sm text-slate-slate100">{summary.text}</p>
        {summary.status === 'stale' && (
          <p className="text-sm text-accent-amber">
            This summary is from {formatDate(summary.at)}. Re-scan to update it.
          </p>
        )}
      </div>
    );
  }
  if (summary.status === 'withheld') return noticeShown ? null : <WithheldNotice message={WITHHELD_MESSAGE} />;
  if (summary.status === 'failed') {
    return <p className="text-sm text-slate-slate400">Burrow couldn&apos;t write a summary. Click Re-scan to try again.</p>;
  }
  if (summary.status === 'ai_unavailable') {
    return (
      <p className="text-sm text-slate-slate400">{SUMMARY_AI_UNAVAILABLE}</p>
    );
  }
  if (!folder.lastScanAt && !scanning) return <p className="text-sm text-slate-slate400">Not read yet.</p>;
  return null;
}

function Toggle({ open, controls, label, onClick, children }) {
  return (
    <button type="button" aria-expanded={open} aria-controls={controls} aria-label={label} onClick={onClick} className={TOGGLE}>
      {open ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
      {children}
    </button>
  );
}

/**
 * One folder: its summary, inventory, progress, file list and actions. The panels that come from the private
 * module (questions, report and the daily re-scan) show the not-included notice when this build lacks it.
 * @param {{ folder: object,
 *   onScan: (id: string) => Promise<unknown>, onCancel: (id: string) => Promise<unknown>,
 *   onRemove: (folder: object) => void, onUpdate: (id: string, patch: object) => Promise<unknown>,
 *   onExport: (id: string, format: 'md'|'json'|'csv') => Promise<unknown>,
 *   shell: { canPickFolder: boolean, canSaveFile: boolean, busy: boolean, pick: (folderId?: string) => Promise<object|null>,
 *     cancel: () => void, confirm: (id: string, path: string) => Promise<unknown>,
 *     exportToChosen: (id: string, format: 'md'|'json'|'csv') => Promise<object|null> } }} props `shell` is the
 *   page's one window at a time (choose a folder, choose where to save). An imported folder (`needsConfirm`)
 *   shows only the confirm step, its export and Remove.
 */
export default function FolderCard({ folder, onScan, onCancel, onRemove, onUpdate, onExport, shell }) {
  // Built from the folder's own id, so the page can focus it for /folders?folder=<id>.
  const headingId = `folder-${folder.id}`;
  const filesId = useId();
  const detailsId = useId();
  const askId = useId();
  const reportId = useId();
  const [open, setOpen] = useState(null);
  const [seen, setSeen] = useState({});
  const [actionError, setActionError] = useState('');
  const [exportError, setExportError] = useState('');
  const [busy, setBusy] = useState(false);
  const [switchBusy, setSwitchBusy] = useState(false);
  const [switchGate, setSwitchGate] = useState(false);
  const [switchError, setSwitchError] = useState('');
  const [confirming, setConfirming] = useState(false);
  const toast = useToast();
  const flow = usePickFlow(shell.pick);
  const needsConfirm = folder.needsConfirm === true;

  // The list is the source of truth for whether a job is active; the polled job only refines an active one. A scan's
  // queued job remembered in the cache would otherwise outlive a fast scan the list already shows as done, and a
  // cached terminal job must not hide a new active job the list shows (scheduled re-scan, another tab).
  const active = isJobActive(folder.job);
  const { job: polled } = useFolderJob(folder.id, { active });
  const job = active && polled && (polled.id === folder.job?.id || isJobActive(polled)) ? polled : folder.job;
  const running = isJobActive(job);
  const notices = running ? [] : (job?.notices ?? []);
  const lastJob = !running && folder.lastJob && folder.lastJob.status !== 'done' ? folder.lastJob : null;
  const failedJobError = !lastJob && !running && job?.error ? job.error : null;

  const act = async (fn) => {
    setBusy(true);
    setActionError('');
    try {
      await fn();
    } catch (err) {
      setActionError(userMessage(err, ERROR_COPY[err?.code] ?? GENERIC_ERROR));
    } finally {
      setBusy(false);
    }
  };

  const toggleAuto = async (next) => {
    setSwitchError('');
    if (next && !PRO_UI_INCLUDED) {
      setSwitchGate(true);
      return;
    }
    setSwitchGate(false);
    setSwitchBusy(true);
    try {
      await onUpdate(folder.id, { autoRescan: next });
      toast({ message: next ? 'Daily re-scan on' : 'Daily re-scan off', type: 'success' });
    } catch (err) {
      setSwitchError(userMessage(err, SAVE_ERROR));
    } finally {
      setSwitchBusy(false);
    }
  };

  // Ask and Report mount on their first open and stay mounted (hidden) so a typed question survives collapsing.
  const flip = (id) => {
    setOpen((o) => ({ ...o, [id]: !o?.[id] }));
    setSeen((s) => (s[id] ? s : { ...s, [id]: true }));
  };
  const showFiles = open?.files === true;
  const meta = [
    statsLine(folder.stats),
    folder.lastScanAt ? `Last read ${formatDate(folder.lastScanAt)}` : '',
    folder.autoRescan && !needsConfirm ? 'Re-scans daily' : '',
  ].filter(Boolean);

  return (
    // `.glass` (backdrop-filter) makes each card its own stacking context, so a card with its More menu open is raised
    // above the next card; otherwise the menu's lower items would sit under that card and miss mouse clicks.
    <article
      aria-labelledby={headingId}
      className="glass relative space-y-4 rounded-2xl p-5 has-[[aria-haspopup=menu][aria-expanded=true]]:z-10"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 id={headingId} tabIndex={-1} className="break-words text-sm font-bold tracking-tight text-slate-slate100">
            <bdi>{folder.name}</bdi>
          </h3>
          <p className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-slate-slate400">
            <span className="break-all">
              <bdi>{folder.path}</bdi>
            </span>
            {meta.length > 0 && <span>{meta.join('. ')}.</span>}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {needsConfirm ? (
            <button
              type="button"
              aria-disabled={shell.busy || undefined}
              aria-label={`${shell.canPickFolder ? CHOOSE_FOLDER_BUTTON : CONFIRM_FOLDER_BUTTON}: ${folder.name}`}
              onClick={() => {
                if (shell.busy) return;
                if (shell.canPickFolder) flow.run(folder.id);
                else setConfirming(true);
              }}
              className={BTN}
            >
              {shell.canPickFolder ? CHOOSE_FOLDER_BUTTON : CONFIRM_FOLDER_BUTTON}
            </button>
          ) : (
            <button
              type="button"
              aria-disabled={busy || running || undefined}
              aria-label={`Re-scan ${folder.name}`}
              onClick={() => {
                if (busy || running) return;
                act(() => onScan(folder.id));
              }}
              className={`${BTN} inline-flex items-center gap-1.5`}
            >
              <RefreshCw size={14} aria-hidden="true" />
              Re-scan
            </button>
          )}
          <FolderMoreMenu
            label={folder.name}
            onDownload={(format) => onExport(folder.id, format)}
            onError={setExportError}
            canSaveFile={shell.canSaveFile}
            onSaveChosen={(format) => shell.exportToChosen(folder.id, format)}
            onCancelSave={shell.cancel}
            shellBusy={shell.busy}
            autoRescan={needsConfirm ? undefined : folder.autoRescan}
            autoBusy={switchBusy}
            onToggleAuto={toggleAuto}
            onRemove={() => onRemove(folder)}
          />
        </div>
      </div>

      {needsConfirm && (
        <p role="note" className="text-sm text-accent-amber">
          {NEEDS_CONFIRM_TEXT}
        </p>
      )}
      <PickStatus flow={flow} onStop={shell.cancel} onAgain={() => flow.run(folder.id)} />

      {actionError && (
        <p role="alert" className="text-xs text-accent-red">
          {actionError}
        </p>
      )}

      {exportError && (
        <p role="alert" className={formErrorClass}>
          {exportError}
        </p>
      )}

      {switchError && (
        <p role="alert" className="text-xs text-accent-red">
          {switchError}
        </p>
      )}
      {switchGate && <NotIncludedNotice capability="folder_auto_rescan" />}

      {running && (
        <FolderJobProgress
          job={job}
          cancelling={busy}
          onCancel={() => act(() => onCancel(folder.id))}
        />
      )}

      {folder.warnings?.includes('onedrive') && (
        <p role="note" className="text-sm text-accent-amber">
          {ONEDRIVE_WARNING}
        </p>
      )}
      {lastJob && (
        <p role="status" className={`text-sm ${lastJob.status === 'failed' ? 'text-accent-red' : 'text-slate-slate300'}`}>
          {lastJob.message || LAST_JOB_FALLBACK[lastJob.status]}
        </p>
      )}
      {failedJobError && (
        <p role="status" className="text-sm text-accent-red">
          {failedJobError.message}
        </p>
      )}
      {notices.map((notice) => (
        <JobNotice key={`${notice.code}:${notice.message}`} notice={notice} />
      ))}

      <SummaryBlock folder={folder} scanning={running} noticeShown={notices.some((n) => n.code === 'withheld')} />
      <FolderLimits stats={folder.stats} />

      <div className="flex flex-wrap items-center gap-x-5 gap-y-1">
        <Toggle open={showFiles} controls={filesId} label={`Files in ${folder.name}`} onClick={() => flip('files')}>
          Files
        </Toggle>
        {hasDetails(folder.stats) && (
          <Toggle open={open?.details === true} controls={detailsId} label={`Details of ${folder.name}`} onClick={() => flip('details')}>
            Details
          </Toggle>
        )}
        {!needsConfirm && (
          <>
            <Toggle open={open?.ask === true} controls={askId} label={`Ask about ${folder.name}`} onClick={() => flip('ask')}>
              Ask
            </Toggle>
            <Toggle open={open?.report === true} controls={reportId} label={`Report for ${folder.name}`} onClick={() => flip('report')}>
              Report
            </Toggle>
          </>
        )}
      </div>
      <div id={filesId} hidden={!showFiles}>
        {showFiles && (
          <FolderFilesTable
            folderId={folder.id}
            name={folder.name}
            job={job}
            onRescan={() => act(() => onScan(folder.id))}
            rescanDisabled={busy || needsConfirm}
          />
        )}
      </div>
      <div id={detailsId} hidden={open?.details !== true}>
        <FolderDetails stats={folder.stats} />
      </div>
      {!needsConfirm && (
        <>
          <div id={askId} hidden={open?.ask !== true}>
            {seen.ask &&
              (FolderAskPanel ? (
                <Suspense fallback={null}>
                  <FolderAskPanel folder={folder} />
                </Suspense>
              ) : (
                <section aria-label={`${ASK_HEADING}: ${folder.name}`}>
                  <NotIncludedNotice capability="folder_qa" />
                </section>
              ))}
          </div>
          <div id={reportId} hidden={open?.report !== true}>
            {seen.report && <FolderReportCard folder={folder} busy={running} />}
          </div>
        </>
      )}
      {confirming && (
        <AddFolderDialog
          mode="confirm"
          initialPath={folder.path}
          onAdd={({ path }) => shell.confirm(folder.id, path)}
          onClose={() => setConfirming(false)}
        />
      )}
    </article>
  );
}
