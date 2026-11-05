// Class strings shared by the Folders components.
export const FOCUS =
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:[outline-color:var(--focus-ring)]';
// Icon-only button: 36px on narrow screens, 28px from sm up (docs/DESIGN.md target sizes).
export const ICON_BTN = `inline-flex h-9 w-9 items-center justify-center rounded text-slate-slate300 hover:text-slate-slate100 sm:h-7 sm:w-7 aria-disabled:cursor-not-allowed aria-disabled:opacity-40 ${FOCUS}`;
// Quiet text toggle (Files, Details, Ask, Report).
export const TOGGLE = `inline-flex items-center gap-1 rounded text-sm font-semibold text-slate-slate300 hover:text-slate-slate100 ${FOCUS}`;
// A menu row.
export const MENU_ITEM =
  'block w-full px-3 py-2 text-left text-sm text-slate-slate300 hover:bg-slate-slate700/50 hover:text-slate-slate100 focus-visible:bg-slate-slate700/50 focus-visible:text-slate-slate100 focus-visible:outline-offset-[-2px] aria-disabled:cursor-not-allowed aria-disabled:opacity-60';
