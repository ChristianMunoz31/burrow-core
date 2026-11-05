import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell, AlertTriangle, Info } from 'lucide-react';
import { useBriefing } from '../../hooks/useBriefing';
import { SHELL_ICON_BTN } from './shellStyles';

// TopBar notification bell: surfaces the daily-briefing alerts (overdue todos,
// habits left, low readiness, imminent countdowns, budget signal). Clicking an
// alert jumps to the relevant module.
export default function NotificationBell() {
  // Refreshing the briefing lives in the Javi card on Home (Pro), next to the briefing itself.
  const { alerts } = useBriefing();
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const ref = useRef(null);
  const triggerRef = useRef(null);
  const popoverId = useId();

  const closePopover = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return undefined;
    const onClick = (e) => {
      if (ref.current && !ref.current.contains(e.target)) closePopover();
    };
    const onKey = (e) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      closePopover();
      triggerRef.current?.focus();
    };
    window.addEventListener('mousedown', onClick);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onClick);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, closePopover]);

  const count = alerts.length;
  const triggerLabel = count > 0 ? `Notifications, ${count} ${count === 1 ? 'alert' : 'alerts'}` : 'Notifications';

  return (
    <div className="relative" ref={ref}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => (open ? closePopover() : setOpen(true))}
        aria-label={triggerLabel}
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
        className={`relative ${SHELL_ICON_BTN}`}
      >
        <Bell size={16} aria-hidden="true" />
        {count > 0 && (
          <span aria-hidden="true" className="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 rounded-full bg-accent-red text-white text-[10px] font-semibold flex items-center justify-center">
            {count}
          </span>
        )}
      </button>

      {open && (
        <div
          id={popoverId}
          role="dialog"
          aria-label="Today’s alerts"
          className="glass-flat absolute right-0 mt-2 w-72 rounded-xl z-50 overflow-hidden"
        >
          <div className="px-3 py-2 border-b border-slate-slate700/50">
            <span aria-hidden="true" className="text-xs font-semibold text-slate-slate200">Today’s alerts</span>
          </div>
          {count === 0 ? (
            <div className="px-3 py-6 text-center text-xs text-slate-slate500">
              Nothing pressing. You’re clear.
            </div>
          ) : (
            <ul className="max-h-72 overflow-y-auto py-1">
              {alerts.map((a) => {
                const Icon = a.severity === 'warn' ? AlertTriangle : Info;
                const color = a.severity === 'warn' ? 'text-accent-amber' : 'text-accent-blue';
                return (
                  <li key={`${a.kind ?? 'alert'}:${a.text}`}>
                    <button
                      type="button"
                      onClick={() => {
                        if (a.to) navigate(a.to);
                        closePopover();
                        triggerRef.current?.focus();
                      }}
                      className="w-full flex items-start gap-2 px-3 py-2 text-left text-sm text-slate-slate300 hover:bg-slate-slate700/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-slate-slateBlueLight"
                    >
                      <Icon size={14} className={`${color} mt-0.5 shrink-0`} aria-hidden="true" />
                      <span className="flex-1">{a.text}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
