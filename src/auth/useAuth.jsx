import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';

const AuthContext = createContext(null);

const isAuthEndpoint = (url) =>
  url.includes('/api/login') ||
  url.includes('/api/logout') ||
  url.includes('/api/auth/status');

export function AuthProvider({ children }) {
  const queryClient = useQueryClient();
  const [state, setState] = useState({ loading: true, enabled: true, authenticated: false });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/auth/status');
        const data = await res.json();
        if (cancelled) return;
        setState({ loading: false, enabled: !!data.enabled, authenticated: !!data.authenticated });
      } catch {
        // If we can't even reach the status endpoint, show the login screen.
        if (cancelled) return;
        setState({ loading: false, enabled: true, authenticated: false });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Global interceptor: if any data request returns 401 mid-session (expired
  // cookie), drop back to the login screen without editing the 16 services.
  useEffect(() => {
    const original = window.fetch;
    window.fetch = async (...args) => {
      const res = await original(...args);
      try {
        const input = args[0];
        const url = typeof input === 'string' ? input : input?.url || '';
        if (res.status === 401 && url.includes('/api/') && !isAuthEndpoint(url)) {
          setState((s) => (s.authenticated ? { ...s, authenticated: false } : s));
        }
      } catch {
        /* ignore */
      }
      return res;
    };
    return () => {
      window.fetch = original;
    };
  }, []);

  const login = useCallback(
    async (password) => {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Login failed');
      }
      setState({ loading: false, enabled: true, authenticated: true });
      queryClient.invalidateQueries();
    },
    [queryClient],
  );

  const logout = useCallback(async () => {
    await fetch('/api/logout', { method: 'POST' }).catch(() => {});
    setState({ loading: false, enabled: true, authenticated: false });
    queryClient.clear();
  }, [queryClient]);

  const value = useMemo(() => ({ ...state, login, logout }), [state, login, logout]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
