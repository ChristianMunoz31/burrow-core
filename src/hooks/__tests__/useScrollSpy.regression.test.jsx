import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useScrollSpy } from '../useScrollSpy';

const IDS = ['a', 'b', 'c'];
const origIO = globalThis.IntersectionObserver;
const origInnerHeight = Object.getOwnPropertyDescriptor(window, 'innerHeight');
const origScrollY = Object.getOwnPropertyDescriptor(window, 'scrollY');

class FakeIO {
  constructor(cb, options) {
    this.cb = cb;
    this.options = options;
  }
  observe() {}
  disconnect() {}
}

function setBottom(on) {
  Object.defineProperty(document.documentElement, 'scrollHeight', { configurable: true, value: 3000 });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
  Object.defineProperty(window, 'scrollY', { configurable: true, value: on ? 2200 : 0 });
}

beforeEach(() => {
  globalThis.IntersectionObserver = FakeIO;
  for (const id of IDS) {
    const el = document.createElement('div');
    el.id = id;
    document.body.appendChild(el);
  }
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
  globalThis.IntersectionObserver = origIO;
  delete document.documentElement.scrollHeight;
  if (origInnerHeight) Object.defineProperty(window, 'innerHeight', origInnerHeight);
  if (origScrollY) Object.defineProperty(window, 'scrollY', origScrollY);
});

describe('B. bottom-of-page does not override an explicit selection on release', () => {
  it('keeps the clicked second-to-last id after the 100ms quiet release', () => {
    vi.useFakeTimers();
    setBottom(true);
    const { result } = renderHook(() => useScrollSpy(IDS));
    act(() => result.current.setActiveId('b'));
    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(result.current.activeId).toBe('b');
  });

  it('keeps the clicked id after scrollend release', () => {
    vi.useFakeTimers();
    setBottom(true);
    const { result } = renderHook(() => useScrollSpy(IDS));
    act(() => result.current.setActiveId('b'));
    act(() => {
      window.dispatchEvent(new Event('scrollend'));
    });
    expect(result.current.activeId).toBe('b');
  });

  it('keeps the clicked id after the 1000ms fallback release', () => {
    vi.useFakeTimers();
    setBottom(true);
    const { result } = renderHook(() => useScrollSpy(IDS));
    act(() => result.current.setActiveId('b'));
    act(() => {
      vi.advanceTimersByTime(1200);
    });
    expect(result.current.activeId).toBe('b');
  });
});

describe('lock lifecycle (stale target, user intent, observer rebuild)', () => {
  let instances;
  class RecordingIO {
    constructor(cb, options) {
      this.cb = cb;
      this.options = options;
      instances.push(this);
    }
    observe() {}
    disconnect() {}
  }
  const emit = (observer, entries) =>
    act(() => {
      observer.cb(entries.map(([id, isIntersecting]) => ({ target: document.getElementById(id), isIntersecting })));
    });

  beforeEach(() => {
    instances = [];
    globalThis.IntersectionObserver = RecordingIO;
    setBottom(false);
  });

  it('does not re-apply a released target on a later plain scrollend', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useScrollSpy(IDS));
    act(() => result.current.setActiveId('b'));
    act(() => {
      window.dispatchEvent(new Event('scrollend'));
    });
    expect(result.current.activeId).toBe('b');
    emit(instances.at(-1), [['c', true]]);
    expect(result.current.activeId).toBe('c');
    act(() => {
      window.dispatchEvent(new Event('scrollend'));
    });
    expect(result.current.activeId).toBe('c');
  });

  it('clears the target on unmount so no stale timer applies it', () => {
    vi.useFakeTimers();
    const { result, unmount } = renderHook(() => useScrollSpy(IDS));
    act(() => result.current.setActiveId('b'));
    unmount();
    expect(() => vi.advanceTimersByTime(1500)).not.toThrow();
  });

  it('recomputes from the observer when the user wheels during the lock', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useScrollSpy(IDS));
    emit(instances.at(-1), [['c', true]]);
    act(() => result.current.setActiveId('b'));
    act(() => {
      window.dispatchEvent(new Event('wheel'));
    });
    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(result.current.activeId).toBe('c');
  });

  it('recomputes on touchstart and on scroll keys, but ignores other keys', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useScrollSpy(IDS));
    emit(instances.at(-1), [['c', true]]);

    act(() => result.current.setActiveId('b'));
    act(() => {
      window.dispatchEvent(new Event('touchstart'));
      vi.advanceTimersByTime(150);
    });
    expect(result.current.activeId).toBe('c');

    act(() => result.current.setActiveId('b'));
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
      vi.advanceTimersByTime(150);
    });
    expect(result.current.activeId).toBe('b');

    act(() => result.current.setActiveId('a'));
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown' }));
      vi.advanceTimersByTime(150);
    });
    expect(result.current.activeId).toBe('c');
  });

  it('removes the intent listeners on unmount', () => {
    const remove = vi.spyOn(window, 'removeEventListener');
    const { unmount } = renderHook(() => useScrollSpy(IDS));
    unmount();
    const types = remove.mock.calls.map((c) => c[0]);
    expect(types).toEqual(expect.arrayContaining(['wheel', 'touchstart', 'keydown']));
    remove.mockRestore();
  });

  it('keeps the lock across a rootMargin change and applies the target on release', () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ rm }) => useScrollSpy(IDS, { rootMargin: rm }), {
      initialProps: { rm: '-80px 0px -60% 0px' },
    });
    act(() => result.current.setActiveId('b'));
    rerender({ rm: '-120px 0px -60% 0px' });
    expect(instances).toHaveLength(2);
    emit(instances[1], [['c', true]]);
    expect(result.current.activeId).toBe('b');
    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(result.current.activeId).toBe('b');
    // Lock is released now: the new observer drives the active section again.
    emit(instances[1], [['c', true]]);
    expect(result.current.activeId).toBe('c');
  });

  it('release after a rebuild still applies the target when the observer saw another section', () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ rm }) => useScrollSpy(IDS, { rootMargin: rm }), {
      initialProps: { rm: '-80px 0px -60% 0px' },
    });
    act(() => result.current.setActiveId('b'));
    rerender({ rm: '-90px 0px -60% 0px' });
    emit(instances[1], [['a', true]]);
    act(() => {
      window.dispatchEvent(new Event('scrollend'));
    });
    expect(result.current.activeId).toBe('b');
  });
});
