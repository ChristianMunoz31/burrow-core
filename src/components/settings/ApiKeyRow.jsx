import { useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Eye, EyeOff } from 'lucide-react';
import { BTN, PILL, TONE_CLASS } from './pillStyles';
import { isNetworkOptInError } from '../../utils/apiError';

const DANGER_BTN =
  'min-h-9 rounded-md bg-red-700 px-3 py-1.5 text-sm font-semibold text-white transition hover:bg-red-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:[outline-color:var(--focus-ring)] sm:min-h-0';

const SOURCE_BADGE = {
  settings: { text: 'Saved in settings', tone: 'ok' },
  env: { text: 'Set outside the app', tone: 'muted' },
  none: { text: 'Not set', tone: 'warn' },
};

const TEST_COPY = {
  unauthorized: 'Key was rejected',
  rate_limited: 'Provider rate-limited the check, try later',
  unreachable: "Couldn't reach provider",
  not_configured: 'No key set',
  upstream_error: 'Provider returned an error',
};

const GENERIC_SAVE_ERROR = "Couldn't save the key. Try again.";
const GENERIC_REMOVE_ERROR = "Couldn't remove the key. Try again.";
const RETRY_HINT = 'Re-enter the key to try again.';

const ERROR_COPY = {
  invalid_value: "That doesn't look like a valid key for this provider.",
  writes_disabled: "Burrow can't save tokens right now.",
  encryption_disabled: "Burrow can't save tokens right now.",
  schema_missing: "Burrow can't save tokens right now.",
  unknown_secret: "That key isn't recognised.",
};

/** Maps an API error to fixed client copy. Raw server text is never rendered. */
function errorCopy(err, fallback) {
  if (err?.status === 429 || err?.code === 'rate_limited') return 'Too many attempts. Wait a moment and try again.';
  return ERROR_COPY[err?.code] ?? fallback;
}

function formatUpdated(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString();
}

/**
 * One API key. The key value lives only in an uncontrolled input: it is read on
 * submit, sent, and cleared in `finally`. It is never in state, storage or a toast.
 */
export default function ApiKeyRow({ secret, writable, writesAllowed, disabledReason, onSave, onRemove, onTest }) {
  const { name, label, description, source, last4, updatedAt, envFallback, stale, testable, configured } = secret;
  const [editing, setEditing] = useState(false);
  const [shown, setShown] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const [removing, setRemoving] = useState(false);
  const removingRef = useRef(false);
  const testSeq = useRef(0);
  const [hint, setHint] = useState(null);
  const [testState, setTestState] = useState(null);
  const inputRef = useRef(null);
  const setRef = useRef(null);
  const removeRef = useRef(null);
  const cancelRemoveRef = useRef(null);
  const focusTarget = useRef(null);
  const reasonId = useId();
  const inputId = useId();

  const badge = SOURCE_BADGE[source] ?? SOURCE_BADGE.none;
  const mask = last4 ? `••••${last4}` : configured ? '••••' : null;
  const canTest = (writesAllowed ?? writable) && testable && configured;
  const updated = source === 'settings' && updatedAt ? formatUpdated(updatedAt) : null;
  const setLabel = source === 'settings' ? 'Replace' : 'Set';

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
    } else if (confirming) {
      cancelRemoveRef.current?.focus();
    } else if (focusTarget.current) {
      (focusTarget.current === 'remove' ? removeRef.current : null)?.focus();
      if (focusTarget.current !== 'remove' || !removeRef.current) setRef.current?.focus();
      focusTarget.current = null;
    }
  }, [editing, confirming]);

  const clearInput = () => {
    if (inputRef.current) inputRef.current.value = '';
    setShown(false);
  };

  const openForm = () => {
    if (!writable) return;
    setError(null);
    setHint(null);
    setEditing(true);
  };

  const cancelForm = () => {
    if (saving) return;
    clearInput();
    setError(null);
    setHint(null);
    focusTarget.current = 'set';
    setEditing(false);
  };

  const submit = async (e) => {
    e.preventDefault();
    if (saving) return;
    const value = inputRef.current?.value ?? '';
    if (!value.trim()) {
      setError('Enter a key to save.');
      return;
    }
    // Any in-flight test was against the old key; drop its result (and its busy state).
    testSeq.current += 1;
    setTestState(null);
    setSaving(true);
    setError(null);
    setHint(null);
    try {
      await onSave(name, value);
      setTestState(null);
      focusTarget.current = 'set';
      setEditing(false);
    } catch (err) {
      setError(errorCopy(err, GENERIC_SAVE_ERROR));
      setHint(RETRY_HINT);
    } finally {
      clearInput();
      setSaving(false);
    }
  };

  const confirmRemove = async () => {
    if (removingRef.current) return;
    removingRef.current = true;
    testSeq.current += 1;
    setTestState(null);
    setRemoving(true);
    try {
      await onRemove(name);
      focusTarget.current = 'set';
      setConfirming(false);
      setTestState(null);
    } catch (err) {
      setConfirming(false);
      focusTarget.current = 'remove';
      setError(errorCopy(err, GENERIC_REMOVE_ERROR));
    } finally {
      removingRef.current = false;
      setRemoving(false);
    }
  };

  const runTest = async () => {
    if (testState?.busy) return;
    const seq = ++testSeq.current;
    setTestState({ busy: true });
    try {
      const result = await onTest(name);
      if (seq !== testSeq.current) return;
      setTestState(
        result?.ok
          ? { ok: true, text: 'Key works' }
          : {
              ok: false,
              text: TEST_COPY[result?.reason] ?? 'Provider returned an error',
            },
      );
    } catch (err) {
      if (seq !== testSeq.current) return;
      setTestState({
        ok: false,
        optIn: isNetworkOptInError(err),
        text: isNetworkOptInError(err)
          ? ''
          : err?.status === 429 || err?.code === 'rate_limited'
            ? 'Too many attempts. Wait a moment and try again.'
            : "Couldn't run the test",
      });
    }
  };

  return (
    <li className="py-3">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-slate-slate100">{label}</p>
          <p className="text-xs text-slate-slate400">{description}</p>
          {(mask || updated) && (
            <p className="mt-0.5 text-xs text-slate-slate400">
              {mask && <span className="font-mono text-slate-slate300">{mask}</span>}
              {mask && updated && ' · '}
              {updated && `Updated ${updated}`}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {stale && <span className={`${PILL} ${TONE_CLASS.warn}`}>Can&apos;t decrypt saved key</span>}
          <span className={`${PILL} ${TONE_CLASS[badge.tone]}`}>{badge.text}</span>
        </div>
      </div>

      {!editing && !confirming && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            ref={setRef}
            type="button"
            onClick={openForm}
            aria-disabled={!writable}
            aria-describedby={!writable && disabledReason ? reasonId : undefined}
            aria-label={`${setLabel} ${label} key`}
            className={BTN}
          >
            {setLabel}
          </button>
          {testable && configured && (
            <button
              type="button"
              onClick={() => {
                if (canTest) runTest();
              }}
              aria-disabled={!canTest || testState?.busy === true}
              aria-describedby={!canTest && disabledReason ? reasonId : undefined}
              aria-busy={testState?.busy === true}
              aria-label={`Test ${label} key`}
              className={BTN}
            >
              {testState?.busy ? 'Testing…' : 'Test'}
            </button>
          )}
          {source === 'settings' && (
            <button
              ref={removeRef}
              type="button"
              onClick={() => {
                if (writable) setConfirming(true);
              }}
              aria-disabled={!writable}
              aria-describedby={!writable && disabledReason ? reasonId : undefined}
              aria-label={`Remove ${label} key`}
              className={BTN}
            >
              Remove
            </button>
          )}
          {(!writable || (testable && configured && !canTest)) && disabledReason && (
            <span id={reasonId} className="text-xs text-slate-slate400">
              {disabledReason}
            </span>
          )}
        </div>
      )}

      {editing && (
        <form
          onSubmit={submit}
          onKeyDown={(e) => e.key === 'Escape' && cancelForm()}
          onBlur={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget)) setShown(false);
          }}
          className="mt-2"
        >
          <label htmlFor={inputId} className="sr-only">
            {label} API key
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <input
              id={inputId}
              ref={inputRef}
              type={shown ? 'text' : 'password'}
              name={`secret-${name}`}
              autoComplete="off"
              data-1p-ignore
              data-lpignore="true"
              data-bwignore
              spellCheck={false}
              autoCapitalize="off"
              placeholder="Paste key"
              className="glass-input min-h-9 min-w-0 flex-1 rounded-md px-3 py-1.5 font-mono text-sm text-slate-slate100 sm:min-h-0"
            />
            <button
              type="button"
              onClick={() => setShown((s) => !s)}
              aria-pressed={shown}
              aria-label={`Show ${label} key`}
              className={`${BTN} inline-flex items-center`}
            >
              {shown ? <EyeOff size={14} aria-hidden="true" /> : <Eye size={14} aria-hidden="true" />}
            </button>
            <button type="submit" aria-disabled={saving} aria-busy={saving} className={BTN}>
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button type="button" onClick={cancelForm} aria-disabled={saving} className={BTN}>
              Cancel
            </button>
          </div>
          {error && (
            <p role="alert" className="mt-1.5 text-xs text-accent-amber">
              {error}
              {hint && ` ${hint}`}
            </p>
          )}
        </form>
      )}

      {confirming && (
        <div
          role="group"
          aria-label={`Confirm removal of ${label} key`}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              focusTarget.current = 'remove';
              setConfirming(false);
            }
          }}
          className="mt-2 flex flex-wrap items-center gap-2"
        >
          <span className="text-sm text-slate-slate100">
            Remove {label} key?
            {envFallback && ' The value set outside the app will be used instead.'}
          </span>
          <button type="button" onClick={confirmRemove} aria-disabled={removing} className={DANGER_BTN}>
            Remove
          </button>
          <button
            ref={cancelRemoveRef}
            type="button"
            onClick={() => {
              focusTarget.current = 'remove';
              setConfirming(false);
            }}
            className={BTN}
          >
            Cancel
          </button>
        </div>
      )}

      {!editing && error && (
        <p role="alert" className="mt-1.5 text-xs text-accent-amber">
          {error}
        </p>
      )}

      <p role="status" className="mt-1.5 text-xs text-slate-slate300 empty:mt-0">
        {testState?.busy ? 'Testing…' : (testState?.text ?? '')}
        {testState?.optIn && (
          <>
            Turn on Oura in{' '}
            <Link
              to={{ pathname: '/settings', hash: '#network' }}
              className="font-medium underline underline-offset-2 hover:text-slate-slate100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:[outline-color:var(--focus-ring)]"
            >
              Settings &gt; Network
            </Link>{' '}
            to test this token.
          </>
        )}
      </p>
    </li>
  );
}
