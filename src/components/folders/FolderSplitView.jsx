import { useCallback } from 'react';
import { ArrowDown, ArrowUp, X } from 'lucide-react';
import { usePreview } from '../../hooks/usePreview';
import { stripBidi } from '../../utils/folderPreview';
import { PREVIEW_NONE_TEXT } from '../../constants/folders';
import FilePreviewPane from './FilePreviewPane';
import FileSummaryPane from './FileSummaryPane';
import { FOCUS, ICON_BTN } from './folderStyles';

// Each pane scrolls on its own. On a narrow screen the two panes stack; from md up they sit side by side.
// The preview sits on one quiet surface; the summary is plain text beside it.
const PANE = 'max-h-96 min-h-32 overflow-auto rounded-lg p-3';

/**
 * The split view of a folder's file list: a read-only preview of the selected file on the left and its summary
 * and status on the right. Previous and next move through the files on the current page; both panes follow.
 * With nothing selected it is one quiet line: the folder summary lives on the card, so it is not repeated here.
 * @param {{ folderId: string, file: object|null, index: number, count: number, job: object|null,
 *   onStep: (delta: -1|1) => void, onClose: () => void, onRescan: () => void, rescanDisabled?: boolean }} props
 */
export default function FolderSplitView({
  folderId,
  file,
  index,
  count,
  job,
  onStep,
  onClose,
  onRescan,
  rescanDisabled = false,
}) {
  const { preview, loading, error, refetch } = usePreview(folderId, file?.id ?? null);
  const onRetry = useCallback(() => refetch(), [refetch]);
  if (!file) return <p className="text-sm text-slate-slate400">{PREVIEW_NONE_TEXT}</p>;
  const name = stripBidi(file.path);
  const atStart = index <= 0;
  const atEnd = index < 0 || index >= count - 1;
  const step = (delta, disabled) => () => {
    if (!disabled) onStep(delta);
  };
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="min-w-0 break-all text-sm font-semibold text-slate-slate100">
          <bdi>{name}</bdi>
        </p>
        <div className="flex items-center gap-1">
          <span className="mr-1 text-xs tabular-nums text-slate-slate400">
            {index + 1} of {count} on this page
          </span>
          <button
            type="button"
            aria-label="Previous file"
            aria-disabled={atStart || undefined}
            onClick={step(-1, atStart)}
            className={ICON_BTN}
          >
            <ArrowUp size={16} aria-hidden="true" />
          </button>
          <button
            type="button"
            aria-label="Next file"
            aria-disabled={atEnd || undefined}
            onClick={step(1, atEnd)}
            className={ICON_BTN}
          >
            <ArrowDown size={16} aria-hidden="true" />
          </button>
          <button type="button" aria-label="Close preview" onClick={onClose} className={ICON_BTN}>
            <X size={16} aria-hidden="true" />
          </button>
        </div>
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <section
          aria-label={`Preview of ${name}`}
          aria-busy={loading}
          tabIndex={0}
          className={`glass-subtle ${PANE} ${FOCUS}`}
        >
          <FilePreviewPane
            preview={preview}
            loading={loading}
            error={error}
            onRetry={onRetry}
            onRescan={onRescan}
            rescanDisabled={rescanDisabled}
          />
        </section>
        <section aria-label={`Summary and status of ${name}`} tabIndex={0} className={`${PANE} ${FOCUS}`}>
          <FileSummaryPane file={file} job={job} />
        </section>
      </div>
    </div>
  );
}
