import { useRef, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Modal from '../Modal';

afterEach(() => {
  cleanup();
  document.body.style.overflow = '';
});

function Harness({ initial = true, finalFocus = false, children }) {
  const [open, setOpen] = useState(initial);
  const fallbackRef = useRef(null);
  return (
    <div>
      <button onClick={() => setOpen(true)}>opener</button>
      <button ref={fallbackRef}>fallback</button>
      {open && (
        <Modal title="Edit thing" onClose={() => setOpen(false)} finalFocusRef={finalFocus ? fallbackRef : undefined}>
          {children ?? (
            <>
              <input aria-label="first" />
              <input aria-label="second" />
            </>
          )}
        </Modal>
      )}
    </div>
  );
}

describe('Modal', () => {
  it('portals to body with dialog role and aria wiring', () => {
    const { container } = render(<Harness />);
    const dialog = screen.getByRole('dialog', { name: 'Edit thing' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(container.contains(dialog)).toBe(false);
    expect(document.body.contains(dialog)).toBe(true);
  });

  it('focuses the first field on open', () => {
    render(<Harness />);
    expect(screen.getByLabelText('first')).toHaveFocus();
  });

  it('honours initialFocusRef', () => {
    function WithRef() {
      const ref = useRef(null);
      return (
        <Modal title="t" onClose={() => {}} initialFocusRef={ref}>
          <input aria-label="a" />
          <input aria-label="b" ref={ref} />
        </Modal>
      );
    }
    render(<WithRef />);
    expect(screen.getByLabelText('b')).toHaveFocus();
  });

  it('falls back to the first focusable (Close) when there are no fields', () => {
    render(<Harness>{<p>text</p>}</Harness>);
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();
  });

  it('wraps Tab from last to first and Shift+Tab from first to last', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const close = screen.getByRole('button', { name: 'Close' });
    const second = screen.getByLabelText('second');
    second.focus();
    await user.tab();
    expect(close).toHaveFocus();
    await user.tab({ shift: true });
    expect(second).toHaveFocus();
  });

  it('closes on Escape', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('ignores Escape from a select', () => {
    render(
      <Harness>
        <select aria-label="sel">
          <option>a</option>
        </select>
      </Harness>,
    );
    fireEvent.keyDown(screen.getByLabelText('sel'), { key: 'Escape' });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('closes on backdrop mousedown but not on panel mousedown', () => {
    render(<Harness />);
    fireEvent.mouseDown(screen.getByRole('dialog'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByRole('dialog').parentElement);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('closes via the X button', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('is not dismissible by Escape, backdrop or X when dismissible=false', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <Modal title="busy" onClose={onClose} dismissible={false}>
        <input aria-label="f" />
      </Modal>,
    );
    await user.keyboard('{Escape}');
    fireEvent.mouseDown(screen.getByRole('dialog').parentElement);
    expect(screen.getByRole('button', { name: 'Close' })).toBeDisabled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('returns focus to the opener on close', async () => {
    const user = userEvent.setup();
    render(<Harness initial={false} />);
    const opener = screen.getByRole('button', { name: 'opener' });
    await user.click(opener);
    expect(screen.getByLabelText('first')).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(opener).toHaveFocus();
  });

  it('uses finalFocusRef when the opener is gone', () => {
    function Gone() {
      const [open, setOpen] = useState(false);
      const [showOpener, setShowOpener] = useState(true);
      const fallbackRef = useRef(null);
      return (
        <div>
          {showOpener && <button onClick={() => setOpen(true)}>opener</button>}
          <button ref={fallbackRef}>fallback</button>
          <button onClick={() => setShowOpener(false)}>hide</button>
          {open && (
            <Modal title="t" onClose={() => setOpen(false)} finalFocusRef={fallbackRef}>
              <input aria-label="f" />
            </Modal>
          )}
        </div>
      );
    }
    render(<Gone />);
    screen.getByRole('button', { name: 'opener' }).focus();
    fireEvent.click(screen.getByRole('button', { name: 'opener' }));
    fireEvent.click(screen.getByRole('button', { name: 'hide' }));
    // Opener removed while the dialog is open; closing via X must fall back.
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.getByRole('button', { name: 'fallback' })).toHaveFocus();
  });

  it('uses finalFocusRef when focus was on document.body at open', () => {
    function FromBody() {
      const [open, setOpen] = useState(true);
      const fallbackRef = useRef(null);
      return (
        <div>
          <button ref={fallbackRef}>fallback</button>
          {open && (
            <Modal title="t" onClose={() => setOpen(false)} finalFocusRef={fallbackRef}>
              <input aria-label="f" />
            </Modal>
          )}
        </div>
      );
    }
    document.activeElement?.blur?.();
    render(<FromBody />);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.getByRole('button', { name: 'fallback' })).toHaveFocus();
  });

  it('does not focus a hidden input first', () => {
    render(
      <Modal title="t" onClose={() => {}}>
        <input type="hidden" name="h" />
        <input aria-label="visible" />
      </Modal>,
    );
    expect(screen.getByLabelText('visible')).toHaveFocus();
  });

  it('locks body scroll and restores it, refcounted across modals', () => {
    document.body.style.overflow = 'auto';
    const a = render(<Modal title="a" onClose={() => {}}><input /></Modal>);
    expect(document.body.style.overflow).toBe('hidden');
    const b = render(<Modal title="b" onClose={() => {}}><input /></Modal>);
    a.unmount();
    expect(document.body.style.overflow).toBe('hidden');
    b.unmount();
    expect(document.body.style.overflow).toBe('auto');
  });

  it('stacked modals: only the lower panel is inert, and it is restored when the top closes', () => {
    function Stack() {
      const [inner, setInner] = useState(false);
      return (
        <>
          <Modal title="lower" onClose={() => {}}>
            <button onClick={() => setInner(true)}>open top</button>
          </Modal>
          {inner && (
            <Modal title="top" onClose={() => setInner(false)}>
              <input aria-label="t" />
            </Modal>
          )}
        </>
      );
    }
    render(<Stack />);
    const lower = screen.getByRole('dialog', { name: 'lower' });
    expect(lower).not.toHaveAttribute('inert');
    fireEvent.click(screen.getByRole('button', { name: 'open top' }));
    const top = screen.getByRole('dialog', { name: 'top' });
    expect(lower).toHaveAttribute('inert');
    expect(top).not.toHaveAttribute('inert');
    fireEvent.click(within(top).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog', { name: 'top' })).not.toBeInTheDocument();
    expect(lower).not.toHaveAttribute('inert');
  });

  it('nested modals: Escape closes only the top one', async () => {
    const user = userEvent.setup();
    function Nested() {
      const [outer, setOuter] = useState(true);
      const [inner, setInner] = useState(false);
      return (
        <>
          {outer && (
            <Modal title="outer" onClose={() => setOuter(false)}>
              <button onClick={() => setInner(true)}>open inner</button>
              {inner && (
                <Modal title="inner" onClose={() => setInner(false)}>
                  <input aria-label="i" />
                </Modal>
              )}
            </Modal>
          )}
        </>
      );
    }
    render(<Nested />);
    fireEvent.click(screen.getByRole('button', { name: 'open inner' }));
    expect(screen.getAllByRole('dialog')).toHaveLength(2);
    await user.keyboard('{Escape}');
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(screen.getByRole('dialog', { name: 'outer' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
