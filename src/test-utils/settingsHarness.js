// Test-only helpers for the Settings feature tests (not shipped; not a test file).

/**
 * Installs a controllable window.matchMedia. Returns a handle whose `setMatches`
 * updates `matches` and fires every registered 'change' listener (wrap in act()).
 */
export function installMatchMedia(initialMatches = false) {
  const state = { matches: initialMatches, listeners: new Set() };
  const mq = {
    get matches() {
      return state.matches;
    },
    media: '(prefers-color-scheme: light)',
    addEventListener: (type, fn) => {
      if (type === 'change') state.listeners.add(fn);
    },
    removeEventListener: (type, fn) => {
      if (type === 'change') state.listeners.delete(fn);
    },
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => true,
  };
  window.matchMedia = () => mq;
  return {
    get listenerCount() {
      return state.listeners.size;
    },
    setMatches(next) {
      state.matches = next;
      for (const fn of [...state.listeners]) fn({ matches: next, media: mq.media });
    },
  };
}

/** Clears persisted settings and the <html> theme/background markers. */
export function resetDom() {
  localStorage.clear();
  const root = document.documentElement;
  root.classList.remove('light');
  root.removeAttribute('data-bg-dark');
  root.removeAttribute('data-bg-light');
  // jsdom logs "Not implemented" for window.scrollTo; SettingsLayout calls it on page changes.
  window.scrollTo = () => {};
}
