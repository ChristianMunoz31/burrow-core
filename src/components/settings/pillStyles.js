export const PILL =
  'inline-flex items-center self-start rounded-full px-2 py-0.5 text-xs font-semibold sm:shrink-0';
// Same pill for rows that center their items (the row-level `items-center` does not reach a `self-start` child).
export const PILL_CENTER = PILL.replace('self-start', 'self-center');
export const TONE_CLASS = {
  ok: 'bg-accent-green/15 text-accent-green',
  warn: 'bg-accent-amber/15 text-accent-amber',
  muted: 'bg-slate-slate500/15 text-slate-slate300',
};
export const BTN =
  'glass-subtle min-h-9 rounded-md px-3 py-1.5 text-sm font-semibold text-slate-slate300 transition hover:text-slate-slate100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:[outline-color:var(--focus-ring)] disabled:cursor-not-allowed disabled:opacity-50 aria-disabled:cursor-not-allowed aria-disabled:opacity-60 sm:min-h-0';
// BTN for an anchor or router link (so it cannot drift from the button style).
export const LINK_BTN = `${BTN} inline-flex items-center`;
