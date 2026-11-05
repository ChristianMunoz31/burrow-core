import { useId, useRef, useState } from 'react';
import { Trash2 } from 'lucide-react';
import Modal from './Modal';
import { userMessage } from '../../utils/apiError';
import { btnDanger, btnSecondary, formErrorClass } from './formStyles';

// Labels that name a removal get the trash icon.
const isRemoveLabel = (label) => /^(remove|delete|erase)\b/i.test(label);

// Busy text while the action runs: Remove shows Removing…, Delete shows Deleting…, others add an ellipsis.
function busyText(label) {
  if (/^remove$/i.test(label)) return 'Removing…';
  if (/^delete$/i.test(label)) return 'Deleting…';
  return `${label}…`;
}

/**
 * Destructive-action confirmation built on Modal (role="alertdialog").
 * Rendered conditionally by the parent, which closes it after onConfirm resolves.
 * The trash icon shows for remove, delete and erase labels, or when `icon` is true;
 * pass `icon={false}` to hide it. A failed action shows the error's own text only when it is deliberate copy (userError or a
 * server message), else the generic line.
 */
export default function ConfirmDialog({
  title,
  message,
  confirmLabel = 'Remove',
  onConfirm,
  onCancel,
  finalFocusRef,
  icon,
}) {
  const messageId = useId();
  const cancelRef = useRef(null);
  const confirmRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const confirm = async () => {
    setBusy(true);
    setError('');
    try {
      await onConfirm();
    } catch (e) {
      setError(userMessage(e));
      setBusy(false);
      // The busy button was disabled, so focus fell to the page; bring it back for a retry.
      requestAnimationFrame(() => confirmRef.current?.focus());
    }
  };

  return (
    <Modal
      title={title}
      onClose={onCancel}
      size="sm"
      role="alertdialog"
      dismissible={!busy}
      initialFocusRef={cancelRef}
      finalFocusRef={finalFocusRef}
      describedBy={messageId}
      busy={busy}
    >
      <p id={messageId} className="text-sm text-slate-slate300">
        {message}
      </p>
      {error && (
        <p role="alert" className={`${formErrorClass} mt-3`}>
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2 mt-4">
        <button ref={cancelRef} type="button" onClick={onCancel} disabled={busy} className={btnSecondary}>
          Cancel
        </button>
        <button ref={confirmRef} type="button" onClick={confirm} disabled={busy} className={btnDanger}>
          {(icon ?? isRemoveLabel(confirmLabel)) && <Trash2 size={14} aria-hidden="true" />}
          {busy ? busyText(confirmLabel) : confirmLabel}
        </button>
      </div>
    </Modal>
  );
}
