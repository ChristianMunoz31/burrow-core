import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import BurgerMenu from '../BurgerMenu';
import { NAV_GROUPS } from '../navItems';
import { ModeProvider } from '../../../contexts/ModeContext';

// Minimal stub: ModeProvider reads `mode` from useSyncedSetting (database-backed).
const settings = vi.hoisted(() => ({ mode: 'all', founder: false, name: null, navHideSubcategories: false }));
vi.mock('../../../hooks/useSyncedSetting', () => ({
  useSyncedSetting: (key, fallback) => {
    if (key === 'nav:hideSubcategories') {
      return [settings.navHideSubcategories ?? fallback, vi.fn(), { isFetched: true, isLoading: false }];
    }
    return [settings.mode ?? fallback, vi.fn(), { isFetched: true, isLoading: false }];
  },
}));

vi.mock('../../../hooks/useLicense', () => ({
  useLicenseFlags: () => ({ known: true, founderBackground: settings.founder, pro: false, trial: null }),
}));

vi.mock('../../../hooks/useProfile', () => ({
  useProfile: () => ({ displayName: settings.name, onboarded: true, isLoading: false, save: vi.fn() }),
}));

function LocationProbe() {
  const { pathname } = useLocation();
  return <div data-testid="pathname">{pathname}</div>;
}

function setup(route = '/', mode = 'all') {
  settings.mode = mode;
  const user = userEvent.setup();
  render(
    <MemoryRouter initialEntries={[route]}>
      <ModeProvider>
        <BurgerMenu />
        <LocationProbe />
      </ModeProvider>
    </MemoryRouter>,
  );
  return user;
}

// The whole menu with every section expanded: Home, Calendar, three named sections.
const SECTIONS = [
  ['Financials', ['Budget', 'Subscriptions']],
  ['Health', ['Journal', 'Habits', 'Sleep & activity']],
  ['Productivity', ['Todos', 'Notes', 'Focus', 'Countdowns', 'Bookmarks', 'Folders']],
];
const MENU = [
  'Home',
  'Calendar',
  '#Financials',
  'Budget',
  'Subscriptions',
  '#Health',
  'Journal',
  'Habits',
  'Sleep & activity',
  '#Productivity',
  'Todos',
  'Notes',
  'Focus',
  'Countdowns',
  'Bookmarks',
  'Folders',
];

const SECTIONS_KEY = 'burrow.nav:sections';
const burger = () => screen.getByRole('button', { name: 'Navigation menu' });
const openMenu = async (user) => {
  await user.click(burger());
  return screen.getByRole('dialog');
};
const header = (name) => within(screen.getByRole('dialog')).getByRole('button', { name });
const isOpen = (name) => header(name).getAttribute('aria-expanded') === 'true';
// Expands every collapsed section, so every row is rendered.
const expandAll = async (user) => {
  for (const [name] of SECTIONS) if (!isOpen(name)) await user.click(header(name));
};
const expandedMap = () => Object.fromEntries(SECTIONS.map(([name]) => [name, isOpen(name)]));
const stored = () => JSON.parse(localStorage.getItem(SECTIONS_KEY));
// The list as rendered: link labels, '#Heading' for section headings and '---' for the separator.
const listOrder = (dialog) =>
  [...within(dialog).getByRole('navigation', { name: 'Main' }).querySelectorAll('a, h3, hr')].map((el) => {
    if (el.tagName === 'HR') return '---';
    if (el.tagName === 'H3') return `#${el.textContent.trim()}`;
    return el.textContent.trim();
  });

beforeEach(() => {
  localStorage.clear();
  settings.mode = 'all';
  settings.founder = false;
  settings.name = null;
  settings.navHideSubcategories = false;
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('null', { status: 200 }));
});
afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
  localStorage.clear();
  document.body.style.overflow = '';
});

describe('BurgerMenu founder badge', () => {
  it('shows the Founding member badge in the footer only when the founder perk is active', async () => {
    settings.founder = true;
    const user = setup();
    const dialog = await openMenu(user);
    expect(within(dialog).getByText('Founding member')).toBeInTheDocument();
  });

  it('hides the badge without the founder perk', async () => {
    const user = setup();
    const dialog = await openMenu(user);
    expect(within(dialog).queryByText('Founding member')).not.toBeInTheDocument();
  });
});

describe('BurgerMenu', () => {
  it('renders a collapsed burger with no dialog', () => {
    setup();
    expect(burger()).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('toggles aria-expanded and aria-controls matches the dialog id', async () => {
    const user = setup();
    expect(burger()).not.toHaveAttribute('aria-controls');

    const dialog = await openMenu(user);
    const controls = burger().getAttribute('aria-controls');
    expect(controls).toBeTruthy();
    expect(burger()).toHaveAttribute('aria-expanded', 'true');
    expect(dialog).toHaveAttribute('id', controls);
    expect(dialog).toHaveAttribute('aria-modal', 'true');
  });

  it('has the Burrow heading, then one h3 per section: no avatar tile and no subtitle', async () => {
    settings.name = 'Sam';
    const user = setup('/');
    const dialog = await openMenu(user);
    const h2 = within(dialog).getByRole('heading', { level: 2 });
    expect(h2).toHaveTextContent(/^Burrow$/);
    expect(dialog).toHaveAccessibleName('Burrow');
    expect(within(dialog).queryByText(/workspace/i)).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/Sam/)).not.toBeInTheDocument();
    expect(within(dialog).getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual([
      'Financials',
      'Health',
      'Productivity',
    ]);
  });

  it('lists Home, Calendar, then the three sections (no Settings, no switch)', async () => {
    const user = setup('/');
    const dialog = await openMenu(user);
    await expandAll(user);
    const nav = within(dialog).getByRole('navigation', { name: 'Main' });
    expect(listOrder(dialog)).toEqual(MENU);
    expect(within(nav).queryAllByRole('separator')).toHaveLength(0);
    // The only buttons are the three section headers (no Budget / Journal switch).
    expect(within(dialog).getAllByRole('button').map((b) => b.textContent)).toEqual(['Financials', 'Health', 'Productivity']);
    expect(within(dialog).queryByRole('group', { name: 'Workspace' })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('link', { name: 'Settings' })).not.toBeInTheDocument();
    for (const item of NAV_GROUPS.filter((g) => g.drawer !== false).flatMap((g) => g.items)) {
      expect(within(nav).getByRole('link', { name: item.label })).toHaveAttribute('href', item.to);
    }
  });

  it('names each section group by its header button and holds its rows', async () => {
    const user = setup('/');
    const dialog = await openMenu(user);
    await expandAll(user);
    const groups = within(dialog).getAllByRole('group');
    expect(groups).toHaveLength(SECTIONS.length);
    SECTIONS.forEach(([name], i) => expect(groups[i]).toHaveAccessibleName(name));
    for (const [name, links] of SECTIONS) {
      const group = within(dialog).getByRole('group', { name });
      expect(within(group).getAllByRole('link').map((l) => l.textContent.trim())).toEqual(links);
      // The heading holds the disclosure button, which controls the section's list.
      const button = within(group).getByRole('button', { name });
      expect(button.closest('h3')).not.toBeNull();
      const list = document.getElementById(button.getAttribute('aria-controls'));
      expect(list).not.toBeNull();
      expect(within(list).getAllByRole('link')).toHaveLength(links.length);
    }
    // Home and Calendar are outside every section.
    for (const name of ['Home', 'Calendar']) {
      expect(screen.getByRole('link', { name }).closest('[role="group"]')).toBeNull();
    }
  });

  it('reaches any page in three clicks at most: burger, section, then the link', async () => {
    const user = setup('/');
    await openMenu(user);
    await user.click(header('Health'));
    await user.click(screen.getByRole('link', { name: 'Habits' }));
    expect(screen.getByTestId('pathname')).toHaveTextContent('/habits');
  });

  it('opens with focus on the current page link, else on Home', async () => {
    let user = setup('/todos');
    await openMenu(user);
    await waitFor(() => expect(screen.getByRole('link', { name: 'Todos' })).toHaveFocus());
    cleanup();
    user = setup('/settings');
    await openMenu(user);
    await waitFor(() => expect(screen.getByRole('link', { name: 'Home' })).toHaveFocus());
  });

  it('arrow keys walk every visible link and section button across sections', async () => {
    const user = setup('/settings');
    await openMenu(user);
    await waitFor(() => expect(screen.getByRole('link', { name: 'Home' })).toHaveFocus());
    await expandAll(user);
    act(() => screen.getByRole('link', { name: 'Home' }).focus());
    const stops = MENU.filter((x) => x !== '---');
    for (const name of stops.slice(1)) {
      await user.keyboard('{ArrowDown}');
      const el = name.startsWith('#')
        ? header(name.slice(1))
        : within(screen.getByRole('navigation', { name: 'Main' })).getByRole('link', { name });
      expect(el).toHaveFocus();
    }
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('link', { name: 'Home' })).toHaveFocus();
    await user.keyboard('{End}');
    expect(screen.getByRole('link', { name: 'Folders' })).toHaveFocus();
    await user.keyboard('{ArrowUp}');
    expect(screen.getByRole('link', { name: 'Bookmarks' })).toHaveFocus();
    await user.keyboard('{Home}');
    expect(screen.getByRole('link', { name: 'Home' })).toHaveFocus();
  });

  it('marks the active row with aria-current and font-semibold only', async () => {
    const user = setup('/notes');
    await openMenu(user);
    await expandAll(user);
    const active = screen.getByRole('link', { name: 'Notes' });
    expect(active).toHaveAttribute('aria-current', 'page');
    expect(active).toHaveClass('font-semibold');
    const rest = screen.getByRole('link', { name: 'Habits' });
    expect(rest).not.toHaveClass('font-semibold');
    expect(rest).not.toHaveAttribute('aria-current');
  });

  it('marks Home active only on /', async () => {
    let user = setup('/');
    await openMenu(user);
    expect(screen.getByRole('link', { name: 'Home' })).toHaveAttribute('aria-current', 'page');
    cleanup();
    user = setup('/journal');
    await openMenu(user);
    expect(screen.getByRole('link', { name: 'Home' })).not.toHaveAttribute('aria-current');
    expect(screen.getByRole('link', { name: 'Journal' })).toHaveAttribute('aria-current', 'page');
  });

  it('rows and headers use py-2 sm:py-1.5 and sections pt-1, so the fully open menu fits a 640px tall window', async () => {
    const user = setup('/');
    await openMenu(user);
    await expandAll(user);
    expect(screen.getByRole('link', { name: 'Todos' })).toHaveClass('py-2', 'sm:py-1.5');
    expect(header('Productivity')).toHaveClass('py-2', 'sm:py-1.5');
    expect(header('Productivity').closest('[role="group"]')).toHaveClass('pt-1');
  });

  it('makes no workspace request and saves nothing to the server while browsing the menu', async () => {
    const user = setup('/budget');
    await openMenu(user);
    await user.click(screen.getByRole('link', { name: 'Calendar' }));
    expect(screen.getByTestId('pathname')).toHaveTextContent('/calendar');
    await user.click(burger());
    await user.click(header('Health'));
    await user.click(screen.getByRole('link', { name: 'Journal' }));
    const urls = vi.mocked(globalThis.fetch).mock.calls.map(([url]) => String(url));
    expect(urls.filter((u) => u.includes('/api/state/workspace'))).toEqual([]);
    expect(urls.filter((u) => u.includes('/api/state'))).toEqual([]);
  });

  it('the mode (Todos filter) never hides pages', async () => {
    const user = setup('/', 'work');
    const dialog = await openMenu(user);
    await expandAll(user);
    expect(listOrder(dialog)).toEqual(MENU);
    expect(within(dialog).queryByText(/work mode/i)).not.toBeInTheDocument();
  });

  it('shows the privacy footer', async () => {
    const user = setup();
    const dialog = await openMenu(user);
    expect(within(dialog).getByText('Private, on this device')).toBeInTheDocument();
  });

  it('clicking a link navigates and closes the menu', async () => {
    const user = setup('/');
    await openMenu(user);
    await user.click(header('Financials'));
    const target = NAV_GROUPS.find((g) => g.id === 'money').items[0];
    await user.click(screen.getByRole('link', { name: target.label }));

    expect(screen.getByTestId('pathname')).toHaveTextContent(target.to);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(burger()).toHaveAttribute('aria-expanded', 'false');
  });

  it('Escape closes the menu and returns focus to the burger', async () => {
    const user = setup();
    await openMenu(user);
    await user.keyboard('{Escape}');

    expect(burger()).toHaveFocus();
    expect(burger()).toHaveAttribute('aria-expanded', 'false');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('does not trap Tab when focus is outside the panel and burger', async () => {
    const user = setup();
    await openMenu(user);
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    outside.focus();
    const ev = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    outside.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
    expect(outside).toHaveFocus();
    outside.remove();
  });

  it('Escape with defaultPrevented or focus in another dialog does not close', async () => {
    const user = setup();
    await openMenu(user);
    const prevented = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    window.addEventListener('keydown', (e) => e.preventDefault(), { once: true, capture: true });
    window.dispatchEvent(prevented);
    expect(burger()).toHaveAttribute('aria-expanded', 'true');

    const other = document.createElement('div');
    other.setAttribute('role', 'dialog');
    const input = document.createElement('input');
    other.appendChild(input);
    document.body.appendChild(other);
    input.focus();
    await user.keyboard('{Escape}');
    expect(burger()).toHaveAttribute('aria-expanded', 'true');
    other.remove();
  });

  it('closes when the command palette opens', async () => {
    const user = setup();
    await openMenu(user);
    act(() => {
      window.dispatchEvent(new CustomEvent('palette:open'));
    });
    expect(burger()).toHaveAttribute('aria-expanded', 'false');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('moves focus to the burger before the palette opens, on the event and on Ctrl+K', async () => {
    const user = setup();
    await openMenu(user);
    expect(burger()).not.toHaveFocus();
    act(() => {
      window.dispatchEvent(new CustomEvent('palette:open'));
    });
    expect(burger()).toHaveFocus();

    await user.click(burger());
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());
    await waitFor(() => expect(burger()).not.toHaveFocus());
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
    });
    expect(burger()).toHaveFocus();
  });

  it('clicking the overlay closes the menu', async () => {
    const user = setup();
    const dialog = await openMenu(user);
    const overlay = dialog.previousElementSibling;
    expect(overlay).toBeTruthy();
    await user.click(overlay);

    expect(burger()).toHaveAttribute('aria-expanded', 'false');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('clicking the burger again closes the menu', async () => {
    const user = setup();
    await openMenu(user);
    await user.click(burger());
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('marks the active route link with aria-current="page"', async () => {
    const user = setup('/todos');
    await openMenu(user);
    const plan = NAV_GROUPS.find((g) => g.items.some((i) => i.to === '/todos'));

    expect(screen.getByRole('link', { name: 'Todos' })).toHaveAttribute('aria-current', 'page');
    for (const item of plan.items.filter((i) => i.to !== '/todos')) {
      expect(screen.getByRole('link', { name: item.label })).not.toHaveAttribute('aria-current');
    }
  });

  describe('Budget vs Subscriptions highlight', () => {
    const activeLinks = async (route) => {
      const user = setup(route);
      await openMenu(user);
      return ['Budget', 'Subscriptions'].filter(
        (name) => screen.getByRole('link', { name }).getAttribute('aria-current') === 'page',
      );
    };

    it('/budget marks only Budget', async () => {
      expect(await activeLinks('/budget')).toEqual(['Budget']);
    });

    it('/budget/planner keeps Budget active', async () => {
      expect(await activeLinks('/budget/planner')).toEqual(['Budget']);
    });

    it('/budget/subscriptions marks only Subscriptions', async () => {
      expect(await activeLinks('/budget/subscriptions')).toEqual(['Subscriptions']);
    });
  });

  describe('keyboard', () => {
    it('Tab from the burger (the last stop) wraps to Home; Shift+Tab wraps back', async () => {
      const user = setup('/todos');
      await openMenu(user);
      act(() => burger().focus());
      await user.tab();
      expect(screen.getByRole('link', { name: 'Home' })).toHaveFocus();
      await user.tab();
      expect(screen.getByRole('link', { name: 'Calendar' })).toHaveFocus();
      await user.tab({ shift: true });
      expect(screen.getByRole('link', { name: 'Home' })).toHaveFocus();
      await user.tab({ shift: true });
      expect(burger()).toHaveFocus();
    });

    it('ArrowDown from Home moves to Calendar and ArrowUp moves back', async () => {
      const user = setup('/');
      await openMenu(user);
      await waitFor(() => expect(screen.getByRole('link', { name: 'Home' })).toHaveFocus());
      await user.keyboard('{ArrowDown}');
      expect(screen.getByRole('link', { name: 'Calendar' })).toHaveFocus();
      await user.keyboard('{ArrowUp}');
      expect(screen.getByRole('link', { name: 'Home' })).toHaveFocus();
    });
  });
});

describe('BurgerMenu section dropdowns', () => {
  it('opens only the section of the current page by default', async () => {
    const user = setup('/journal');
    await openMenu(user);
    expect(expandedMap()).toEqual({ Financials: false, Productivity: false, Health: true });
    expect(screen.getByRole('link', { name: 'Journal' })).toHaveAttribute('aria-current', 'page');
    // Collapsed rows are not rendered at all.
    expect(screen.queryByRole('link', { name: 'Todos' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Subscriptions' })).not.toBeInTheDocument();
    // Home and Calendar are plain rows, always shown.
    expect(screen.getByRole('link', { name: 'Home' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Calendar' })).toBeInTheDocument();
  });

  it('opens Financials for /budget/subscriptions and nothing on a page outside the sections', async () => {
    let user = setup('/budget/subscriptions');
    await openMenu(user);
    expect(expandedMap()).toEqual({ Financials: true, Productivity: false, Health: false });
    cleanup();
    localStorage.clear();
    user = setup('/');
    await openMenu(user);
    expect(expandedMap()).toEqual({ Financials: false, Productivity: false, Health: false });
    expect(screen.getAllByRole('link').map((l) => l.textContent)).toEqual(['Home', 'Calendar']);
  });

  it('wires every header with aria-expanded and aria-controls to its list inside the named group', async () => {
    const user = setup('/todos');
    const dialog = await openMenu(user);
    for (const [name, links] of SECTIONS) {
      const button = header(name);
      expect(button).toHaveAttribute('aria-expanded', name === 'Productivity' ? 'true' : 'false');
      const list = document.getElementById(button.getAttribute('aria-controls'));
      expect(list).not.toBeNull();
      expect(within(list).queryAllByRole('link')).toHaveLength(isOpen(name) ? links.length : 0);
      expect(within(dialog).getByRole('group', { name })).toContainElement(list);
    }
  });

  it('toggles a section with a click and rotates the chevron', async () => {
    const user = setup('/');
    await openMenu(user);
    const chevron = () => header('Productivity').querySelector('.lucide-chevron-down');
    expect(chevron()).not.toHaveClass('rotate-180');
    await user.click(header('Productivity'));
    expect(isOpen('Productivity')).toBe(true);
    expect(chevron()).toHaveClass('rotate-180');
    expect(screen.getByRole('link', { name: 'Folders' })).toBeInTheDocument();
    await user.click(header('Productivity'));
    expect(isOpen('Productivity')).toBe(false);
    expect(screen.queryByRole('link', { name: 'Folders' })).not.toBeInTheDocument();
  });

  it('toggles with Enter and Space on the focused header', async () => {
    const user = setup('/');
    await openMenu(user);
    act(() => header('Financials').focus());
    await user.keyboard('{Enter}');
    expect(isOpen('Financials')).toBe(true);
    await user.keyboard(' ');
    expect(isOpen('Financials')).toBe(false);
    expect(header('Financials')).toHaveFocus();
  });

  it('remembers each toggle on this device under burrow.nav:sections', async () => {
    let user = setup('/');
    await openMenu(user);
    await user.click(header('Health'));
    await user.click(header('Financials'));
    expect(stored()).toEqual({ wellbeing: true, money: true });
    await user.click(header('Financials'));
    expect(stored()).toEqual({ wellbeing: true, money: false });
    cleanup();
    user = setup('/');
    await openMenu(user);
    expect(expandedMap()).toEqual({ Financials: false, Productivity: false, Health: true });
  });

  it('opening on a page whose section was remembered closed opens it and keeps the other choices', async () => {
    localStorage.setItem(SECTIONS_KEY, JSON.stringify({ productivity: false, money: true, wellbeing: false }));
    const user = setup('/notes');
    await openMenu(user);
    expect(expandedMap()).toEqual({ Financials: true, Productivity: true, Health: false });
    expect(stored()).toEqual({ productivity: true, money: true, wellbeing: false });
    await waitFor(() => expect(screen.getByRole('link', { name: 'Notes' })).toHaveFocus());
  });

  it.each([
    ['not JSON', '{nope'],
    ['a number', '5'],
    ['a string', '"open"'],
    ['null', 'null'],
    ['an array', '[true, true, true]'],
    ['non-boolean values', JSON.stringify({ money: 'yes', productivity: 1 })],
  ])('falls back to the defaults when the stored value is %s', async (_label, raw) => {
    localStorage.setItem(SECTIONS_KEY, raw);
    const user = setup('/habits');
    await openMenu(user);
    expect(expandedMap()).toEqual({ Financials: false, Productivity: false, Health: true });
  });

  it('works when storage throws: defaults on open, toggles still work for the session', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const user = setup('/focus');
    await openMenu(user);
    expect(expandedMap()).toEqual({ Financials: false, Productivity: true, Health: false });
    await user.click(header('Financials'));
    expect(isOpen('Financials')).toBe(true);
  });

  it('a route change opens the target section next time, and leaves the other sections as they were', async () => {
    function Go() {
      const navigate = useNavigate();
      return (
        <button type="button" onClick={() => navigate('/countdowns')}>
          go
        </button>
      );
    }
    localStorage.setItem(SECTIONS_KEY, JSON.stringify({ money: true, wellbeing: false }));
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/journal']}>
        <ModeProvider>
          <BurgerMenu />
          <Go />
        </ModeProvider>
      </MemoryRouter>,
    );
    // Navigate while the menu is closed (as the palette or a link on a page would).
    await user.click(screen.getByRole('button', { name: 'go' }));
    await openMenu(user);
    expect(expandedMap()).toEqual({ Financials: true, Productivity: true, Health: false });
    expect(stored()).toEqual({ money: true, wellbeing: false, productivity: true });
    await waitFor(() => expect(screen.getByRole('link', { name: 'Countdowns' })).toHaveFocus());
  });

  it('opening the menu again shows the current page even after its section was collapsed', async () => {
    const user = setup('/todos');
    await openMenu(user);
    await user.click(header('Productivity'));
    expect(isOpen('Productivity')).toBe(false);
    expect(screen.queryByRole('link', { name: 'Todos' })).not.toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await openMenu(user);
    expect(isOpen('Productivity')).toBe(true);
    await waitFor(() => expect(screen.getByRole('link', { name: 'Todos' })).toHaveFocus());
  });

  it('arrow keys skip the rows of collapsed sections', async () => {
    const user = setup('/journal');
    await openMenu(user);
    await waitFor(() => expect(screen.getByRole('link', { name: 'Journal' })).toHaveFocus());
    await user.keyboard('{Home}');
    const order = [];
    for (let i = 0; i < 8; i += 1) {
      order.push(document.activeElement.textContent.trim());
      await user.keyboard('{ArrowDown}');
    }
    expect(order).toEqual([
      'Home',
      'Calendar',
      'Financials',
      'Health',
      'Journal',
      'Habits',
      'Sleep & activity',
      'Productivity',
    ]);
    expect(screen.getByRole('link', { name: 'Home' })).toHaveFocus();
    await user.keyboard('{ArrowUp}');
    expect(header('Productivity')).toHaveFocus();
  });

  it('the Tab trap includes the headers and skips collapsed rows', async () => {
    const user = setup('/');
    await openMenu(user);
    await waitFor(() => expect(screen.getByRole('link', { name: 'Home' })).toHaveFocus());
    await user.tab();
    expect(screen.getByRole('link', { name: 'Calendar' })).toHaveFocus();
    await user.tab();
    expect(header('Financials')).toHaveFocus();
    await user.tab();
    expect(header('Health')).toHaveFocus();
    await user.tab();
    expect(header('Productivity')).toHaveFocus();
  });
});

describe('BurgerMenu with hide subcategories on', () => {
  const FIRST_PAGES = [
    ['Financials', '/budget'],
    ['Health', '/journal'],
    ['Productivity', '/todos'],
  ];

  beforeEach(() => {
    settings.navHideSubcategories = true;
  });

  it('lists section names as links to the first page, with no nested rows or disclosure buttons', async () => {
    const user = setup();
    const dialog = await openMenu(user);
    for (const [name, href] of FIRST_PAGES) {
      expect(within(dialog).getByRole('link', { name })).toHaveAttribute('href', href);
    }
    expect(listOrder(dialog)).toEqual(['Home', 'Calendar', 'Financials', 'Health', 'Productivity']);
    expect(within(dialog).queryByRole('button', { name: /Financials|Health|Productivity/ })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('group')).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('link', { name: 'Budget' })).not.toBeInTheDocument();
  });

  it('marks the section holding the current page and focuses it on open', async () => {
    const user = setup('/habits');
    const dialog = await openMenu(user);
    const health = within(dialog).getByRole('link', { name: 'Health' });
    expect(health).toHaveAttribute('aria-current', 'page');
    expect(within(dialog).getByRole('link', { name: 'Financials' })).not.toHaveAttribute('aria-current');
    expect(health).toHaveFocus();
  });

  it('keeps Financials current on a sibling page and navigates when a section is clicked', async () => {
    const user = setup('/budget/subscriptions');
    const dialog = await openMenu(user);
    expect(within(dialog).getByRole('link', { name: 'Financials' })).toHaveAttribute('aria-current', 'page');
    await user.click(within(dialog).getByRole('link', { name: 'Productivity' }));
    expect(screen.getByTestId('pathname')).toHaveTextContent('/todos');
  });

  it('with the setting off, the section headers are disclosure buttons again', async () => {
    settings.navHideSubcategories = false;
    const user = setup('/habits');
    const dialog = await openMenu(user);
    expect(within(dialog).getByRole('button', { name: 'Health' })).toHaveAttribute('aria-expanded', 'true');
    expect(within(dialog).queryByRole('link', { name: 'Health' })).not.toBeInTheDocument();
  });
});
