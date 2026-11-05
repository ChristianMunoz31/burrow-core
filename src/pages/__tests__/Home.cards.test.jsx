import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import Home from '../Home';

const h = vi.hoisted(() => ({
  stored: null,
  fetched: true,
  writes: [],
  context: null,
  briefing: null,
  weather: null,
  stub: (name) => ({
    default: ({ dimmed }) => (
      <div data-testid={`widget-${name}`} data-dimmed={dimmed ? 'yes' : undefined}>
        {name}
      </div>
    ),
  }),
}));

// A stored work mode must not change anything on Home any more.
vi.mock('../../contexts/ModeContext', async (orig) => ({
  ...(await orig()),
  useMode: () => ({ mode: 'work', setMode: () => {} }),
}));
// Stateful per render tree, so a Customize change (hide a card) shows up in the same test. `h.stored` is the
// saved Home layout; every write is recorded so a test can check nothing is written on mount.
vi.mock('../../hooks/useSyncedSetting', async () => {
  const { useCallback, useState } = await import('react');
  return {
    useSyncedSetting: (key, fallback) => {
      const [value, setValue] = useState(key === 'pos:homeLayout' ? h.stored : fallback);
      const set = useCallback(
        (next) => {
          h.writes.push(key);
          setValue(next);
        },
        [key],
      );
      return [value, set, { isFetched: h.fetched }];
    },
  };
});
vi.mock('../../hooks/useBriefing', async (orig) => ({ ...(await orig()), useBriefing: () => ({ briefing: h.briefing, alerts: [] }) }));
vi.mock('../../hooks/useWeather', () => ({ useCachedWeatherReader: () => () => h.weather }));
vi.mock('../../hooks/useEntitlements', async () => (await import('../../test-utils/entitlements.js')).entitlementsModule());
vi.mock('../../contexts/PageContextContext', () => ({
  usePageContext: (_page, build) => {
    h.context = build();
  },
}));

vi.mock('../../components/budget/BudgetWidget', () => h.stub('budget'));
vi.mock('../../components/budget/SubscriptionsWidget', () => h.stub('subscriptions'));
vi.mock('../../components/home/JaviHomeCard', () => h.stub('javi'));
vi.mock('../../components/health/HealthWidget', () => h.stub('health'));
vi.mock('../../components/todos/TodosWidget', () => h.stub('todos'));
vi.mock('../../components/calendar/CalendarWidget', () => h.stub('calendar'));
vi.mock('../../components/habits/HabitsWidget', () => h.stub('habits'));
vi.mock('../../components/journal/JournalWidget', () => h.stub('journal'));
vi.mock('../../components/notes/NotesWidget', () => h.stub('notes'));
vi.mock('../../components/bookmarks/BookmarksWidget', () => h.stub('bookmarks'));
vi.mock('../../components/focus/FocusWidget', () => h.stub('focus'));
vi.mock('../../components/countdowns/CountdownsWidget', () => h.stub('countdowns'));
vi.mock('../../components/home/BackupHealthNotice', () => ({ default: () => <div>backup notice</div> }));
vi.mock('../../components/settings/DataFolderWarning', () => ({ default: () => null }));
vi.mock('../../components/home/DirectImportNotice', () => ({ default: () => null }));
vi.mock('../../components/home/CrossInsightsCard', () => ({ default: () => <div>patterns</div> }));

// A Home never customized: the Javi card, then the six default data cards, in this order.
const DATA_DEFAULTS = ['budget', 'subscriptions', 'todos', 'journal', 'habits', 'calendar'];
const DEFAULTS = ['javi', ...DATA_DEFAULTS];
const ALL = [...DEFAULTS, 'notes', 'focus', 'countdowns', 'bookmarks', 'health'];

const shownWidgets = () =>
  screen.queryAllByTestId(/^widget-/).map((el) => el.getAttribute('data-testid').replace('widget-', ''));

beforeEach(() => {
  h.stored = null;
  h.fetched = true;
  h.writes = [];
  h.context = null;
  h.weather = null;
});
afterEach(cleanup);

describe('Home cards', () => {
  it('keeps Customize disabled until the saved layout has been fetched', async () => {
    h.fetched = false;
    const { rerender } = render(<Home />);
    expect(screen.getByRole('button', { name: /customize/i })).toBeDisabled();
    h.fetched = true;
    rerender(<Home />);
    const button = screen.getByRole('button', { name: /customize/i });
    expect(button).toBeEnabled();
    await userEvent.click(button);
    expect(screen.getByRole('button', { name: /done/i })).toBeInTheDocument();
    expect(h.writes).toEqual([]);
  });

  it('with no stored layout shows the Javi card first, then the six defaults in order, and tells Javi the data cards', () => {
    render(<Home />);
    expect(shownWidgets()).toEqual(DEFAULTS);
    expect(h.context.widgets).toEqual(DATA_DEFAULTS);
  });

  it('puts the Javi card at the top of a layout saved before it existed and drops an old Weather card', () => {
    h.stored = { order: ['calendar', 'weather', 'budget', 'todos'], cards: { weather: { w: 2 } } };
    render(<Home />);
    const shown = shownWidgets();
    expect(shown.slice(0, 4)).toEqual(['javi', 'calendar', 'budget', 'todos']);
    expect(shown).not.toContain('weather');
    expect(h.writes).toEqual([]);
  });

  it('keeps the Javi card where a saved layout put it', () => {
    h.stored = { order: ['budget', 'javi', 'todos'], cards: {} };
    render(<Home />);
    expect(shownWidgets().slice(0, 3)).toEqual(['budget', 'javi', 'todos']);
  });

  it('adds the loaded forecast to the Home context and nothing about weather while it is off', () => {
    render(<Home />);
    expect(h.context.weather).toBeUndefined();
    cleanup();
    h.weather = {
      locationSource: 'device',
      data: { latitude: 1.23, longitude: 4.56, current: { temperature_2m: 70.4, weather_code: 0, wind_speed_10m: 5 }, daily: { time: ['2026-10-10'], temperature_2m_max: [72], temperature_2m_min: [55], weather_code: [3] } },
    };
    render(<Home />);
    expect(h.context.weather.current).toMatchObject({ tempF: 70.4, condition: 'Clear' });
    expect(h.context.weather.days[0]).toMatchObject({ highF: 72, lowF: 55, condition: 'Overcast' });
    expect(JSON.stringify(h.context)).not.toContain('1.23');
  });

  it('writes no layout on mount', () => {
    render(<Home />);
    expect(h.writes).not.toContain('pos:homeLayout');
  });

  it('Customize shows all twelve cards (no Weather card)', async () => {
    render(<Home />);
    await userEvent.setup().click(screen.getByRole('button', { name: /Customize/ }));
    expect(shownWidgets()).toEqual(ALL);
  });

  it('a stored layout keeps its order and flags, and a card with no entry shows', () => {
    h.stored = { order: [...ALL].reverse(), cards: { todos: { hidden: true } } };
    render(<Home />);
    expect(shownWidgets()).toEqual([...ALL].reverse().filter((k) => k !== 'todos'));
  });

  it('tells a hidden card shown dimmed in Customize that it is dimmed (the Javi card then marks nothing read)', async () => {
    h.stored = { order: DEFAULTS, cards: { javi: { hidden: true } } };
    render(<Home />);
    expect(screen.queryByTestId('widget-javi')).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: /Customize/ }));
    expect(screen.getByTestId('widget-javi')).toHaveAttribute('data-dimmed', 'yes');
    expect(screen.getByTestId('widget-todos')).not.toHaveAttribute('data-dimmed');
  });

  it('sends the default mode to Javi even with work stored', () => {
    render(<Home />);
    expect(h.context.mode).toBe('all');
  });

  it('can hide the Subscriptions card in Customize, and then Javi is not told about it', async () => {
    const user = userEvent.setup();
    render(<Home />);
    await user.click(screen.getByRole('button', { name: /Customize/ }));
    const tile = screen.getByTestId('widget-subscriptions').closest('.relative');
    await user.click(within(tile).getByRole('button', { name: /hide/i }));
    await user.click(screen.getByRole('button', { name: /Done/ }));
    const expected = DEFAULTS.filter((k) => k !== 'subscriptions');
    expect(shownWidgets()).toEqual(expected);
    expect(h.context.widgets).toEqual(expected.filter((k) => k !== 'javi'));
  });

  it('Reset restores the defaults', async () => {
    h.stored = { order: [...ALL].reverse(), cards: {} };
    const user = userEvent.setup();
    render(<Home />);
    expect(shownWidgets()).toEqual([...ALL].reverse());
    await user.click(screen.getByRole('button', { name: /Customize/ }));
    await user.click(screen.getByRole('button', { name: /Reset/ }));
    await user.click(screen.getByRole('button', { name: /Done/ }));
    expect(shownWidgets()).toEqual(DEFAULTS);
  });

  it('says "Everything important at a glance." with no workspace and never mentions tags', () => {
    render(<Home />);
    expect(screen.getByText('Everything important at a glance.')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/workspace|Showing your|dashboard|work mode/i);
  });

  it('shows the grid at once, with no skeleton, and keeps the notices', () => {
    const { container } = render(<Home />);
    expect(container.querySelectorAll('.animate-pulse')).toHaveLength(0);
    expect(container.querySelector('[aria-busy="true"]')).toBeNull();
    expect(screen.getByText('backup notice')).toBeInTheDocument();
    expect(screen.getByText('patterns')).toBeInTheDocument();
  });
});
