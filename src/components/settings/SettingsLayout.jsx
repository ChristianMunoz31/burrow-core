import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Database } from 'lucide-react';
import { sectionHeadingId, settingsSectionsFor } from './settingsSections';
import { useScrollSpy } from '../../hooks/useScrollSpy';
import { useAppInfo } from '../../hooks/useAppInfo';

const FOCUS_RING =
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:[outline-color:var(--focus-ring)]';
// Sticky top bar height comes from the --topbar-h CSS variable (measured in TopBar, default in
// index.css). The pill bar below md is ~60px tall (nav p-1 + list py-1.5 + 38px item).
const TOPBAR_FALLBACK_PX = 56;
const PILL_BAR_PX = 60;
const DESKTOP_BAND_GAP_PX = 16;

const prefersReducedMotion = () =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const isBelowMd = () =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  !window.matchMedia('(min-width: 768px)').matches;

// IntersectionObserver needs px: top bar + pill bar below md, or top bar + 1rem on md+ (the gap
// between sections, so the previous section's tail is outside the band; see settingsSections.js).
function readSpyRootMargin() {
  let topbar = TOPBAR_FALLBACK_PX;
  if (typeof document !== 'undefined') {
    const raw = parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue('--topbar-h'),
    );
    if (Number.isFinite(raw) && raw > 0) topbar = raw;
  }
  const top = Math.round(topbar + (isBelowMd() ? PILL_BAR_PX : DESKTOP_BAND_GAP_PX));
  return `-${top}px 0px -60% 0px`;
}

const ITEM_BASE = `relative flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors duration-150 motion-reduce:transition-none ${FOCUS_RING}`;
const ITEM_IDLE = 'font-medium text-slate-slate400 hover:bg-slate-slate700/50 hover:text-slate-slate100';
const ITEM_ACTIVE = 'bg-slate-slate700/60 font-medium text-slate-slate100';

function NavList({ variant, sections, onHome, activeId, onSectionClick }) {
  const pill = variant === 'pill';
  const listRef = useRef(null);
  const item = (active) =>
    `${ITEM_BASE} ${active ? ITEM_ACTIVE : ITEM_IDLE} ${
      pill ? `shrink-0 whitespace-nowrap border-b-2 ${active ? 'border-slate-slate400' : 'border-transparent'}` : ''
    }`;
  const bar = (active) =>
    pill ? null : (
      <span
        aria-hidden="true"
        className={`absolute left-0 top-1/2 h-5 w-1 -translate-y-1/2 rounded-r-full bg-slate-slate400 transition-[opacity,transform] duration-150 motion-reduce:transition-none ${
          active ? 'scale-y-100 opacity-100' : 'scale-y-0 opacity-0'
        }`}
      />
    );

  // Keep the active pill visible and centred by scrolling the list itself (never the window).
  useEffect(() => {
    if (!pill) return;
    const list = listRef.current;
    const current = list?.querySelector('[aria-current]');
    if (!list || !current) return;
    const left = current.offsetLeft - (list.clientWidth - current.offsetWidth) / 2;
    list.scrollLeft = Math.max(0, left);
  }, [pill, activeId, onHome]);

  return (
    <ul
      ref={listRef}
      role="list"
      className={pill ? 'relative flex min-w-0 items-center gap-1 overflow-x-auto px-1 py-1.5' : 'space-y-1'}
    >
      {sections.map(({ id, label, icon: Icon }) => {
        const active = onHome && activeId === id;
        const content = (
          <>
            {bar(active)}
            <Icon size={16} aria-hidden="true" className="shrink-0" />
            <span>{label}</span>
          </>
        );
        return (
          <li key={id} className={pill ? 'shrink-0' : undefined}>
            {onHome ? (
              <a
                href={`#${id}`}
                aria-current={active ? 'location' : undefined}
                onClick={(e) => onSectionClick(e, id)}
                className={item(active)}
              >
                {content}
              </a>
            ) : (
              <Link to={{ pathname: '/settings', hash: `#${id}` }} className={item(false)}>
                {content}
              </Link>
            )}
          </li>
        );
      })}
      <li
        aria-hidden="true"
        className={
          pill
            ? 'mx-1 h-5 w-px shrink-0 bg-[var(--glass-border-strong)]'
            : 'my-2 border-t border-[color:var(--glass-border)]'
        }
      />
      <li className={pill ? 'shrink-0' : undefined}>
        <Link
          to="/settings/data"
          aria-current={onHome ? undefined : 'page'}
          className={item(!onHome)}
        >
          {bar(!onHome)}
          <Database size={16} aria-hidden="true" className="shrink-0" />
          <span>Browse your data</span>
        </Link>
      </li>
    </ul>
  );
}

// Shared by /settings and /settings/data: section navigation (sticky sidebar from md up,
// sticky pill bar below md) around the page content.
export default function SettingsLayout({ children }) {
  const { pathname, hash, key: locationKey } = useLocation();
  const onHome = pathname.toLowerCase().replace(/\/+$/, '') === '/settings';
  const { info } = useAppInfo();
  const sections = settingsSectionsFor(info);
  const sectionIds = sections.map((s) => s.id);
  const sectionKey = sectionIds.join('|');
  const [rootMargin, setRootMargin] = useState(readSpyRootMargin);
  useEffect(() => {
    const update = () => {
      const next = readSpyRootMargin();
      setRootMargin((prev) => (prev === next ? prev : next));
    };
    const mql =
      typeof window.matchMedia === 'function' ? window.matchMedia('(min-width: 768px)') : null;
    mql?.addEventListener?.('change', update);
    window.addEventListener('resize', update);
    // TopBar publishes --topbar-h on <html> via an effect/ResizeObserver (no resize event).
    const mo =
      typeof MutationObserver === 'function' ? new MutationObserver(update) : null;
    mo?.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
    // The initial read happened during render; TopBar's publish may already have run by now.
    update();
    return () => {
      mql?.removeEventListener?.('change', update);
      window.removeEventListener('resize', update);
      mo?.disconnect();
    };
  }, []);
  const { activeId, setActiveId } = useScrollSpy(sectionIds, {
    enabled: onHome,
    rootMargin,
    initialId: onHome ? hash.slice(1) : undefined,
  });

  // Switching pages (e.g. into Browse your data) starts at the top unless a hash targets a section.
  const hashRef = useRef(hash);
  useEffect(() => {
    hashRef.current = hash;
  }, [hash]);
  useEffect(() => {
    if (hashRef.current) return;
    if (typeof window.scrollTo === 'function') window.scrollTo({ top: 0, behavior: 'instant' });
  }, [pathname]);

  // Deep link (/settings#api-keys, also from /settings/data): jump there once rendered.
  // `locationKey` changes on every navigation, so repeating the same link (the section nav only
  // uses replaceState, so the hash can already match) still scrolls and focuses the heading.
  useEffect(() => {
    if (!onHome) return;
    const id = hash.slice(1);
    // Keyed on the id list: an extension section joins it once app info loads, so its hash jumps then.
    if (!sectionKey.split('|').includes(id)) return;
    document.getElementById(id)?.scrollIntoView?.({ behavior: 'instant', block: 'start' });
    setActiveId(id);
    document.getElementById(sectionHeadingId(id))?.focus({ preventScroll: true });
  }, [onHome, hash, locationKey, setActiveId, sectionKey]);

  const onSectionClick = (e, id) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    document.getElementById(id)?.scrollIntoView?.({
      behavior: prefersReducedMotion() ? 'auto' : 'smooth',
      block: 'start',
    });
    // replaceState (not navigate) so the router never sees a hash change and re-runs the
    // deep-link jump mid-scroll. history.state is kept: react-router stores its key there.
    window.history.replaceState(window.history.state, '', `#${id}`);
    setActiveId(id);
    document.getElementById(sectionHeadingId(id))?.focus({ preventScroll: true });
  };

  const listProps = { sections, onHome, activeId, onSectionClick };
  return (
    <div className="mx-auto max-w-6xl p-4 sm:p-6">
      <nav
        aria-label="Settings sections"
        className="glass-flat sticky top-[var(--topbar-h)] z-20 mb-4 min-w-0 rounded-xl p-1 md:hidden"
      >
        <NavList variant="pill" {...listProps} />
      </nav>
      <div className="md:flex md:items-start md:gap-8">
        <nav
          aria-label="Settings sections"
          className="sticky top-[calc(var(--topbar-h)_+_1rem)] hidden w-52 shrink-0 self-start md:block"
        >
          <NavList variant="list" {...listProps} />
        </nav>
        {/* Settings is a readable column; the data browser grid needs the full width. */}
        <div className={`min-w-0 flex-1 ${onHome ? 'max-w-3xl' : ''}`}>{children}</div>
      </div>
    </div>
  );
}
