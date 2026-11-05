import { useEffect, useId, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import SectionCard from '../shared/SectionCard';
import { ListSkeleton } from '../shared/Skeleton';
import { sectionProps } from './settingsSections';
import { BTN, LINK_BTN } from './pillStyles';
import SwitchToggle from './SwitchToggle';
import UpdateInstallPanel from './UpdateInstallPanel';
import { GENERIC_ERROR, HINT, PRIMARY_BTN, UNAVAILABLE_COPY } from './updateCopy';
import { useAppInfo } from '../../hooks/useAppInfo';
import { useNetworkSettings } from '../../hooks/useNetworkSettings';
import { useUpdateCheck } from '../../hooks/useUpdateCheck';
import { useUpdateInstall } from '../../hooks/useUpdateInstall';
import { userMessage } from '../../utils/apiError';

export const STORE_UPDATES_COPY = 'Updates come from the Microsoft Store. Burrow does not check for updates itself.';

const STORE_URL = 'https://apps.microsoft.com/detail/9NT29CNPKBK4';
const RELEASES = 'https://github.com/ChristianMunoz31/burrow-releases/releases/';
const INSTALLER_URL = /^https:\/\/github\.com\/ChristianMunoz31\/burrow-releases\/releases\/download\/v\d+\.\d+\.\d+\/Burrow-Setup-(x64|arm64)\.exe$/;
const SUMS_URL = /^https:\/\/github\.com\/ChristianMunoz31\/burrow-releases\/releases\/download\/v\d+\.\d+\.\d+\/SHA256SUMS\.txt$/;
const FILE_NAME = /^Burrow-Setup-(x64|arm64)\.exe$/;
const LINK = 'underline underline-offset-2';
const EXTERNAL = { target: '_blank', rel: 'noopener noreferrer' };
const CODE_BLOCK = 'glass-subtle block break-all rounded-md p-2 font-mono text-xs text-slate-slate100';

/** Screen-reader note for a link that leaves Burrow (the desktop app hands web links to the default browser). */
function OpensInBrowser() {
  return (
    <>
      {' '}
      <span className="sr-only">(opens in your browser)</span>
    </>
  );
}

const formatDate = (iso) => {
  const d = new Date(iso);
  return typeof iso === 'string' && !Number.isNaN(d.getTime())
    ? d.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' })
    : null;
};
const formatDateTime = (iso) => {
  const d = new Date(iso);
  return typeof iso === 'string' && !Number.isNaN(d.getTime())
    ? d.toLocaleString([], { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    : null;
};

/** True when the answer is the installer Burrow asked for: right version, pinned link, plain file name, SHA-256. */
const isValidInstaller = (r, version) =>
  /^[0-9a-f]{64}$/.test(r?.sha256) &&
  FILE_NAME.test(r.fileName) &&
  r.version === version &&
  INSTALLER_URL.test(r.installerUrl) &&
  r.installerUrl.endsWith(`/v${version}/${r.fileName}`);

/** Get the installer: the server saves a backup, then returns the pinned link and the expected SHA-256 to check. */
function ManualDownload({ version, onBusyChange }) {
  const { getInstaller } = useUpdateInstall();
  const [phase, setPhase] = useState('idle'); // idle | saving | ready
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const busy = useRef(false);
  const headingRef = useRef(null);
  const saving = phase === 'saving';

  useEffect(() => {
    if (phase === 'ready') headingRef.current?.focus();
  }, [phase]);

  // Tell the parent while the backup is being saved, so Check now cannot swap the version underneath.
  useEffect(() => {
    onBusyChange?.(saving);
    return () => onBusyChange?.(false);
  }, [saving, onBusyChange]);

  const get = async () => {
    if (busy.current) return;
    busy.current = true;
    setError(null);
    setPhase('saving');
    try {
      const r = await getInstaller(version);
      if (!isValidInstaller(r, version)) throw new Error('invalid');
      setResult(r);
      setPhase('ready');
    } catch (err) {
      setError(err);
      setPhase('idle');
    } finally {
      busy.current = false;
    }
  };

  return (
    <div className="space-y-2">
      {/* Always mounted, so screen readers announce the saving line when it appears. */}
      <div role="status" aria-live="polite">
        {saving && <p className={HINT}>Saving a backup of your data...</p>}
      </div>
      {phase === 'ready' ? (
        <>
          <h5 ref={headingRef} tabIndex={-1} className="text-sm font-semibold text-slate-slate100 outline-none">
            Backup saved. Download Burrow {result.version}
          </h5>
          <a href={result.installerUrl} {...EXTERNAL} className={PRIMARY_BTN}>
            Download {result.fileName}
            <OpensInBrowser />
          </a>
          <p className={HINT}>
            When it finishes, check that the download is complete and unchanged before you run it. Open PowerShell and run:
          </p>
          <code className={CODE_BLOCK}>
            {`Get-FileHash "$env:USERPROFILE\\Downloads\\${result.fileName}" -Algorithm SHA256`}
          </code>
          <p className={HINT}>If your browser saved it under another name or folder, use that path.</p>
          <p className={HINT}>The hash must be:</p>
          <code className={CODE_BLOCK}>{result.sha256}</code>
          <p className={HINT}>
            If it is different, delete the file and download it again. If it matches, the download is complete and unchanged: close
            Burrow and run the installer. Your data stays on your computer.
          </p>
          <p className={HINT}>Windows may show &quot;Windows protected your PC&quot;. Click More info, then Run anyway.</p>
          <p className={HINT}>
            The checksum comes from{' '}
            {SUMS_URL.test(result.sumsUrl) ? (
              <a href={result.sumsUrl} {...EXTERNAL} className={LINK}>
                SHA256SUMS.txt
                <OpensInBrowser />
              </a>
            ) : (
              'SHA256SUMS.txt'
            )}{' '}
            on GitHub.
          </p>
        </>
      ) : (
        <>
          {error && (
            <p role="alert" className="text-sm text-accent-amber">
              {userMessage(error, GENERIC_ERROR)}
            </p>
          )}
          <button type="button" onClick={get} aria-disabled={saving} className={PRIMARY_BTN}>
            {saving ? 'Saving a backup...' : 'Get the installer'}
          </button>
        </>
      )}
    </div>
  );
}

function AvailableUpdate({ status, recheck, onBusyChange }) {
  const notesId = useId();
  const { latest, notes, canInstall, canDownload } = status;
  const date = formatDate(status.publishedAt);
  const hasNotes = typeof notes === 'string' && notes.trim() !== '';
  const safeUrl = typeof status.url === 'string' && status.url.startsWith(RELEASES);

  return (
    <div className="glass-subtle space-y-3 rounded-md p-3">
      <div>
        <h4 className="text-sm font-semibold text-slate-slate100">Burrow {latest} is available</h4>
        {date && <p className={HINT}>Released {date}.</p>}
      </div>
      {hasNotes && (
        <div>
          <p id={notesId} className="text-xs font-semibold text-slate-slate300">
            What&apos;s new
          </p>
          <div
            tabIndex={0}
            role="region"
            aria-labelledby={notesId}
            className="mt-1 max-h-48 overflow-y-auto whitespace-pre-wrap break-words text-xs text-slate-slate300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:[outline-color:var(--focus-ring)]"
          >
            {notes}
          </div>
        </div>
      )}
      {canInstall && (
        <>
          <p className={HINT}>
            Before it updates, Burrow saves a backup of your data. If the backup fails, nothing is downloaded. The new version also keeps
            a copy of your data file before it changes anything.
          </p>
          <UpdateInstallPanel key={latest} version={latest} onRecheck={recheck} onBusyChange={onBusyChange} />
        </>
      )}
      {!canInstall && canDownload && (
        <>
          <p className={HINT}>Burrow saves a backup of your data first. Then your browser downloads the installer.</p>
          <ManualDownload key={latest} version={latest} onBusyChange={onBusyChange} />
        </>
      )}
      {!canInstall && !canDownload && (
        <p className={HINT}>To update, download the new version from the releases page.</p>
      )}
      {safeUrl && (
        <a href={status.url} {...EXTERNAL} className={`${HINT} ${LINK}`}>
          See what&apos;s new on GitHub
          <OpensInBrowser />
        </a>
      )}
    </div>
  );
}

export default function UpdatesSection() {
  const { info, isLoading: infoLoading, refetch: refetchInfo } = useAppInfo();
  const { features, isLoading: featuresLoading, refetch: refetchFeatures, setEnabled } = useNetworkSettings();
  const labelId = useId();
  const descId = useId();
  const noteId = useId();
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [saveError, setSaveError] = useState(false);
  const [checkError, setCheckError] = useState(false);
  // True once Check now has turned the opt-in on: the section then runs the one (refreshing) check itself, so the
  // query's own first fetch cannot fire a second request. The switch hands control back.
  const [driven, setDriven] = useState(false);
  // An install or installer download is under way in the update card: version changes must wait.
  const [panelBusy, setPanelBusy] = useState(false);
  // Without app info the edition is unknown, so no update control is shown (and no request is made).
  const mode = !info ? null : info.distribution === 'store' ? 'store' : info.channel === 'dev' ? 'dev' : 'stable';
  const on = features?.find((f) => f.id === 'updates')?.enabled === true;
  const { status, isLoading, recheck } = useUpdateCheck({ enabled: mode === 'stable' && on && !driven });

  const save = async (enabled) => {
    setSaveError(false);
    try {
      await setEnabled('updates', enabled);
      return true;
    } catch {
      setSaveError(true);
      return false;
    }
  };

  // One action at a time; the ref closes the gap before the next render.
  const exclusive = async (action) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await action();
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const toggle = (enabled) => {
    if (panelBusy) return undefined;
    return exclusive(async () => {
      setDriven(false);
      setCheckError(false);
      await save(enabled);
    });
  };

  // The card's own "Check again": a success clears the section's failed-check line; a failure is shown by both.
  const recheckFromPanel = async () => {
    try {
      await recheck();
      setCheckError(false);
    } catch (err) {
      setCheckError(true);
      throw err;
    }
  };

  const checking = busy || isLoading;
  const checkNow = () => {
    if (checking || panelBusy) return undefined;
    return exclusive(async () => {
      if (!on) {
        setDriven(true);
        if (!(await save(true))) {
          setDriven(false);
          return;
        }
      }
      try {
        await recheck();
        setCheckError(false);
      } catch {
        // The section keeps showing the last result, with a line saying the check failed.
        setCheckError(true);
      }
    });
  };

  const version = typeof info?.version === 'string' && info.version !== 'unknown' ? info.version : null;
  const edition = {
    store: 'Desktop app from the Microsoft Store',
    dev: 'Burrow Dev, a test build',
    stable: info?.desktop ? 'Desktop app, direct download' : 'Running in your browser',
  }[mode];
  const result = on && !isLoading ? status : null;
  const unavailable =
    on && !checking && (checkError || !result || (result.status !== 'current' && result.status !== 'available'));
  let liveText = '';
  if (checking) liveText = 'Checking for updates...';
  else if (unavailable) liveText = UNAVAILABLE_COPY;
  else if (result?.status === 'current') liveText = 'You have the latest version.';
  else if (result?.status === 'available') liveText = `Burrow ${result.latest} is available.`;
  // The available announcement repeats the card heading, so only screen readers get it.
  const liveClass = result?.status === 'available' && !checking && !unavailable ? 'sr-only' : liveText ? HINT : undefined;
  const checkedAt = formatDateTime(result?.checkedAt);

  return (
    <SectionCard
      {...sectionProps('updates')}
      title="Updates"
      subtitle="Get the newest Burrow. Nothing is downloaded until you choose to."
      icon={RefreshCw}
    >
      {infoLoading ? (
        <ListSkeleton rows={2} />
      ) : !info ? (
        <div className="flex flex-wrap items-center gap-3">
          <p role="alert" className="text-sm text-accent-amber">
            Couldn&apos;t load details about this copy of Burrow.
          </p>
          <button type="button" onClick={() => refetchInfo?.()} className={BTN}>
            Retry
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          <div>
            {version && <p className="text-sm text-slate-slate100">You have Burrow {version}.</p>}
            <p className="text-xs text-slate-slate400">{edition}</p>
          </div>

          {mode === 'store' && (
            <>
              <p className={HINT}>{STORE_UPDATES_COPY}</p>
              <a href={STORE_URL} {...EXTERNAL} className={LINK_BTN}>
                Open in Microsoft Store
                <OpensInBrowser />
              </a>
            </>
          )}

          {mode === 'dev' && (
            <p className={HINT}>
              Burrow Dev updates from its source folder with <span className="font-mono">npm run dev:update</span>. It never updates
              itself.
            </p>
          )}

          {mode === 'stable' && featuresLoading && <ListSkeleton rows={1} />}

          {mode === 'stable' && !featuresLoading && !features && (
            <div className="flex flex-wrap items-center gap-3">
              <p role="alert" className="text-sm text-accent-amber">
                Couldn&apos;t load update settings.
              </p>
              <button type="button" onClick={() => refetchFeatures()} className={BTN}>
                Retry
              </button>
            </div>
          )}

          {mode === 'stable' && features && (
            <>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p id={labelId} className="text-sm font-semibold text-slate-slate100">
                    Check for updates when I open Settings
                  </p>
                  <p id={descId} className="text-xs text-slate-slate400">
                    Asks GitHub for the newest version. Nothing about you or your data is sent. This is the same switch as Update check
                    in Settings &gt; Network.
                  </p>
                </div>
                <SwitchToggle checked={on} disabled={busy || panelBusy} labelledBy={labelId} describedBy={descId} onChange={toggle} />
              </div>

              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={checkNow}
                  aria-disabled={checking || panelBusy}
                  aria-busy={checking}
                  aria-describedby={on ? undefined : noteId}
                  className={BTN}
                >
                  {checking ? 'Checking...' : 'Check now'}
                </button>
                {!on && (
                  <p id={noteId} className="text-xs text-slate-slate400">
                    Checking turns on update checks. You can turn them off again here.
                  </p>
                )}
              </div>
              {saveError && (
                <p role="alert" className="text-xs text-accent-amber">
                  Couldn&apos;t save that change. Try again.
                </p>
              )}

              {/* Always mounted, so screen readers announce the checking, current, available and unavailable lines. */}
              <p role="status" aria-live="polite" className={liveClass}>
                {liveText}
              </p>
              {checkedAt && !checking && <p className="text-xs text-slate-slate400">Last checked {checkedAt}.</p>}
              {/* Stays mounted during a recheck, so an install under way keeps its state. */}
              {result?.status === 'available' && (
                <AvailableUpdate status={result} recheck={recheckFromPanel} onBusyChange={setPanelBusy} />
              )}
            </>
          )}
        </div>
      )}
    </SectionCard>
  );
}
