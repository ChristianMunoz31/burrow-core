import { useEffect, useId, useRef, useState } from 'react';
import { useProfile } from '../../hooks/useProfile';
import { BTN } from './pillStyles';

const MAX_NAME = 60;

/** Display name from onboarding, editable here. Saves on blur or with the Save button. */
export default function DisplayNameField() {
  const { displayName, save } = useProfile();
  const inputId = useId();
  const statusId = `${inputId}-status`;
  const [draft, setDraft] = useState(displayName ?? '');
  const [status, setStatus] = useState(null); // 'saved' | 'local' | null

  const savingRef = useRef(false);
  const focusedRef = useRef(false);
  const draftRef = useRef(draft);
  const syncedRef = useRef(displayName ?? '');

  // Follow the stored name when it changes elsewhere (e.g. the server answer arrives),
  // but never overwrite what the user is typing (focused or edited since the last sync).
  useEffect(() => {
    const next = displayName ?? '';
    const untouched = draftRef.current === syncedRef.current;
    syncedRef.current = next;
    if (focusedRef.current || !untouched) return;
    draftRef.current = next;
    setDraft(next);
  }, [displayName]);

  const dirty = draft.trim() !== (displayName ?? '');

  const commit = async () => {
    if (!dirty || savingRef.current) return;
    savingRef.current = true;
    try {
      const { saved } = await save({ displayName: draft });
      setStatus(saved ? 'saved' : 'local');
    } finally {
      savingRef.current = false;
    }
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        commit();
      }}
    >
      <label htmlFor={inputId} className="mb-1.5 block text-sm font-semibold text-slate-slate100">
        Display name
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <input
          id={inputId}
          type="text"
          value={draft}
          maxLength={MAX_NAME}
          autoComplete="nickname"
          placeholder="Your name"
          aria-describedby={statusId}
          onChange={(e) => {
            draftRef.current = e.target.value;
            setDraft(e.target.value);
            setStatus(null);
          }}
          onFocus={() => {
            focusedRef.current = true;
          }}
          onBlur={() => {
            focusedRef.current = false;
            // savingRef makes the Save click that follows this blur a no-op (one PUT).
            commit();
          }}
          className="glass-input min-h-9 min-w-0 flex-1 rounded-md px-3 py-1.5 text-sm text-slate-slate100 sm:min-h-0"
        />
        <button type="submit" disabled={!dirty} className={BTN}>
          Save
        </button>
      </div>
      <p id={statusId} role="status" className="mt-1.5 text-xs text-slate-slate400">
        {status === 'saved'
          ? 'Saved.'
          : status === 'local'
            ? "Saved in this browser only. Burrow couldn't save it to its data file."
            : 'What Burrow and Javi call you. Leave empty to clear it.'}
      </p>
    </form>
  );
}
