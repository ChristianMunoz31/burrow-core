// Copy and class strings shared by UpdatesSection and UpdateInstallPanel. A plain module (no components), so
// react-refresh keeps working in both.
import { btnPrimary } from '../shared/formStyles';

export const GENERIC_ERROR = "Burrow couldn't start the update. Close and reopen Burrow, then try again.";
export const UNAVAILABLE_COPY = "Couldn't check for updates right now. Try again in a little while.";
/** Small helper text used across the update UI. */
export const HINT = 'text-xs text-slate-slate300';
/** The primary button while it has aria-disabled: same muted look as aiFormStyles PRIMARY_BTN (#80), not clickable. */
export const PRIMARY_BTN = `${btnPrimary} aria-disabled:cursor-not-allowed aria-disabled:bg-slate-slate700/60 aria-disabled:text-slate-slate300 aria-disabled:hover:bg-slate-slate700/60 forced-colors:aria-disabled:opacity-60`;
