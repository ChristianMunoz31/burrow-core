import { PILL, TONE_CLASS } from '../settings/pillStyles';

/**
 * A small "Pro" marker for a control that is part of Burrow Pro, shown only while the user is known
 * to be on Free. The pill is decorative (aria-hidden); `ProPillDescription` carries the words for
 * screen readers and is pointed to with aria-describedby on the control. Neither disables anything.
 */
export function ProPill({ className = '' }) {
  return (
    <span aria-hidden="true" className={`${PILL} ${TONE_CLASS.muted} ${className}`.trim()}>
      Pro
    </span>
  );
}

/** Screen reader text for the control's aria-describedby. Place it next to the control, not inside it. */
export function ProPillDescription({ id }) {
  return (
    <span id={id} className="sr-only">
      Part of Burrow Pro
    </span>
  );
}
