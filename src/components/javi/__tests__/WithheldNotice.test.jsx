import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter } from 'react-router-dom';
import WithheldNotice from '../WithheldNotice';

describe('WithheldNotice', () => {
  afterEach(cleanup);

  it('keeps the Settings > AI path on one line', () => {
    render(
      <MemoryRouter>
        <WithheldNotice message="Your journal isn't shared with cloud AI. You can change that in Settings > AI." />
      </MemoryRouter>,
    );
    const path = screen.getByText('Settings > AI.');
    expect(path).toHaveClass('whitespace-nowrap');
    expect(screen.getByRole('status')).toHaveTextContent(
      "Your journal isn't shared with cloud AI. You can change that in Settings > AI.",
    );
  });

  it('does not treat any character after "AI" as part of the path', () => {
    render(
      <MemoryRouter>
        <WithheldNotice message="Open Settings > AIx to change that." />
      </MemoryRouter>,
    );
    expect(screen.queryByText('Settings > AIx')).not.toBeInTheDocument();
    expect(screen.getByText('Settings > AI')).toHaveClass('whitespace-nowrap');
    expect(screen.getByRole('status')).toHaveTextContent('Open Settings > AIx to change that.');
  });

  it('renders messages without the path unchanged', () => {
    render(
      <MemoryRouter>
        <WithheldNotice message="That isn't shared with cloud AI." />
      </MemoryRouter>,
    );
    expect(screen.getByText("That isn't shared with cloud AI.")).toBeInTheDocument();
  });
});
