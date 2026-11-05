import { ChevronUp, Sparkles } from 'lucide-react';

/**
 * Docked message bar, fixed bottom-right (above content z-[1] and TopBar z-30, below modals z-50,
 * the palette z-[60] and toasts z-[200]); at most 3rem plus the bottom safe area tall (AppShell's
 * pb-16 relies on it). One button: avatar, "Javi", the "AI helper" tag, the "new for you" badge and
 * a chevron. Hidden (a class, not a tab stop) while the window is open; the window header takes its
 * place. The name carries the real count, the visible badge (aria-hidden, never animated) caps at 9+.
 * @param {{ ref?: import('react').Ref<HTMLButtonElement>, open: boolean, onToggle: () => void,
 *   controlsId: string, count?: number }} props
 */
export default function JaviBar({ ref, open, onToggle, controlsId, count = 0 }) {
  return (
    <button
      ref={ref}
      type="button"
      onClick={onToggle}
      aria-label={count > 0 ? `Javi, AI helper, ${count} new for you` : 'Javi, AI helper'}
      aria-keyshortcuts="Alt+J"
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-controls={open ? controlsId : undefined}
      className={`glass-javi-bar ${open ? 'hidden' : 'flex'} fixed z-40 bottom-0 right-3 sm:right-[max(1rem,env(safe-area-inset-right))] min-h-12 items-center gap-2 rounded-t-2xl border-b-0 pl-2 pr-3 pb-[env(safe-area-inset-bottom)] text-left sm:w-72 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:[outline-color:var(--focus-ring)]`}
    >
      <span aria-hidden="true" className="glass-javi-send flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-transparent">
        <Sparkles size={18} />
      </span>
      <span aria-hidden="true" className="text-lg font-semibold text-slate-slate100">
        Javi
      </span>
      <span aria-hidden="true" className="glass-javi-chip shrink-0 whitespace-nowrap rounded-full px-2.5 py-0.5 text-sm text-slate-slate300">
        AI helper
      </span>
      {count > 0 && (
        <span
          aria-hidden="true"
          className="glass-javi-send ml-auto flex h-6 min-w-[1.5rem] items-center justify-center rounded-full border border-transparent px-1.5 text-sm font-semibold"
        >
          {count > 9 ? '9+' : count}
        </span>
      )}
      <ChevronUp size={16} aria-hidden="true" className={`${count > 0 ? '' : 'ml-auto'} text-slate-slate400`} />
    </button>
  );
}
