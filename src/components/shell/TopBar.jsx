import { useEffect, useRef } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Search, Settings } from 'lucide-react';
import { openCommandPalette } from '../../hooks/useCommandPalette';
import NotificationBell from './NotificationBell';
import BackButton from './BackButton';
import DevBuildBadge from './DevBuildBadge';
import TrialBadge from './TrialBadge';
import { SHELL_ICON_BTN, SHELL_ICON_BTN_ACTIVE } from './shellStyles';

// "⌘K" on Apple platforms, "Ctrl K" elsewhere.
function shortcutHint() {
  const platform = navigator.userAgentData?.platform || navigator.platform || '';
  return /mac|iphone|ipad/i.test(platform) ? '⌘K' : 'Ctrl K';
}

// One calm bar: Back, the Burrow wordmark (Home), then search, bell and the Settings gear.
// The burger (BurgerMenu) is fixed over the left padding.
export default function TopBar() {
  const { pathname } = useLocation();
  const headerRef = useRef(null);
  const settings = pathname === '/settings' || pathname.startsWith('/settings/');

  // Publish the measured bar height so sticky offsets / scroll margins elsewhere stay exact.
  useEffect(() => {
    const el = headerRef.current;
    if (!el) return undefined;
    const publish = () => {
      if (el.offsetHeight > 0) {
        document.documentElement.style.setProperty('--topbar-h', `${el.offsetHeight}px`);
      }
    };
    publish();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(publish);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <header
      data-topbar=""
      ref={headerRef}
      className="sticky top-0 z-[45] flex h-14 items-center gap-1 pl-14 pr-3 sm:pr-4 glass-strong border-x-0 border-t-0 shadow-none">
      <BackButton />

      <div className="flex min-w-0 items-center gap-2">
        <Link
          to="/"
          aria-label="Burrow, go to Home"
          aria-current={pathname === '/' ? 'page' : undefined}
          className="rounded-md px-1.5 py-1 text-lg font-bold tracking-tight text-slate-slate100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-slateBlueLight"
        >
          Burrow
        </Link>
        <DevBuildBadge />
        <TrialBadge />
      </div>

      <div className="ml-auto flex shrink-0 items-center gap-1">
        {/* Command palette / search (Ctrl K or ⌘K) */}
        <button
          type="button"
          onClick={openCommandPalette}
          aria-label="Search commands and your data"
          aria-keyshortcuts="Control+K Meta+K"
          title={`Search (${shortcutHint()})`}
          className={SHELL_ICON_BTN}
        >
          <Search size={18} aria-hidden="true" />
        </button>

        {/* Javi briefing + alerts */}
        <NotificationBell />

        <Link
          to="/settings"
          aria-label="Settings"
          title="Settings"
          aria-current={settings ? 'page' : undefined}
          className={`${SHELL_ICON_BTN} ${settings ? SHELL_ICON_BTN_ACTIVE : ''}`}
        >
          <Settings size={18} aria-hidden="true" />
        </Link>
      </div>
    </header>
  );
}
