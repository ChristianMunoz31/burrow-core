import { useEffect, useId, useRef, useState } from 'react';
import { importExportZip } from '../../services/importService';
import { BTN } from './pillStyles';
import { tableLabel } from '../../constants/tableLabels';

const PREVIEWING = 'Checking file…';
const IMPORTING = 'Importing…';
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

const confirmText = (n) =>
  n === 1
    ? '1 imported folder needs confirming on the Folders page before Burrow reads it.'
    : `${n} imported folders need confirming on the Folders page before Burrow reads them.`;

function doneText(totals) {
  const skipped = totals.skipped > 0 ? `, ${plural(totals.skipped, 'item', 'items')} skipped` : '';
  return `Import complete: ${plural(totals.inserted, 'item', 'items')} added, ${totals.updated} updated${skipped}.`;
}

export default function ImportControl() {
  const headingId = useId();
  const fileId = useId();
  const hintId = useId();
  const [phase, setPhase] = useState('idle'); // idle | previewing | ready | importing | done
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [message, setMessage] = useState('');
  const [toConfirm, setToConfirm] = useState(0);
  const [error, setError] = useState(null);
  const inputRef = useRef(null);
  const controllerRef = useRef(null);

  // Leaving the page cancels a running request.
  useEffect(() => () => controllerRef.current?.abort(), []);

  const reset = () => {
    controllerRef.current?.abort();
    setPhase('idle');
    setFile(null);
    setPreview(null);
    setError(null);
    if (inputRef.current) inputRef.current.value = '';
  };

  const run = async (target, dryRun) => {
    const controller = new AbortController();
    controllerRef.current = controller;
    setError(null);
    try {
      return await importExportZip(target, { dryRun, signal: controller.signal });
    } catch (e) {
      if (!controller.signal.aborted && e?.name !== 'AbortError') setError(e?.message || 'Import failed. Try again.');
      return null;
    }
  };

  const onPick = async (event) => {
    const picked = event.target.files?.[0] ?? null;
    setPreview(null);
    setMessage('');
    setToConfirm(0);
    setError(null);
    if (!picked) {
      setFile(null);
      setPhase('idle');
      return;
    }
    setFile(picked);
    setPhase('previewing');
    const result = await run(picked, true);
    if (controllerRef.current?.signal.aborted) return;
    if (result) {
      setPreview(result);
      setPhase('ready');
    } else {
      setPhase('idle');
    }
  };

  const confirm = async () => {
    if (!file || phase !== 'ready') return;
    setPhase('importing');
    const result = await run(file, false);
    if (controllerRef.current?.signal.aborted) return;
    if (result) {
      setMessage(doneText(result.totals));
      setToConfirm(Number.isInteger(result.foldersToConfirm) ? result.foldersToConfirm : 0);
      setPhase('done');
      setFile(null);
      setPreview(null);
      if (inputRef.current) inputRef.current.value = '';
    } else {
      setPhase('ready');
    }
  };

  const busy = phase === 'previewing' || phase === 'importing';
  const liveText = phase === 'previewing' ? PREVIEWING : phase === 'importing' ? IMPORTING : message;
  const totals = preview?.totals;
  const importable = totals ? totals.received - totals.skipped : 0;

  return (
    <section aria-labelledby={headingId}>
      <h4 id={headingId} className="text-sm font-semibold text-slate-slate100">
        Import data
      </h4>
      <p id={hintId} className="mt-1 text-xs text-slate-slate400">
        Bring in data from a Burrow export (.zip). Matching items are updated; nothing is deleted.
      </p>
      <div className="mt-3">
        <label htmlFor={fileId} className="block text-xs font-semibold text-slate-slate300">
          Export file (.zip)
        </label>
        <input
          ref={inputRef}
          id={fileId}
          type="file"
          accept=".zip,application/zip"
          onChange={onPick}
          disabled={busy}
          aria-describedby={hintId}
          className="mt-1 block w-full max-w-sm text-xs text-slate-slate300 file:mr-3 file:cursor-pointer file:rounded-md file:border-0 file:bg-white/10 file:px-3 file:py-1.5 file:text-sm file:font-semibold file:text-slate-slate200 disabled:cursor-not-allowed disabled:opacity-60"
        />
      </div>

      {phase === 'ready' && preview && (
        <div className="mt-3">
          <p className="text-xs text-slate-slate300">
            {totals.received === 0
              ? 'This file has nothing to import.'
              : `Ready to import ${plural(totals.received, 'item', 'items')}: ${totals.inserted} new, ${totals.updated} will update existing items${totals.skipped > 0 ? `, ${totals.skipped} skipped` : ''}.`}
          </p>
          {preview.tables.length > 0 && (
            <table className="mt-2 w-full max-w-md text-left text-xs text-slate-slate300">
              <caption className="sr-only">Items per type in this file</caption>
              <thead>
                <tr className="text-slate-slate400">
                  <th scope="col" className="py-1 pr-3 font-semibold">
                    Type
                  </th>
                  <th scope="col" className="py-1 pr-3 text-right font-semibold">
                    New
                  </th>
                  <th scope="col" className="py-1 pr-3 text-right font-semibold">
                    Updated
                  </th>
                  <th scope="col" className="py-1 text-right font-semibold">
                    Skipped
                  </th>
                </tr>
              </thead>
              <tbody>
                {preview.tables.map((t) => (
                  <tr key={t.id} className="border-t border-white/10">
                    <th scope="row" className="py-1 pr-3 font-normal">
                      {tableLabel(t.id)}
                    </th>
                    <td className="py-1 pr-3 text-right tabular-nums">{t.inserted}</td>
                    <td className="py-1 pr-3 text-right tabular-nums">{t.updated}</td>
                    <td className="py-1 text-right tabular-nums">{t.skipped}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            {importable > 0 && (
              <button type="button" onClick={confirm} className={BTN}>
                {`Import ${plural(importable, 'item', 'items')}`}
              </button>
            )}
            <button type="button" onClick={reset} className={BTN}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {phase === 'importing' && (
        <button type="button" aria-disabled="true" aria-busy="true" className={`${BTN} mt-3`}>
          {IMPORTING}
        </button>
      )}

      <p role="status" className="sr-only">
        {liveText}
      </p>
      {phase === 'done' && message && (
        <p aria-hidden="true" className="mt-2 text-xs text-accent-green">
          {message}
        </p>
      )}
      {phase === 'done' && toConfirm > 0 && (
        <p role="status" className="mt-2 text-xs text-accent-amber">
          {confirmText(toConfirm)}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-2 text-xs text-accent-amber">
          {error}
        </p>
      )}
    </section>
  );
}
