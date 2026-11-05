// Fire from anywhere (command palette) to open the calculator dialog. CommandPalette listens for it.
export const CALCULATOR_OPEN_EVENT = 'calculator:open';

/** @param {Element | null} [returnTo] where focus goes back on close when the opener is gone */
export function openCalculator(returnTo = null) {
  window.dispatchEvent(new CustomEvent(CALCULATOR_OPEN_EVENT, { detail: { returnTo } }));
}
