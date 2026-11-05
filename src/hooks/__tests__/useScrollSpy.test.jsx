import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useScrollSpy } from '../useScrollSpy';

const IDS = ['a', 'b', 'c'];
let observers;
const origIO = globalThis.IntersectionObserver;
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
}

const fire = (entries) =>
  act(() => {
    observers.at(-1).cb(
      entries.map(([id, isIntersecting]) => ({ target: document.getElementById(id), isIntersecting })),
    );
  });

function setBottom(on) {
  Object.defineProperty(document.documentElement, 'scrollHeight', { configurable: true, value: 3000 });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
  Object.defineProperty(window, 'scrollY', { configurable: true, value: on ? 2200 : 0 });
}

beforeEach(() => {
  observers = [];
  globalThis.IntersectionObserver = FakeIO;
  for (const id of IDS) {
    const el = document.createElement('div');
    el.id = id;
    document.body.appendChild(el);
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.body.innerHTML = '';
  globalThis.IntersectionObserver = origIO;
  delete document.documentElement.scrollHeight;
  if (origInnerHeight) Object.defineProperty(window, 'innerHeight', origInnerHeight);
  if (origScrollY) Object.defineProperty(window, 'scrollY', origScrollY);
});

describe('useScrollSpy', () => {
  it('starts on the first id (null for an empty list)', () => {
    expect(renderHook(() => useScrollSpy(IDS)).result.current.activeId).toBe('a');
    expect(renderHook(() => useScrollSpy([])).result.current.activeId).toBeNull();
  });

  it('observes each existing element with the given rootMargin and skips missing ids', () => {
    renderHook(() => useScrollSpy([...IDS, 'missing'], { rootMargin: '-10px 0px -50% 0px' }));
    expect(observers).toHaveLength(1);
    expect(observers[0].options).toEqual({ rootMargin: '-10px 0px -50% 0px' });
    expect(observers[0].targets.map((e) => e.id)).toEqual(IDS);
  });

  it('activates the first visible id in page order and falls back as sections leave', () => {
    const { result } = renderHook(() => useScrollSpy(IDS));
    fire([['c', true]]);
    expect(result.current.activeId).toBe('c');
    fire([['b', true]]);
    expect(result.current.activeId).toBe('b');
    fire([['b', false]]);
    expect(result.current.activeId).toBe('c');
  });

  it('keeps the current id when nothing is visible', () => {
    const { result } = renderHook(() => useScrollSpy(IDS));
    fire([['b', true]]);
    fire([['b', false]]);
    expect(result.current.activeId).toBe('b');
  });

  it('forces the last id at the bottom of the page via observer and via scroll', () => {
    const { result } = renderHook(() => useScrollSpy(IDS));
    setBottom(true);
    fire([['a', true]]);
    expect(result.current.activeId).toBe('c');

    const second = renderHook(() => useScrollSpy(IDS));
    setBottom(false);
    act(() => {
      window.dispatchEvent(new Event('scroll'));
    });
    expect(second.result.current.activeId).toBe('a');
    setBottom(true);
    act(() => {
      window.dispatchEvent(new Event('scroll'));
    });
    expect(second.result.current.activeId).toBe('c');
  });

  it('is not "at the bottom" when the page does not scroll', () => {
    const { result } = renderHook(() => useScrollSpy(IDS));
    Object.defineProperty(document.documentElement, 'scrollHeight', { configurable: true, value: 800 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 0 });
    fire([['a', true]]);
    expect(result.current.activeId).toBe('a');
  });

  it('setActiveId applies immediately and locks observer updates until scrollend, then keeps the clicked id', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useScrollSpy(IDS));
    act(() => result.current.setActiveId('c'));
    expect(result.current.activeId).toBe('c');

    fire([['a', true]]);
    fire([['b', true]]);
    expect(result.current.activeId).toBe('c');

    act(() => {
      window.dispatchEvent(new Event('scrollend'));
    });
    expect(result.current.activeId).toBe('c');

    // Unlocked: observer updates apply again.
    fire([['a', false]]);
    expect(result.current.activeId).toBe('b');
  });

  it('releases after a 100ms quiet period and then follows the observer', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useScrollSpy(IDS));
    act(() => result.current.setActiveId('c'));
    fire([['b', true]]); // would change the id if unlocked
    act(() => {
      vi.advanceTimersByTime(60);
      window.dispatchEvent(new Event('scroll'));
      vi.advanceTimersByTime(60);
    });
    // Scroll event re-armed the quiet timer, so 120ms in it is still locked.
    expect(result.current.activeId).toBe('c');
    fire([['a', true]]);
    expect(result.current.activeId).toBe('c');
    act(() => {
      vi.advanceTimersByTime(40);
    });
    expect(result.current.activeId).toBe('c'); // clicked id kept on release
    fire([['a', false]]); // unlocked: topmost visible is now b
    expect(result.current.activeId).toBe('b');
  });

  it('falls back to a 1000ms release when scroll events never go quiet', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useScrollSpy(IDS));
    act(() => result.current.setActiveId('c'));
    fire([['a', true]]);
    for (let t = 0; t < 900; t += 50) {
      act(() => {
        window.dispatchEvent(new Event('scroll'));
        vi.advanceTimersByTime(50);
      });
    }
    expect(result.current.activeId).toBe('c'); // still locked at 900ms
    fire([['b', true]]);
    expect(result.current.activeId).toBe('c');
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(result.current.activeId).toBe('c');
    fire([['b', false]]); // unlocked: a is still visible
    expect(result.current.activeId).toBe('a');
  });

  it('scrollend with no pending target recomputes from the observer', () => {
    const { result } = renderHook(() => useScrollSpy(IDS));
    fire([['b', true]]);
    expect(result.current.activeId).toBe('b');
    act(() => {
      window.dispatchEvent(new Event('scrollend'));
    });
    expect(result.current.activeId).toBe('b');
    // Nothing visible and not at bottom: stays; with c visible the recompute picks it up.
    fire([['b', false], ['c', true]]);
    act(() => {
      window.dispatchEvent(new Event('scrollend'));
    });
    expect(result.current.activeId).toBe('c');
  });

  it('the pending target is cleared after release: a later scrollend does not re-apply it', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useScrollSpy(IDS));
    act(() => result.current.setActiveId('c'));
    act(() => {
      window.dispatchEvent(new Event('scrollend'));
    });
    expect(result.current.activeId).toBe('c');
    // Unlocked: observer moves the id away from the old target.
    fire([['a', true]]);
    expect(result.current.activeId).toBe('a');
    act(() => {
      window.dispatchEvent(new Event('scrollend'));
    });
    expect(result.current.activeId).toBe('a');
    act(() => {
      vi.advanceTimersByTime(1500); // stale timers must not resurrect 'c'
    });
    expect(result.current.activeId).toBe('a');
  });

  it('release keeps the clicked id at the bottom; later scrolling picks the last id', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useScrollSpy(IDS));
    act(() => result.current.setActiveId('a'));
    setBottom(true);
    act(() => {
      window.dispatchEvent(new Event('scrollend'));
    });
    expect(result.current.activeId).toBe('a');
    act(() => {
      window.dispatchEvent(new Event('scroll'));
    });
    expect(result.current.activeId).toBe('c');
  });

  it('cleanup clears timers and the scrollend listener', () => {
    vi.useFakeTimers();
    const remove = vi.spyOn(window, 'removeEventListener');
    const { result, unmount } = renderHook(() => useScrollSpy(IDS));
    act(() => result.current.setActiveId('c'));
    unmount();
    expect(remove).toHaveBeenCalledWith('scrollend', expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('initialId seeds the active id only when it is one of the ids', () => {
    expect(renderHook(() => useScrollSpy(IDS, { initialId: 'b' })).result.current.activeId).toBe('b');
    expect(renderHook(() => useScrollSpy(IDS, { initialId: 'nope' })).result.current.activeId).toBe('a');
    expect(renderHook(() => useScrollSpy(IDS, { initialId: '' })).result.current.activeId).toBe('a');
  });

  it('the lock also blocks the bottom-of-page scroll listener', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useScrollSpy(IDS));
    act(() => result.current.setActiveId('a'));
    setBottom(true);
    act(() => {
      window.dispatchEvent(new Event('scroll'));
    });
    expect(result.current.activeId).toBe('a');
  });

  it('does nothing while disabled, and starts observing once enabled', () => {
    const { result, rerender } = renderHook(({ enabled }) => useScrollSpy(IDS, { enabled }), {
      initialProps: { enabled: false },
    });
    expect(observers).toHaveLength(0);
    const add = vi.spyOn(window, 'addEventListener');
    rerender({ enabled: true });
    expect(observers).toHaveLength(1);
    expect(add).toHaveBeenCalledWith('scroll', expect.any(Function), { passive: true });
    fire([['b', true]]);
    expect(result.current.activeId).toBe('b');
  });

  it('cleanup disconnects the observer and removes the scroll listener', () => {
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    const { unmount } = renderHook(() => useScrollSpy(IDS));
    const handler = add.mock.calls.find(([t]) => t === 'scroll')[1];
    unmount();
    expect(observers[0].disconnect).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith('scroll', handler);
  });

  it('disabling disconnects too', () => {
    const { rerender } = renderHook(({ enabled }) => useScrollSpy(IDS, { enabled }), {
      initialProps: { enabled: true },
    });
    rerender({ enabled: false });
    expect(observers[0].disconnect).toHaveBeenCalledTimes(1);
  });

  it('does not re-subscribe when an equal ids array is passed again', () => {
    const { rerender } = renderHook(({ ids }) => useScrollSpy(ids), { initialProps: { ids: [...IDS] } });
    rerender({ ids: [...IDS] });
    expect(observers).toHaveLength(1);
  });

  it('works without IntersectionObserver (scroll listener only, no crash)', () => {
    delete globalThis.IntersectionObserver;
    const { result, unmount } = renderHook(() => useScrollSpy(IDS));
    setBottom(true);
    act(() => {
      window.dispatchEvent(new Event('scroll'));
    });
    expect(result.current.activeId).toBe('c');
    expect(() => unmount()).not.toThrow();
  });
});
