import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import LoadError from '../LoadError';

afterEach(cleanup);

describe('LoadError', () => {
  it('renders fixed copy as an alert', () => {
    render(<LoadError thing="habits" onRetry={() => {}} />);
    expect(screen.getByRole('alert')).toHaveTextContent(
      "Burrow couldn't load your habits. Your data is safe.",
    );
  });

  it('disables the button and shows Retrying… while retrying', () => {
    render(<LoadError thing="notes" onRetry={() => {}} retrying />);
    expect(screen.getByRole('button', { name: 'Retrying…' })).toBeDisabled();
  });

  it('calls onRetry when Retry is clicked', async () => {
    const onRetry = vi.fn();
    render(<LoadError thing="notes" onRetry={onRetry} />);
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
