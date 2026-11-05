import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useHomeLayout } from '../useHomeLayout';

const h = vi.hoisted(() => ({ raw: null, fetched: true, writes: [], keys: [], writtenKeys: [] }));

vi.mock('../useSyncedSetting', async () => {
  const React = await import('react');
  return {
    useSyncedSetting: (key) => {
      h.keys.push(key);
      const [value, setValue] = React.useState(h.raw);
      const set = React.useCallback((next) => {
        h.writes.push(next);
        h.writtenKeys.push(key);
        setValue((prev) => (typeof next === 'function' ? next(prev) : next));
      }, [key]);
      return [value, set, { isFetched: h.fetched }];
    },
  };
});

const ALL = ['budget', 'weather', 'health', 'todos', 'habits', 'journal', 'notes', 'bookmarks', 'focus', 'countdowns', 'calendar'];
const BUDGET = ['budget', 'weather', 'bookmarks', 'countdowns', 'calendar'];

beforeEach(() => {
  h.raw = null;
  h.fetched = true;
  h.writes = [];
  h.keys = [];
  h.writtenKeys = [];
});

describe('useHomeLayout', () => {
  it('writes nothing before the saved layout has been fetched, so it cannot replace it', () => {
    h.fetched = false;
    const { result } = renderHook(() => useHomeLayout(ALL, ['weather']));
    expect(result.current.ready).toBe(false);
    act(() => {
      result.current.toggleHidden('todos');
      result.current.cycleWidth('todos');
      result.current.reorder(['calendar', 'budget']);
      result.current.reset();
    });
    expect(h.writes).toEqual([]);
  });

  it('keeps the slots of cards not shown when the shown cards are reordered', () => {
    const { result } = renderHook(() => useHomeLayout(ALL));
    expect(result.current.order).toEqual(ALL);
    act(() => result.current.reorder(['calendar', 'budget', 'weather', 'bookmarks', 'countdowns']));
    const order = result.current.order;
    expect([order[2], order[3], order[4], order[5], order[6], order[8]]).toEqual(['health', 'todos', 'habits', 'journal', 'notes', 'focus']);
    expect([order[0], order[1], order[7], order[9], order[10]]).toEqual(['calendar', 'budget', 'weather', 'bookmarks', 'countdowns']);
    expect(result.current.orderKeys(BUDGET)).toEqual(['calendar', 'budget', 'weather', 'bookmarks', 'countdowns']);
  });

  it('keeps the slot of a hidden card after a drag of the shown cards', () => {
    h.raw = { order: ALL, cards: { weather: { hidden: true } } };
    const { result } = renderHook(() => useHomeLayout(ALL));
    const shown = result.current.orderKeys(BUDGET).filter((k) => !result.current.cardFor(k).hidden);
    expect(shown).toEqual(['budget', 'bookmarks', 'countdowns', 'calendar']);
    act(() => result.current.reorder(['calendar', 'budget', 'bookmarks', 'countdowns']));
    expect(result.current.order[1]).toBe('weather');
    expect(result.current.order[0]).toBe('calendar');
    expect(result.current.order).toHaveLength(ALL.length);
    expect(new Set(result.current.order)).toEqual(new Set(ALL));
  });

  it('appends budget at the end of a saved layout that predates it', () => {
    h.raw = { order: ALL.filter((k) => k !== 'budget'), cards: {} };
    const { result } = renderHook(() => useHomeLayout(ALL));
    expect(result.current.order.at(-1)).toBe('budget');
  });

  it('two quick activations compound instead of reading the same render', () => {
    const { result } = renderHook(() => useHomeLayout(ALL));
    act(() => {
      result.current.cycleWidth('todos');
      result.current.cycleWidth('todos');
    });
    expect(result.current.cardFor('todos').w).toBe(3);
    act(() => {
      result.current.toggleHeight('todos');
      result.current.toggleHeight('todos');
      result.current.toggleHidden('todos');
      result.current.toggleHidden('todos');
    });
    expect(result.current.cardFor('todos').h).toBe(1);
    expect(result.current.cardFor('todos').hidden).toBe(false);
    act(() => {
      result.current.toggleHidden('todos');
    });
    expect(result.current.cardFor('todos').hidden).toBe(true);
    expect(result.current.cardFor('todos').w).toBe(3);
  });

  it('reset writes the default order and clears the cards', () => {
    h.raw = { order: [...ALL].reverse(), cards: { todos: { hidden: true } } };
    const { result } = renderHook(() => useHomeLayout(ALL));
    act(() => result.current.reset());
    expect(result.current.order).toEqual(ALL);
    expect(result.current.cardFor('todos').hidden).toBe(false);
  });

  describe('default-hidden cards', () => {
    const HIDDEN = ['notes', 'bookmarks', 'focus'];

    it('hides them in memory while no layout is stored, and writes nothing on mount', () => {
      const { result } = renderHook(() => useHomeLayout(ALL, HIDDEN));
      expect(result.current.order).toEqual(ALL);
      for (const k of HIDDEN) expect(result.current.cardFor(k).hidden).toBe(true);
      expect(result.current.cardFor('todos').hidden).toBe(false);
      expect(h.writes).toEqual([]);
    });

    it('a stored layout is used as is: a card with no entry stays shown', () => {
      h.raw = { order: ALL, cards: { todos: { hidden: true } } };
      const { result } = renderHook(() => useHomeLayout(ALL, HIDDEN));
      for (const k of HIDDEN) expect(result.current.cardFor(k).hidden).toBe(false);
      expect(result.current.cardFor('todos').hidden).toBe(true);
      expect(h.writes).toEqual([]);
    });

    it('the first change persists the seeded flags with it', () => {
      const { result } = renderHook(() => useHomeLayout(ALL, HIDDEN));
      act(() => result.current.toggleHidden('notes'));
      expect(h.writes).toHaveLength(1);
      expect(result.current.cardFor('notes').hidden).toBe(false);
      expect(result.current.cardFor('bookmarks').hidden).toBe(true);
      expect(result.current.cardFor('focus').hidden).toBe(true);
    });

    it('the first reorder also persists the seeded flags', () => {
      const { result } = renderHook(() => useHomeLayout(ALL, HIDDEN));
      act(() => result.current.reorder(['calendar', 'budget']));
      for (const k of HIDDEN) expect(result.current.cardFor(k).hidden).toBe(true);
    });

    it('reset restores the default order and the default-hidden cards', () => {
      h.raw = { order: [...ALL].reverse(), cards: { todos: { hidden: true }, notes: { hidden: false, w: 2 } } };
      const { result } = renderHook(() => useHomeLayout(ALL, HIDDEN));
      act(() => result.current.reset());
      expect(result.current.order).toEqual(ALL);
      expect(result.current.cardFor('todos').hidden).toBe(false);
      expect(result.current.cardFor('notes')).toEqual({ w: 1, h: 1, hidden: true });
      for (const k of HIDDEN) expect(result.current.cardFor(k).hidden).toBe(true);
    });
  });

  describe('first keys and card defaults (the Javi card)', () => {
    const KEYS = ['javi', 'budget', 'todos', 'calendar'];
    const OPTIONS = { firstKeys: ['javi'], cardDefaults: { javi: { w: 2 } } };

    it('puts a first key missing from a saved layout at the top, appends other new keys and drops removed ones', () => {
      h.raw = { order: ['calendar', 'weather', 'budget'], cards: { weather: { hidden: true } } };
      const { result } = renderHook(() => useHomeLayout(KEYS, [], OPTIONS));
      expect(result.current.order).toEqual(['javi', 'calendar', 'budget', 'todos']);
      expect(h.writes).toEqual([]);
    });

    it('keeps a first key where the saved layout put it, also after a reorder is saved', () => {
      h.raw = { order: ['calendar', 'weather', 'budget', 'todos'], cards: {} };
      const { result } = renderHook(() => useHomeLayout(KEYS, [], OPTIONS));
      act(() => result.current.reorder(['calendar', 'javi', 'budget', 'todos']));
      expect(result.current.order).toEqual(['calendar', 'javi', 'budget', 'todos']);
    });

    it('applies card defaults under a saved entry, and a width change starts from the default', () => {
      const { result } = renderHook(() => useHomeLayout(KEYS, [], OPTIONS));
      expect(result.current.cardFor('javi')).toEqual({ w: 2, h: 1, hidden: false });
      expect(result.current.cardFor('budget').w).toBe(1);
      act(() => result.current.cycleWidth('javi'));
      expect(result.current.cardFor('javi').w).toBe(3);
    });
  });

  describe('storageKey option', () => {
    const KEYS = ['budgetVsActual', 'incomeVsExpenses', 'categoryPies'];

    it('reads and writes pos:homeLayout when no options are given', () => {
      const { result } = renderHook(() => useHomeLayout(ALL));
      expect(new Set(h.keys)).toEqual(new Set(['pos:homeLayout']));
      act(() => result.current.reorder(['calendar', 'budget']));
      act(() => result.current.reset());
      expect(h.writtenKeys).toEqual(['pos:homeLayout', 'pos:homeLayout']);
    });

    it('keeps pos:homeLayout when options omit storageKey', () => {
      const { result } = renderHook(() => useHomeLayout(ALL, [], { firstKeys: ['javi'] }));
      act(() => result.current.toggleHidden('todos'));
      expect(new Set(h.keys)).toEqual(new Set(['pos:homeLayout']));
      expect(h.writtenKeys).toEqual(['pos:homeLayout']);
    });

    it('reads and writes only the given storageKey, never pos:homeLayout', () => {
      const opts = { storageKey: 'pos:budgetLayout' };
      const { result } = renderHook(() => useHomeLayout(KEYS, undefined, opts));
      expect(new Set(h.keys)).toEqual(new Set(['pos:budgetLayout']));
      act(() => result.current.reorder(['categoryPies', 'incomeVsExpenses', 'budgetVsActual']));
      expect(result.current.order).toEqual(['categoryPies', 'incomeVsExpenses', 'budgetVsActual']);
      act(() => result.current.reset());
      expect(result.current.order).toEqual(KEYS);
      expect(h.writes.at(-1)).toEqual({ order: KEYS, cards: {} });
      act(() => result.current.toggleHidden('categoryPies'));
      expect(h.writtenKeys).toHaveLength(3);
      expect(new Set(h.writtenKeys)).toEqual(new Set(['pos:budgetLayout']));
      expect(h.keys).not.toContain('pos:homeLayout');
    });

    it('still blocks writes to a custom key before the layout is fetched', () => {
      h.fetched = false;
      const { result } = renderHook(() => useHomeLayout(KEYS, undefined, { storageKey: 'pos:budgetLayout' }));
      expect(result.current.ready).toBe(false);
      act(() => {
        result.current.reorder(['categoryPies']);
        result.current.reset();
      });
      expect(h.writes).toEqual([]);
    });
  });
});
