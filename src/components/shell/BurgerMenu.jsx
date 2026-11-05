import { useCallback, useEffect, useId, useReducer, useRef, useState } from 'react';
import { Link, matchPath, useLocation } from 'react-router-dom';
import { ChevronDown, Menu, X } from 'lucide-react';
import { NAV_GROUPS } from './navItems';
import { SHELL_ICON_BTN } from './shellStyles';
import { lsKey } from '../../utils/storageKeys';
import { useSyncedSetting } from '../../hooks/useSyncedSetting';
import {
  SETTINGS_DEFAULTS,
  SETTINGS_KEYS,
  normalizeNavHideSubcategories,
} from '../../constants/settingsDefaults';

const CLOSE_MS = 220;
const FOCUSABLE = 'a[href], button:not([disabled])';

// Menu lifecycle: 'closed' (unmounted) -> 'open' -> 'closing' (exit animation) -> 'closed'.
function phaseReducer(phase, action) {
  if (action === 'OPEN') return 'open';
  if (action === 'CLOSE') return phase === 'open' ? 'closing' : phase;
  if (action === 'HIDE') return 'closed';
  return phase;
}

// Active row: fill plus semibold (a non-colour cue that survives forced colours).
const linkClass = (active, nested = false) =>
  `relative flex items-center ${nested ? 'gap-2.5 pl-6 pr-3 text-[13px] sm:text-sm' : 'gap-3 px-3 text-sm'} rounded-md py-2 sm:py-1.5 transition-colors ${
    active
      ? 'bg-slate-slate700/60 font-semibold text-slate-slate100'
      : 'font-medium text-slate-slate400 hover:bg-slate-slate700/50 hover:text-slate-slate100'
  }`;

// An item is active when its path matches and no `exclude` path does.
function isItemActive(item, pathname) {
  if (!matchPath({ path: item.to, end: item.end ?? false }, pathname)) return false;
  return !(item.exclude ?? []).some((path) => matchPath({ path, end: false }, pathname));
}

// A plain Link (not NavLink): NavLink always derives aria-current from its own match, which
// cannot honor `exclude`.
function MenuLink({ to, label, icon: Icon, end, exclude, onNavigate, nested = false }) {
  const { pathname } = useLocation();
  const active = isItemActive({ to, end, exclude }, pathname);
  return (
    <Link
      to={to}
      onClick={onNavigate}
      className={linkClass(active, nested)}
      aria-current={active ? 'page' : undefined}
    >
      <Icon size={nested ? 14 : 16} aria-hidden="true" className="shrink-0" />
      <span>{label}</span>
    </Link>
  );
}

// Drawer rows, computed once: top unsectioned rows (Home, Calendar), then the sectioned groups
// (Financials, Health, Productivity), then any tail unsectioned rows. Settings is `drawer: false`.
const LISTED = NAV_GROUPS.filter((g) => g.drawer !== false);
const firstSectionIndex = LISTED.findIndex((g) => g.section);
const TOP_ROWS = (firstSectionIndex === -1 ? LISTED : LISTED.slice(0, firstSectionIndex)).flatMap((g) => g.items);
const SECTIONS = LISTED.filter((g) => g.section);
const lastSectionIndex = LISTED.findLastIndex((g) => g.section);
const TAIL_ROWS = (lastSectionIndex === -1 ? [] : LISTED.slice(lastSectionIndex + 1)).filter((g) => !g.section).flatMap((g) => g.items);

// Which sections are expanded, remembered per section on this device ({ [group id]: true|false }).
// A missing, unreadable or malformed value means the defaults: every section closed except the
// current page's, which opening the menu always expands (the active row is never hidden).
const SECTIONS_KEY = lsKey('nav:sections');
function loadSections() {
  try {
    // Anything that is not a map of `true` values (null, a number, a string) reads as all closed.
    return JSON.parse(localStorage.getItem(SECTIONS_KEY)) || {};
  } catch {
    return {};
  }
}
function saveSections(map) {
  try {
    localStorage.setItem(SECTIONS_KEY, JSON.stringify(map));
  } catch {
    /* storage unavailable: the choice lasts until the page reloads */
  }
  return map;
}

// Burger menu: one list of every page. Home, one named group per section whose heading is a
// disclosure button (its rows show only while expanded), a divider and Calendar. The top bar's wordmark also
// opens Home and its gear opens Settings. All of it comes from NAV_GROUPS (navItems.js).
export default function BurgerMenu() {
  const { pathname } = useLocation();
  const [storedNavHideSubcategories] = useSyncedSetting(
    SETTINGS_KEYS.navHideSubcategories,
    SETTINGS_DEFAULTS.navHideSubcategories,
  );
  const navHideSubcategories = normalizeNavHideSubcategories(storedNavHideSubcategories);
  const [phase, dispatch] = useReducer(phaseReducer, 'closed');
  const buttonRef = useRef(null);
  const panelRef = useRef(null);
  const baseId = useId();
  const panelId = `${baseId}-panel`;
  const headingId = `${baseId}-heading`;

  const isOpen = phase === 'open';
  const rendered = phase !== 'closed';
  const [expanded, setExpanded] = useState(loadSections);
  const current = SECTIONS.find((g) => g.items.some((item) => isItemActive(item, pathname)))?.id;
  const setSection = (id, value) => setExpanded(saveSections({ ...expanded, [id]: value }));

  const close = useCallback(() => {
    dispatch('CLOSE');
    buttonRef.current?.focus();
  }, []);

  const toggle = () => {
    if (isOpen) {
      close();
    } else {
      if (current && expanded[current] !== true) setSection(current, true);
      dispatch('OPEN');
    }
  };

  // Unmount after the exit animation finishes.
  useEffect(() => {
    if (phase !== 'closing') return undefined;
    const t = setTimeout(() => dispatch('HIDE'), CLOSE_MS);
    return () => clearTimeout(t);
  }, [phase]);

  // Safety net: any route change closes the menu.
  const prevPath = useRef(pathname);
  useEffect(() => {
    if (prevPath.current !== pathname) {
      prevPath.current = pathname;
      dispatch('CLOSE');
      // Return focus to the burger if it was inside the panel that is about to go away.
      if (panelRef.current?.contains(document.activeElement)) buttonRef.current?.focus();
    }
  }, [pathname]);

  // Focus management: the current page's link on open, else the first control.
  useEffect(() => {
    if (!isOpen) return;
    const panel = panelRef.current;
    (panel?.querySelector('a[aria-current="page"]') ?? panel?.querySelector(FOCUSABLE))?.focus();
  }, [isOpen]);

  // Escape, Tab trap and body scroll lock while open. The command palette
  // (z-[60], its own dialog) can open on top; the menu yields to it by closing
  // when the palette opens and by ignoring keys that belong to the palette.
  useEffect(() => {
    if (!isOpen) return undefined;
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        // Palette is opening (or toggling): park focus on the burger first, so the palette
        // remembers a stable opener instead of a link inside the panel that is about to unmount.
        buttonRef.current?.focus();
        dispatch('CLOSE');
        return;
      }
      const active = document.activeElement;
      if (e.key === 'Escape') {
        if (e.defaultPrevented) return;
        const otherDialog = active?.closest?.('[role="dialog"]');
        if (otherDialog && otherDialog !== panelRef.current) return;
        close();
        return;
      }
      if (e.key !== 'Tab' || !panelRef.current) return;
      const inside = panelRef.current.contains(active) || active === buttonRef.current;
      if (!inside) return;
      const items = [...panelRef.current.querySelectorAll(FOCUSABLE)];
      if (buttonRef.current) items.push(buttonRef.current);
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    const onPaletteOpen = () => {
      buttonRef.current?.focus();
      dispatch('CLOSE');
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('palette:open', onPaletteOpen);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('palette:open', onPaletteOpen);
      document.body.style.overflow = prevOverflow;
    };
  }, [isOpen, close]);

  // ArrowUp/ArrowDown/Home/End move between the visible links and section buttons (collapsed rows
  // are not rendered, so they are skipped).
  const onListKeyDown = (e) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    const rows = [...e.currentTarget.querySelectorAll(FOCUSABLE)];
    const index = rows.indexOf(document.activeElement);
    if (index === -1) return;
    e.preventDefault();
    let next = index;
    if (e.key === 'ArrowDown') next = (index + 1) % rows.length;
    if (e.key === 'ArrowUp') next = (index - 1 + rows.length) % rows.length;
    if (e.key === 'Home') next = 0;
    if (e.key === 'End') next = rows.length - 1;
    rows[next].focus();
  };

  const closing = phase === 'closing';

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={toggle}
        aria-label="Navigation menu"
        aria-expanded={isOpen}
        aria-controls={rendered ? panelId : undefined}
        aria-haspopup="dialog"
        className={`fixed top-2.5 left-3 z-[60] ${SHELL_ICON_BTN}`}
      >
        {isOpen ? <X size={18} aria-hidden="true" /> : <Menu size={18} aria-hidden="true" />}
      </button>

      {rendered && (
        <div className="fixed inset-0 z-50" inert={closing}>
          {/* Dimmed backdrop; clicking outside the panel closes the menu */}
          <div
            className={`glass-overlay absolute inset-0 ${closing ? 'animate-overlay-out' : 'animate-overlay-in'}`}
            onClick={close}
            aria-hidden="true"
          />
          <aside
            id={panelId}
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={headingId}
            data-nav-drawer=""
            className={`absolute inset-y-0 left-0 w-72 max-w-[85vw] glass-strong border-y-0 border-l-0 flex flex-col ${closing ? 'animate-drawer-out' : 'animate-drawer-in'}`}
          >
            {/* pl-14 (3.5rem) clears the fixed burger: left-3 (0.75rem) + 36px button + gap */}
            <div className="flex h-14 shrink-0 items-center pl-14 pr-4">
              <h2 id={headingId} className="text-lg font-bold tracking-tight text-slate-slate100">
                Burrow
              </h2>
            </div>

            <nav aria-label="Main" className="flex-1 overflow-y-auto px-3 pt-1 pb-3">
              {/* One container, so the arrow keys cross sections and skip the divider */}
              <div onKeyDown={onListKeyDown}>
                {TOP_ROWS.map((item) => (
                  <MenuLink key={item.to} {...item} onNavigate={close} />
                ))}
                {SECTIONS.map((group) => {
                  const SectionIcon = group.icon;
                  if (navHideSubcategories) {
                    const primary = group.items[0];
                    const active = group.items.some((item) => isItemActive(item, pathname));
                    return (
                      <Link
                        key={group.id}
                        to={primary?.to}
                        onClick={close}
                        className={linkClass(active, false)}
                        aria-current={active ? 'page' : undefined}
                      >
                        {SectionIcon && <SectionIcon size={16} aria-hidden="true" className="shrink-0" />}
                        <span>{group.section}</span>
                      </Link>
                    );
                  }
                  const sid = `${baseId}-${group.id}`;
                  const listId = `${sid}-list`;
                  const open = expanded[group.id] === true;
                  return (
                    <div key={group.id} role="group" aria-labelledby={sid} className="pt-1">
                      <h3>
                        <button
                          id={sid}
                          type="button"
                          aria-expanded={open}
                          aria-controls={listId}
                          onClick={() => setSection(group.id, !open)}
                          className="flex w-full items-center justify-between rounded-md px-3 py-2 sm:py-1.5 text-sm transition-colors font-medium text-slate-slate400 hover:bg-slate-slate700/50 hover:text-slate-slate100"
                        >
                          <div className="flex items-center gap-3">
                            {SectionIcon && <SectionIcon size={16} aria-hidden="true" />}
                            <span>{group.section}</span>
                          </div>
                          <ChevronDown
                            size={16}
                            aria-hidden="true"
                            className={open ? 'shrink-0 rotate-180 transition-transform duration-200' : 'shrink-0 transition-transform duration-200'}
                          />
                        </button>
                      </h3>
                      <div id={listId} className="space-y-0.5">
                        {open && group.items.map((item) => <MenuLink key={item.to} {...item} onNavigate={close} nested />)}
                      </div>
                    </div>
                  );
                })}
                {TAIL_ROWS.length > 0 && (
                  <>
                    <hr className="mx-3 my-2 border-t border-slate-slate700/50" />
                    {TAIL_ROWS.map((item) => (
                      <MenuLink key={item.to} {...item} onNavigate={close} />
                    ))}
                  </>
                )}
              </div>
            </nav>

            <div className="px-4 py-3 border-t border-slate-slate700/50 text-xs text-slate-slate400">
              <div>Private, on this device</div>
            </div>
          </aside>
        </div>
      )}
    </>
  );
}
