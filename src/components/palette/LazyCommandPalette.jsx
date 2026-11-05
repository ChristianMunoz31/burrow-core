import { Suspense, lazy, useEffect, useState } from 'react';

const loadPalette = () => import('./CommandPalette');
const CommandPalette = lazy(loadPalette);

const PALETTE_OPEN_EVENT = 'palette:open';

// Fetch the chunk when the browser is idle so the first Ctrl/Cmd+K rarely waits on it.
function whenIdle(fn) {
  if (typeof window.requestIdleCallback === 'function') {
    const id = window.requestIdleCallback(fn, { timeout: 4000 });
    return () => window.cancelIdleCallback?.(id);
  }
  const id = setTimeout(fn, 1500);
  return () => clearTimeout(id);
}

/**
 * AppShell host for the command palette. The palette chunk is preloaded on idle and mounted
 * on the first Ctrl/Cmd+K or 'palette:open'. That first trigger is handed to the palette
 * as `initialOpen`, since its own listeners did not exist yet; from then on it owns them.
 * @param {{ javiAvailable?: boolean }} props
 */
export default function LazyCommandPalette({ javiAvailable = false }) {
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if (armed) return undefined;
    const cancelIdle = whenIdle(() => {
      loadPalette().catch(() => {});
    });
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        setArmed(true);
      }
    };
    const onOpen = () => setArmed(true);
    window.addEventListener('keydown', onKey);
    window.addEventListener(PALETTE_OPEN_EVENT, onOpen);
    return () => {
      cancelIdle();
      window.removeEventListener('keydown', onKey);
      window.removeEventListener(PALETTE_OPEN_EVENT, onOpen);
    };
  }, [armed]);

  if (!armed) return null;
  return (
    <Suspense fallback={null}>
      <CommandPalette initialOpen javiAvailable={javiAvailable} />
    </Suspense>
  );
}
