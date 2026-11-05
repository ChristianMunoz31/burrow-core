import { memo, useMemo } from 'react';
import { btnSecondary } from '../shared/formStyles';
import { ListSkeleton } from '../shared/Skeleton';
import { parseCsvPreview, previewKb, splitPages } from '../../utils/folderPreview';
import { userMessage } from '../../utils/apiError';
import {
  ERROR_COPY,
  GENERIC_ERROR,
  PREVIEW_CSV_COLUMNS,
  PREVIEW_CSV_COLUMNS_NOTE,
  PREVIEW_CSV_ROWS_NOTE,
  PREVIEW_EMPTY_TEXT,
  PREVIEW_LOADING,
  RESCAN_WAIT,
  PREVIEW_REASON_COPY,
  PREVIEW_REASON_FALLBACK,
  PREVIEW_CSV_ROWS,
  PREVIEW_TRUNCATED_NOTE,
} from '../../constants/folders';

const TEXT_CLASS = 'whitespace-pre-wrap break-words font-mono text-sm text-slate-slate100';

function Note({ children }) {
  return <p className="text-xs text-slate-slate400">{children}</p>;
}

const CsvTable = memo(function CsvTable({ text, truncated }) {
  const table = useMemo(() => parseCsvPreview(text, truncated), [text, truncated]);
  if (!table) return <p className="text-sm text-slate-slate400">{PREVIEW_EMPTY_TEXT}</p>;
  return (
    <div className="space-y-2">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="text-xs text-slate-slate400">
            {table.headers.map((cell, i) => (
              <th key={i} scope="col" className="whitespace-nowrap pb-1 pr-3 font-medium">
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((cells, r) => (
            <tr key={r} className="border-t border-slate-slate700/40 align-top">
              {cells.map((cell, c) => (
                <td key={c} className="max-w-xs break-words py-1 pr-3 text-slate-slate100">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {table.moreRows && <Note>{PREVIEW_CSV_ROWS_NOTE.replace('{n}', String(PREVIEW_CSV_ROWS))}</Note>}
      {table.moreCols && <Note>{PREVIEW_CSV_COLUMNS_NOTE.replace('{n}', String(PREVIEW_CSV_COLUMNS))}</Note>}
    </div>
  );
});

const PagedText = memo(function PagedText({ text, pageBreaks }) {
  const segments = useMemo(() => splitPages(text, pageBreaks), [text, pageBreaks]);
  return (
    <div>
      {segments.map((segment) => (
        <div key={segment.page}>
          {segment.page > 1 && (
            <div
              role="separator"
              aria-label={`Page ${segment.page}`}
              className="my-3 border-t border-slate-slate700/60 pt-1 text-xs text-slate-slate400"
            >
              Page {segment.page}
            </div>
          )}
          <pre className={TEXT_CLASS}>{segment.text}</pre>
        </div>
      ))}
    </div>
  );
});

function PreviewError({ error, onRetry, onRescan, rescanDisabled }) {
  const code = error?.code;
  // The server's fixed copy for the code; the page's own fallback only when a response carries none.
  const message = userMessage(error, ERROR_COPY[code] ?? GENERIC_ERROR);
  const changed = code === 'folder_file_changed' || code === 'folder_moved' || code === 'folder_file_not_found';
  const confirm = code === 'folder_needs_confirm' || code === 'folder_not_found';
  return (
    <div role="alert" className="flex flex-col items-start gap-2">
      <p className="text-sm text-slate-slate300">{message}</p>
      {changed && (
        <button
          type="button"
          aria-disabled={rescanDisabled || undefined}
          onClick={() => {
            if (!rescanDisabled) onRescan();
          }}
          className={btnSecondary}
        >
          Re-scan
        </button>
      )}
      {changed && rescanDisabled && <Note>{RESCAN_WAIT}</Note>}
      {!changed && !confirm && (
        <button type="button" onClick={onRetry} className={btnSecondary}>
          Try again
        </button>
      )}
    </div>
  );
}

/**
 * The body of the preview pane: plain text, a page-divided document, a CSV table or an empty state.
 * Everything is rendered as React text, never as markup, so a file cannot add elements to the page.
 * @param {{ preview: object|null, loading: boolean, error: Error|null,
 *   onRetry: () => void, onRescan: () => void, rescanDisabled?: boolean }} props
 */
export default memo(function FilePreviewPane({ preview, loading, error, onRetry, onRescan, rescanDisabled = false }) {
  let body;
  if (loading) body = <ListSkeleton rows={4} label={PREVIEW_LOADING} />;
  else if (error) {
    body = <PreviewError error={error} onRetry={onRetry} onRescan={onRescan} rescanDisabled={rescanDisabled} />;
  } else if (preview) {
    if (preview.kind === 'none') {
      body = (
        <p className="text-sm text-slate-slate400">
          {PREVIEW_REASON_COPY[preview.reason] ?? PREVIEW_REASON_FALLBACK}
        </p>
      );
    } else if (typeof preview.text !== 'string' || preview.text === '') {
      body = <p className="text-sm text-slate-slate400">{PREVIEW_EMPTY_TEXT}</p>;
    } else {
      body = (
        <div className="space-y-2">
          {preview.kind === 'csv' ? (
            <CsvTable text={preview.text} truncated={preview.truncated} />
          ) : (
            <PagedText text={preview.text} pageBreaks={preview.kind === 'document' ? preview.pageBreaks : null} />
          )}
          {preview.truncated && (
            <Note>{PREVIEW_TRUNCATED_NOTE.replace('{n}', previewKb(preview.shownChars).toLocaleString())}</Note>
          )}
        </div>
      );
    }
  }
  return body ?? null;
});
