import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect } from 'react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import Settings from '../../../pages/Settings';
import SettingsLayout from '../SettingsLayout';
import { ThemeProvider } from '../../../contexts/ThemeContext';
import { ModeProvider } from '../../../contexts/ModeContext';
import { ToastProvider } from '../../../contexts/ToastContext';
import { installMatchMedia, resetDom } from '../../../test-utils/settingsHarness';
import { allowSlowSuite } from '../../../test-utils/slowSuite';

vi.mock('../../../services/stateService', () => ({
  stateService: {
    getAll: vi.fn(async () => ({})),
    get: vi.fn(async () => undefined),
    put: vi.fn(async () => ({ ok: true })),
  },
}));
vi.mock('../../../hooks/useJarvisStatus', () => ({ useJarvisStatus: () => ({ status: null }) }));
vi.mock('../../../services/auditService', () => ({
  auditService: {
    list: vi.fn(async () => ({ entries: [], nextBefore: null, available: true })),
  },
}));
vi.mock('../../../services/secretsService', () => ({
  secretsService: {
    list: vi.fn(async () => ({
      encryption: { enabled: true },
      storage: { available: true },
      writable: true,
      secrets: [],
    })),
    save: vi.fn(),
    remove: vi.fn(),
    test: vi.fn(),
  },
}));

// Some tests render SettingsLayout without a QueryClient; the Developer nav entry has its own test file.
vi.mock('../../../hooks/useAppInfo', () => ({ useAppInfo: () => ({ info: null }) }));
vi.mock('../../../services/aiSettingsService', () => ({
  aiSettingsService: {
    get: vi.fn(() => new Promise(() => {})),
    models: vi.fn(() => new Promise(() => {})),
  },
}));


const SECTIONS = [
  ['appearance', 'Appearance'],
  ['budget', 'Budget'],
  ['general', 'General'],
  ['ai', 'AI'],
  ['data-storage', 'Data & storage'],
  ['privacy', 'Privacy & activity'],
  ['network', 'Network'],
  ['api-keys', 'Connected services'],
  ['license', 'License'],
  ['updates', 'Updates'],
];

// --- globals mocked per test -------------------------------------------------------------
let scrollIntoView;
let scrollTo;
let observers;
const origScrollTo = Object.getOwnPropertyDescriptor(window, 'scrollTo');
const origIO = globalThis.IntersectionObserver;
const origScrollIntoViewDesc = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView');
const origInnerHeight = Object.getOwnPropertyDescriptor(window, 'innerHeight');
const origScrollY = Object.getOwnPropertyDescriptor(window, 'scrollY');

class FakeIO {
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
}

function fire(observer, entries) {
  act(() => {
    observer.cb(
      entries.map(([id, isIntersecting]) => ({ target: document.getElementById(id), isIntersecting })),
    );
  });
}

function setBottom(on) {
  Object.defineProperty(document.documentElement, 'scrollHeight', { configurable: true, value: 3000 });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
  Object.defineProperty(window, 'scrollY', { configurable: true, value: on ? 2200 : 0 });
}

beforeEach(() => {
  resetDom();
  installMatchMedia(false);
  scrollIntoView = vi.fn();
  Object.defineProperty(Element.prototype, 'scrollIntoView', {
    configurable: true,
    writable: true,
    value: scrollIntoView,
  });
  observers = [];
  globalThis.IntersectionObserver = FakeIO;
  scrollTo = vi.fn();
  Object.defineProperty(window, 'scrollTo', { configurable: true, writable: true, value: scrollTo });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  resetDom();
  globalThis.IntersectionObserver = origIO;
  if (origScrollIntoViewDesc) Object.defineProperty(Element.prototype, 'scrollIntoView', origScrollIntoViewDesc);
  else delete Element.prototype.scrollIntoView;
  delete document.documentElement.scrollHeight;
  if (origScrollTo) Object.defineProperty(window, 'scrollTo', origScrollTo);
  else delete window.scrollTo;
  if (origInnerHeight) Object.defineProperty(window, 'innerHeight', origInnerHeight);
  if (origScrollY) Object.defineProperty(window, 'scrollY', origScrollY);
});

async function renderSettings(url = '/settings') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[url]}>
        <ToastProvider>
          <ThemeProvider>
            <ModeProvider>
              <Settings />
            </ModeProvider>
          </ThemeProvider>
        </ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return utils;
}

const navs = () => screen.getAllByRole('navigation', { name: 'Settings sections' });
const item = (nav, name) => within(nav).getByRole('link', { name });

// Heavy render-and-wait suite: raise the time limits so a busy machine does not trip them.
allowSlowSuite();

describe('SettingsLayout nav structure (real Settings page)', () => {
  it('renders two section navs: mobile pill bar and desktop sidebar', async () => {
    await renderSettings();
    const [mobile, desktop] = navs();
    expect(navs()).toHaveLength(2);
    expect(mobile).toHaveClass('md:hidden');
    expect(desktop).toHaveClass('hidden', 'md:block');
  });

  it('lists every section in page order, each targeting a rendered section id', async () => {
    await renderSettings();
    for (const nav of navs()) {
      const links = within(nav).getAllByRole('link');
      expect(links.map((a) => a.textContent)).toEqual([
        ...SECTIONS.map(([, label]) => label),
        'Browse your data',
      ]);
      SECTIONS.forEach(([id], i) => {
        expect(links[i]).toHaveAttribute('href', `#${id}`);
        const target = document.getElementById(id);
        expect(target).toBeInTheDocument();
        const heading = document.getElementById(`${id}-heading`);
        expect(heading).toBeInTheDocument();
        expect(heading).toHaveAttribute('tabindex', '-1');
        expect(target).toContainElement(heading);
      });
      expect(links.at(-1)).toHaveAttribute('href', '/settings/data');
    }
  });

  it('page order of the section elements matches the nav order', async () => {
    await renderSettings();
    const els = SECTIONS.map(([id]) => document.getElementById(id));
    for (let i = 1; i < els.length; i += 1) {
      expect(els[i - 1].compareDocumentPosition(els[i]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  it('marks the first section active initially and Browse your data has no aria-current', async () => {
    await renderSettings();
    for (const nav of navs()) {
      expect(item(nav, 'Appearance')).toHaveAttribute('aria-current', 'location');
      expect(within(nav).getAllByRole('link').filter((a) => a.hasAttribute('aria-current'))).toHaveLength(1);
      expect(item(nav, 'Browse your data')).not.toHaveAttribute('aria-current');
    }
  });

  it('hides the separator from assistive tech', async () => {
    await renderSettings();
    for (const nav of navs()) {
      const items = nav.querySelectorAll('ul > li');
      expect(items).toHaveLength(12);
      expect(items[10]).toHaveAttribute('aria-hidden', 'true');
    }
  });
});

describe('mobile pill bar', () => {
  it('contains all ten section links plus Browse your data and scrolls horizontally', async () => {
    await renderSettings();
    const [mobile] = navs();
    for (const [, label] of SECTIONS) expect(item(mobile, label)).toBeInTheDocument();
    expect(item(mobile, 'Browse your data')).toHaveAttribute('href', '/settings/data');
    expect(within(mobile).getAllByRole('link')).toHaveLength(11);
    expect(mobile.querySelector('ul')).toHaveClass('overflow-x-auto');
  });
});

describe('click behaviour on /settings', () => {
  it('scrolls, replaces history (no push), focuses the heading and sets aria-current', async () => {
    const user = userEvent.setup();
    const replaceState = vi.spyOn(window.history, 'replaceState');
    const pushState = vi.spyOn(window.history, 'pushState');
    await renderSettings();

    await user.click(item(navs()[1], 'Connected services'));

    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView.mock.contexts[0]).toBe(document.getElementById('api-keys'));
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' });
    expect(replaceState).toHaveBeenCalledTimes(1);
    expect(replaceState.mock.calls[0][2]).toBe('#api-keys');
    expect(pushState).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(document.getElementById('api-keys-heading'));
    for (const nav of navs()) {
      expect(item(nav, 'Connected services')).toHaveAttribute('aria-current', 'location');
      expect(item(nav, 'Appearance')).not.toHaveAttribute('aria-current');
    }
  });

  it('works from the mobile pill bar too', async () => {
    const user = userEvent.setup();
    await renderSettings();
    await user.click(item(navs()[0], 'Budget'));
    expect(scrollIntoView.mock.contexts[0]).toBe(document.getElementById('budget'));
    expect(document.activeElement).toBe(document.getElementById('budget-heading'));
    expect(item(navs()[1], 'Budget')).toHaveAttribute('aria-current', 'location');
  });

  it('prevents default navigation (href hash is not followed by the router)', async () => {
    await renderSettings();
    const link = item(navs()[1], 'General');
    const notPrevented = link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(notPrevented).toBe(false);
  });

  it('does not hijack modified or non-primary clicks (ctrl-click opens normally)', async () => {
    await renderSettings();
    const link = item(navs()[1], 'General');
    const ctrl = link.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }),
    );
    const middle = link.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, button: 1 }),
    );
    expect(ctrl).toBe(true);
    expect(middle).toBe(true);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('uses behavior "auto" when the user prefers reduced motion', async () => {
    installMatchMedia(true);
    const user = userEvent.setup();
    await renderSettings();
    await user.click(item(navs()[1], 'Connected services'));
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'auto', block: 'start' });
  });

  it('does not throw when scrollIntoView is unavailable', async () => {
    delete Element.prototype.scrollIntoView;
    const user = userEvent.setup();
    await renderSettings();
    await user.click(item(navs()[1], 'Budget'));
    expect(item(navs()[1], 'Budget')).toHaveAttribute('aria-current', 'location');
  });
});

describe('deep link', () => {
  it('scrolls to the hash section (instant) and marks it active', async () => {
    await renderSettings('/settings#api-keys');
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'instant', block: 'start' });
    expect(scrollIntoView.mock.contexts[0]).toBe(document.getElementById('api-keys'));
    for (const nav of navs()) {
      expect(item(nav, 'Connected services')).toHaveAttribute('aria-current', 'location');
    }
  });

  it('opens the Updates section from /settings#updates (the desktop Help menu link) and focuses its heading', async () => {
    await renderSettings('/settings#updates');
    expect(scrollIntoView.mock.contexts[0]).toBe(document.getElementById('updates'));
    expect(document.activeElement).toBe(document.getElementById('updates-heading'));
    for (const nav of navs()) {
      expect(item(nav, 'Updates')).toHaveAttribute('aria-current', 'location');
    }
  });

  it('ignores an unknown hash', async () => {
    await renderSettings('/settings#nope');
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(item(navs()[1], 'Appearance')).toHaveAttribute('aria-current', 'location');
  });

  it('does not scroll when there is no hash', async () => {
    await renderSettings('/settings');
    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});

describe('deep link repeats', () => {
  function Jump() {
    const navigate = useNavigate();
    return (
      <button type="button" onClick={() => navigate({ pathname: '/settings', hash: '#api-keys' })}>
        jump
      </button>
    );
  }

  it('scrolls and focuses the heading again when the same link is followed twice', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/settings']}>
        <SettingsLayout>
          <Jump />
          <section id="api-keys">
            <h2 id="api-keys-heading" tabIndex={-1}>
              Connected services
            </h2>
          </section>
        </SettingsLayout>
      </MemoryRouter>,
    );
    await user.click(screen.getByRole('button', { name: 'jump' }));
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(document.getElementById('api-keys-heading'));
    // Focus and scroll moved away; the same link again must bring them back.
    screen.getByRole('button', { name: 'jump' }).focus();
    await user.click(screen.getByRole('button', { name: 'jump' }));
    expect(scrollIntoView).toHaveBeenCalledTimes(2);
    expect(document.activeElement).toBe(document.getElementById('api-keys-heading'));
  });
});

describe('mobile pill bar centring', () => {
  const protoKeys = ['offsetLeft', 'offsetWidth', 'clientWidth'];
  const saved = {};
  beforeEach(() => {
    for (const k of protoKeys) saved[k] = Object.getOwnPropertyDescriptor(HTMLElement.prototype, k);
    Object.defineProperty(HTMLElement.prototype, 'offsetLeft', { configurable: true, value: 500 });
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, value: 100 });
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: 300 });
  });
  afterEach(() => {
    for (const k of protoKeys) {
      if (saved[k]) Object.defineProperty(HTMLElement.prototype, k, saved[k]);
      else delete HTMLElement.prototype[k];
    }
  });

  it('scrolls the pill list (not the window) so the active pill is centred', async () => {
    const user = userEvent.setup();
    await renderSettings();
    await user.click(item(navs()[0], 'Budget'));
    const ul = navs()[0].querySelector('ul');
    expect(ul.scrollLeft).toBe(400);
    // Only the click's own section scroll touched scrollIntoView.
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });
});

describe('scroll spy integration', () => {
  it('observes every section with the configured rootMargin', async () => {
    await renderSettings();
    expect(observers).toHaveLength(1);
    expect(observers[0].targets.map((el) => el.id)).toEqual(SECTIONS.map(([id]) => id));
    expect(observers[0].options.rootMargin).toMatch(/px/);
  });

  it('moves aria-current to Budget when budget intersects', async () => {
    await renderSettings();
    fire(observers[0], [['budget', true]]);
    for (const nav of navs()) {
      expect(item(nav, 'Budget')).toHaveAttribute('aria-current', 'location');
      expect(item(nav, 'Appearance')).not.toHaveAttribute('aria-current');
    }
  });

  it('picks the topmost visible section when several intersect', async () => {
    await renderSettings();
    fire(observers[0], [['general', true], ['budget', true]]);
    expect(item(navs()[1], 'Budget')).toHaveAttribute('aria-current', 'location');
    fire(observers[0], [['budget', false]]);
    expect(item(navs()[1], 'General')).toHaveAttribute('aria-current', 'location');
  });

  it('forces the last section active at the bottom of the page (observer)', async () => {
    await renderSettings();
    setBottom(true);
    fire(observers[0], [['general', true]]);
    expect(item(navs()[1], 'Updates')).toHaveAttribute('aria-current', 'location');
    expect(item(navs()[1], 'General')).not.toHaveAttribute('aria-current');
  });

  it('forces the last section active on a window scroll to the bottom', async () => {
    await renderSettings();
    setBottom(true);
    act(() => {
      window.dispatchEvent(new Event('scroll'));
    });
    expect(item(navs()[1], 'Updates')).toHaveAttribute('aria-current', 'location');
  });

  it('a scroll that is not at the bottom changes nothing', async () => {
    await renderSettings();
    setBottom(false);
    act(() => {
      window.dispatchEvent(new Event('scroll'));
    });
    expect(item(navs()[1], 'Appearance')).toHaveAttribute('aria-current', 'location');
  });

  it('rebuilds the observer rootMargin when --topbar-h changes on <html>', async () => {
    installMatchMedia(true); // every query matches: desktop (md+) band gap of 16px
    await renderSettings();
    document.documentElement.style.setProperty('--topbar-h', '110px');
    try {
      await waitFor(() => expect(observers.at(-1).options.rootMargin).toBe('-126px 0px -60% 0px'));
    } finally {
      document.documentElement.style.removeProperty('--topbar-h');
    }
  });

  it('picks up a --topbar-h published before the layout effect attached its observer', async () => {
    installMatchMedia(true);
    // Child effects run before the parent's, so this mimics TopBar publishing after render
    // but before SettingsLayout's MutationObserver exists.
    function PublishTopbar() {
      useEffect(() => {
        document.documentElement.style.setProperty('--topbar-h', '110px');
      }, []);
      return null;
    }
    try {
      render(
        <MemoryRouter initialEntries={['/settings']}>
          <SettingsLayout>
            <PublishTopbar />
          </SettingsLayout>
        </MemoryRouter>,
      );
      await waitFor(() => expect(observers.at(-1).options.rootMargin).toBe('-126px 0px -60% 0px'));
    } finally {
      document.documentElement.style.removeProperty('--topbar-h');
    }
  });

  it('disconnects the observer on unmount', async () => {
    const { unmount } = await renderSettings();
    expect(observers[0].disconnect).not.toHaveBeenCalled();
    unmount();
    expect(observers[0].disconnect).toHaveBeenCalledTimes(1);
  });
});

// --- /settings/data variant --------------------------------------------------------------
function Probe() {
  const { pathname, hash } = useLocation();
  return <output data-testid="loc">{`${pathname}${hash}`}</output>;
}

function renderLayout(url) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <SettingsLayout>
        <p>content</p>
      </SettingsLayout>
      <Probe />
    </MemoryRouter>,
  );
}

describe('SettingsLayout on /settings/data', () => {
  it('Browse your data is aria-current=page and section items are router links without aria-current', () => {
    renderLayout('/settings/data');
    for (const nav of navs()) {
      expect(item(nav, 'Browse your data')).toHaveAttribute('aria-current', 'page');
      for (const [id, label] of SECTIONS) {
        const link = item(nav, label);
        expect(link).toHaveAttribute('href', `/settings#${id}`);
        expect(link).not.toHaveAttribute('aria-current');
      }
    }
  });

  it('does not observe sections while off the settings page', () => {
    renderLayout('/settings/data');
    expect(observers).toHaveLength(0);
  });

  it('clicking a section link navigates to /settings with that hash', async () => {
    const user = userEvent.setup();
    renderLayout('/settings/data');
    await user.click(item(navs()[1], 'Budget'));
    expect(screen.getByTestId('loc')).toHaveTextContent('/settings#budget');
    await waitFor(() => expect(item(navs()[1], 'Budget')).toHaveAttribute('aria-current', 'location'));
    expect(item(navs()[1], 'Browse your data')).not.toHaveAttribute('aria-current');
  });

  it('treats a trailing slash on /settings/ as the settings home', () => {
    renderLayout('/settings/');
    expect(item(navs()[1], 'Browse your data')).not.toHaveAttribute('aria-current');
    expect(item(navs()[1], 'Appearance')).toHaveAttribute('href', '#appearance');
  });

  it('renders children', () => {
    renderLayout('/settings/data');
    expect(screen.getByText('content')).toBeInTheDocument();
  });

  it('compares the pathname case-insensitively', () => {
    renderLayout('/Settings');
    expect(item(navs()[1], 'Appearance')).toHaveAttribute('href', '#appearance');
  });

  it('scrolls to the top when the pathname changes and there is no hash', async () => {
    const user = userEvent.setup();
    renderLayout('/settings#budget');
    expect(scrollTo).not.toHaveBeenCalled();
    await user.click(item(navs()[1], 'Browse your data'));
    expect(screen.getByTestId('loc')).toHaveTextContent('/settings/data');
    expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'instant' });
  });

  it('seeds the active section from the hash and gives both lists role="list"', () => {
    renderLayout('/settings#general');
    for (const nav of navs()) {
      expect(item(nav, 'General')).toHaveAttribute('aria-current', 'location');
      expect(within(nav).getByRole('list')).toBeInTheDocument();
    }
  });
});
