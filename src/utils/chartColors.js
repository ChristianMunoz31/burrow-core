// Theme-aware color helpers for Recharts. Call these inside render (not at
// module scope) so they read the current CSS variable values, which flip when
// the user toggles dark ↔ light mode via the .light class on <html>.
function cssVar(name) {
  return `rgb(${getComputedStyle(document.documentElement).getPropertyValue(name).trim()})`;
}

export const getAccentColor = (name) => cssVar(`--acc-${name}`);

export function getSeriesColors() {
  return ['purple', 'cyan', 'green', 'yellow', 'orange', 'red', 'teal', 'blue', 'fuchsia'].map(
    (n) => cssVar(`--acc-${n}`),
  );
}

// Theme-agnostic: every value is a CSS variable (see --tooltip-* / --glass-shadow
// in src/index.css), so the tooltip flips with the theme without reading the DOM.
// No backdrop-filter on purpose: tooltips render inside already-blurred cards.
export function getTooltipStyle() {
  return {
    backgroundColor: 'var(--tooltip-bg)',
    border: '1px solid var(--tooltip-border)',
    borderRadius: '10px',
    boxShadow: 'var(--glass-shadow)',
    fontSize: '11px',
    color: 'var(--tooltip-text)',
    padding: '8px 10px',
  };
}
