import { useEffect, useId, useRef, useState } from 'react';
import { BTN } from './pillStyles';
import { errorMessageFor } from './licenseCopy';

const FOCUS_RING =
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:[outline-color:var(--focus-ring)]';
const DANGER_BTN = `rounded-md bg-red-700 px-3 py-1.5 text-sm font-semibold text-white transition hover:bg-red-600 disabled:cursor-not-allowed disabled:opacity-60 ${FOCUS_RING}`;
const KEY_NEEDED_CODES = new Set(['license_key_needed', 'key_mismatch']);

/**
 * A button that opens an inline confirm group (Escape or Cancel closes it; focus moves to Cancel on open
 * and back to the trigger on close).
 *
 * Props: triggerLabel, groupLabel (accessible name), question, confirmLabel, cancelLabel, busy, onConfirm(licenseKey?) (rejects with the API error),
 * askForKey (a key input appears after the server answers license_key_needed).
 */
export default function LicenseConfirmAction({
  triggerLabel,
  groupLabel,
  question,
  confirmLabel,
  cancelLabel = 'Cancel',
  busy,
  onConfirm,
  askForKey = false,
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  const [needKey, setNeedKey] = useState(false);
  const [key, setKey] = useState('');
  const questionId = useId();
  const keyId = useId();
  const errorId = useId();
  const triggerRef = useRef(null);
  const cancelRef = useRef(null);
  const keyRef = useRef(null);
  const wasOpen = useRef(false);

  useEffect(() => {
    if (open) cancelRef.current?.focus();
    else if (wasOpen.current) triggerRef.current?.focus();
    wasOpen.current = open;
  }, [open]);

  const close = () => {
    setOpen(false);
    setError('');
    setNeedKey(false);
    setKey('');
  };

  const confirm = async () => {
    if (busy) return;
    setError('');
    try {
      await onConfirm(needKey ? key.trim() : undefined);
      wasOpen.current = false;
      close();
    } catch (e) {
      setError(errorMessageFor(e));
      if (askForKey && KEY_NEEDED_CODES.has(e?.code)) {
        setNeedKey(true);
        setTimeout(() => keyRef.current?.focus(), 0);
      }
    }
  };

  if (!open) {
    return (
      <button ref={triggerRef} type="button" disabled={busy} onClick={() => setOpen(true)} className={BTN}>
        {triggerLabel}
      </button>
    );
  }
  return (
    <div
      role="group"
      aria-label={groupLabel}
      aria-describedby={questionId}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !busy) {
          e.stopPropagation();
          close();
        }
      }}
      className="w-full max-w-xl space-y-2 rounded-lg p-3 glass-subtle"
    >
      <p id={questionId} className="text-sm text-slate-slate100">
        {question}
      </p>
      {needKey && (
        <div>
          <label htmlFor={keyId} className="block text-xs font-semibold text-slate-slate300">
            License key
          </label>
          <input
            ref={keyRef}
            id={keyId}
            type="text"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            aria-describedby={error ? errorId : undefined}
            className={`glass-input mt-1 block w-full rounded-md p-2 font-mono text-sm text-slate-slate200 ${FOCUS_RING}`}
          />
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={confirm}
          disabled={busy || (needKey && !key.trim())}
          aria-busy={busy ? 'true' : undefined}
          className={DANGER_BTN}
        >
          {confirmLabel}
        </button>
        <button ref={cancelRef} type="button" onClick={close} disabled={busy} className={BTN}>
          {cancelLabel}
        </button>
      </div>
      {error && (
        <p id={errorId} role="alert" className="text-xs text-accent-amber">
          {error}
        </p>
      )}
    </div>
  );
}
