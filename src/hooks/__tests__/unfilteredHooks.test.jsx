import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { lsKey } from '../../utils/storageKeys';
import { useTodos } from '../useTodos';
import { useHabits } from '../useHabits';
import { useJournal } from '../useJournal';
import { useNotes } from '../useNotes';
import { useCalendar } from '../useCalendar';
import { useBookmarks } from '../useBookmarks';
import { useCountdowns } from '../useCountdowns';
import { useFocus } from '../useFocus';

// One row per tag. The hooks no longer read the Work/Home mode, so these render
// with no ModeProvider and must return all of them whatever `mode` holds.
const rows = (extra = {}) =>
  ['work', 'home', 'both'].map((context, i) => ({ id: `r${i}`, context, ...extra }));

vi.mock('../../services/todosService', () => ({ todosService: { list: vi.fn(), update: vi.fn() } }));
vi.mock('../../services/habitsService', () => ({ habitsService: { list: vi.fn(), update: vi.fn() } }));
vi.mock('../../services/journalService', () => ({ journalService: { list: vi.fn(), update: vi.fn() } }));
vi.mock('../../services/notesService', () => ({ notesService: { list: vi.fn(), update: vi.fn() } }));
vi.mock('../../services/calendarService', () => ({ calendarService: { list: vi.fn(), update: vi.fn() } }));
vi.mock('../../services/bookmarksService', () => ({ bookmarksService: { list: vi.fn(), update: vi.fn() } }));
vi.mock('../../services/countdownsService', () => ({ countdownsService: { list: vi.fn(), update: vi.fn() } }));
vi.mock('../../services/focusService', () => ({ focusService: { list: vi.fn(), create: vi.fn() } }));

import { todosService } from '../../services/todosService';
import { habitsService } from '../../services/habitsService';
import { journalService } from '../../services/journalService';
import { notesService } from '../../services/notesService';
import { calendarService } from '../../services/calendarService';
import { bookmarksService } from '../../services/bookmarksService';
import { countdownsService } from '../../services/countdownsService';
import { focusService } from '../../services/focusService';

function setup(hook) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return { client, ...renderHook(hook, { wrapper }) };
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.resetAllMocks();
});

const TABLE = [
  ['useTodos', useTodos, 'todos', todosService, ['todos'], (v) => v],
  ['useHabits', useHabits, 'habits', habitsService, ['habits'], (v) => v],
  ['useJournal', useJournal, 'entries', journalService, ['journal'], (v) => v],
  ['useNotes', useNotes, 'notes', notesService, ['notes'], (v) => v],
  ['useCalendar', useCalendar, 'events', calendarService, ['calendar'], (v) => ({ events: v })],
  ['useBookmarks', useBookmarks, 'bookmarks', bookmarksService, ['bookmarks'], (v) => v],
  ['useCountdowns', useCountdowns, 'countdowns', countdownsService, ['countdowns'], (v) => v],
  ['useFocus', useFocus, 'sessions', focusService, ['focus'], (v) => v],
];

describe('hooks return records of every tag', () => {
  it.each(TABLE)('%s ignores the stored mode and needs no ModeProvider', async (_n, hook, key, service, _qk, wrap) => {
    localStorage.setItem(lsKey('mode'), JSON.stringify('work'));
    service.list.mockResolvedValue(wrap(rows({ start: '2026-01-01T00:00:00Z', targetDate: '2026-01-01' })));
    const { result } = setup(hook);
    await waitFor(() => expect(result.current[key]).toHaveLength(3));
    expect(result.current[key].map((r) => r.context).sort()).toEqual(['both', 'home', 'work']);
  });

  it('useFocus().today counts focus sessions of every tag', async () => {
    const startedAt = new Date().toISOString();
    focusService.list.mockResolvedValue(
      rows({ kind: 'focus', startedAt, durationMin: 10 }),
    );
    const { result } = setup(() => useFocus());
    await waitFor(() => expect(result.current.today.count).toBe(3));
    expect(result.current.today.minutes).toBe(30);
  });
});

describe('sorted hooks never reorder the cached array', () => {
  it('useCalendar sorts by start but leaves the cache in server order', async () => {
    const server = [
      { id: 'b', start: '2026-03-02T00:00:00Z', context: 'work' },
      { id: 'a', start: '2026-03-01T00:00:00Z', context: 'home' },
    ];
    calendarService.list.mockResolvedValue({ events: server });
    const { result, client } = setup(() => useCalendar());
    await waitFor(() => expect(result.current.events).toHaveLength(2));
    expect(result.current.events.map((e) => e.id)).toEqual(['a', 'b']);
    expect(client.getQueryData(['calendar']).map((e) => e.id)).toEqual(['b', 'a']);
  });

  it('useCountdowns sorts by target date but leaves the cache in server order', async () => {
    countdownsService.list.mockResolvedValue([
      { id: 'b', targetDate: '2026-03-02', context: 'work' },
      { id: 'a', targetDate: '2026-03-01', context: 'home' },
    ]);
    const { result, client } = setup(() => useCountdowns());
    await waitFor(() => expect(result.current.countdowns).toHaveLength(2));
    expect(result.current.countdowns.map((c) => c.id)).toEqual(['a', 'b']);
    expect(client.getQueryData(['countdowns']).map((c) => c.id)).toEqual(['b', 'a']);
  });
});

describe('editing a tagged record keeps its tag in the cache', () => {
  const EDITABLE = TABLE.filter(([, , , service]) => service !== focusService);

  it.each(EDITABLE)('%s: a patch with no context leaves context home', async (_n, hook, key, service, qk, wrap) => {
    service.list.mockResolvedValue(wrap([{ id: 'x', context: 'home', title: 'Old', start: '2026-01-01T00:00:00Z', targetDate: '2026-01-01' }]));
    service.update.mockImplementation(() => new Promise(() => {})); // stay in the optimistic phase
    const { result, client } = setup(hook);
    await waitFor(() => expect(result.current[key]).toHaveLength(1));
    act(() => {
      result.current.update('x', { title: 'New' });
    });
    await waitFor(() => expect(client.getQueryData(qk)[0].title).toBe('New'));
    expect(client.getQueryData(qk)[0].context).toBe('home');
  });
});
