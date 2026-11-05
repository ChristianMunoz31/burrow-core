import { createContext, useContext, useEffect, useMemo, useSyncExternalStore } from 'react';
import { useSyncedSetting } from '../hooks/useSyncedSetting';
import {
  SETTINGS_DEFAULTS,
  SETTINGS_KEYS,
  normalizeBackground,
  normalizeThemePreference,
} from '../constants/settingsDefaults';

const ThemeContext = createContext(null);

const LIGHT_QUERY = '(prefers-color-scheme: light)';

// Cached lazily so snapshot reads (every render) reuse one MediaQueryList. Keyed on
// the matchMedia function itself so a replaced implementation (tests) is picked up.
let cachedMql = null;
let cachedMatchMedia = null;
function mediaQuery() {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null;
  if (!cachedMql || cachedMatchMedia !== window.matchMedia) {
    cachedMatchMedia = window.matchMedia;
    cachedMql = window.matchMedia(LIGHT_QUERY);
  }
  return cachedMql;
}

function subscribeSystem(onChange) {
  const mq = mediaQuery();
  if (!mq) return () => {};
  if (typeof mq.addEventListener === 'function') {
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }
  // Older Safari only supports the deprecated addListener/removeListener pair.
  if (typeof mq.addListener === 'function') {
    mq.addListener(onChange);
    return () => mq.removeListener(onChange);
  }
  return () => {};
}

// True when the OS prefers light. Dark is the fallback when matchMedia is missing.
function systemPrefersLight() {
  return mediaQuery()?.matches === true;
}

// Idempotent DOM write of the `.light` class on <html>.
function applyThemeClass(theme) {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (root.classList.contains('light') !== (theme === 'light')) {
    root.classList.toggle('light', theme === 'light');
  }
}

// Idempotent DOM write of the background preset attributes on <html>.
function applyBackground(bgLight, bgDark) {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (root.dataset.bgLight !== bgLight) root.dataset.bgLight = bgLight;
  if (root.dataset.bgDark !== bgDark) root.dataset.bgDark = bgDark;
}

export function ThemeProvider({ children }) {
  // Preference is 'system' | 'light' | 'dark'. Legacy stored 'light'/'dark' still work.
  const [storedPref, setPreference] = useSyncedSetting(
    SETTINGS_KEYS.theme,
    SETTINGS_DEFAULTS.theme,
  );
  const [storedBgLight, setBgLight] = useSyncedSetting(
    SETTINGS_KEYS.bgLight,
    SETTINGS_DEFAULTS.bgLight,
  );
  const [storedBgDark, setBgDark] = useSyncedSetting(
    SETTINGS_KEYS.bgDark,
    SETTINGS_DEFAULTS.bgDark,
  );

  const preference = normalizeThemePreference(storedPref);
  const savedBgLight = normalizeBackground(storedBgLight);
  const savedBgDark = normalizeBackground(storedBgDark);

  const bgLight = savedBgLight;
  const bgDark = savedBgDark;

  const systemLight = useSyncExternalStore(subscribeSystem, systemPrefersLight, () => false);
  const theme = preference === 'system' ? (systemLight ? 'light' : 'dark') : preference;

  // Apply synchronously during render so children (chart helpers read computed
  // CSS vars / the .light class while rendering) see the new theme on the same
  // render pass. This is a render-phase DOM write, which is only acceptable because
  // it is idempotent and derived purely from inputs that update synchronously
  // (the query cache and useSyncExternalStore). The effect stays as a fallback.
  applyThemeClass(theme);
  applyBackground(bgLight, bgDark);
  useEffect(() => {
    applyThemeClass(theme);
    applyBackground(bgLight, bgDark);
  }, [theme, bgLight, bgDark]);

  const value = useMemo(
    () => ({
      theme,
      preference,
      setPreference,
      bgLight,
      bgDark,
      setBgLight,
      setBgDark,
    }),
    [
      theme,
      preference,
      setPreference,
      bgLight,
      bgDark,
      setBgLight,
      setBgDark,
    ],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider');
  return ctx;
}
