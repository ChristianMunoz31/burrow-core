import { AlertTriangle } from 'lucide-react';
import { useAppInfo } from '../../hooks/useAppInfo';
import { useSyncedSetting } from '../../hooks/useSyncedSetting';

// The folder whose warning the user dismissed. Saved with the other settings (not in the browser alone: the desktop window's
// origin changes on every launch, so browser storage would forget it), and per folder, so a moved data folder warns again.
const SEEN_KEY = 'dataFolderWarning:seen';
const DISMISS =
  'ml-auto shrink-0 rounded-md px-2 py-1 text-xs font-semibold text-slate-slate300 hover:text-slate-slate100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:[outline-color:var(--focus-ring)]';

/**
 * One-time warning when the data folder lies inside OneDrive (or is a linked folder), where a sync program can damage a live
 * database. It never blocks anything; Dismiss remembers the folder. Renders nothing otherwise.
 */
export default function DataFolderWarning() {
  const { info } = useAppInfo();
  const [seen, setSeen, { isFetched }] = useSyncedSetting(SEEN_KEY, '');
  const warning = info?.dataFolderWarning;
  const path = typeof info?.dataDir === 'string' ? info.dataDir : '';
  // Wait for the saved value, so a dismissed warning never flashes.
  if (!warning || typeof warning.message !== 'string' || !isFetched || seen === path) return null;
  return (
    <aside aria-label="Data folder warning" className="glass-subtle mb-4 flex items-start gap-2 rounded-lg p-3 text-sm text-slate-slate200">
      <AlertTriangle size={16} className="mt-0.5 shrink-0 text-accent-amber" aria-hidden="true" />
      <p className="min-w-0">
        {warning.message}{warning.code === 'onedrive' ? ' Move the folder out of OneDrive, or stop OneDrive from syncing it.' : ''} It is in {path}.
      </p>
      <button type="button" onClick={() => setSeen(path)} className={DISMISS}>
        Dismiss
      </button>
    </aside>
  );
}
