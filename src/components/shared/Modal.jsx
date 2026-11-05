import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const FIELDS = 'input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled])';

const SIZES = { sm: 'sm:max-w-sm', md: 'sm:max-w-lg', lg: 'sm:max-w-2xl', full: 'sm:max-w-[min(96vw,80rem)]' };

// Module-level state shared by every mounted Modal: a body-scroll lock counter and a
// stack of open modal ids so only the topmost one reacts to Escape / Tab.
let lockCount = 0;
let savedOverflow = '';
const stack = [];
// Each mounted Modal registers a callback so it can mark itself `inert` while another
// modal is stacked above it (keeps the virtual cursor / Tab out of the covered panel).
const stackListeners = new Set();

function notifyStack() {
  stackListeners.forEach((fn) => fn());
}

function lockScroll() {
  if (lockCount === 0) {
    savedOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
  }
  lockCount += 1;
}

function unlockScroll() {
  lockCount -= 1;
  if (lockCount === 0) document.body.style.overflow = savedOverflow;
}

/**
 * Generic modal dialog portaled to <body>. Mounted == open: callers render it
 * conditionally so form state resets per open. Handles Escape, Tab trapping,
 * backdrop click, scroll lock, and focus restore; nested modals only act when on top.
 */
export default function Modal({
  title,
  onClose,
  children,
  size = 'md',
  role = 'dialog',
  dismissible = true,
  backdropDismiss = true,
  initialFocusRef,
  finalFocusRef,
  describedBy,
  busy = false,
}) {
  const titleId = useId();
  const stackId = useId();
  const panelRef = useRef(null);
  const onCloseRef = useRef(onClose);
  const dismissibleRef = useRef(dismissible);
  const finalFocusRefRef = useRef(finalFocusRef);
  useEffect(() => {
    onCloseRef.current = onClose;
    dismissibleRef.current = dismissible;
    finalFocusRefRef.current = finalFocusRef;
  });

  useEffect(() => {
    lockScroll();
    return unlockScroll;
  }, []);

  useEffect(() => {
    const panel = panelRef.current;
    const opener = document.activeElement;
    stack.push(stackId);
    // Imperative attribute (not state) so the lower modal is un-inerted synchronously
    // in the closing modal's cleanup, before focus is restored into it.
    const syncInert = () => {
      if (!panel) return;
      if (stack[stack.length - 1] === stackId) panel.removeAttribute('inert');
      else panel.setAttribute('inert', '');
    };
    stackListeners.add(syncInert);
    notifyStack();

    const target =
      initialFocusRef?.current ||
      panel?.querySelector(FIELDS) ||
      panel?.querySelector(FOCUSABLE) ||
      panel;
    target?.focus();

    const onKeyDown = (e) => {
      if (stack[stack.length - 1] !== stackId) return;
      if (e.key === 'Escape') {
        if (!dismissibleRef.current || e.isComposing) return;
        const t = e.target;
        if (t?.tagName === 'SELECT' || t?.type === 'date' || t?.type === 'time') return;
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab' || !panel) return;
      const items = panel.querySelectorAll(FOCUSABLE);
      if (!items.length) {
        e.preventDefault();
        panel.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (!panel.contains(active)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (e.shiftKey && (active === first || active === panel)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      const i = stack.lastIndexOf(stackId);
      if (i !== -1) stack.splice(i, 1);
      stackListeners.delete(syncInert);
      notifyStack();
      const hasOpener =
        opener && opener !== document.body && opener.isConnected && typeof opener.focus === 'function';
      if (hasOpener) opener.focus();
      else finalFocusRefRef.current?.current?.focus();
    };
    // Mount-only: focus and listeners are set up once per open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return createPortal(
    <div
      className="glass-overlay fixed inset-0 z-50 flex items-end sm:items-center justify-center sm:p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && dismissible && backdropDismiss) onClose();
      }}
    >
      <div
        ref={panelRef}
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={describedBy}
        aria-busy={busy || undefined}
        tabIndex={-1}
        className={`glass-flat w-full ${SIZES[size] ?? SIZES.md} max-h-[90dvh] overflow-y-auto rounded-t-2xl sm:rounded-2xl p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] focus:outline-none`}
      >
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 id={titleId} className="min-w-0 break-words text-base font-bold text-slate-slate100">
            {title}
          </h2>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            disabled={!dismissible}
            className="text-slate-slate400 hover:text-slate-slate100 p-1 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-slateBlueLight"
          >
            <X size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}
