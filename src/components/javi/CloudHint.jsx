import { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { X } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { aiSettingsService } from '../../services/aiSettingsService';
import { LINK_CLASS } from '../shared/AiUnavailable';

const STATUS_KEY = ['jarvis-status'];
const OFF = { show: false, reason: null };

const FOCUS_RING =
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:[outline-color:var(--focus-ring)]';

/**
 * A one-time nudge shown when Javi is slow on this computer. It only ever points at Settings;
 * it never turns cloud AI on. Posts `shown` once on mount and `dismissed` on any exit.
 * @param {{ onDismiss: () => void }} props
 */
export default function CloudHint({ onDismiss }) {
  const queryClient = useQueryClient();
  const shownRef = useRef(false);

  // Best effort: the hint cadence is a nicety, so a failed post never surfaces to the user.
  const post = (event) => aiSettingsService.cloudHint(event).catch(() => {});

  useEffect(() => {
    if (shownRef.current) return;
    shownRef.current = true;
    post('shown').then(() => queryClient.invalidateQueries({ queryKey: STATUS_KEY }));
    // The server now counts this as shown; keep the cached status in step so reopening the
    // panel does not show it again. This panel stays visible for the rest of its session.
    queryClient.setQueryData(STATUS_KEY, (old) => (old ? { ...old, cloudHint: OFF } : old));
    // Mount-only: one `shown` post per appearance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dismiss = () => {
    post('dismissed');
    onDismiss();
  };

  return (
    <div role="region" aria-label="Cloud AI option" className="glass-javi-chip flex items-start gap-2 rounded-xl px-3 py-2.5">
      <div className="min-w-0 flex-1 space-y-2">
        <p className="text-sm text-slate-slate200">
          Javi is slow on this computer. You can keep it local, or connect your own cloud AI in Settings.
        </p>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <button
            type="button"
            onClick={dismiss}
            className={`glass-javi-suggest rounded-full px-3 py-1 text-slate-slate300 hover:text-slate-slate100 ${FOCUS_RING}`}
          >
            Keep it local
          </button>
          <Link to={{ pathname: '/settings', hash: '#ai' }} onClick={dismiss} className={`text-slate-slate300 ${LINK_CLASS}`}>
            Open Settings
          </Link>
        </div>
      </div>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss"
        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-slate-slate400 hover:text-slate-slate100 ${FOCUS_RING}`}
      >
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  );
}
