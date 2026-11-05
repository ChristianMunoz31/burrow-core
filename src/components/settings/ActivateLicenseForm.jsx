import { useId, useRef, useState } from 'react';
import SegmentedRadio from './SegmentedRadio';
import { BTN } from './pillStyles';
import { detectStore, getLicenseStore, MAX_KEY_INPUT_CHARS } from '../../constants/licenseStores';
import { activateLabel, disclosureFor, errorMessageFor } from './licenseCopy';

const FOCUS_RING =
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:[outline-color:var(--focus-ring)]';
const HINT = 'text-xs text-slate-slate400';

/**
 * Store picker, key input and the Activate button. Nothing here calls the store: `onActivate`
 * runs only from an explicit submit (button click or Enter in the key field).
 *
 * Props: stores (configured stores, Gumroad first), busy, onActivate(licenseKey, storeId)
 * (rejects with the API error), replaceHint (show the "different key replaces this one" hint).
 */
export default function ActivateLicenseForm({ stores, busy, onActivate, replaceHint = false }) {
  const inputId = useId();
  const noteId = useId();
  const errorId = useId();
  const inputRef = useRef(null);
  const [choice, setChoice] = useState(null);
  // The store the key's format pointed to when the user picked by hand: that detection is not applied again.
  const [overridden, setOverridden] = useState(null);
  const [key, setKey] = useState('');
  const [error, setError] = useState('');

  const store = stores.find((s) => s.id === choice) ?? stores[0] ?? null;
  if (!store) return null;
  const trimmed = key.trim();

  const changeKey = (value) => {
    setKey(value);
    setError('');
    if (value.trim() === '') {
      setOverridden(null);
      return;
    }
    // A key that fully matches the other store's format switches the picker, unless the user overrode that match by hand.
    const detected = detectStore(value);
    if (detected && detected !== overridden && detected !== store.id && stores.some((s) => s.id === detected)) {
      setChoice(detected);
    }
  };

  const pick = (id) => {
    setChoice(id);
    setOverridden(detectStore(key));
    setError('');
  };

  const submit = async (event) => {
    event.preventDefault();
    if (busy || !trimmed) return;
    setError('');
    try {
      await onActivate(trimmed, store.id);
      setKey('');
      setOverridden(null);
    } catch (e) {
      setError(errorMessageFor(e));
      inputRef.current?.focus();
    }
  };

  const describedBy = error ? `${noteId} ${errorId}` : noteId;
  return (
    <form onSubmit={submit} noValidate className="space-y-3">
      {stores.length > 1 && (
        <SegmentedRadio
          legend="Where did you buy Burrow?"
          value={store.id}
          onChange={pick}
          options={stores.map((s) => ({ value: s.id, label: getLicenseStore(s.id)?.label ?? s.label }))}
          disabled={busy}
        />
      )}
      <div>
        <label htmlFor={inputId} className="block text-xs font-semibold text-slate-slate300">
          License key
        </label>
        <input
          ref={inputRef}
          id={inputId}
          type="text"
          value={key}
          onChange={(e) => changeKey(e.target.value)}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          maxLength={MAX_KEY_INPUT_CHARS * 4}
          aria-invalid={error ? 'true' : undefined}
          aria-describedby={describedBy}
          className={`glass-input mt-1 block w-full max-w-xl rounded-md p-2 font-mono text-sm text-slate-slate200 ${error ? '!border-accent-red' : ''} ${FOCUS_RING}`}
        />
        {replaceHint && <p className={`mt-1 ${HINT}`}>Activating a different key replaces this one on this computer.</p>}
      </div>
      <div>
        <button type="submit" disabled={busy || !trimmed} aria-busy={busy ? 'true' : undefined} className={BTN}>
          {busy ? 'Activating...' : activateLabel(store.id)}
        </button>
        <p id={noteId} className={`mt-1 max-w-xl ${HINT}`}>
          {disclosureFor(store.id)}
        </p>
      </div>
      {error && (
        <p id={errorId} role="alert" className="text-xs text-accent-amber">
          {error}
        </p>
      )}
    </form>
  );
}
