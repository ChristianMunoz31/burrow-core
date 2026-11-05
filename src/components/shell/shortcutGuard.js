// Shared by Back and the calculator shortcut.
// Checkbox, radio, range and button inputs are not text fields, so shortcuts still work on them.
export const EDITABLE =
  'input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=button]):not([type=submit]):not([type=reset]), textarea, select, [contenteditable]:not([contenteditable=false])';
// A modal inside an inert subtree (a dialog playing its closing animation) does not count.
// `selector` narrows which modals count.
export const isModalOpen = (selector = '[aria-modal="true"]') =>
  [...document.querySelectorAll(selector)].some((el) => !el.closest('[inert]'));
export const inEditable = (target) => Boolean(target?.closest?.(EDITABLE));
