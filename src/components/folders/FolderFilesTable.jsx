import { memo, useCallback, useEffect, useId, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight } from 'lucide-react';
import { useFolderFiles } from '../../hooks/useFolderFiles';
import { formatBytes } from '../../utils/backupFormat';
import { stripBidi } from '../../utils/folderPreview';
import { btnSecondary } from '../shared/formStyles';
import { ListSkeleton } from '../shared/Skeleton';
import FolderSplitView from './FolderSplitView';
import { FOCUS } from './folderStyles';
import {
  FILES_PAGE_SIZE,
  FILE_STATUS_FALLBACK,
  FILE_STATUS_LABELS,
  FILE_SUMMARY_LABELS,
  KIND_LABELS,
  PREVIEW_GONE,
  formatDate,
  isJobActive,
} from '../../constants/folders';

const COLUMNS = [
  { sort: 'path', label: 'File' },
  { sort: 'size', label: 'Size' },
  { sort: 'modified', label: 'Changed' },
  { sort: 'status', label: 'Status' },
];

const FileRow = memo(function FileRow({ file, selected, onSelect }) {
  const name = stripBidi(file.path);
  const [open, setOpen] = useState(false);
  const summaryId = useId();
  const statusLabel =
    file.status === 'ok'
      ? FILE_SUMMARY_LABELS[file.summaryStatus] ?? FILE_STATUS_LABELS.ok
      : FILE_STATUS_LABELS[file.status] ?? FILE_STATUS_FALLBACK;
  return (
    <>
      <tr className={`align-top ${selected ? 'bg-slate-slate700/30' : ''}`}>
        <td className="py-2.5 pr-3">
          <button
            type="button"
            data-file-id={file.id}
            aria-current={selected ? 'true' : undefined}
            aria-label={`${name}, ${KIND_LABELS[file.kind] ?? KIND_LABELS.other}`}
            onClick={() => onSelect(file.id)}
            className={`block w-full rounded text-left ${FOCUS}`}
          >
            <span className="block break-all text-slate-slate100">
              <bdi>{name}</bdi>
            </span>
            <span className="block text-xs text-slate-slate400">{KIND_LABELS[file.kind] ?? KIND_LABELS.other}</span>
          </button>
          {file.summary && (
            <button
              type="button"
              aria-expanded={open}
              aria-controls={summaryId}
              aria-label={`Summary of ${name}`}
              onClick={() => setOpen((o) => !o)}
              className={`mt-1 inline-flex items-center gap-1 rounded text-xs font-semibold text-slate-slate300 hover:text-slate-slate100 ${FOCUS}`}
            >
              {open ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
              Summary
            </button>
          )}
        </td>
        <td className="whitespace-nowrap py-2.5 pr-3 tabular-nums text-slate-slate300">{formatBytes(file.sizeBytes)}</td>
        <td className="whitespace-nowrap py-2.5 pr-3 tabular-nums text-slate-slate300">{formatDate(file.modifiedAt)}</td>
        <td className={`py-2 text-xs ${file.status === 'ok' ? 'text-slate-slate400' : 'text-accent-amber'}`}>{statusLabel}</td>
      </tr>
      {open && file.summary && (
        <tr>
          <td colSpan={4} className="pb-2">
            <p id={summaryId} className="whitespace-pre-wrap pl-3 text-sm text-slate-slate300">
              {file.summary}
            </p>
          </td>
        </tr>
      )}
    </>
  );
});

/**
 * The paged file list of one folder (100 per page), sortable by file, size, date changed and status.
 * Statuses and counts come from the server; a summary opens in place as plain text.
 * Selecting a file (click, Enter or Space) opens the split view above the list: its preview and its summary.
 * ArrowUp and ArrowDown on a row, or [ and ], step through the page; Escape closes the view and puts focus
 * back on the row.
 * @param {{ folderId: string, name: string, job?: object|null,
 *   onRescan?: () => void, rescanDisabled?: boolean }} props
 */
export default function FolderFilesTable({ folderId, name, job = null, onRescan, rescanDisabled = false }) {
  const [offset, setOffset] = useState(0);
  const [sort, setSort] = useState('path');
  const [dir, setDir] = useState('asc');
  const [selectedId, setSelectedId] = useState(null);
  const [gone, setGone] = useState(false);
  const rootRef = useRef(null);
  const tableRef = useRef(null);
  const { files, total, loading, error, refetch } = useFolderFiles(folderId, {
    offset,
    sort,
    dir,
    polling: isJobActive(job),
  });

  const index = files.findIndex((f) => f.id === selectedId);
  const selected = index >= 0 ? files[index] : null;
  const focusRow = (id) => {
    const rows = rootRef.current?.querySelectorAll('button[data-file-id]') ?? [];
    for (const row of rows) {
      if (row.dataset.fileId === id) {
        row.focus();
        return;
      }
    }
  };
  const choose = useCallback((id) => {
    setGone(false);
    setSelectedId(id);
  }, []);
  const rescan = useCallback(() => onRescan?.(), [onRescan]);
  // Steps from `from` (the selected row, or the focused one for the arrow keys) to its neighbour.
  const step = (delta, { from = index, focus = false } = {}) => {
    const next = files[from + delta];
    if (!next) return;
    choose(next.id);
    if (focus) requestAnimationFrame(() => focusRow(next.id));
  };
  const close = () => {
    const id = selectedId;
    choose(null);
    if (id) requestAnimationFrame(() => focusRow(id));
  };

  // The selected file left the list (a re-scan removed it): drop the selection, tell the user, keep focus on the list.
  const lost = Boolean(selectedId) && !loading && !error && index < 0;
  if (lost) {
    setSelectedId(null);
    setGone(true);
  }
  useEffect(() => {
    if (gone) tableRef.current?.focus();
  }, [gone]);
  const status = selected ? `Showing ${stripBidi(selected.path)}, ${index + 1} of ${files.length}` : gone ? PREVIEW_GONE : '';
  const onKeyDown = (event) => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
    const target = event.target;
    if (target instanceof HTMLElement && target.closest('input, textarea, select')) return;
    const onRow = target instanceof HTMLElement && target.matches('button[data-file-id]');
    if (event.key === 'Escape' && selectedId) {
      event.preventDefault();
      close();
      return;
    }
    const delta =
      event.key === ']' || (onRow && event.key === 'ArrowDown')
        ? 1
        : event.key === '[' || (onRow && event.key === 'ArrowUp')
          ? -1
          : 0;
    if (!delta || !selected) return;
    event.preventDefault();
    // A held key repeats many times a second; one step per press.
    if (event.repeat) return;
    const arrow = event.key === 'ArrowDown' || event.key === 'ArrowUp';
    const from = arrow ? files.findIndex((f) => f.id === target.dataset.fileId) : index;
    step(delta, { from, focus: onRow });
  };

  // If the list shrank (a re-scan removed files) below the page being viewed, step back to the last page.
  const lastOffset = total > 0 ? Math.floor((total - 1) / FILES_PAGE_SIZE) * FILES_PAGE_SIZE : 0;
  if (!loading && !error && offset > lastOffset) setOffset(lastOffset);

  const changeSort = (next) => {
    setOffset(0);
    choose(null);
    if (next === sort) setDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSort(next);
      setDir('asc');
    }
  };

  if (loading) return <ListSkeleton rows={4} label="Loading files" />;
  if (error) {
    return (
      <div role="alert" className="flex flex-col items-start gap-2">
        <p className="text-sm text-slate-slate300">Burrow couldn&apos;t load the file list. Your files are untouched.</p>
        <button type="button" onClick={() => refetch()} className={btnSecondary}>
          Retry
        </button>
      </div>
    );
  }
  if (total === 0) return <p className="text-sm text-slate-slate400">No files listed yet. Click Re-scan to read this folder.</p>;

  const shown = Math.min(offset, lastOffset);
  const from = shown + 1;
  const to = Math.min(shown + FILES_PAGE_SIZE, total);
  return (
    <div ref={rootRef} className="space-y-3" onKeyDown={onKeyDown}>
      <p role="status" className="sr-only">
        {status}
      </p>
      <FolderSplitView
        folderId={folderId}
        file={selected}
        index={index}
        count={files.length}
        job={job}
        onStep={(delta) => step(delta)}
        onClose={close}
        onRescan={rescan}
        rescanDisabled={rescanDisabled || isJobActive(job) || !onRescan}
      />
      <div className="overflow-x-auto">
        <table ref={tableRef} tabIndex={-1} className={`w-full text-left text-sm ${FOCUS}`}>
          <caption className="sr-only">
            Files in <bdi>{name}</bdi>
          </caption>
          <thead>
            <tr className="text-xs text-slate-slate400">
              {COLUMNS.map((col) => {
                const active = sort === col.sort;
                return (
                  <th
                    key={col.sort}
                    scope="col"
                    aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}
                    className="pb-1 pr-3 font-medium"
                  >
                    <button
                      type="button"
                      onClick={() => changeSort(col.sort)}
                      className={`inline-flex items-center gap-1 rounded font-medium hover:text-slate-slate100 ${FOCUS}`}
                    >
                      {col.label}
                      {active &&
                        (dir === 'asc' ? (
                          <ArrowUp size={12} aria-hidden="true" />
                        ) : (
                          <ArrowDown size={12} aria-hidden="true" />
                        ))}
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {files.map((file) => (
              <FileRow key={file.id} file={file} selected={file.id === selectedId} onSelect={choose} />
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs tabular-nums text-slate-slate400" aria-live="polite">
          Showing {from.toLocaleString()} to {to.toLocaleString()} of {total.toLocaleString()}
        </p>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => {
              choose(null);
              setOffset((o) => Math.max(0, o - FILES_PAGE_SIZE));
            }}
            disabled={shown === 0}
            className={btnSecondary}
          >
            Previous
          </button>
          <button
            type="button"
            onClick={() => {
              choose(null);
              setOffset((o) => o + FILES_PAGE_SIZE);
            }}
            disabled={shown + FILES_PAGE_SIZE >= total}
            className={btnSecondary}
          >
            Next
          </button>
        </div>
      </div>
    </div>
  );
}
