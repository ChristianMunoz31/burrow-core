import { useCallback, useEffect, useRef, useState } from 'react';

const QUIET_MS = 100;
const FALLBACK_MS = 1000;
const SCROLL_KEYS = new Set([
  'ArrowUp',
  'ArrowDown',
  'PageUp',
  'PageDown',
  'Home',
  'End',
  ' ',
  'Spacebar',
]);

// Tracks which element (by id) is the current section while the page scrolls.
// Topmost intersecting section wins; at the very bottom of a scrollable page the last
// section is forced active. `setActiveId` applies at once and locks the spy so a smooth
// programmatic scroll does not flicker through the sections in between. The lock releases on
// 'scrollend', after QUIET_MS without scroll events, or after FALLBACK_MS, whichever is first;
// on release a pending explicit selection (`setActiveId`) is applied as-is; otherwise the active
// section is recomputed from what is visible. User scroll intent (wheel, touch, scroll keys)
// during the lock drops the pending selection so the release recomputes instead. The lock
// survives option changes (observer rebuilds); only unmount resets it. At the page bottom a
// clicked non-last section holds until the next scroll, after which the last section wins.
// `initialId` seeds the active section when it is one of `ids`.
export function useScrollSpy(
  ids,
  { enabled = true, rootMargin = '-80px 0px -60% 0px', initialId } = {},
) {
  const [activeId, setActive] = useState(() =>
    initialId && ids.includes(initialId) ? initialId : (ids[0] ?? null),
  );
  const locked = useRef(false);
  const quietTimer = useRef(null);
  const fallbackTimer = useRef(null);
  const release = useRef(null);
  const targetRef = useRef(null);
  const idsKey = ids.join('|');

  const clearTimers = useCallback(() => {
    clearTimeout(quietTimer.current);
    clearTimeout(fallbackTimer.current);
    quietTimer.current = null;
    fallbackTimer.current = null;
  }, []);

  const setActiveId = useCallback(
    (id) => {
      locked.current = true;
      targetRef.current = id;
      clearTimers();
      const fire = () => {
        if (release.current) release.current();
        else {
          locked.current = false;
          targetRef.current = null;
        }
      };
      quietTimer.current = setTimeout(fire, QUIET_MS);
      fallbackTimer.current = setTimeout(fire, FALLBACK_MS);
      setActive(id);
    },
    [clearTimers],
  );

  useEffect(() => {
    if (!enabled || typeof window === 'undefined' || !idsKey) return undefined;
    const list = idsKey.split('|');
    const last = list[list.length - 1];
    const visible = new Set();

    const apply = (id) => {
      if (id && !locked.current) setActive(id);
    };
    const atBottom = () => {
      const root = document.documentElement;
      return (
        root.scrollHeight > window.innerHeight + 2 &&
        window.innerHeight + window.scrollY >= root.scrollHeight - 2
      );
    };
    const current = () => (atBottom() ? last : list.find((id) => visible.has(id)));

    const doRelease = () => {
      const wasLocked = locked.current;
      locked.current = false;
      clearTimers();
      const target = wasLocked ? targetRef.current : null;
      targetRef.current = null;
      if (target) setActive(target);
      else apply(current());
    };
    release.current = doRelease;

    let observer = null;
    if (typeof IntersectionObserver !== 'undefined') {
      observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting) visible.add(entry.target.id);
            else visible.delete(entry.target.id);
          }
          apply(current());
        },
        { rootMargin },
      );
      for (const id of list) {
        const el = document.getElementById(id);
        if (el) observer.observe(el);
      }
    }

    const onScroll = () => {
      if (locked.current) {
        clearTimeout(quietTimer.current);
        quietTimer.current = setTimeout(() => release.current?.(), QUIET_MS);
        return;
      }
      if (atBottom()) apply(last);
    };
    const dropTarget = () => {
      if (locked.current) targetRef.current = null;
    };
    const onKeyDown = (e) => {
      if (SCROLL_KEYS.has(e.key)) dropTarget();
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('scrollend', doRelease);
    window.addEventListener('wheel', dropTarget, { passive: true });
    window.addEventListener('touchstart', dropTarget, { passive: true });
    window.addEventListener('keydown', onKeyDown, { passive: true });

    return () => {
      observer?.disconnect();
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('scrollend', doRelease);
      window.removeEventListener('wheel', dropTarget);
      window.removeEventListener('touchstart', dropTarget);
      window.removeEventListener('keydown', onKeyDown);
      release.current = null;
    };
  }, [enabled, idsKey, rootMargin, clearTimers]);

  // Lock, timers and target outlive observer rebuilds (rootMargin/ids/enabled changes); only
  // unmount resets them.
  useEffect(
    () => () => {
      clearTimers();
      locked.current = false;
      targetRef.current = null;
    },
    [clearTimers],
  );

  return { activeId, setActiveId };
}
