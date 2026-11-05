const FOCUS_RING =
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:[outline-color:var(--focus-ring)]';

/** A real button with role="switch". Names it through labelledBy (and optionally describedBy); buttonRef reaches the button for focus. */
export default function SwitchToggle({ checked, disabled, labelledBy, describedBy, onChange, buttonRef }) {
  return (
    <button
      ref={buttonRef}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      aria-disabled={disabled || undefined}
      onClick={() => {
        if (!disabled) onChange(!checked);
      }}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors aria-disabled:cursor-not-allowed aria-disabled:opacity-50 motion-reduce:transition-none ${FOCUS_RING} ${
        checked ? 'bg-slate-slateBlue' : 'bg-slate-slate600'
      }`}
    >
      <span
        aria-hidden="true"
        className={`inline-block h-4 w-4 rounded-full bg-white transition-transform motion-reduce:transition-none ${
          checked ? 'translate-x-6' : 'translate-x-1'
        }`}
      />
    </button>
  );
}
