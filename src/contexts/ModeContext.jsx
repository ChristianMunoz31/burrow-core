import { createContext, useCallback, useContext, useMemo } from 'react';
import { useSyncedSetting } from '../hooks/useSyncedSetting';

// The stored `mode` (all, work, home) is the Work/Home filter of the Todos page only. It no longer
// hides modules, filters other records or seeds anything else.

const ModeContext = createContext(null);

// eslint-disable-next-line react-refresh/only-export-components
export const MODES = ['all', 'work', 'home'];

export function ModeProvider({ children }) {
  const [stored, setStored] = useSyncedSetting('mode', 'all');
  const mode = MODES.includes(stored) ? stored : 'all';

  const setMode = useCallback(
    (next, options) => {
      if (MODES.includes(next)) setStored(next, options);
    },
    [setStored],
  );

  const value = useMemo(() => ({ mode, setMode }), [mode, setMode]);

  return <ModeContext.Provider value={value}>{children}</ModeContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useMode() {
  const ctx = useContext(ModeContext);
  if (!ctx) throw new Error('useMode must be used within ModeProvider');
  return ctx;
}

// Return true if a record with the given context tag should be visible in the
// current mode. Records without a context default to 'both'.
// eslint-disable-next-line react-refresh/only-export-components
export function matchesMode(mode, context = 'both') {
  if (mode === 'all') return true;
  if (context === 'both' || !context) return true;
  return context === mode;
}
