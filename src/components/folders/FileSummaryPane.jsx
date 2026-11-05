import WithheldNotice from '../javi/WithheldNotice';
import { JobBar } from './FolderJobProgress';
import {
  FILE_STATUS_FALLBACK,
  FILE_STATUS_LABELS,
  FILE_SUMMARY_LABELS,
  SUMMARY_NONE,
  SUMMARY_SUMMARIZING,
  SUMMARY_WAITING,
  WITHHELD_MESSAGE,
  isJobActive,
} from '../../constants/folders';

// Summary states that are final until the next scan, so "waiting for its turn" would be wrong.
// Job phases in which a file without a summary can still get one.
const WAITING_PHASES = new Set(['queued', 'inventory', 'summarizing_files']);
const SETTLED = new Set(['failed', 'not_included', 'withheld', 'not_text', 'ai_unavailable']);

/**
 * The right pane for one file, derived from the file row and the folder's job: its summary, "Summarizing",
 * "Waiting for its turn", or why there is none. Plain text only.
 * @param {{ file: object, job: object|null }} props
 */
export default function FileSummaryPane({ file, job }) {
  const running = isJobActive(job);
  const text = (value, tone = 'text-slate-slate300') => <p className={`text-sm ${tone}`}>{value}</p>;

  if (file.status !== 'ok') return text(FILE_STATUS_LABELS[file.status] ?? FILE_STATUS_FALLBACK);
  if (file.summary && (file.summaryStatus === 'ok' || file.summaryStatus === 'stale')) {
    return (
      <div className="space-y-1">
        <p className="whitespace-pre-wrap break-words text-sm text-slate-slate100">{file.summary}</p>
        {file.summaryStatus === 'stale' && <p className="text-xs text-accent-amber">{FILE_SUMMARY_LABELS.stale}</p>}
      </div>
    );
  }
  if (running && job.progress?.currentFileId === file.id) {
    return (
      <div>
        <p className="text-sm text-slate-slate100">{SUMMARY_SUMMARIZING}</p>
        <JobBar job={job} />
      </div>
    );
  }
  const mayStillGetOne = job?.status === 'queued' || WAITING_PHASES.has(job?.phase);
  if (running && mayStillGetOne && !SETTLED.has(file.summaryStatus)) return text(SUMMARY_WAITING, 'text-slate-slate400');
  if (file.summaryStatus === 'withheld') return <WithheldNotice message={WITHHELD_MESSAGE} />;
  if (FILE_SUMMARY_LABELS[file.summaryStatus]) return text(FILE_SUMMARY_LABELS[file.summaryStatus], 'text-slate-slate400');
  return text(SUMMARY_NONE, 'text-slate-slate400');
}
