import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import JaviBar from '../JaviBar';

afterEach(cleanup);

const props = { open: false, onToggle: () => {}, controlsId: 'p' };
const badgeOf = (button) => [...button.querySelectorAll('span')].find((el) => /^(\d|9\+)/.test(el.textContent));

describe('JaviBar', () => {
  it('is named by its visible text, with no title or description and the Alt+J shortcut', () => {
    render(<JaviBar {...props} />);
    const button = screen.getByRole('button', { name: 'Javi, AI helper' });
    expect(button).toHaveTextContent('Javi');
    expect(button).toHaveTextContent('AI helper');
    expect(button).not.toHaveAttribute('title');
    expect(button).not.toHaveAttribute('aria-description');
    expect(button).toHaveAttribute('aria-keyshortcuts', 'Alt+J');
    expect(button).toHaveAttribute('aria-haspopup', 'dialog');
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(button).not.toHaveAttribute('aria-controls');
    // Every child is hidden from the accessibility tree, so the name is exactly the label.
    for (const child of button.children) expect(child).toHaveAttribute('aria-hidden', 'true');
  });

  it('has no badge at 0', () => {
    render(<JaviBar {...props} count={0} />);
    expect(badgeOf(screen.getByRole('button', { name: 'Javi, AI helper' }))).toBeUndefined();
  });

  it('shows 9+ for 12 while the name carries the real number; the badge is hidden and never animates', () => {
    render(<JaviBar {...props} count={12} />);
    const badge = badgeOf(screen.getByRole('button', { name: 'Javi, AI helper, 12 new for you' }));
    expect(badge).toHaveTextContent('9+');
    expect(badge).toHaveAttribute('aria-hidden', 'true');
    expect(badge.className).not.toMatch(/animate|transition/);
  });

  it('shows the number up to 9', () => {
    render(<JaviBar {...props} count={3} />);
    expect(badgeOf(screen.getByRole('button', { name: 'Javi, AI helper, 3 new for you' }))).toHaveTextContent(/^3$/);
  });

  it('is hidden by class while open and points at the window', () => {
    render(<JaviBar {...props} open />);
    const button = screen.getByRole('button', { name: 'Javi, AI helper' });
    expect(button).toHaveAttribute('aria-expanded', 'true');
    expect(button).toHaveAttribute('aria-controls', 'p');
    expect(button.className.split(/\s+/)).toContain('hidden');
    expect(button.className.split(/\s+/)).not.toContain('flex');
  });

  it('calls onToggle on a click', async () => {
    const onToggle = vi.fn();
    render(<JaviBar {...props} onToggle={onToggle} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Javi, AI helper' }));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});
