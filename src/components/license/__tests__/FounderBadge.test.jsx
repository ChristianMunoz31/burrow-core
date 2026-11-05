import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import FounderBadge from '../FounderBadge';

afterEach(cleanup);

describe('FounderBadge', () => {
  it('renders the Founding member pill in gold on deep purple', () => {
    render(<FounderBadge />);
    const badge = screen.getByText('Founding member');
    expect(badge.className).toContain('bg-[#5b21b6]');
    expect(badge.className).toContain('text-[#fde68a]');
  });

  it('accepts an extra class without losing the base styling', () => {
    render(<FounderBadge className="mt-2" />);
    const badge = screen.getByText('Founding member');
    expect(badge).toHaveClass('mt-2');
    expect(badge.className).toContain('bg-[#5b21b6]');
  });
});
