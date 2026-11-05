import { useEffect, useId, useRef, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { btnDanger, btnSecondary } from '../shared/formStyles';
import { BTN } from './pillStyles';

/**
 * Inline reset with confirmation (no window.confirm). Clicking the trigger swaps
 * it for "Reset <label> to defaults? [Confirm] [Cancel]" with focus on Cancel;
 * Escape cancels. Focus returns to the trigger afterwards.
 *
 * Props: label (lowercase, e.g. "appearance settings"), onConfirm(), triggerText (optional).
 */
export default function ResetControl({ label, onConfirm, triggerText }) {
  const [confirming, setConfirming] = useState(false);
  const questionId = useId();
  const triggerRef = useRef(null);
  const cancelRef = useRef(null);
  const wasConfirming = useRef(false);

  useEffect(() => {
    if (confirming) {
      cancelRef.current?.focus();
    } else if (wasConfirming.current) {
      triggerRef.current?.focus();
    }
    wasConfirming.current = confirming;
  }, [confirming]);

  const onKeyDown = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      setConfirming(false);
    }
  };

  const confirm = () => {
    onConfirm();
    setConfirming(false);
  };

  if (!confirming) {
    return (
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setConfirming(true)}
        className={`${btnSecondary} inline-flex items-center gap-1.5`}
      >
        <RotateCcw size={14} aria-hidden="true" />
        {triggerText ?? `Reset ${label}`}
      </button>
    );
  }

  return (
    <div
      role="group"
      aria-label={`Confirm reset of ${label}`}
      aria-describedby={questionId}
      onKeyDown={onKeyDown}
      className="flex flex-wrap items-center gap-2"
    >
      <span id={questionId} className="text-sm text-slate-slate100">
        Reset {label} to defaults?
      </span>
      <button type="button" onClick={confirm} className={btnDanger}>
        Confirm
      </button>
      <button
        ref={cancelRef}
        type="button"
        onClick={() => setConfirming(false)}
        className={BTN}
      >
        Cancel
      </button>
    </div>
  );
}
