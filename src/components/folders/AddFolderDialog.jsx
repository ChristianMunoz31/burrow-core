import { useEffect, useId, useRef, useState } from 'react';
import Modal from '../shared/Modal';
import { btnPrimary, formErrorClass, inputClass, labelClass } from '../shared/formStyles';
import { userMessage } from '../../utils/apiError';
import {
  ADD_BUTTON,
  ADD_DIALOG_TITLE,
  CONFIRM_DIALOG_HELP,
  CONFIRM_DIALOG_TITLE,
  CONFIRM_FOLDER_BUTTON,
  ERROR_COPY,
  GENERIC_ERROR,
  NAME_LABEL,
  PATH_ERROR_CODES,
  PATH_HELP,
  PATH_LABEL,
  PATH_PLACEHOLDER,
} from '../../constants/folders';

/** Strips the quotes File Explorer's "Copy as path" puts around a path. The server does it too. */
const cleanPath = (value) => value.trim().replace(/^"(.*)"$/, '$1').trim();

/**
 * Dialog that adds a folder by its path. A refused path shows its reason next to the field (keyed off the
 * error `code`); anything else shows as one message above the buttons. Rendered only while open.
 * `finalFocusRef` is where focus lands on close when the button that opened the dialog is gone (the empty
 * state's button is replaced by the Add button once the first folder exists).
 * `mode="confirm"` re-checks an imported folder: the path starts as `initialPath`, there is no Name field, and
 * `onAdd` gets `{ path }` only.
 * @param {{ onAdd: (input: { path: string, name?: string }) => Promise<unknown>, onClose: () => void,
 *   finalFocusRef?: import('react').RefObject<HTMLElement|null>, mode?: 'add'|'confirm', initialPath?: string }} props
 */
export default function AddFolderDialog({ onAdd, onClose, finalFocusRef, mode = 'add', initialPath = '' }) {
  const confirming = mode === 'confirm';
  const submitLabel = confirming ? CONFIRM_FOLDER_BUTTON : ADD_BUTTON;
  const pathId = useId();
  const helpId = useId();
  const pathErrorId = useId();
  const pathRef = useRef(null);
  const nameId = useId();
  const [path, setPath] = useState(initialPath);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [pathError, setPathError] = useState('');
  const [formError, setFormError] = useState('');

  // The Add button disables while it works, so a refused path sends focus to the field that needs fixing.
  useEffect(() => {
    if (pathError) pathRef.current?.focus();
  }, [pathError]);

  const submit = async (e) => {
    e.preventDefault();
    const trimmed = cleanPath(path);
    if (!trimmed || busy) return;
    setBusy(true);
    setPathError('');
    setFormError('');
    try {
      await onAdd(confirming ? { path: trimmed } : { path: trimmed, name: name.trim() || undefined });
      onClose();
    } catch (err) {
      const text = userMessage(err, ERROR_COPY[err?.code] ?? GENERIC_ERROR);
      if (PATH_ERROR_CODES.includes(err?.code)) setPathError(text);
      else setFormError(text);
      setBusy(false);
    }
  };

  return (
    <Modal title={confirming ? CONFIRM_DIALOG_TITLE : ADD_DIALOG_TITLE} onClose={onClose} dismissible={!busy} busy={busy} finalFocusRef={finalFocusRef}>
      <form onSubmit={submit} className="space-y-4" noValidate>
        <div>
          <label htmlFor={pathId} className={labelClass}>
            {PATH_LABEL}
          </label>
          <input
            ref={pathRef}
            id={pathId}
            type="text"
            value={path}
            placeholder={PATH_PLACEHOLDER}
            autoComplete="off"
            spellCheck={false}
            required
            aria-invalid={pathError ? true : undefined}
            aria-describedby={pathError ? `${helpId} ${pathErrorId}` : helpId}
            onChange={(e) => setPath(e.target.value)}
            className={inputClass}
          />
          <p id={helpId} className="mt-1 text-xs text-slate-slate400">
            {confirming ? CONFIRM_DIALOG_HELP : PATH_HELP}
          </p>
          {pathError && (
            <p id={pathErrorId} role="alert" className={`${formErrorClass} mt-1`}>
              {pathError}
            </p>
          )}
        </div>
        {!confirming && (
          <div>
            <label htmlFor={nameId} className={labelClass}>
              {NAME_LABEL}
            </label>
            <input
              id={nameId}
              type="text"
              value={name}
              maxLength={120}
              autoComplete="off"
              onChange={(e) => setName(e.target.value)}
              className={inputClass}
            />
          </div>
        )}
        {formError && (
          <p role="alert" className={formErrorClass}>
            {formError}
          </p>
        )}
        <div className="flex justify-end">
          <button type="submit" disabled={busy || !cleanPath(path)} className={btnPrimary}>
            {busy ? (confirming ? 'Confirming…' : 'Adding…') : submitLabel}
          </button>
        </div>
      </form>
    </Modal>
  );
}
