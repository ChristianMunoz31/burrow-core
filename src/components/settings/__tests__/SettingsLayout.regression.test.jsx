import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter } from 'react-router-dom';
import SettingsLayout from '../SettingsLayout';
import { SETTINGS_SECTIONS } from '../settingsSections';

// Rendered without a QueryClient; the Developer nav entry has its own test file.
vi.mock('../../../hooks/useAppInfo', () => ({ useAppInfo: () => ({ info: null }) }));

// Regression tests for the Settings side-nav scroll spy / layout bugs. They exercise behaviour
// (geometry-backed IntersectionObserver, matchMedia flips) rather than a specific rootMargin string.

const IDS = SETTINGS_SECTIONS.map((s) => s.id);
const TOPBAR = 71;
const VIEWPORT_H = 800;
const GAP = 16; // space-y-4
const HEIGHTS = { appearance: 400, budget: 500, general: 600, 'data-storage': 500, privacy: 500, network: 400, 'api-keys': 700 };
const FIRST_TOP = 120;

let observers;
let layout;
let mq;
const origIO = globalThis.IntersectionObserver;
const origMatchMedia = window.matchMedia;
const origScrollTo = window.scrollTo;
const origScrollIntoViewDesc = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView');
const origInnerHeight = Object.getOwnPropertyDescriptor(window, 'innerHeight');
const origScrollY = Object.getOwnPropertyDescriptor(window, 'scrollY');

function docTop(id) {
  let y = FIRST_TOP;
  for (const k of IDS) {
    if (k === id) return y;
    y += HEIGHTS[k] + GAP;
  }
  return y;
}

function toPx(token, base) {
  return token.endsWith('%') ? (parseFloat(token) / 100) * base : parseFloat(token);
}

// Returns the top-margin offset in px as a signed number (negative shrinks the root).
function parseTop(rootMargin) {
  const v = rootMargin.trim().split(/\s+/);
  return toPx(v[0], VIEWPORT_H);
}

class GeoIO {
  constructor(cb, options) {
    this.cb = cb;
    this.options = options;
    this.targets = [];
    this.disconnect = vi.fn();
    observers.push(this);
  }
  observe(el) {
    this.targets.push(el);
  }
  unobserve() {}
  entries() {
    const v = this.options.rootMargin.trim().split(/\s+/);
    const top = toPx(v[0], VIEWPORT_H);
    const bottom = toPx(v[2] ?? v[0], VIEWPORT_H);
    const bandTop = -top;
    const bandBottom = VIEWPORT_H + bottom;
    return this.targets.map((el) => {
      const r = el.getBoundingClientRect();
      return { target: el, isIntersecting: r.bottom >= bandTop && r.top <= bandBottom };
    });
  }
}

function installMq() {
  const state = { desktop: true, listeners: new Set() };
  window.matchMedia = (q) => ({
    get matches() {
      return q.includes('min-width') ? state.desktop : false;
    },
    media: q,
    addEventListener: (t, fn) => t === 'change' && state.listeners.add(fn),
    removeEventListener: (t, fn) => t === 'change' && state.listeners.delete(fn),
    addListener: (fn) => state.listeners.add(fn),
    removeListener: (fn) => state.listeners.delete(fn),
    dispatchEvent: () => true,
  });
  return {
    setDesktop(next) {
      state.desktop = next;
      act(() => {
        for (const fn of [...state.listeners]) fn({ matches: next, media: '(min-width: 768px)' });
        window.dispatchEvent(new Event('resize'));
      });
    },
  };
}

function Sections() {
  return (
    <>
      {IDS.map((id) => (
        <section key={id} id={id}>
          <h2 id={`${id}-heading`} tabIndex={-1}>
            {id}
          </h2>
        </section>
      ))}
    </>
  );
}

function layoutDom() {
  for (const id of IDS) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.getBoundingClientRect = () => {
      const top = docTop(id) - layout.scrollY;
      return { top, bottom: top + HEIGHTS[id], height: HEIGHTS[id], left: 0, right: 0, width: 0, x: 0, y: top };
    };
  }
}

function renderAt(url = '/settings') {
  const utils = render(
    <MemoryRouter initialEntries={[url]}>
      <SettingsLayout>
        <Sections />
      </SettingsLayout>
    </MemoryRouter>,
  );
  layoutDom();
  return utils;
}

const navs = () => screen.getAllByRole('navigation', { name: 'Settings sections' });
const link = (nav, name) => within(nav).getByRole('link', { name });
const refire = (obs) => act(() => obs.cb(obs.entries()));

beforeEach(() => {
  observers = [];
  layout = { scrollY: 0 };
  globalThis.IntersectionObserver = GeoIO;
  mq = installMq();
  document.documentElement.style.setProperty('--topbar-h', `${TOPBAR}px`);
  Object.defineProperty(document.documentElement, 'scrollHeight', { configurable: true, value: 4000 });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: VIEWPORT_H });
  Object.defineProperty(window, 'scrollY', { configurable: true, get: () => layout.scrollY });
  window.scrollTo = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  globalThis.IntersectionObserver = origIO;
  window.matchMedia = origMatchMedia;
  window.scrollTo = origScrollTo;
  document.documentElement.style.removeProperty('--topbar-h');
  delete document.documentElement.scrollHeight;
  if (origScrollIntoViewDesc) Object.defineProperty(Element.prototype, 'scrollIntoView', origScrollIntoViewDesc);
  else delete Element.prototype.scrollIntoView;
  if (origInnerHeight) Object.defineProperty(window, 'innerHeight', origInnerHeight);
  if (origScrollY) Object.defineProperty(window, 'scrollY', origScrollY);
});

describe('A. desktop click does not snap back to the previous section', () => {
  it.each(['budget', 'general', 'data-storage'])(
    'keeps %s active after the click scroll settles (md+, 16px section gaps)',
    (id) => {
      vi.useFakeTimers();
      // Browser lands the target at topbar + scroll-margin (24px) on md+.
      Object.defineProperty(Element.prototype, 'scrollIntoView', {
        configurable: true,
        writable: true,
        value: function scrollIntoView() {
          layout.scrollY = docTop(this.id) - (TOPBAR + 24);
        },
      });
      renderAt('/settings');
      refire(observers.at(-1));

      const label = SETTINGS_SECTIONS.find((s) => s.id === id).label;
      fireEvent.click(link(navs()[1], label));
      expect(link(navs()[1], label)).toHaveAttribute('aria-current', 'location');

      // Scrolling finished: observer re-evaluates at the final position, then the lock releases.
      refire(observers.at(-1));
      act(() => {
        window.dispatchEvent(new Event('scrollend'));
      });
      act(() => {
        vi.advanceTimersByTime(150);
      });
      // Unlocked: re-evaluate the band geometry. The previous section's bottom sits at topbar+8, so
      // it must fall outside the band (top = topbar+16) or the active item would snap back.
      refire(observers.at(-1));

      for (const nav of navs()) {
        expect(link(nav, label)).toHaveAttribute('aria-current', 'location');
      }
      const active = within(navs()[1])
        .getAllByRole('link')
        .filter((a) => a.getAttribute('aria-current') === 'location');
      expect(active).toHaveLength(1);
    },
  );

  it('also holds when release comes from the 100ms quiet timer (no scrollend)', () => {
    vi.useFakeTimers();
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      writable: true,
      value: function scrollIntoView() {
        layout.scrollY = docTop(this.id) - (TOPBAR + 24);
      },
    });
    renderAt('/settings');
    refire(observers.at(-1));
    fireEvent.click(link(navs()[1], 'Budget'));
    refire(observers.at(-1));
    act(() => {
      vi.advanceTimersByTime(150);
    });
    // Unlocked: geometry re-evaluated; previous section must not intersect the band.
    refire(observers.at(-1));
    expect(link(navs()[1], 'Budget')).toHaveAttribute('aria-current', 'location');
  });
});

describe('C. spy band follows breakpoint and topbar-height changes', () => {
  function referenceMargin({ desktop, topbar }) {
    const prev = observers.length;
    document.documentElement.style.setProperty('--topbar-h', `${topbar}px`);
    mq.setDesktop(desktop);
    const { unmount } = renderAt('/settings');
    const margin = observers.slice(prev).at(-1).options.rootMargin;
    unmount();
    return margin;
  }

  it('recomputes rootMargin when the md breakpoint flips to mobile', () => {
    const mobileRef = referenceMargin({ desktop: false, topbar: TOPBAR });
    const desktopRef = referenceMargin({ desktop: true, topbar: TOPBAR });
    expect(parseTop(mobileRef)).toBeLessThan(parseTop(desktopRef)); // mobile band starts lower

    observers = [];
    renderAt('/settings');
    expect(observers.at(-1).options.rootMargin).toBe(desktopRef);

    mq.setDesktop(false);
    expect(observers.length).toBeGreaterThan(1);
    expect(observers.at(-1).options.rootMargin).toBe(mobileRef);
  });

  it('recomputes rootMargin when --topbar-h changes (resize)', () => {
    const tall = referenceMargin({ desktop: true, topbar: 110 });
    const short = referenceMargin({ desktop: true, topbar: TOPBAR });
    expect(tall).not.toBe(short);

    observers = [];
    renderAt('/settings');
    expect(observers.at(-1).options.rootMargin).toBe(short);

    document.documentElement.style.setProperty('--topbar-h', '110px');
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(observers.at(-1).options.rootMargin).toBe(tall);
  });
});

describe('D. active and idle nav items share the same font weight (no layout shift)', () => {
  const weights = (el) => [...el.classList].filter((c) => /^font-(thin|extralight|light|normal|medium|semibold|bold|extrabold|black)$/.test(c)).sort();

  it('section links: active vs idle in both navs', () => {
    renderAt('/settings');
    for (const nav of navs()) {
      const active = link(nav, 'Appearance');
      const idle = link(nav, 'Budget');
      expect(active).toHaveAttribute('aria-current', 'location');
      expect(idle).not.toHaveAttribute('aria-current');
      expect(weights(active).length).toBeGreaterThan(0);
      expect(weights(active)).toEqual(weights(idle));
    }
  });

  it('Browse your data link: active (on /settings/data) vs idle (on /settings) uses the same weight', () => {
    const { unmount } = renderAt('/settings/data');
    const activeW = navs().map((n) => weights(link(n, 'Browse your data')));
    const idleOnData = navs().map((n) => weights(link(n, 'Budget')));
    unmount();
    renderAt('/settings');
    const idleW = navs().map((n) => weights(link(n, 'Browse your data')));
    expect(activeW).toEqual(idleW);
    expect(activeW).toEqual(idleOnData);
  });
});

describe('E. page change scrolls to top instantly', () => {
  it('calls window.scrollTo({top:0, behavior:"instant"}) and never bare (0, 0)', () => {
    renderAt('/settings#budget');
    window.scrollTo.mockClear();
    fireEvent.click(link(navs()[1], 'Browse your data'));
    expect(window.scrollTo).toHaveBeenCalled();
    expect(window.scrollTo).toHaveBeenCalledWith(expect.objectContaining({ top: 0, behavior: 'instant' }));
    expect(window.scrollTo.mock.calls.some((c) => c.length === 2 && c[0] === 0 && c[1] === 0)).toBe(false);
  });
});
