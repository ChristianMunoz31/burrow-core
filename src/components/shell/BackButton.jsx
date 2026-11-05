import { useCallback, useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ChevronLeft } from 'lucide-react';
import { parentPath } from './routeKey';
import { inEditable, isModalOpen } from './shortcutGuard';
import { SHELL_ICON_BTN } from './shellStyles';

// Safety net: how long a Back press blocks further triggers if the location never changes.
const LATCH_MS = 300;

// Back inside Burrow only. The keyboard and mouse shortcuts are registered here and TopBar mounts this
// on every route, so they also work on Home, where the button itself is shown dimmed and disabled.
export default function BackButton() {
  const { pathname, key } = useLocation();
  const navigate = useNavigate();
  const latched = useRef(false);
  const latchTimer = useRef(null);

  const release = useCallback(() => {
    latched.current = false;
    if (latchTimer.current !== null) {
      clearTimeout(latchTimer.current);
      latchTimer.current = null;
    }
  }, []);

  // navigate(-1) is async, so history.state.idx is stale until the location changes. Clear the latch then.
  useEffect(() => {
    release();
  }, [key, release]);
  useEffect(() => release, [release]);

  const goBack = useCallback(() => {
    if (latched.current) return;
    // React Router's BrowserRouter writes { usr, key, idx } into history.state; idx 0 is the first
    // entry of this document load. Anything before it is the splash page or the single-use
    // /desktop/bootstrap URL, so never go below idx 0.
    if (window.history.state?.idx > 0) {
      latched.current = true;
      latchTimer.current = setTimeout(release, LATCH_MS);
      navigate(-1);
    } else if (pathname !== '/') navigate(parentPath(pathname), { replace: true });
  }, [navigate, pathname, release]);

  useEffect(() => {
    const onKey = (e) => {
      const altLeft = e.key === 'ArrowLeft' && e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey;
      if ((!altLeft && e.key !== 'BrowserBack') || e.defaultPrevented) return;
      e.preventDefault(); // always: stops the webview's own history back
      if (e.repeat || isModalOpen() || inEditable(e.target)) return;
      goBack();
    };
    // Mouse button 4 (XButton1). Chromium reports it as mouseup; some builds fire auxclick instead,
    // so both are handled, and the preventDefault on either stops the webview's own navigation.
    const onMouse = (e) => {
      if (e.button !== 3) return;
      e.preventDefault();
      if (e.type === 'mouseup' && !isModalOpen()) goBack();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mouseup', onMouse);
    window.addEventListener('auxclick', onMouse);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mouseup', onMouse);
      window.removeEventListener('auxclick', onMouse);
    };
  }, [goBack]);

  // Home has nowhere to go back to: the same button, dimmed and disabled, keeps the header from
  // shifting. It has no action there, so it is hidden from assistive technology, never focusable and
  // ignores the pointer (no hover fill, no tooltip).
  const home = pathname === '/' && {
    disabled: true,
    tabIndex: -1,
    'aria-hidden': true,
    'data-testid': 'back-placeholder',
    className: `${SHELL_ICON_BTN} pointer-events-none opacity-40`,
  };
  return (
    <button
      type="button"
      onClick={goBack}
      aria-label="Back"
      title="Back (Alt+Left)"
      aria-keyshortcuts="Alt+ArrowLeft"
      className={SHELL_ICON_BTN}
      {...home}
    >
      <ChevronLeft size={18} aria-hidden="true" />
    </button>
  );
}
