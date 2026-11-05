import { useEffect, useMemo, useRef } from 'react';
import Modal from '../shared/Modal';

/**
 * Viewer for a full text/JSON value, built on the shared Modal (focus trap, Escape,
 * scroll lock, scrim click). Focus returns to `trigger`; when that row is gone
 * (rows replaced while open), `focusFallback` is called instead of dropping focus on <body>.
 */
export default function ValueViewer({ title, content, trigger, focusFallback, onClose }) {
  const focusFallbackRef = useRef(focusFallback);
  useEffect(() => {
    focusFallbackRef.current = focusFallback;
  });
  const finalFocusRef = useMemo(
    () => ({
      get current() {
        return trigger?.isConnected ? trigger : { focus: () => focusFallbackRef.current?.() };
      },
    }),
    [trigger],
  );

  return (
    <Modal title={title} size="lg" onClose={onClose} finalFocusRef={finalFocusRef}>
      <pre
        tabIndex={0}
        aria-label="Full value"
        className="max-h-[60dvh] overflow-auto whitespace-pre-wrap break-words rounded-lg glass-input p-3 font-mono text-xs text-slate-slate100"
      >
        {content}
      </pre>
    </Modal>
  );
}
