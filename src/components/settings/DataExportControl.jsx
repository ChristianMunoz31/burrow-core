import { useEffect, useId, useRef, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { downloadExport } from '../../services/exportService';
import { BTN } from './pillStyles';

const PREPARING = 'Preparing export…';
const SUCCESS_TEXT = 'Export ready. Check your downloads.';
const INCOMPLETE_TEXT = "Some items couldn't be exported. Try again.";

const MULTI_NOTE = 'Your browser may ask to allow multiple downloads.';

function resultText(result) {
  if (result.complete) {
    if (result.parts > 1) return { tone: 'ok', text: `Export ready: ${result.parts} files. ${MULTI_NOTE}` };
    return { tone: 'ok', text: SUCCESS_TEXT };
  }
  return { tone: 'warn', text: INCOMPLETE_TEXT };
}

export default function DataExportControl() {
  const headingId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const inFlight = useRef(false);
  const controllerRef = useRef(null);

  // Leaving the page cancels a running export and skips the save.
  useEffect(() => () => controllerRef.current?.abort(), []);

  // aria-disabled (not disabled) keeps keyboard focus on the button while it runs.
  const run = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    const controller = new AbortController();
    controllerRef.current = controller;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const out = await downloadExport({ signal: controller.signal });
      if (!controller.signal.aborted) setResult(resultText(out));
    } catch (e) {
      if (!controller.signal.aborted && e?.name !== 'AbortError') {
        const message = e?.message || 'Export failed. Try again.';
        setError(
          e?.savedParts > 0
            ? `Saved ${e.savedParts} of ${e.totalParts} files before stopping. ${message} ${MULTI_NOTE}`
            : message,
        );
      }
    } finally {
      inFlight.current = false;
      if (!controller.signal.aborted) setBusy(false);
    }
  };

  const liveText = busy ? PREPARING : (result?.text ?? '');

  return (
    <section aria-labelledby={headingId}>
      <h4 id={headingId} className="text-sm font-semibold text-slate-slate100">
        Export your data
      </h4>
      <p className="mt-1 text-xs text-slate-slate400">
        Download a .zip of all your data as CSV, JSON and Markdown. Saved tokens are never included.
      </p>
      <div className="mt-3">
        <button type="button" onClick={run} aria-disabled={busy} aria-busy={busy} className={BTN}>
          {busy ? PREPARING : 'Export all data (.zip)'}
        </button>
      </div>
      <p role="status" className="sr-only">
        {liveText}
      </p>
      {result && (
        <p
          aria-hidden="true"
          className={`mt-2 flex items-start gap-1.5 text-xs ${result.tone === 'ok' ? 'text-accent-green' : 'text-accent-yellow'}`}
        >
          {result.tone === 'warn' && <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />}
          {result.text}
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
