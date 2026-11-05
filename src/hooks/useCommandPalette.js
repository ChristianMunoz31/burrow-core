import { useEffect, useState } from 'react';

// Fire from anywhere (e.g. the TopBar button) to open the palette.
export function openCommandPalette() {
  window.dispatchEvent(new CustomEvent('palette:open'));
}

// Global ⌘K / Ctrl+K toggle + Escape close, plus a 'palette:open' custom event
// so non-adjacent components (TopBar) can open it without prop-drilling.
export function useCommandPalette(initialOpen = false) {
  const [open, setOpen] = useState(initialOpen);
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        setOpen((o) => !o);
      } else if (e.key === 'Escape') {
        // A quick-add sub-mode handles Escape itself (back to the list): leave it open.
        if (e.defaultPrevented) return;
        setOpen(false);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('palette:open', onOpen);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('palette:open', onOpen);
    };
  }, []);
  return { open, setOpen };
}
