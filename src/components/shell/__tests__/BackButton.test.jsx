import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { BrowserRouter, Link, useLocation } from 'react-router-dom';
import BackButton from '../BackButton';
import { parentPath } from '../routeKey';

function Probe() {
  const { pathname, hash } = useLocation();
  return <output data-testid="where">{pathname + hash}</output>;
}

// BrowserRouter reads the real window.history, so a test sets the starting entry first. An entry with
// no state is stamped idx 0 by the router: the first entry of this document load, nothing before it.
function renderAt(url, { extra = null } = {}) {
  window.history.replaceState(null, '', url);
  return render(
    <BrowserRouter>
      <BackButton />
      <Probe />
      <Link to="/budget">to budget</Link>
      <Link to="/todos">to todos</Link>
      <Link to="/settings">to settings</Link>
      {extra}
    </BrowserRouter>,
  );
}

const where = () => screen.getByTestId('where').textContent;
const backBtn = () => screen.queryByRole('button', { name: 'Back' });

beforeEach(() => window.history.replaceState(null, '', '/'));
afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/');
});

describe('parentPath', () => {
  it.each([
    ['/settings/data', '/settings'],
    ['/settings/anything/else', '/settings'],
    ['/settings', '/'],
    ['/settings/', '/'],
    ['/budget', '/'],
    ['/budget/planner', '/'],
    ['/budget/subscriptions', '/'],
    ['/todos', '/'],
    ['/', '/'],
    ['/no/such/page', '/'],
    ['', '/'],
  ])('%s -> %s', (from, to) => {
    expect(parentPath(from)).toBe(to);
  });
});

describe('BackButton visibility', () => {
  it('is hidden on Home', () => {
    renderAt('/');
    expect(backBtn()).not.toBeInTheDocument();
  });

  it.each(['/budget', '/budget/planner', '/todos', '/settings', '/settings/data'])('is shown on %s', (path) => {
    renderAt(path);
    const btn = backBtn();
    expect(btn).toBeInTheDocument();
    expect(btn).toHaveAttribute('type', 'button');
    expect(btn).toHaveAttribute('aria-keyshortcuts', 'Alt+ArrowLeft');
    expect(btn.className).toMatch(/focus-visible:ring-2/);
  });

  it('appears and disappears as the route changes', async () => {
    renderAt('/');
    fireEvent.click(screen.getByText('to todos'));
    expect(await screen.findByRole('button', { name: 'Back' })).toBeInTheDocument();
    fireEvent.click(backBtn());
    await waitFor(() => expect(where()).toBe('/'));
    expect(backBtn()).not.toBeInTheDocument();
  });
});

describe('BackButton on Home', () => {
  it('shows a dimmed, disabled Back that is hidden from assistive technology and not focusable', () => {
    renderAt('/');
    const slot = screen.getByTestId('back-placeholder');
    // Visible (not `invisible`), the same icon as the real button, but with no action.
    expect(slot.tagName).toBe('BUTTON');
    expect(slot).toBeVisible();
    expect(slot.className).not.toMatch(/\binvisible\b/);
    expect(slot.className).toMatch(/\bopacity-40\b/);
    expect(slot.className).toMatch(/\bpointer-events-none\b/);
    expect(slot.querySelector('svg')).not.toBeNull();
    expect(slot).toBeDisabled();
    expect(slot).toHaveAttribute('aria-hidden', 'true');
    expect(slot).toHaveAttribute('tabindex', '-1');
    // Not announced: no Back button in the accessibility tree, and none at all on Home.
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    slot.focus();
    expect(slot).not.toHaveFocus();
  });

  it('clicking the dimmed Back does nothing', () => {
    renderAt('/');
    fireEvent.click(screen.getByTestId('back-placeholder'));
    expect(where()).toBe('/');
  });

  it('keeps the same size and icon as the real button, so the header does not shift', async () => {
    renderAt('/');
    const slot = screen.getByTestId('back-placeholder');
    const sizeClasses = (el) => el.className.split(/\s+/).filter((c) => /^(h|w)-\d+$|^shrink-0$/.test(c)).sort();
    const placeholderSize = sizeClasses(slot);
    const placeholderIcon = slot.querySelector('svg').getAttribute('width');
    fireEvent.click(screen.getByText('to todos'));
    const btn = await screen.findByRole('button', { name: 'Back' });
    expect(sizeClasses(btn)).toEqual(placeholderSize);
    expect(placeholderSize).toEqual(['h-9', 'shrink-0', 'w-9']);
    expect(btn.querySelector('svg').getAttribute('width')).toBe(placeholderIcon);
    expect(btn).not.toHaveAttribute('aria-hidden');
    expect(btn).not.toHaveAttribute('tabindex');
    expect(btn).toBeEnabled();
  });

  it('the placeholder is gone on other pages, where the button has a tooltip', () => {
    renderAt('/todos');
    expect(screen.queryByTestId('back-placeholder')).toBeNull();
    expect(backBtn()).toHaveAttribute('title', 'Back (Alt+Left)');
  });

  it('keeps the shortcuts mounted: Alt+Left still goes back when there is history', async () => {
    renderAt('/');
    fireEvent.click(screen.getByText('to budget'));
    fireEvent.click(screen.getByText('to todos'));
    await waitFor(() => expect(where()).toBe('/todos'));
    // Land on Home through history, then press Alt+Left there: the placeholder is showing, the listener is live.
    fireEvent.keyDown(window, { key: 'ArrowLeft', altKey: true });
    await waitFor(() => expect(where()).toBe('/budget'));
    fireEvent.keyDown(window, { key: 'ArrowLeft', altKey: true });
    await waitFor(() => expect(where()).toBe('/'));
    expect(screen.getByTestId('back-placeholder')).toBeInTheDocument();
    fireEvent.click(screen.getByText('to settings'));
    await waitFor(() => expect(where()).toBe('/settings'));
    window.history.back();
    await waitFor(() => expect(where()).toBe('/'));
    expect(screen.getByTestId('back-placeholder')).toBeInTheDocument();
    expect(fireEvent.keyDown(window, { key: 'ArrowLeft', altKey: true })).toBe(false);
  });
});

describe('BackButton double triggers', () => {
  const press = (init = {}) => fireEvent.keyDown(window, { key: 'ArrowLeft', altKey: true, ...init });

  it('two Alt+Left presses before the popstate, and a repeat, never go below idx 0', async () => {
    renderAt('/');
    fireEvent.click(screen.getByText('to budget'));
    await waitFor(() => expect(where()).toBe('/budget'));
    expect(window.history.state.idx).toBe(1);
    const go = vi.spyOn(window.history, 'go');
    try {
      expect(press()).toBe(false);
      expect(press()).toBe(false); // second press, state.idx still 1 because popstate has not landed
      expect(press({ repeat: true })).toBe(false); // auto-repeat: ignored but still prevented
      expect(go).toHaveBeenCalledTimes(1);
      await waitFor(() => expect(where()).toBe('/'));
      expect(window.history.state.idx).toBe(0);
      expect(window.history.state.idx).toBeGreaterThanOrEqual(0);
      expect(['/', '/budget']).toContain(window.location.pathname);
    } finally {
      go.mockRestore();
    }
  });

  it('a fast double mouse button 4 is one step too', async () => {
    renderAt('/');
    fireEvent.click(screen.getByText('to budget'));
    await waitFor(() => expect(where()).toBe('/budget'));
    const go = vi.spyOn(window.history, 'go');
    try {
      expect(fireEvent.mouseUp(window, { button: 3 })).toBe(false);
      expect(fireEvent.mouseUp(window, { button: 3 })).toBe(false);
      expect(go).toHaveBeenCalledTimes(1);
      await waitFor(() => expect(where()).toBe('/'));
      expect(window.history.state.idx).toBe(0);
    } finally {
      go.mockRestore();
    }
  });

  it('a repeat keydown alone does nothing but is still prevented', () => {
    renderAt('/');
    fireEvent.click(screen.getByText('to budget'));
    const go = vi.spyOn(window.history, 'go');
    try {
      expect(press({ repeat: true })).toBe(false);
      expect(go).not.toHaveBeenCalled();
    } finally {
      go.mockRestore();
    }
  });

  it('the latch releases on its own if the location never changes', async () => {
    renderAt('/');
    fireEvent.click(screen.getByText('to budget'));
    await waitFor(() => expect(where()).toBe('/budget'));
    const go = vi.spyOn(window.history, 'go').mockImplementation(() => {});
    try {
      press();
      press();
      expect(go).toHaveBeenCalledTimes(1);
      await new Promise((resolve) => setTimeout(resolve, 400));
      press();
      expect(go).toHaveBeenCalledTimes(2);
    } finally {
      go.mockRestore();
    }
  });
});

describe('BackButton click', () => {
  it('goes back one entry when the app has history', async () => {
    renderAt('/');
    fireEvent.click(screen.getByText('to todos'));
    await waitFor(() => expect(where()).toBe('/todos'));
    fireEvent.click(screen.getByText('to settings'));
    await waitFor(() => expect(where()).toBe('/settings'));
    fireEvent.click(backBtn());
    await waitFor(() => expect(where()).toBe('/todos'));
  });

  it.each([
    ['/settings/data', '/settings'],
    ['/settings#updates', '/'],
    ['/budget/planner', '/'],
    ['/todos', '/'],
    ['/settings/data?table=transactions&view=overview', '/settings'],
  ])('with no history, %s falls back to %s and replaces the entry', async (start, target) => {
    renderAt(start);
    expect(window.history.state.idx).toBe(0);
    const before = window.history.length;
    fireEvent.click(backBtn());
    await waitFor(() => expect(where()).toBe(target));
    expect(window.history.length).toBe(before);
    expect(window.history.state.idx).toBe(0);
  });

  it('after a fallback to /settings a second Back reaches Home, never a blank page', async () => {
    renderAt('/settings/data');
    fireEvent.click(backBtn());
    await waitFor(() => expect(where()).toBe('/settings'));
    fireEvent.click(backBtn());
    await waitFor(() => expect(where()).toBe('/'));
    expect(backBtn()).not.toBeInTheDocument();
  });
});

describe('BackButton shortcuts', () => {
  const altLeft = (target = window, init = {}) =>
    fireEvent.keyDown(target, { key: 'ArrowLeft', altKey: true, ...init });

  it('Alt+Left goes back and prevents the default', async () => {
    renderAt('/todos');
    const notPrevented = altLeft();
    expect(notPrevented).toBe(false);
    await waitFor(() => expect(where()).toBe('/'));
  });

  it('Alt+Left works on Home too (prevented, nothing to do)', async () => {
    renderAt('/');
    expect(altLeft()).toBe(false);
    expect(where()).toBe('/');
  });

  it('Alt+Left steps back through in-app history', async () => {
    renderAt('/');
    fireEvent.click(screen.getByText('to budget'));
    await waitFor(() => expect(where()).toBe('/budget'));
    altLeft();
    await waitFor(() => expect(where()).toBe('/'));
  });

  it('the BrowserBack key does the same', async () => {
    renderAt('/settings/data');
    expect(fireEvent.keyDown(window, { key: 'BrowserBack' })).toBe(false);
    await waitFor(() => expect(where()).toBe('/settings'));
  });

  it('ignores other Alt, Ctrl, Shift and Meta combinations and other keys', () => {
    renderAt('/todos');
    for (const init of [
      { key: 'ArrowLeft' },
      { key: 'ArrowLeft', altKey: true, ctrlKey: true },
      { key: 'ArrowLeft', altKey: true, shiftKey: true },
      { key: 'ArrowLeft', altKey: true, metaKey: true },
      { key: 'ArrowRight', altKey: true },
      { key: 'Escape' },
    ]) {
      expect(fireEvent.keyDown(window, init)).toBe(true);
    }
    expect(where()).toBe('/todos');
  });

  it.each([
    ['input', () => document.createElement('input')],
    ['textarea', () => document.createElement('textarea')],
    ['select', () => document.createElement('select')],
    [
      'contenteditable',
      () => {
        const div = document.createElement('div');
        div.setAttribute('contenteditable', 'true');
        return div;
      },
    ],
  ])('does not navigate from a %s, but still prevents the default', (_name, make) => {
    renderAt('/todos');
    const el = make();
    document.body.appendChild(el);
    try {
      el.focus();
      expect(altLeft(el)).toBe(false);
      expect(where()).toBe('/todos');
    } finally {
      el.remove();
    }
  });

  it('does not navigate while a modal dialog is open, but still prevents the default', () => {
    renderAt('/todos');
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    document.body.appendChild(dialog);
    try {
      expect(altLeft()).toBe(false);
      fireEvent.mouseUp(window, { button: 3 });
      expect(where()).toBe('/todos');
    } finally {
      dialog.remove();
    }
  });

  it('a closing modal (inside an inert wrapper) does not block it', async () => {
    renderAt('/todos');
    const wrap = document.createElement('div');
    wrap.setAttribute('inert', '');
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    wrap.appendChild(dialog);
    document.body.appendChild(wrap);
    try {
      altLeft();
      await waitFor(() => expect(where()).toBe('/'));
    } finally {
      wrap.remove();
    }
  });

  it('a non-modal popover does not block it', async () => {
    renderAt('/todos');
    const pop = document.createElement('div');
    pop.setAttribute('role', 'dialog');
    document.body.appendChild(pop);
    try {
      altLeft();
      await waitFor(() => expect(where()).toBe('/'));
    } finally {
      pop.remove();
    }
  });

  it('leaves a keydown that something else already handled alone', () => {
    renderAt('/todos');
    const handler = (e) => e.preventDefault();
    document.body.addEventListener('keydown', handler);
    try {
      altLeft(document.body);
      expect(where()).toBe('/todos');
    } finally {
      document.body.removeEventListener('keydown', handler);
    }
  });

  it('mouse button 4 goes back and prevents the default', async () => {
    renderAt('/todos');
    expect(fireEvent.mouseUp(window, { button: 3 })).toBe(false);
    await waitFor(() => expect(where()).toBe('/'));
  });

  it('mouse button 4 also works from inside a text field', async () => {
    renderAt('/todos');
    const input = document.createElement('input');
    document.body.appendChild(input);
    try {
      fireEvent.mouseUp(input, { button: 3 });
      await waitFor(() => expect(where()).toBe('/'));
    } finally {
      input.remove();
    }
  });

  it('auxclick for button 4 is prevented but does not navigate a second time', async () => {
    renderAt('/');
    fireEvent.click(screen.getByText('to budget'));
    fireEvent.click(screen.getByText('to todos'));
    await waitFor(() => expect(where()).toBe('/todos'));
    expect(fireEvent(window, new MouseEvent('auxclick', { button: 3, bubbles: true, cancelable: true }))).toBe(false);
    expect(where()).toBe('/todos');
  });

  it('ignores the other mouse buttons', () => {
    renderAt('/todos');
    for (const button of [0, 1, 2, 4]) {
      expect(fireEvent.mouseUp(window, { button })).toBe(true);
    }
    expect(where()).toBe('/todos');
  });

  it('removes its listeners on unmount', () => {
    const { unmount } = renderAt('/todos');
    unmount();
    expect(altLeft()).toBe(true);
    expect(fireEvent.mouseUp(window, { button: 3 })).toBe(true);
  });

  it('Alt+Left on a focused checkbox, radio or range navigates', async () => {
    for (const type of ['checkbox', 'radio', 'range', 'button']) {
      renderAt('/');
      fireEvent.click(screen.getByText('to todos'));
      await waitFor(() => expect(where()).toBe('/todos'));
      const el = document.createElement('input');
      el.type = type;
      document.body.appendChild(el);
      el.focus();
      expect(altLeft(el)).toBe(false);
      await waitFor(() => expect(where()).toBe('/'));
      el.remove();
      cleanup();
    }
  });

  it('still ignores text-like inputs, including a contenteditable that is not false', () => {
    renderAt('/todos');
    for (const make of [
      () => Object.assign(document.createElement('input'), { type: 'text' }),
      () => Object.assign(document.createElement('input'), { type: 'email' }),
      () => {
        const div = document.createElement('div');
        div.setAttribute('contenteditable', 'plaintext-only');
        return div;
      },
    ]) {
      const el = make();
      document.body.appendChild(el);
      altLeft(el);
      el.remove();
    }
    expect(where()).toBe('/todos');
  });

  it('never leaves the app: every fallback target is Home or Settings', async () => {
    for (const start of ['/settings/data', '/settings#ai', '/budget/subscriptions', '/folders#add-folder', '/journal']) {
      renderAt(start);
      await act(async () => {
        altLeft();
      });
      await waitFor(() => expect(['/', '/settings']).toContain(where()));
      cleanup();
    }
  });
});
